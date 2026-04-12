import { Config } from "./config";
import { logger } from "./logger";

const ROUND_DURATION = 900; // 15 minutes
const CACHE_TTL = 2_000; // 低延迟: 每2s刷新剩余时间

export interface Round15m {
  market: Record<string, any>;
  upToken: string;
  downToken: string;
  secondsLeft: number;
  question: string;
  conditionId: string;
  negRisk: boolean;
}

let cache: Round15m | null = null;
let cacheTs = 0;
let cacheEndTime = 0;  // 缓存对应回合的endTime毫秒戳, 用于实时计算secondsLeft

// 下一轮预加载缓存 — 消除回合切换时的冷启动延迟
let prefetchedSlug = "";
let prefetchedRound: Round15m | null = null;
let prefetchedEndTime = 0;   // endDate的毫秒时间戳, 用于精确计算secondsLeft

function clampRoundSeconds(secondsLeft: number): number {
  return Math.max(0, Math.min(ROUND_DURATION, secondsLeft));
}

function computeSlug(): string {
  const now = Math.floor(Date.now() / 1000);
  const roundStart = now - (now % ROUND_DURATION);
  return `btc-updown-15m-${roundStart}`;
}

async function fetchEvent(slug: string): Promise<Record<string, any> | null> {
  try {
    const url = `${Config.GAMMA_HOST}/events?slug=${encodeURIComponent(slug)}&limit=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
  } catch (e: any) {
    logger.error(`fetchEvent15m ${slug}: ${e.message}`);
  }
  return null;
}

const tokenParseCache = new Map<string, { up: string; down: string } | null>();

function parseTokens(market: Record<string, any>): { up: string; down: string } | null {
  // 用conditionId做缓存key (同一市场token不会变)
  const cacheKey = market.conditionId || market.questionID || "";
  if (cacheKey && tokenParseCache.has(cacheKey)) return tokenParseCache.get(cacheKey)!;

  let clobIds = market.clobTokenIds;
  let outcomes = market.outcomes;
  if (clobIds && outcomes) {
    try {
      if (typeof clobIds === "string") clobIds = JSON.parse(clobIds);
      if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
      const result: Record<string, string> = {};
      for (let i = 0; i < clobIds.length; i++) {
        const key = (outcomes[i] as string).toLowerCase();
        if (key.includes("up")) result.up = clobIds[i];
        else if (key.includes("down")) result.down = clobIds[i];
      }
      if (result.up && result.down) {
        const r = { up: result.up, down: result.down };
        if (cacheKey) tokenParseCache.set(cacheKey, r);
        return r;
      }
    } catch {}
  }
  const tokens = market.tokens as any[] | undefined;
  if (tokens) {
    const result: Record<string, string> = {};
    for (const t of tokens) {
      const outcome = ((t.outcome || "") as string).toLowerCase();
      const tokenId = t.token_id as string;
      if (!tokenId) continue;
      if (outcome.includes("up")) result.up = tokenId;
      else if (outcome.includes("down")) result.down = tokenId;
    }
    if (result.up && result.down) {
      const r = { up: result.up, down: result.down };
      if (cacheKey) tokenParseCache.set(cacheKey, r);
      return r;
    }
  }
  if (cacheKey) tokenParseCache.set(cacheKey, null);
  return null;
}

/** 预加载下一轮市场 tokens，消除回合切换的 Gamma API 冷启动延迟 */
export async function prefetchNextRound(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const nextStart = (nowSec - (nowSec % ROUND_DURATION)) + ROUND_DURATION;
  const slug = `btc-updown-15m-${nextStart}`;
  if (prefetchedSlug === slug) return; // 已在处理，防止并发重复请求
  prefetchedSlug = slug; // 先占位
  try {
    const event = await fetchEvent(slug);
    if (!event) { prefetchedSlug = ""; return; }
    const markets = event.markets as any[] | undefined;
    if (!markets?.length) { prefetchedSlug = ""; return; }
    const market = markets[0];
    const tokens = parseTokens(market);
    if (!tokens) { prefetchedSlug = ""; return; }
    const endStr = event.endDate || market.endDate;
    if (!endStr) { prefetchedSlug = ""; return; }
    prefetchedEndTime = new Date(endStr).getTime();
    prefetchedRound = {
      market,
      upToken: tokens.up,
      downToken: tokens.down,
      secondsLeft: 0,  // 占位, 使用时从 prefetchedEndTime 实时计算
      question: market.question || "",
      conditionId: market.conditionId || "",
      negRisk: !!market.negRisk,
    };
    logger.info(`下一轮预加载: ${prefetchedRound.question}`);
  } catch {
    prefetchedSlug = "";
  }
}

export async function getCurrentRound15m(): Promise<Round15m | null> {
  const now = Date.now();

  // 优先使用预加载数据，消除回合切换时的冷启动延迟
  const curSlug = computeSlug();
  if (prefetchedRound && prefetchedSlug === curSlug) {
    const secondsLeft = clampRoundSeconds((prefetchedEndTime - now) / 1000);
    if (secondsLeft > 0) {
      cache = { ...prefetchedRound, secondsLeft };
      cacheTs = now;
      cacheEndTime = prefetchedEndTime;
      prefetchedRound = null;
      prefetchedSlug = "";
      return cache;
    }
  }

  if (cache && now - cacheTs < CACHE_TTL && cacheEndTime > 0) {
    // 从endTime实时计算secondsLeft, 避免高频调用累计扣减漂移
    const freshSecsLeft = clampRoundSeconds((cacheEndTime - now) / 1000);
    if (freshSecsLeft <= 0) { cache = null; return null; }
    cache.secondsLeft = freshSecsLeft;
    return cache;
  }

  let slug = computeSlug();
  let event = await fetchEvent(slug);

  if (!event) {
    const nowSec = Math.floor(Date.now() / 1000);
    const nextStart = nowSec - (nowSec % ROUND_DURATION) + ROUND_DURATION;
    event = await fetchEvent(`btc-updown-15m-${nextStart}`);
    if (!event) {
      cache = null;
      return null;
    }
  }

  const markets = event.markets as any[] | undefined;
  if (!markets || markets.length === 0) return null;
  const market = markets[0];

  if (!market.acceptingOrders || event.closed) {
    cache = null;
    return null;
  }

  const endStr = event.endDate || market.endDate;
  if (!endStr) return null;

  const endTime = new Date(endStr).getTime();
  const secondsLeft = clampRoundSeconds((endTime - Date.now()) / 1000);
  if (secondsLeft <= 0) {
    cache = null;
    return null;
  }

  const tokens = parseTokens(market);
  if (!tokens) return null;

  cache = {
    market,
    upToken: tokens.up,
    downToken: tokens.down,
    secondsLeft,
    question: market.question || "",
    conditionId: market.conditionId || "",
    negRisk: !!market.negRisk,
  };
  cacheTs = Date.now();
  cacheEndTime = endTime;
  return cache;
}
