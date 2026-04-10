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
let clWsReconnectDelay = 10_000;          // 指数退避: 10s → 20s → 40s → 最大120s
let clWsConnectCount = 0;                 // 连接次数 (去重日志)

function startPolygonChainlinkWs(): void {
  if (!running) return;
  // 防止重复连接: 先关闭旧实例
  if (clWsInstance) {
    try { clWsInstance.terminate(); } catch {}
    clWsInstance = null;
    clWsConnected = false;
  }
  const wsRpc = Config.CHAINLINK_RPC
    .replace("https://", "wss://")
    .replace("http://", "ws://");
  const wsUrl = wsRpc.startsWith("wss://") ? wsRpc : "wss://polygon.gateway.tenderly.co";
  try {
    const ws = new WebSocket(wsUrl);
    clWsInstance = ws;
    ws.on("open", () => {
      clWsConnected = true;
      clWsReconnectDelay = 10_000; // 成功连接后重置退避
      clWsConnectCount++;
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_subscribe",
        params: ["logs", {
          address: Config.CHAINLINK_BTC_FEED,
          topics: ["0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"],
        }],
      }));
      // 只在首次或每10次重连时打日志, 避免刷屏
      if (clWsConnectCount <= 1 || clWsConnectCount % 10 === 0) {
        logger.info(`Polygon Chainlink WS 已连接 (实时CL更新) #${clWsConnectCount}`);
      }
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
              // 只在价格真正变化时更新时间戳, 避免重连重播旧事件伪装fresh
              if (price !== clLastSeenPrice || chainlinkUpdatedAt <= 0) {
                chainlinkUpdatedAt = Math.floor(wsNow / 1000);
              }
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
      if (running) {
        setTimeout(startPolygonChainlinkWs, clWsReconnectDelay);
        clWsReconnectDelay = Math.min(120_000, clWsReconnectDelay * 2); // 指数退避上限120s
      }
    });
    ws.on("error", () => {
      clWsConnected = false;
      if (clWsInstance) { try { clWsInstance.terminate(); } catch {} }
      clWsInstance = null;
    });
  } catch {
    if (running) {
      setTimeout(startPolygonChainlinkWs, clWsReconnectDelay);
      clWsReconnectDelay = Math.min(120_000, clWsReconnectDelay * 2);
    }
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
    // Q: 每60个周期(~18s)刷新一次资金费率
    if (cycle % 60 === 0) {
      fetchFundingRate().catch(() => {});
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
  startDepthWebSocket();           // O
  startLiquidationWebSocket();     // P
  fetchFundingRate().catch(() => {}); // Q: 立即获取一次
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
  if (depthWsInstance) {
    try { depthWsInstance.terminate(); } catch {}
    depthWsInstance = null;
  }
  if (liqWsInstance) {
    try { liqWsInstance.terminate(); } catch {}
    liqWsInstance = null;
  }
  wsConnected = false;
  clWsConnected = false;
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

// ===================== L: Taker Flow (买卖比) =====================

/**
 * 本回合 Taker 买卖比.
 * >1 = 买方主导(看涨), <1 = 卖方主导(看跌), ~1 = 平衡
 * 返回 { ratio, buyVol, sellVol, trades, direction, confidence }
 */
export function getTakerFlowRatio(): {
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
export function getVolumeSpikeInfo(): {
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
export function getLargeOrderInfo(): {
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
export function getDepthImbalance(): {
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
export function getLiquidationInfo(): {
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
export function getFundingRateInfo(): {
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
