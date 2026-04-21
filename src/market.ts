import type { BtcTick, MarketInfo, OrderBook, Side } from "./types.js";

const BINANCE_SPOT_ENDPOINTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://data-api.binance.vision"
];
const BINANCE_FUTURES = "https://fapi.binance.com";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

export function currentBucketStart(nowMs = Date.now()) {
  return Math.floor(Math.floor(nowMs / 1000) / 300) * 300;
}

export function marketSlugForBucket(bucketStart: number) {
  return `btc-updown-5m-${bucketStart}`;
}

export function marketUrl(slug: string) {
  return `https://polymarket.com/event/${slug}`;
}

export function extractSlug(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/\/event\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

export async function getBtcTick(): Promise<BtcTick> {
  const errors: string[] = [];
  for (const base of BINANCE_SPOT_ENDPOINTS) {
    try {
      return await getSpotBtcTick(base);
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return await getFuturesBtcTick();
  } catch (error) {
    errors.push(`${BINANCE_FUTURES}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Binance BTC data failed: ${errors.join(" | ")}`);
}

export async function getBtcCloseForBucket(bucketStart: number): Promise<number> {
  const startTime = bucketStart * 1000;
  const endTime = (bucketStart + 300) * 1000 - 1;
  const errors: string[] = [];
  for (const base of BINANCE_SPOT_ENDPOINTS) {
    try {
      return await getCloseFromKlines(`${base}/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=1`, bucketStart);
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return await getCloseFromKlines(`${BINANCE_FUTURES}/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=1`, bucketStart);
  } catch (error) {
    errors.push(`${BINANCE_FUTURES}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Binance settlement data failed: ${errors.join(" | ")}`);
}

async function getSpotBtcTick(base: string): Promise<BtcTick> {
  const [priceRes, klineRes] = await Promise.all([
    fetch(`${base}/api/v3/ticker/price?symbol=BTCUSDT`),
    fetch(`${base}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1`)
  ]);
  if (!priceRes.ok) throw new Error(`price ${priceRes.status}`);
  if (!klineRes.ok) throw new Error(`kline ${klineRes.status}`);
  const priceJson = await priceRes.json() as { price: string };
  const klines = await klineRes.json() as unknown[][];
  const k = klines[0];
  const price = Number(priceJson.price);
  const open = Number(k?.[1] ?? priceJson.price);
  if (!Number.isFinite(price) || !Number.isFinite(open)) throw new Error("invalid spot BTC data");
  return { timestamp: Date.now(), price, open, source: base.replace("https://", "") };
}

async function getFuturesBtcTick(): Promise<BtcTick> {
  const [priceRes, klineRes] = await Promise.all([
    fetch(`${BINANCE_FUTURES}/fapi/v1/ticker/price?symbol=BTCUSDT`),
    fetch(`${BINANCE_FUTURES}/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=1`)
  ]);
  if (!priceRes.ok) throw new Error(`price ${priceRes.status}`);
  if (!klineRes.ok) throw new Error(`kline ${klineRes.status}`);
  const priceJson = await priceRes.json() as { price: string };
  const klines = await klineRes.json() as unknown[][];
  const k = klines[0];
  const price = Number(priceJson.price);
  const open = Number(k?.[1] ?? priceJson.price);
  if (!Number.isFinite(price) || !Number.isFinite(open)) throw new Error("invalid futures BTC data");
  return { timestamp: Date.now(), price, open, source: "fapi.binance.com" };
}

async function getCloseFromKlines(url: string, bucketStart: number) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kline ${res.status}`);
  const klines = await res.json() as unknown[][];
  const close = Number(klines[0]?.[4]);
  if (!Number.isFinite(close)) throw new Error(`No close for ${bucketStart}`);
  return close;
}

export async function discoverMarket(slug: string, bucketStart: number): Promise<MarketInfo> {
  const eventRes = await fetch(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
  if (!eventRes.ok) throw new Error(`Polymarket event not found: ${slug} (${eventRes.status})`);
  const event = await eventRes.json() as any;
  const market = Array.isArray(event.markets) ? event.markets[0] : event;
  const tokenIds = parseJsonArray(market.clobTokenIds ?? market.clob_token_ids);
  const outcomes = parseJsonArray(market.outcomes);
  if (tokenIds.length < 2) throw new Error(`No CLOB token ids for ${slug}`);

  let upIndex = outcomes.findIndex((x) => String(x).toLowerCase().includes("up"));
  let downIndex = outcomes.findIndex((x) => String(x).toLowerCase().includes("down"));
  if (upIndex < 0 || downIndex < 0) {
    upIndex = 0;
    downIndex = 1;
  }

  return {
    slug,
    url: marketUrl(slug),
    bucketStart,
    bucketEnd: bucketStart + 300,
    conditionId: market.conditionId ?? market.condition_id,
    upTokenId: String(tokenIds[upIndex]),
    downTokenId: String(tokenIds[downIndex]),
    title: event.title ?? market.question
  };
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB book failed: ${res.status}`);
  const book = await res.json() as any;
  return normalizeBook(tokenId, book);
}

function normalizeBook(tokenId: string, book: any): OrderBook {
  const bids = normalizeLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(book.asks).sort((a, b) => a.price - b.price);
  return {
    tokenId,
    bids,
    asks,
    minOrderSize: Number(book.min_order_size ?? book.minOrderSize ?? 0),
    tickSize: Number(book.tick_size ?? book.tickSize ?? 0),
    timestamp: book.timestamp
  };
}

function normalizeLevels(levels: any): { price: number; size: number }[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0);
}

export function bookForSide(side: Side, upBook: OrderBook, downBook: OrderBook) {
  return side === "UP" ? upBook : downBook;
}
