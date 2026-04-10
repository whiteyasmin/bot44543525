import { Config } from "./config";
import { logger } from "./logger";
import { WebSocket } from "ws";

let running = false;
let latestPrice = 0;
let roundStartPrice = 0;
let roundStartTime = 0;
let roundStartChainlinkPrice = 0;
let chainlinkPrice = 0;
let chainlinkUpdatedAt = 0;

// F: CL方向稳定性追踪
let clDirHistory: string[] = [];           // 最近N次CL方向读数
const CL_DIR_HISTORY_MAX = 10;
// G: CL本回合更新次数追踪
let clRoundUpdateCount = 0;                // 本回合CL收到几次实际价格变化
let clLastSeenPrice = 0;                   // 上次CL价格 (用于检测是否真的变了)
// H: CL翻转频率追踪
let clFlipCount = 0;                       // 本回合CL方向翻转次数
let clLastRecordedDir = "";                // 上一次记录的方向
// I: CL-Binance 价差收敛追踪
let clBinSpreadHistory: number[] = [];     // 最近N次 |CL - Binance| 价差
const CL_BIN_SPREAD_MAX = 8;
// J: CL 动量置信度追踪
let clMovePctHistory: number[] = [];       // 最近N次CL偏移幅度(有符号)
const CL_MOMENTUM_MAX = 5;
// K: CL 更新间隔追踪
let clUpdateTimestamps: number[] = [];     // 本回合CL更新时间戳
const CL_UPDATE_TS_MAX = 10;

const recentPrices: { t: number; p: number }[] = [];
const MAX_SAMPLES = 1500;

let roundSecsLeft = 999;
let consecutiveRejections = 0;

let wsPrice = 0;
let wsLastTs = 0;
let wsConnected = false;
let wsInstance: WebSocket | null = null;

let clWsInstance: WebSocket | null = null;
let clWsConnected = false;

function startPolygonChainlinkWs(): void {
  if (!running) return;
  const wsRpc = Config.CHAINLINK_RPC
    .replace("https://", "wss://")
    .replace("http://", "ws://");
  const wsUrl = wsRpc.startsWith("wss://") ? wsRpc : "wss://polygon.gateway.tenderly.co";
  try {
    const ws = new WebSocket(wsUrl);
    clWsInstance = ws;
    ws.on("open", () => {
      clWsConnected = true;
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_subscribe",
        params: ["logs", {
          address: Config.CHAINLINK_BTC_FEED,
          topics: ["0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"],
        }],
      }));
      logger.info("Polygon Chainlink WS 已连接 (实时CL更新)");
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === "eth_subscription" && msg.params?.result?.data) {
          const hex = msg.params.result.data.slice(2);
          if (hex.length >= 64) {
            let answer = BigInt("0x" + hex.slice(0, 64));
            if (answer >= 2n ** 255n) answer -= 2n ** 256n;
            const price = Number(answer) / 1e8;
            if (price > 1000) {
              const wsNow = Date.now();
              // G+K: 检测CL价格是否真的变了
              if (price !== clLastSeenPrice) {
                clRoundUpdateCount++;
                clLastSeenPrice = price;
                clUpdateTimestamps.push(wsNow);
                if (clUpdateTimestamps.length > CL_UPDATE_TS_MAX) clUpdateTimestamps.shift();
              }
              chainlinkPrice = price;
              chainlinkUpdatedAt = Math.floor(wsNow / 1000);
              // F+H: 记录方向读数 + 翻转检测
              if (roundStartChainlinkPrice > 0) {
                const dir = price >= roundStartChainlinkPrice ? "up" : "down";
                clDirHistory.push(dir);
                if (clDirHistory.length > CL_DIR_HISTORY_MAX) clDirHistory.shift();
                if (clLastRecordedDir && dir !== clLastRecordedDir) clFlipCount++;
                clLastRecordedDir = dir;
                // J: 动量
                const signedPct = (price - roundStartChainlinkPrice) / roundStartChainlinkPrice;
                clMovePctHistory.push(signedPct);
                if (clMovePctHistory.length > CL_MOMENTUM_MAX) clMovePctHistory.shift();
              }
              // I: CL-Binance价差
              if (latestPrice > 0) {
                const spread = Math.abs(price - latestPrice);
                clBinSpreadHistory.push(spread);
                if (clBinSpreadHistory.length > CL_BIN_SPREAD_MAX) clBinSpreadHistory.shift();
              }
              logger.info(`CL WS update: $${price.toFixed(2)}`);
            }
          }
        }
      } catch {}
    });
    ws.on("close", () => {
      clWsConnected = false;
      clWsInstance = null;
      if (running) setTimeout(startPolygonChainlinkWs, 10_000);
    });
    ws.on("error", () => {
      clWsConnected = false;
      if (clWsInstance) { try { clWsInstance.terminate(); } catch {} }
      clWsInstance = null;
    });
  } catch {
    if (running) setTimeout(startPolygonChainlinkWs, 15_000);
  }
}

// --- Fetchers ---

async function fetchBinance(): Promise<number | null> {
  try {
    const resp = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      { signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

async function fetchBybit(): Promise<number | null> {
  try {
    const resp = await fetch(
      "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
      { signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const price = parseFloat(data.result?.list?.[0]?.lastPrice);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchCoinGecko(): Promise<number | null> {
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.bitcoin?.usd ?? null;
  } catch {
    return null;
  }
}

const POLYGON_RPCS: string[] = [];
{
  const seen = new Set<string>();
  for (const url of [
    Config.CHAINLINK_RPC,
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-mainnet.public.blastapi.io",
    "https://polygon.gateway.tenderly.co",
  ]) {
    if (url && !seen.has(url)) { seen.add(url); POLYGON_RPCS.push(url); }
  }
}
let lastWorkingRpc = 0;

async function fetchChainlinkFromRpc(rpcUrl: string): Promise<number | null> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [
        { to: Config.CHAINLINK_BTC_FEED, data: "0xfeaf968c" },
        "latest",
      ],
      id: 1,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  const result = json.result as string | undefined;
  if (!result || result === "0x" || result.length < 322) throw new Error(`bad result: ${(result || "").slice(0, 40)}`);
  const hex = result.slice(2);
  let answer = BigInt("0x" + hex.slice(64, 128));
  if (answer >= 2n ** 255n) answer -= 2n ** 256n;
  const updatedAt = Number(BigInt("0x" + hex.slice(192, 256)));
  const price = Number(answer) / 1e8;
  if (price <= 1000) throw new Error(`invalid price: ${price}`);
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  if (updatedAt > 0 && age > 300) {
    logger.warn(`Chainlink stale: ${age}s old (rpc=${rpcUrl.slice(0, 30)})`);
    return null;
  }
  chainlinkUpdatedAt = updatedAt;
  return price;
}

async function fetchChainlink(): Promise<number | null> {
  const order = [lastWorkingRpc, ...POLYGON_RPCS.map((_, i) => i).filter(i => i !== lastWorkingRpc)];
  for (const idx of order) {
    const rpc = POLYGON_RPCS[idx];
    if (!rpc) continue;
    try {
      const price = await fetchChainlinkFromRpc(rpc);
      if (price && price > 0) {
        if (idx !== lastWorkingRpc) {
          logger.info(`Chainlink RPC switched to: ${rpc.slice(0, 35)}`);
          lastWorkingRpc = idx;
        }
        return price;
      }
      return null;
    } catch (e: any) {
      logger.warn(`Chainlink RPC failed (${rpc.slice(0, 30)}): ${e.message}`);
    }
  }
  logger.warn("All Chainlink RPCs failed");
  return null;
}

async function fetchPrice(): Promise<number | null> {
  const [binance, bybit] = await Promise.all([fetchBinance(), fetchBybit()]);
  const prices = [binance, bybit].filter((p): p is number => p !== null && p > 0);
  if (prices.length >= 2) {
    prices.sort((a, b) => a - b);
    const mid = prices.length / 2;
    return (prices[Math.floor(mid - 1 + 0.5)] + prices[Math.floor(mid + 0.5)]) / 2;
  }
  if (prices.length === 1) return prices[0];
  return fetchCoinGecko();
}

// --- WebSocket price feed ---

function startBinanceWebSocket(): void {
  if (!running) return;
  try {
    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@aggTrade");
    wsInstance = ws;
    ws.on("open", () => {
      wsConnected = true;
      logger.info("Binance WebSocket 已连接 (实时价格)");
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        const p = parseFloat(msg.p);
        if (p > 0) { wsPrice = p; wsLastTs = Date.now(); }
      } catch {}
    });
    ws.on("close", () => {
      wsConnected = false;
      wsInstance = null;
      if (running) setTimeout(startBinanceWebSocket, 3000);
    });
    ws.on("error", (_err: Error) => {
      wsConnected = false;
      if (wsInstance) { try { wsInstance.terminate(); } catch {} }
      wsInstance = null;
    });
  } catch {
    if (running) setTimeout(startBinanceWebSocket, 5000);
  }
}

// --- Sample loop ---

async function sampleLoop(): Promise<void> {
  let cycle = 0;
  while (running) {
    const wsAge = wsLastTs > 0 ? Date.now() - wsLastTs : Infinity;
    const p: number | null = (wsConnected && wsAge < 5000) ? wsPrice : await fetchPrice();
    if (p) {
      if (latestPrice > 0 && Math.abs(p - latestPrice) / latestPrice > 0.02 && consecutiveRejections < 5) {
        consecutiveRejections++;
        logger.warn(`Price outlier rejected (${consecutiveRejections}/5): $${p.toFixed(2)} vs $${latestPrice.toFixed(2)}`);
      } else {
        if (consecutiveRejections >= 5) {
          logger.warn(`Sustained move accepted after ${consecutiveRejections} rejections: $${p.toFixed(2)}`);
        }
        consecutiveRejections = 0;
        latestPrice = p;
        recentPrices.push({ t: Date.now(), p });
        if (recentPrices.length > MAX_SAMPLES) recentPrices.shift();
      }
    }
    const clFast = roundSecsLeft < 60;
    if (!clWsConnected && (clFast || cycle % 3 === 0)) {
      const cp = await fetchChainlink();
      if (cp) { updateClTracking(cp); chainlinkPrice = cp; }
    } else if (clWsConnected && cycle % 5 === 0) {
      const cp = await fetchChainlink();
      if (cp) { updateClTracking(cp); chainlinkPrice = cp; }
    }
    cycle++;
    await sleep(wsConnected ? 300 : 1500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Public API ---

export function startPriceFeed(): Promise<void> {
  if (running) return Promise.resolve();
  running = true;
  startBinanceWebSocket();
  startPolygonChainlinkWs();
  sampleLoop();
  return new Promise<void>((resolve) => {
    let waited = 0;
    const iv = setInterval(() => {
      if (latestPrice > 0 || waited >= 15_000) {
        clearInterval(iv);
        logger.info(`价格源启动, BTC=$${latestPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
        resolve();
      }
      waited += 500;
    }, 500);
  });
}

export function stopPriceFeed(): void {
  running = false;
  if (wsInstance) {
    try { wsInstance.terminate(); } catch {}
    wsInstance = null;
  }
  if (clWsInstance) {
    try { clWsInstance.terminate(); } catch {}
    clWsInstance = null;
  }
  wsConnected = false;
  clWsConnected = false;
}

export function getBtcPrice(): number {
  return latestPrice;
}

export function setRoundStartPrice(price = 0): void {
  roundStartPrice = price > 0 ? price : latestPrice;
  roundStartTime = Date.now();
  consecutiveRejections = 0;
  roundStartChainlinkPrice = chainlinkPrice > 0 ? chainlinkPrice : 0;
  // F+G: 新回合重置
  clDirHistory = [];
  clRoundUpdateCount = 0;
  clLastSeenPrice = chainlinkPrice;
  // H+I+J+K: 新回合重置
  clFlipCount = 0;
  clLastRecordedDir = "";
  clBinSpreadHistory = [];
  clMovePctHistory = [];
  clUpdateTimestamps = [];
}

export function getRoundStartPrice(): number {
  return roundStartPrice;
}

export function getPriceChange(): number {
  if (roundStartPrice <= 0) return 0;
  return latestPrice - roundStartPrice;
}

export function getDirection(): string {
  return getPriceChange() >= 0 ? "up" : "down";
}

export function setRoundSecsLeft(secs: number): void {
  roundSecsLeft = secs;
}

export function getChainlinkPrice(): number {
  return chainlinkPrice;
}

export function isChainlinkFresh(): boolean {
  if (chainlinkUpdatedAt <= 0) return false;
  // CL BTC/USD 心跳~27分钟, 60s太严导致几乎总是回退到交易所价格
  // 用900s(一个回合周期): 只要本回合内有CL数据就优先使用, 更准确匹配结算数据源
  return Math.floor(Date.now() / 1000) - chainlinkUpdatedAt <= 900;
}

export function getChainlinkDirection(): string {
  if (chainlinkPrice <= 0 || !isChainlinkFresh()) return getDirection();
  if (roundStartChainlinkPrice <= 0) {
    // 回合开始时没有CL基准: 用当前CL vs BTC回合开始价, 比纯BTC更接近链上
    if (roundStartPrice > 0) {
      return chainlinkPrice >= roundStartPrice ? "up" : "down";
    }
    return getDirection();
  }
  return chainlinkPrice >= roundStartChainlinkPrice ? "up" : "down";
}

/** CL 变动幅度百分比 (绝对值). 基准为 roundStartChainlinkPrice */
export function getChainlinkMovePct(): number {
  if (chainlinkPrice <= 0 || roundStartChainlinkPrice <= 0) return 0;
  return Math.abs(chainlinkPrice - roundStartChainlinkPrice) / roundStartChainlinkPrice;
}

/** CL 新鲜度分档: "high"(<60s) | "mid"(60-300s) | "low"(300-900s) | "stale"(>900s) */
export function getChainlinkFreshnessTier(): "high" | "mid" | "low" | "stale" {
  if (chainlinkUpdatedAt <= 0) return "stale";
  const age = Math.floor(Date.now() / 1000) - chainlinkUpdatedAt;
  if (age <= 60) return "high";
  if (age <= 300) return "mid";
  if (age <= 900) return "low";
  return "stale";
}

/** Binance 方向 (纯交易所价格 vs 回合开始价) */
export function getBinanceDirection(): string {
  return getDirection();          // getDirection() 已经是 Binance 价格
}

/** 内部: RPC 拉取时也追踪 F+G+H+I+J+K */
function updateClTracking(price: number): void {
  const now = Date.now();
  if (price !== clLastSeenPrice) {
    clRoundUpdateCount++;
    clLastSeenPrice = price;
    // K: 记录更新时间戳
    clUpdateTimestamps.push(now);
    if (clUpdateTimestamps.length > CL_UPDATE_TS_MAX) clUpdateTimestamps.shift();
  }
  if (roundStartChainlinkPrice > 0) {
    const dir = price >= roundStartChainlinkPrice ? "up" : "down";
    clDirHistory.push(dir);
    if (clDirHistory.length > CL_DIR_HISTORY_MAX) clDirHistory.shift();
    // H: 翻转检测
    if (clLastRecordedDir && dir !== clLastRecordedDir) clFlipCount++;
    clLastRecordedDir = dir;
    // J: 动量 (有符号偏移百分比)
    const signedPct = (price - roundStartChainlinkPrice) / roundStartChainlinkPrice;
    clMovePctHistory.push(signedPct);
    if (clMovePctHistory.length > CL_MOMENTUM_MAX) clMovePctHistory.shift();
  }
  // I: CL-Binance价差
  if (price > 0 && latestPrice > 0) {
    const spread = Math.abs(price - latestPrice);
    clBinSpreadHistory.push(spread);
    if (clBinSpreadHistory.length > CL_BIN_SPREAD_MAX) clBinSpreadHistory.shift();
  }
}

/** F: CL方向连续一致次数 (最近读数中末尾连续同方向的数量) */
export function getChainlinkDirStability(): number {
  if (clDirHistory.length === 0) return 0;
  const last = clDirHistory[clDirHistory.length - 1];
  let count = 0;
  for (let i = clDirHistory.length - 1; i >= 0; i--) {
    if (clDirHistory[i] === last) count++;
    else break;
  }
  return count;
}

/** G: 本回合CL价格实际变化次数 (心跳到达次数) */
export function getChainlinkRoundUpdates(): number {
  return clRoundUpdateCount;
}

/** H: 本回合CL方向翻转次数 (up→down 或 down→up). 翻转多=噪音大 */
export function getChainlinkFlipCount(): number {
  return clFlipCount;
}

/** I: CL-Binance价差是否在收敛. 返回 "converging"|"diverging"|"unknown" */
export function getClBinanceSpreadTrend(): "converging" | "diverging" | "unknown" {
  if (clBinSpreadHistory.length < 3) return "unknown";
  const half = Math.floor(clBinSpreadHistory.length / 2);
  const firstHalf = clBinSpreadHistory.slice(0, half);
  const secondHalf = clBinSpreadHistory.slice(half);
  const avg1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avg2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  if (avg2 < avg1 * 0.85) return "converging";
  if (avg2 > avg1 * 1.15) return "diverging";
  return "unknown";
}

/** J: CL动量置信度. 正=加速远离基准(强), 负=减速/回撤(弱). 返回 "accelerating"|"decelerating"|"unknown" */
export function getChainlinkMomentumTrend(): "accelerating" | "decelerating" | "unknown" {
  if (clMovePctHistory.length < 3) return "unknown";
  // 看绝对偏移是在增大还是缩小
  const absList = clMovePctHistory.map(Math.abs);
  const half = Math.floor(absList.length / 2);
  const first = absList.slice(0, half);
  const second = absList.slice(half);
  const avg1 = first.reduce((a, b) => a + b, 0) / first.length;
  const avg2 = second.reduce((a, b) => a + b, 0) / second.length;
  if (avg2 > avg1 * 1.1) return "accelerating";
  if (avg2 < avg1 * 0.9) return "decelerating";
  return "unknown";
}

/** K: CL最近两次更新的平均间隔(ms). 短间隔=活跃. 返回0表示数据不足 */
export function getChainlinkUpdateIntervalMs(): number {
  if (clUpdateTimestamps.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < clUpdateTimestamps.length; i++) {
    sum += clUpdateTimestamps[i] - clUpdateTimestamps[i - 1];
  }
  return Math.round(sum / (clUpdateTimestamps.length - 1));
}

/** 返回最近 N 秒内 BTC 价格变化百分比 (正=涨, 负=跌) */
export function getRecentMomentum(windowSec = 30): number {
  if (recentPrices.length < 2) return 0;
  const cutoff = Date.now() - windowSec * 1000;
  const old = recentPrices.find(p => p.t >= cutoff);
  if (!old || old.p <= 0) return 0;
  const latest = recentPrices[recentPrices.length - 1];
  return (latest.p - old.p) / old.p;
}
