import { Config } from "./config";
import { logger } from "./logger";

const PING_INTERVAL_MS = 3_000; // 每3s ping一次 CLOB，面板反馈更及时
const PING_TIMEOUT_MS  = 5_000;
const HISTORY_SIZE     = 20;
const HTTP_FRESH_MS    = 10_000;

type LatencyBucket = {
  samples: number[];
  head: number;           // 循环写入位置
  count: number;          // 当前样本数
  lastMs: number;
  lastAt: number;
};

function makeBucket(): LatencyBucket {
  return { samples: new Array(HISTORY_SIZE).fill(0), head: 0, count: 0, lastMs: 0, lastAt: 0 };
}

const pingSamples: LatencyBucket = makeBucket();
const httpSamples: LatencyBucket = makeBucket();
const cacheSamples: LatencyBucket = makeBucket();

function addSample(bucket: LatencyBucket, ms: number): void {
  if (ms <= 0 || ms > 8_000) return; // 过滤异常值
  bucket.samples[bucket.head] = ms;
  bucket.head = (bucket.head + 1) % HISTORY_SIZE;
  if (bucket.count < HISTORY_SIZE) bucket.count++;
  bucket.lastMs = ms;
  bucket.lastAt = Date.now();
}

function summarize(bucket: LatencyBucket, fallbackP50: number, fallbackP90: number): { p50: number; p90: number; count: number; lastMs: number; lastAt: number } {
  if (bucket.count === 0) {
    return { p50: fallbackP50, p90: fallbackP90, count: 0, lastMs: 0, lastAt: 0 };
  }
  const active = bucket.samples.slice(0, bucket.count);
  const sorted = active.sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90: sorted[Math.floor((sorted.length - 1) * 0.9)],
    count: bucket.count,
    lastMs: bucket.lastMs,
    lastAt: bucket.lastAt,
  };
}

async function doPing(): Promise<void> {
  const t0 = Date.now();
  try {
    // HEAD request: 只测 TCP+TLS+TTFB, 不传输 body
    const r = await fetch(`${Config.CLOB_HOST}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      cache: "no-store",
    });
    // 即便返回 404 也算有效延迟测量
    void r;
    const ms = Date.now() - t0;
    addSample(pingSamples, ms);
    // 只输出到 console, 不写日志文件 (避免每3s一条挤掉交易日志)
    console.log(`CLOB ping: ${ms}ms (netP50=${getP50Ms()}ms netP90=${getP90Ms()}ms)`);
  } catch {
    // 超时或网络中断 — 不记样本, 下次再测
  }
}

let pingTimer: ReturnType<typeof setInterval> | null = null;

export function startLatencyMonitor(): void {
  if (pingTimer) return;
  doPing(); // 立即取第一个样本
  pingTimer = setInterval(doPing, PING_INTERVAL_MS);
}

export function stopLatencyMonitor(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

/** 由交易循环调用: 记录一次真实的订单簿请求延迟 */
export function recordLatency(ms: number, source: "http" | "cache" = "http"): void {
  if (source === "cache") {
    addSample(cacheSamples, ms);
    return;
  }
  addSample(httpSamples, ms);
}

export function getLatencySnapshot(): {
  networkP50: number;
  networkP90: number;
  networkSource: "ping" | "http";
  pingP50: number;
  pingP90: number;
  httpP50: number;
  httpP90: number;
  cacheP50: number;
  cacheP90: number;
  pingCount: number;
  httpCount: number;
  cacheCount: number;
  pingLastMs: number;
  pingLastAt: number;
  httpLastMs: number;
  httpLastAt: number;
  cacheLastMs: number;
  cacheLastAt: number;
} {
  const ping = summarize(pingSamples, 150, 250);
  const http = summarize(httpSamples, 150, 250);
  const cache = summarize(cacheSamples, 0, 0);
  const useFreshHttp = http.count > 0 && http.lastAt > 0 && (Date.now() - http.lastAt) <= HTTP_FRESH_MS;
  const networkSource = useFreshHttp ? http : ping;
  return {
    networkP50: networkSource.p50,
    networkP90: networkSource.p90,
    networkSource: useFreshHttp ? "http" : "ping",
    pingP50: ping.p50,
    pingP90: ping.p90,
    httpP50: http.count > 0 ? http.p50 : 0,
    httpP90: http.count > 0 ? http.p90 : 0,
    cacheP50: cache.count > 0 ? cache.p50 : 0,
    cacheP90: cache.count > 0 ? cache.p90 : 0,
    pingCount: ping.count,
    httpCount: http.count,
    cacheCount: cache.count,
    pingLastMs: ping.lastMs,
    pingLastAt: ping.lastAt,
    httpLastMs: http.lastMs,
    httpLastAt: http.lastAt,
    cacheLastMs: cache.lastMs,
    cacheLastAt: cache.lastAt,
  };
}

/** P50 延迟 (中位数), 无样本时返回保守默认值 */
export function getP50Ms(): number {
  return getLatencySnapshot().networkP50;
}

/** P90 延迟, 无样本时返回保守默认值 */
export function getP90Ms(): number {
  return getLatencySnapshot().networkP90;
}

/**
 * 根据当前 P90 延迟动态生成各项操作参数。
 * 延迟越低 → 参数越激进 (检测更快, 确认等待更短)。
 * 使用 P90 而非 P50 作为基准, 防止偶发尖刺导致误判。
 */
export function getDynamicParams(): {
  dumpBaselineMs:     number; // 砸盘基准快照最低年龄 (ms)
  dumpWindowMs:       number; // 砸盘快照保留窗口 (ms)
  fillCheckMs:        number; // 下单后等待成交确认 (ms)
  watchPollMs:        number; // watching 状态轮询间隔 (ms)
  idlePollMs:         number; // leg1_filled/done 状态轮询间隔 (ms)
  orderbookTimeoutMs: number; // 订单簿请求超时上限 (ms)
  p50: number;
  p90: number;
} {
  const p50 = getP50Ms();
  const p90 = getP90Ms();

  // 以 P90 (不超过500ms) 作为插值变量, 保守但能反映真实网络条件
  const lat = Math.max(20, Math.min(500, p90));

  /**
   * 线性插值: lat=loLat 时返回 loVal, lat=hiLat 时返回 hiVal
   * lat < loLat → 取最激进值 (loVal)
   * lat > hiLat → 取最保守值 (hiVal)
   */
  const lerp = (loLat: number, hiLat: number, loVal: number, hiVal: number): number => {
    if (lat <= loLat) return loVal;
    if (lat >= hiLat) return hiVal;
    return Math.round(loVal + (hiVal - loVal) * ((lat - loLat) / (hiLat - loLat)));
  };

  return {
    // 砸盘基准年龄: 延迟低时可用更新鲜的参考点, 快速响应行情
    dumpBaselineMs:     lerp(30, 300,  150, 1200),
    // 快照缓冲窗口: 延迟低时用更窄窗口, 减少噪音
    dumpWindowMs:       lerp(30, 300,  800, 2500),
    // 成交确认等待: 低延迟回报更快
    fillCheckMs:        lerp(30, 300,  120,  700),
    // watching 轮询间隔: 低延迟下轮询更密
    watchPollMs:        lerp(30, 300,   40,  120),
    // leg1/done 轮询间隔
    idlePollMs:         lerp(30, 300,  150,  500),
    // 订单簿请求超时: 低延迟连接不需要那么长的超时
    orderbookTimeoutMs: lerp(30, 300, 1000, 4000),
    p50,
    p90,
  };
}
