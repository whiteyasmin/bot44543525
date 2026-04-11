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
              chainlinkPrice = price;
              chainlinkUpdatedAt = Math.floor(Date.now() / 1000);
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
      if (cp) chainlinkPrice = cp;
    } else if (clWsConnected && cycle % 5 === 0) {
      const cp = await fetchChainlink();
      if (cp) chainlinkPrice = cp;
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

/** 返回最近 N 秒内 BTC 价格变化百分比 (正=涨, 负=跌) */
export function getRecentMomentum(windowSec = 30): number {
  if (recentPrices.length < 2) return 0;
  const cutoff = Date.now() - windowSec * 1000;
  const old = recentPrices.find(p => p.t >= cutoff);
  if (!old || old.p <= 0) return 0;
  const latest = recentPrices[recentPrices.length - 1];
  return (latest.p - old.p) / old.p;
}
