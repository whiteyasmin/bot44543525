import { logger } from "./logger";
import { WebSocket } from "ws";

let running = false;
let latestPrice = 0;
let roundStartPrice = 0;
let roundStartTime = 0;

// L: Binance Taker Flow (买卖比) 追踪
let takerBuyVol = 0;                       // 本回合主动买入量 (BTC)
let takerSellVol = 0;                      // 本回合主动卖出量 (BTC)
let takerTradeCount = 0;                   // 本回合成交笔数
// 滑动窗口: 最近60s的分段买卖量 (用于趋势检测)
let takerBuckets: { t: number; buy: number; sell: number }[] = [];
const TAKER_BUCKET_INTERVAL = 10_000;      // 10s一桶
let currentBucketStart = 0;
let currentBucketBuy = 0;
let currentBucketSell = 0;

// M: Volume Spike Detection (成交量飙升检测)
let volBuckets: { t: number; vol: number }[] = [];     // 10s分桶量(BTC)
let volCurrentBucketStart = 0;
let volCurrentBucketVol = 0;

// N: Large Order Tracking (大单追踪, ≥0.5 BTC)
const LARGE_ORDER_THRESHOLD = 0.5;                      // 单笔≥0.5BTC视为大单
let largeBuyCount = 0;                                   // 本回合大单买入数
let largeSellCount = 0;                                  // 本回合大单卖出数
let largeBuyVol = 0;                                     // 本回合大单买入量
let largeSellVol = 0;                                    // 本回合大单卖出量
let recentLargeOrders: { t: number; side: "buy" | "sell"; qty: number }[] = [];

// O: Depth Imbalance (盘口深度失衡)
let depthBidTotal = 0;                                   // 最近快照bid总量
let depthAskTotal = 0;                                   // 最近快照ask总量
let depthLastUpdate = 0;
let depthWsInstance: WebSocket | null = null;
let depthWsConnected = false;

// P: Forced Liquidation Cascade (强制平仓级联)
let liqBuyVol = 0;                                       // 本回合强平买入量(空头被平)
let liqSellVol = 0;                                      // 本回合强平卖出量(多头被平)
let liqBuyCount = 0;
let liqSellCount = 0;
let liqWsInstance: WebSocket | null = null;
let liqWsConnected = false;

// Q: Funding Rate (资金费率)
let fundingRate = 0;                                     // 最新资金费率(正=多付空)
let fundingRateTs = 0;                                   // 最后更新时间
let nextFundingTime = 0;
let openInterest = 0;
let openInterestTs = 0;
let roundStartOpenInterest = 0;

const recentPrices: { t: number; p: number }[] = [];
const MAX_SAMPLES = 1500;

let roundSecsLeft = 999;
let consecutiveRejections = 0;

let wsPrice = 0;
let wsLastTs = 0;
let wsConnected = false;
let wsInstance: WebSocket | null = null;

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
        if (p > 0) {
          wsPrice = p; wsLastTs = Date.now();
          // L: Taker Flow 统计
          const q = parseFloat(msg.q) || 0;
          if (q > 0) {
            takerTradeCount++;
            // msg.m === true → buyer is maker → this trade is taker sell
            if (msg.m) { takerSellVol += q; } else { takerBuyVol += q; }
            // 滑动窗口桶
            const now = Date.now();
            if (now - currentBucketStart >= TAKER_BUCKET_INTERVAL && currentBucketStart > 0) {
              takerBuckets.push({ t: currentBucketStart, buy: currentBucketBuy, sell: currentBucketSell });
              if (takerBuckets.length > 12) takerBuckets.shift(); // 保留2min
              currentBucketStart = now;
              currentBucketBuy = 0;
              currentBucketSell = 0;
            }
            if (currentBucketStart === 0) currentBucketStart = now;
            if (msg.m) { currentBucketSell += q; } else { currentBucketBuy += q; }
            // M: Volume Spike — 分桶追踪总量
            if (now - volCurrentBucketStart >= TAKER_BUCKET_INTERVAL && volCurrentBucketStart > 0) {
              volBuckets.push({ t: volCurrentBucketStart, vol: volCurrentBucketVol });
              if (volBuckets.length > 30) volBuckets.shift(); // 保留5min历史
              volCurrentBucketStart = now;
              volCurrentBucketVol = 0;
            }
            if (volCurrentBucketStart === 0) volCurrentBucketStart = now;
            volCurrentBucketVol += q;
            // N: Large Order — 大单检测
            if (q >= LARGE_ORDER_THRESHOLD) {
              if (msg.m) { largeSellCount++; largeSellVol += q; } else { largeBuyCount++; largeBuyVol += q; }
              recentLargeOrders.push({ t: now, side: msg.m ? "sell" : "buy", qty: q });
              if (recentLargeOrders.length > 50) recentLargeOrders.shift();
            }
          }
        }
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

// --- O: Depth Imbalance WebSocket (盘口深度) ---
function startDepthWebSocket(): void {
  if (!running) return;
  try {
    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@depth5@100ms");
    depthWsInstance = ws;
    ws.on("open", () => {
      depthWsConnected = true;
      logger.info("Binance Depth WS 已连接 (盘口深度)");
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        const bids = msg.bids as [string, string][] | undefined;
        const asks = msg.asks as [string, string][] | undefined;
        if (bids && asks) {
          depthBidTotal = bids.reduce((s, b) => s + parseFloat(b[1]), 0);
          depthAskTotal = asks.reduce((s, a) => s + parseFloat(a[1]), 0);
          depthLastUpdate = Date.now();
        }
      } catch {}
    });
    ws.on("close", () => {
      depthWsConnected = false;
      depthWsInstance = null;
      if (running) setTimeout(startDepthWebSocket, 5000);
    });
    ws.on("error", () => {
      depthWsConnected = false;
      if (depthWsInstance) { try { depthWsInstance.terminate(); } catch {} }
      depthWsInstance = null;
    });
  } catch {
    if (running) setTimeout(startDepthWebSocket, 10000);
  }
}

// --- P: Forced Liquidation WebSocket (强平追踪) ---
function startLiquidationWebSocket(): void {
  if (!running) return;
  try {
    const ws = new WebSocket("wss://fstream.binance.com/ws/btcusdt@forceOrder");
    liqWsInstance = ws;
    ws.on("open", () => {
      liqWsConnected = true;
      logger.info("Binance Liquidation WS 已连接 (强平追踪)");
    });
    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        const o = msg.o;
        if (o && o.s === "BTCUSDT") {
          const qty = parseFloat(o.q) || 0;
          // S=SELL → 多头被强平(卖出), S=BUY → 空头被强平(买入)
          if (o.S === "BUY") { liqBuyVol += qty; liqBuyCount++; }
          else if (o.S === "SELL") { liqSellVol += qty; liqSellCount++; }
        }
      } catch {}
    });
    ws.on("close", () => {
      liqWsConnected = false;
      liqWsInstance = null;
      if (running) setTimeout(startLiquidationWebSocket, 5000);
    });
    ws.on("error", () => {
      liqWsConnected = false;
      if (liqWsInstance) { try { liqWsInstance.terminate(); } catch {} }
      liqWsInstance = null;
    });
  } catch {
    if (running) setTimeout(startLiquidationWebSocket, 10000);
  }
}

// --- Q: Funding Rate (资金费率) ---
async function fetchFundingRate(): Promise<void> {
  try {
    const resp = await fetch(
      "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return;
    const d = await resp.json();
    if (d.lastFundingRate != null) {
      fundingRate = parseFloat(d.lastFundingRate);
      fundingRateTs = Date.now();
    }
    if (d.nextFundingTime) {
      nextFundingTime = Number(d.nextFundingTime);
    }
  } catch {}
}

async function fetchOpenInterest(): Promise<void> {
  try {
    const resp = await fetch(
      "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return;
    const d = await resp.json();
    const nextOi = parseFloat(d.openInterest);
    if (Number.isFinite(nextOi) && nextOi > 0) {
      openInterest = nextOi;
      openInterestTs = Date.now();
      if (roundStartOpenInterest <= 0) roundStartOpenInterest = nextOi;
    }
  } catch {}
}

// --- Sample loop ---

async function sampleLoop(): Promise<void> {
  let cycle = 0;
  let fallbackBackoff = 5000; // 初始REST降级间隔5s
  while (running) {
    const wsAge = wsLastTs > 0 ? Date.now() - wsLastTs : Infinity;
    const wsFresh = wsConnected && wsAge < 5000;
    const p: number | null = wsFresh ? wsPrice : await fetchPrice();
    if (p) {
      fallbackBackoff = 5000; // REST成功, 重置退避
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
    // Q: 每60个周期(~18s)刷新一次资金费率
    if (cycle % 60 === 0) {
      fetchFundingRate().catch(() => {});
      fetchOpenInterest().catch(() => {});
    }
    cycle++;
    if (wsFresh) {
      await sleep(300);
    } else {
      await sleep(fallbackBackoff);
      fallbackBackoff = Math.min(30_000, Math.floor(fallbackBackoff * 1.5)); // 指数退避, 上限30s
    }
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
  startDepthWebSocket();           // O
  startLiquidationWebSocket();     // P
  fetchFundingRate().catch(() => {}); // Q: 立即获取一次
  fetchOpenInterest().catch(() => {});
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
  if (depthWsInstance) {
    try { depthWsInstance.terminate(); } catch {}
    depthWsInstance = null;
  }
  if (liqWsInstance) {
    try { liqWsInstance.terminate(); } catch {}
    liqWsInstance = null;
  }
  wsConnected = false;
  depthWsConnected = false;
  liqWsConnected = false;
}

export function getBtcPrice(): number {
  return latestPrice;
}

export function setRoundStartPrice(price = 0): void {
  roundStartPrice = price > 0 ? price : latestPrice;
  roundStartTime = Date.now();
  consecutiveRejections = 0;
  // L: Taker Flow 重置
  takerBuyVol = 0;
  takerSellVol = 0;
  takerTradeCount = 0;
  takerBuckets = [];
  currentBucketStart = 0;
  currentBucketBuy = 0;
  currentBucketSell = 0;
  // M: Volume Spike 重置
  volBuckets = [];
  volCurrentBucketStart = 0;
  volCurrentBucketVol = 0;
  // N: Large Order 重置
  largeBuyCount = 0;
  largeSellCount = 0;
  largeBuyVol = 0;
  largeSellVol = 0;
  recentLargeOrders = [];
  // P: Liquidation 重置
  liqBuyVol = 0;
  liqSellVol = 0;
  liqBuyCount = 0;
  liqSellCount = 0;
  if (openInterest > 0) {
    roundStartOpenInterest = openInterest;
  }
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

/** Binance 回合内 BTC 绝对变动幅度 */
export function getBtcMovePct(): number {
  if (latestPrice <= 0 || roundStartPrice <= 0) return 0;
  return Math.abs(latestPrice - roundStartPrice) / roundStartPrice;
}

/** Binance 方向 (equal = down: Polymarket "Up" = strictly above open) */
export function getBtcDirection(): "up" | "down" {
  return latestPrice > roundStartPrice ? "up" : "down";
}

export function setRoundSecsLeft(secs: number): void {
  roundSecsLeft = secs;
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

/** 最近N秒内BTC价格波动率 (最高-最低)/均价, 用于过滤微行情 */
export function getRecentVolatility(windowSec = 300): number {
  if (recentPrices.length < 5) return 0;
  const cutoff = Date.now() - windowSec * 1000;
  let hi = 0, lo = Infinity, count = 0;
  for (let i = recentPrices.length - 1; i >= 0; i--) {
    if (recentPrices[i].t < cutoff) break;
    const p = recentPrices[i].p;
    if (p > hi) hi = p;
    if (p < lo) lo = p;
    count++;
  }
  if (count < 5 || lo <= 0) return 0;
  return (hi - lo) / ((hi + lo) / 2);
}

// ===================== L: Taker Flow (买卖比) =====================

// ── 信号缓存 (避免 getState() 每250ms重算所有信号) ──
const SIGNAL_CACHE_TTL = 500; // 500ms缓存
let _signalCacheTs = 0;
let _cachedTakerFlow: ReturnType<typeof _getTakerFlowRatio> | null = null;
let _cachedVolSpike: ReturnType<typeof _getVolumeSpikeInfo> | null = null;
let _cachedLargeOrder: ReturnType<typeof _getLargeOrderInfo> | null = null;
let _cachedDepth: ReturnType<typeof _getDepthImbalance> | null = null;
let _cachedLiq: ReturnType<typeof _getLiquidationInfo> | null = null;
let _cachedFunding: ReturnType<typeof _getFundingRateInfo> | null = null;
let _cachedOpenInterest: ReturnType<typeof _getOpenInterestInfo> | null = null;

function invalidateSignalCache(): void {
  _signalCacheTs = 0;
}

function refreshSignalCacheIfStale(): void {
  if (Date.now() - _signalCacheTs < SIGNAL_CACHE_TTL) return;
  _cachedTakerFlow = _getTakerFlowRatio();
  _cachedVolSpike = _getVolumeSpikeInfo();
  _cachedLargeOrder = _getLargeOrderInfo();
  _cachedDepth = _getDepthImbalance();
  _cachedLiq = _getLiquidationInfo();
  _cachedFunding = _getFundingRateInfo();
  _cachedOpenInterest = _getOpenInterestInfo();
  _signalCacheTs = Date.now();
}

export function getTakerFlowRatio() { refreshSignalCacheIfStale(); return _cachedTakerFlow!; }
export function getVolumeSpikeInfo() { refreshSignalCacheIfStale(); return _cachedVolSpike!; }
export function getLargeOrderInfo() { refreshSignalCacheIfStale(); return _cachedLargeOrder!; }
export function getDepthImbalance() { refreshSignalCacheIfStale(); return _cachedDepth!; }
export function getLiquidationInfo() { refreshSignalCacheIfStale(); return _cachedLiq!; }
export function getFundingRateInfo() { refreshSignalCacheIfStale(); return _cachedFunding!; }
export function getOpenInterestInfo() { refreshSignalCacheIfStale(); return _cachedOpenInterest!; }

/**
 * 本回合 Taker 买卖比.
 * >1 = 买方主导(看涨), <1 = 卖方主导(看跌), ~1 = 平衡
 * 返回 { ratio, buyVol, sellVol, trades, direction, confidence }
 */
function _getTakerFlowRatio(): {
  ratio: number;
  buyVol: number;
  sellVol: number;
  trades: number;
  direction: "buy" | "sell" | "neutral";
  confidence: "high" | "medium" | "low";
} {
  const total = takerBuyVol + takerSellVol;
  if (total <= 0 || takerTradeCount < 10) {
    return { ratio: 1, buyVol: 0, sellVol: 0, trades: 0, direction: "neutral", confidence: "low" };
  }
  const ratio = takerSellVol > 0 ? takerBuyVol / takerSellVol : 9.99;
  const clamped = Math.min(9.99, Math.max(0.1, ratio));
  // 方向判定: 偏离1.0超过15%才视为有方向
  let direction: "buy" | "sell" | "neutral" = "neutral";
  if (clamped >= 1.15) direction = "buy";
  else if (clamped <= 0.87) direction = "sell";   // 1/1.15 ≈ 0.87
  // 置信度: 基于样本量 + 偏离幅度
  let confidence: "high" | "medium" | "low" = "low";
  if (takerTradeCount >= 500 && Math.abs(clamped - 1) >= 0.2) confidence = "high";
  else if (takerTradeCount >= 100 && Math.abs(clamped - 1) >= 0.1) confidence = "medium";
  return { ratio: clamped, buyVol: takerBuyVol, sellVol: takerSellVol, trades: takerTradeCount, direction, confidence };
}

/**
 * Taker Flow 趋势: 最近分桶的买卖比是在增强还是减弱
 * "strengthening" = 买方/卖方力量在持续增强
 * "weakening" = 主导方力量在减弱
 * "unknown" = 数据不足
 */
export function getTakerFlowTrend(): "strengthening" | "weakening" | "unknown" {
  // Note: getTakerFlowTrend is cheap (few buckets), no cache needed
  if (takerBuckets.length < 3) return "unknown";
  const half = Math.floor(takerBuckets.length / 2);
  const first = takerBuckets.slice(0, half);
  const second = takerBuckets.slice(half);
  const ratioOf = (b: typeof takerBuckets) => {
    const tb = b.reduce((s, x) => s + x.buy, 0);
    const ts = b.reduce((s, x) => s + x.sell, 0);
    return ts > 0 ? tb / ts : 1;
  };
  const r1 = ratioOf(first);
  const r2 = ratioOf(second);
  // 同方向且在加强
  if ((r1 > 1 && r2 > r1 * 1.1) || (r1 < 1 && r2 < r1 * 0.9)) return "strengthening";
  if ((r1 > 1 && r2 < r1 * 0.9) || (r1 < 1 && r2 > r1 * 1.1)) return "weakening";
  return "unknown";
}

// ===================== M: Volume Spike Detection (成交量飙升) =====================

/**
 * 检测当前成交量是否飙升.
 * 比较最近一桶 vs 历史平均, ≥2x视为spike.
 * 返回 { spikeRatio, currentVol, avgVol, direction, isSpike }
 */
function _getVolumeSpikeInfo(): {
  spikeRatio: number;
  currentVol: number;
  avgVol: number;
  direction: "buy" | "sell" | "neutral";
  isSpike: boolean;
} {
  if (volBuckets.length < 3) {
    return { spikeRatio: 1, currentVol: 0, avgVol: 0, direction: "neutral", isSpike: false };
  }
  const avgVol = volBuckets.reduce((s, b) => s + b.vol, 0) / volBuckets.length;
  const currentVol = volCurrentBucketVol;
  const spikeRatio = avgVol > 0 ? currentVol / avgVol : 1;
  const isSpike = spikeRatio >= 2.0;
  // spike时方向取最近桶的买卖主导
  let direction: "buy" | "sell" | "neutral" = "neutral";
  if (isSpike && currentBucketBuy + currentBucketSell > 0) {
    const ratio = currentBucketBuy / (currentBucketBuy + currentBucketSell);
    if (ratio >= 0.6) direction = "buy";
    else if (ratio <= 0.4) direction = "sell";
  }
  return { spikeRatio: Math.min(9.99, spikeRatio), currentVol, avgVol, direction, isSpike };
}

// ===================== N: Large Order Tracking (大单追踪) =====================

/**
 * 本回合大单统计.
 * 返回 { buyCount, sellCount, buyVol, sellVol, direction, netVol, recentCount60s }
 */
function _getLargeOrderInfo(): {
  buyCount: number;
  sellCount: number;
  buyVol: number;
  sellVol: number;
  direction: "buy" | "sell" | "neutral";
  netVol: number;
  recentCount60s: number;
} {
  const netVol = largeBuyVol - largeSellVol;
  let direction: "buy" | "sell" | "neutral" = "neutral";
  const total = largeBuyVol + largeSellVol;
  if (total > 0) {
    const ratio = largeBuyVol / total;
    if (ratio >= 0.65) direction = "buy";
    else if (ratio <= 0.35) direction = "sell";
  }
  const cutoff = Date.now() - 60_000;
  const recentCount60s = recentLargeOrders.filter(o => o.t >= cutoff).length;
  return { buyCount: largeBuyCount, sellCount: largeSellCount, buyVol: largeBuyVol, sellVol: largeSellVol, direction, netVol, recentCount60s };
}

// ===================== O: Depth Imbalance (盘口深度失衡) =====================

/**
 * 盘口深度失衡比.
 * >1 = bid(买)深, <1 = ask(卖)深. >1.5或<0.67视为显著失衡.
 * 返回 { ratio, bidTotal, askTotal, direction, fresh }
 */
function _getDepthImbalance(): {
  ratio: number;
  bidTotal: number;
  askTotal: number;
  direction: "buy" | "sell" | "neutral";
  fresh: boolean;
} {
  const fresh = depthLastUpdate > 0 && Date.now() - depthLastUpdate < 5000;
  if (!fresh || depthAskTotal <= 0) {
    return { ratio: 1, bidTotal: 0, askTotal: 0, direction: "neutral", fresh: false };
  }
  const ratio = depthBidTotal / depthAskTotal;
  let direction: "buy" | "sell" | "neutral" = "neutral";
  if (ratio >= 1.5) direction = "buy";       // bid厚 → 买方支撑强
  else if (ratio <= 0.67) direction = "sell"; // ask厚 → 卖压大
  return { ratio: Math.min(9.99, ratio), bidTotal: depthBidTotal, askTotal: depthAskTotal, direction, fresh };
}

// ===================== P: Forced Liquidation (强平级联) =====================

/**
 * 本回合强平统计.
 * 空头被平(买入) vs 多头被平(卖出), 强平方向通常预示价格持续该方向.
 * 返回 { buyVol, sellVol, buyCount, sellCount, direction, intensity }
 */
function _getLiquidationInfo(): {
  buyVol: number;
  sellVol: number;
  buyCount: number;
  sellCount: number;
  direction: "buy" | "sell" | "neutral";
  intensity: "high" | "medium" | "low";
} {
  const total = liqBuyVol + liqSellVol;
  let direction: "buy" | "sell" | "neutral" = "neutral";
  if (total > 0) {
    const ratio = liqBuyVol / total;
    if (ratio >= 0.65) direction = "buy";       // 空头被平多 → 价格可能继续上涨
    else if (ratio <= 0.35) direction = "sell";  // 多头被平多 → 价格可能继续下跌
  }
  let intensity: "high" | "medium" | "low" = "low";
  if (total >= 5) intensity = "high";
  else if (total >= 1) intensity = "medium";
  return { buyVol: liqBuyVol, sellVol: liqSellVol, buyCount: liqBuyCount, sellCount: liqSellCount, direction, intensity };
}

// ===================== Q: Funding Rate (资金费率) =====================

/**
 * 最新资金费率.
 * 正 = 多头付空头(看涨氛围过热), 负 = 空头付多头(看跌氛围过热).
 * 极端费率(>0.01或<-0.01)通常预示反转.
 * 返回 { rate, direction, extreme, freshMs }
 */
function _getFundingRateInfo(): {
  rate: number;
  direction: "long_pay" | "short_pay" | "neutral";
  extreme: boolean;
  freshMs: number;
} {
  const freshMs = fundingRateTs > 0 ? Date.now() - fundingRateTs : Infinity;
  if (freshMs > 600_000 || fundingRateTs === 0) {
    return { rate: 0, direction: "neutral", extreme: false, freshMs };
  }
  let direction: "long_pay" | "short_pay" | "neutral" = "neutral";
  if (fundingRate > 0.0001) direction = "long_pay";
  else if (fundingRate < -0.0001) direction = "short_pay";
  const extreme = Math.abs(fundingRate) >= 0.01;
  return { rate: fundingRate, direction, extreme, freshMs };
}

function _getOpenInterestInfo(): {
  value: number;
  baseline: number;
  changePct: number;
  direction: "long_build" | "short_cover" | "neutral";
  fresh: boolean;
} {
  const fresh = openInterestTs > 0 && Date.now() - openInterestTs < 600_000;
  if (!fresh || openInterest <= 0 || roundStartOpenInterest <= 0) {
    return {
      value: openInterest,
      baseline: roundStartOpenInterest,
      changePct: 0,
      direction: "neutral",
      fresh: false,
    };
  }
  const changePct = (openInterest - roundStartOpenInterest) / roundStartOpenInterest;
  let direction: "long_build" | "short_cover" | "neutral" = "neutral";
  if (Math.abs(changePct) >= 0.003) {
    direction = changePct > 0 ? "long_build" : "short_cover";
  }
  return {
    value: openInterest,
    baseline: roundStartOpenInterest,
    changePct,
    direction,
    fresh,
  };
}
