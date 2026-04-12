import { ClobClient, Side, OrderType, type ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { WebSocket, type RawData } from "ws";
import { Config } from "./config";
import { getP50Ms } from "./latency";
import { logger } from "./logger";

const PAPER_TAKER_FEE = 0.02;
const PAPER_MAKER_FEE = 0.00;   // maker 挂单 0% fee
const ORDERBOOK_CACHE_TTL_MS = 250;
const ORDERBOOK_POLL_MS = 50;
const ORDERBOOK_FAST_POLL_MS = 25;
const ORDERBOOK_FAST_CACHE_TTL_MS = 90;
const ORDERBOOK_UPDATE_WAIT_MS = 1000;
const ORDERBOOK_WS_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const USER_WS_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const WS_PING_MS = 10_000;
const ORDER_FAST_RETRY_MS = 80;
const ORDER_SLOW_RETRY_MS = 180;
const ORDER_UPDATE_WAIT_MS = 900;
const LOCAL_BOOK_MAX_LEVELS = 32;
const LOCAL_BOOK_STALE_MS = 1_500;
const LOCAL_BOOK_FULL_SYNC_MS = 4_000;
const LOCAL_BOOK_SNAPSHOT_MAX_AGE_MS = 1_200;

export interface TraderInitOptions {
  mode?: "live" | "paper";
  paperBalance?: number;
}

interface PaperOrder {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "FAK" | "FOK" | "GTC";
  size: number;
  filled: number;
  avgPrice: number;
  price?: number;
  canceled?: boolean;
}

interface BestPriceSnapshot {
  bid: number | null;
  ask: number | null;
  spread: number;
  askDepth: number;
  bidDepth: number;
  updatedAt: number;
}

interface LocalOrderbook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  updatedAt: number;
  lastFullSyncAt: number;
  source: "ws" | "http";
}

interface OrderbookWaiter {
  minVersion: number;
  resolve: (version: number) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OrderFillSnapshot {
  filled: number;
  avgPrice: number;
  status: string;
  updatedAt: number;
}

interface OrderUpdateWaiter {
  orderId: string;
  minVersion: number;
  resolve: (version: number) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MarketBookLevel {
  price: string;
  size: string;
}

interface MarketSocketMessage {
  event_type?: string;
  asset_id?: string;
  best_bid?: string;
  best_ask?: string;
  best_bid_size?: string;
  best_ask_size?: string;
  spread?: string;
  bids?: MarketBookLevel[];
  asks?: MarketBookLevel[];
  price_changes?: Array<{
    asset_id?: string;
    price?: string;
    size?: string;
    side?: string;
    best_bid?: string;
    best_ask?: string;
  }>;
}

interface UserSocketMessage {
  event_type?: string;
  id?: string;
  status?: string;
  size_matched?: string;
  price?: string;
  associate_trades?: Array<{ price?: string; size?: string; amount?: string }> | null;
  taker_order_id?: string;
  maker_orders?: Array<{ order_id?: string }>;
}

// 自适应参数缓存 (避免每次调用 getP50Ms)
let _adaptiveCacheTs = 0;
let _adaptivePollMs = ORDERBOOK_POLL_MS;
let _adaptiveCacheTtl = ORDERBOOK_CACHE_TTL_MS;
let _adaptiveRetryMs = ORDER_SLOW_RETRY_MS;
const ADAPTIVE_CACHE_DURATION = 2000; // 2s刷新一次

function refreshAdaptiveParams(): void {
  if (Date.now() - _adaptiveCacheTs < ADAPTIVE_CACHE_DURATION) return;
  const p50 = getP50Ms();
  _adaptivePollMs = p50 <= 25 ? ORDERBOOK_FAST_POLL_MS : ORDERBOOK_POLL_MS;
  _adaptiveCacheTtl = p50 <= 25 ? ORDERBOOK_FAST_CACHE_TTL_MS : ORDERBOOK_CACHE_TTL_MS;
  _adaptiveRetryMs = p50 <= 25 ? ORDER_FAST_RETRY_MS : ORDER_SLOW_RETRY_MS;
  _adaptiveCacheTs = Date.now();
}

function getAdaptiveOrderbookPollMs(): number {
  refreshAdaptiveParams();
  return _adaptivePollMs;
}

function getAdaptiveCacheTtlMs(): number {
  refreshAdaptiveParams();
  return _adaptiveCacheTtl;
}

function getAdaptiveOrderRetryMs(): number {
  refreshAdaptiveParams();
  return _adaptiveRetryMs;
}

function parseNum(value: unknown): number {
  const num = typeof value === "number" ? value : parseFloat(String(value ?? "0"));
  return Number.isFinite(num) ? num : 0;
}

function summarizeBookSide(levels: MarketBookLevel[] | undefined, side: "bid" | "ask"): { price: number | null; depth: number } {
  if (!levels || levels.length === 0) return { price: null, depth: 0 };
  const sorted = levels
    .map((level) => ({ price: parseNum(level.price), size: parseNum(level.size) }))
    .filter((level) => level.price > 0 && level.size >= 0)
    .sort((left, right) => side === "ask" ? left.price - right.price : right.price - left.price);
  if (sorted.length === 0) return { price: null, depth: 0 };
  let depth = 0;
  for (let index = 0; index < Math.min(3, sorted.length); index += 1) {
    depth += sorted[index].size;
  }
  return { price: sorted[0].price, depth };
}

function buildBookMap(levels: MarketBookLevel[] | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (!levels) return map;
  for (const level of levels) {
    const price = parseNum(level.price);
    const size = parseNum(level.size);
    if (price > 0 && size > 0) map.set(price, size);
  }
  return map;
}

export interface TraderDiagnostics {
  marketWsConnected: boolean;
  userWsConnected: boolean;
  marketWsAgeMs: number;
  userWsAgeMs: number;
  orderbookSource: "ws" | "http" | "idle";
  localBookReady: boolean;
  trackedTokenCount: number;
  localBookTokenCount: number;
  fallbackActive: boolean;
  marketWsDisconnects: number;
  userWsDisconnects: number;
  marketWsReconnects: number;
  userWsReconnects: number;
  fallbackTransitions: number;
  lastFallbackAt: number;
  localBookMaxDepth: number;
  localBookStaleCount: number;
  localBookCrossedCount: number;
}

function trimBookSide(side: Map<number, number>, direction: "bid" | "ask"): void {
  if (side.size <= LOCAL_BOOK_MAX_LEVELS) return;

  const prices = Array.from(side.keys()).sort((left, right) => direction === "bid" ? right - left : left - right);
  for (const price of prices.slice(LOCAL_BOOK_MAX_LEVELS)) {
    side.delete(price);
  }
}

function getSortedBookLevels(side: Map<number, number>, direction: "bid" | "ask"): Array<{ price: number; size: number }> {
  return Array.from(side.entries())
    .map(([price, size]) => ({ price, size }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((left, right) => direction === "ask" ? left.price - right.price : right.price - left.price);
}

function summarizeBookMap(side: Map<number, number>, direction: "bid" | "ask"): { price: number | null; depth: number } {
  const sorted = getSortedBookLevels(side, direction);
  if (sorted.length === 0) return { price: null, depth: 0 };
  let depth = 0;
  for (let index = 0; index < Math.min(3, sorted.length); index += 1) {
    depth += sorted[index].size;
  }
  return { price: sorted[0].price, depth };
}

export class Trader {
  private client!: ClobClient;
  private apiCreds: ApiKeyCreds | null = null;
  private mode: "live" | "paper" = "live";
  private paperBalance = 0;
  private paperOrders = new Map<string, PaperOrder>();
  private paperOrderSeq = 0;
  private orderbookCache = new Map<string, BestPriceSnapshot>();
  private localOrderbooks = new Map<string, LocalOrderbook>();
  private trackedTokens = new Set<string>();
  private trackedMarkets = new Set<string>();
  private orderbookLoopActive = false;
  private orderbookVersion = 0;
  private orderbookWaiters: OrderbookWaiter[] = [];
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private marketWsConnected = false;
  private userWsConnected = false;
  private marketWsPing: ReturnType<typeof setInterval> | null = null;
  private userWsPing: ReturnType<typeof setInterval> | null = null;
  private marketWsLastMessageAt = 0;
  private userWsLastMessageAt = 0;
  private marketWsDisconnects = 0;
  private userWsDisconnects = 0;
  private marketWsReconnects = 0;
  private userWsReconnects = 0;
  private fallbackTransitions = 0;
  private lastFallbackAt = 0;
  private fallbackActiveState = false;
  private orderFillCache = new Map<string, OrderFillSnapshot>();
  private orderUpdateVersions = new Map<string, number>();
  private orderUpdateWaiters: OrderUpdateWaiter[] = [];

  async init(options: TraderInitOptions = {}): Promise<void> {
    this.mode = options.mode || "live";
    const wallet = Config.PRIVATE_KEY ? new Wallet(Config.PRIVATE_KEY) : Wallet.createRandom();

    if (this.mode === "paper") {
      this.client = new ClobClient(Config.CLOB_HOST, Config.CHAIN_ID, wallet);
      this.apiCreds = null;
      this.paperBalance = options.paperBalance && options.paperBalance > 0 ? options.paperBalance : 100;
      this.paperOrders.clear();
      this.paperOrderSeq = 0;
      this.startOrderbookLoop();
      logger.info(`交易客户端连接成功 (paper mode, initialBalance=$${this.paperBalance.toFixed(2)})`);
      return;
    }

    const tempClient = new ClobClient(Config.CLOB_HOST, Config.CHAIN_ID, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    this.apiCreds = creds;
    let sigType = Config.SIGNATURE_TYPE;
    if (Config.FUNDER_ADDRESS && Config.FUNDER_ADDRESS.toLowerCase() !== wallet.address.toLowerCase() && sigType === 0) {
      sigType = 1;
      logger.info(`Auto-detected SIGNATURE_TYPE=1 (POLY_PROXY) for funder ${Config.FUNDER_ADDRESS.slice(0, 10)}...`);
    }
    this.client = new ClobClient(
      Config.CLOB_HOST,
      Config.CHAIN_ID,
      wallet,
      creds,
      sigType,
      Config.FUNDER_ADDRESS,
    );
    this.startOrderbookLoop();
    this.startMarketSocket();
    this.startUserSocket();
    logger.info(`交易客户端连接成功 (sigType=${sigType}, funder=${Config.FUNDER_ADDRESS.slice(0, 10)}...)`);
  }

  isPaperMode(): boolean {
    return this.mode === "paper";
  }

  private nextPaperOrderId(prefix: string): string {
    this.paperOrderSeq += 1;
    return `paper-${prefix}-${Date.now()}-${this.paperOrderSeq}`;
  }

  setTrackedTokens(tokenIds: string[]): void {
    const nextTokens = Array.from(new Set(tokenIds.filter((tokenId) => tokenId && tokenId.length > 0)));
    const previousTokens = new Set(this.trackedTokens);
    const nextSet = new Set(nextTokens);
    const hasNewToken = nextTokens.some((tokenId) => !this.trackedTokens.has(tokenId));
    this.trackedTokens = nextSet;
    this.syncMarketSubscriptions(previousTokens, nextSet);
    if (hasNewToken) {
      void this.warmTrackedTokens(nextTokens);
    }
  }

  setTrackedMarkets(marketIds: string[]): void {
    const nextIds = Array.from(new Set(marketIds.filter((marketId) => marketId && marketId.length > 0)));
    const previousIds = new Set(this.trackedMarkets);
    const nextSet = new Set(nextIds);
    this.trackedMarkets = nextSet;
    this.syncUserSubscriptions(previousIds, nextSet);
  }

  stopOrderbookLoop(): void {
    this.orderbookLoopActive = false;
    this.trackedTokens.clear();
    this.trackedMarkets.clear();
    this.stopMarketSocket();
    this.stopUserSocket();
    const version = this.orderbookVersion + 1;
    this.orderbookVersion = version;
    const waiters = this.orderbookWaiters;
    this.orderbookWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(version);
    }
    const orderWaiters = this.orderUpdateWaiters;
    this.orderUpdateWaiters = [];
    for (const waiter of orderWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.getOrderUpdateVersion(waiter.orderId) + 1);
    }
  }

  private startOrderbookLoop(): void {
    if (this.orderbookLoopActive) return;
    this.orderbookLoopActive = true;
    void this.orderbookLoop();
  }

  private async orderbookLoop(): Promise<void> {
    while (this.orderbookLoopActive) {
      const tokens = Array.from(this.trackedTokens);
      let updated = false;
      const wsFresh = this.marketWsConnected && Date.now() - this.marketWsLastMessageAt < 2_000;
      const refreshTargets = !wsFresh
        ? tokens
        : tokens.filter((tokenId) => this.needsLocalBookRefresh(tokenId));
      if (refreshTargets.length > 0) {
        await Promise.allSettled(refreshTargets.map(async (tokenId) => {
          const snapshot = await this.fetchBestPrices(tokenId);
          this.orderbookCache.set(tokenId, { ...snapshot, updatedAt: Date.now() });
          updated = true;
        }));
      }
      if (updated) {
        this.notifyOrderbookUpdate();
      }
      const intervalMs = wsFresh ? Math.max(200, getAdaptiveOrderbookPollMs() * 4) : Math.max(500, getAdaptiveOrderbookPollMs());
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private startMarketSocket(): void {
    if (this.mode !== "live" || this.marketWs || !this.orderbookLoopActive) return;
    try {
      const ws = new WebSocket(ORDERBOOK_WS_ENDPOINT);
      this.marketWs = ws;
      ws.on("open", () => {
        if (this.marketWsLastMessageAt > 0 || this.marketWsDisconnects > 0) this.marketWsReconnects += 1;
        this.marketWsConnected = true;
        this.marketWsLastMessageAt = Date.now();
        this.sendMarketSubscription(true);
        this.marketWsPing = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, WS_PING_MS);
        logger.info("Polymarket market WS 已连接");
      });
      ws.on("message", (data: RawData) => {
        this.marketWsLastMessageAt = Date.now();
        const raw = data.toString();
        if (raw === "PONG") return;
        try {
          const payload = JSON.parse(raw);
          const messages = Array.isArray(payload) ? payload : [payload];
          for (const message of messages) {
            this.handleMarketSocketMessage(message as MarketSocketMessage);
          }
        } catch {}
      });
      ws.on("close", () => {
        this.marketWsDisconnects += 1;
        this.marketWsConnected = false;
        this.marketWs = null;
        if (this.marketWsPing) {
          clearInterval(this.marketWsPing);
          this.marketWsPing = null;
        }
        if (this.mode === "live" && this.orderbookLoopActive) {
          setTimeout(() => this.startMarketSocket(), 1500);
        }
      });
      ws.on("error", () => {
        this.marketWsConnected = false;
        if (this.marketWs) {
          try { this.marketWs.terminate(); } catch {}
        }
      });
    } catch {
      if (this.mode === "live" && this.orderbookLoopActive) {
        setTimeout(() => this.startMarketSocket(), 3000);
      }
    }
  }

  private stopMarketSocket(): void {
    this.marketWsConnected = false;
    this.marketWsLastMessageAt = 0;
    if (this.marketWsPing) {
      clearInterval(this.marketWsPing);
      this.marketWsPing = null;
    }
    if (this.marketWs) {
      try { this.marketWs.terminate(); } catch {}
      this.marketWs = null;
    }
  }

  private startUserSocket(): void {
    if (this.mode !== "live" || this.userWs || !this.apiCreds || !this.orderbookLoopActive) return;
    try {
      const ws = new WebSocket(USER_WS_ENDPOINT);
      this.userWs = ws;
      ws.on("open", () => {
        if (this.userWsLastMessageAt > 0 || this.userWsDisconnects > 0) this.userWsReconnects += 1;
        this.userWsConnected = true;
        this.userWsLastMessageAt = Date.now();
        this.sendUserSubscription(true);
        this.userWsPing = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, WS_PING_MS);
        logger.info("Polymarket user WS 已连接");
      });
      ws.on("message", (data: RawData) => {
        this.userWsLastMessageAt = Date.now();
        const raw = data.toString();
        if (raw === "PONG") return;
        try {
          const payload = JSON.parse(raw);
          const messages = Array.isArray(payload) ? payload : [payload];
          for (const message of messages) {
            this.handleUserSocketMessage(message as UserSocketMessage);
          }
        } catch {}
      });
      ws.on("close", () => {
        this.userWsDisconnects += 1;
        this.userWsConnected = false;
        this.userWs = null;
        if (this.userWsPing) {
          clearInterval(this.userWsPing);
          this.userWsPing = null;
        }
        if (this.mode === "live" && this.orderbookLoopActive && this.apiCreds) {
          setTimeout(() => this.startUserSocket(), 1500);
        }
      });
      ws.on("error", () => {
        this.userWsConnected = false;
        if (this.userWs) {
          try { this.userWs.terminate(); } catch {}
        }
      });
    } catch {
      if (this.mode === "live" && this.orderbookLoopActive && this.apiCreds) {
        setTimeout(() => this.startUserSocket(), 3000);
      }
    }
  }

  private stopUserSocket(): void {
    this.userWsConnected = false;
    this.userWsLastMessageAt = 0;
    if (this.userWsPing) {
      clearInterval(this.userWsPing);
      this.userWsPing = null;
    }
    if (this.userWs) {
      try { this.userWs.terminate(); } catch {}
      this.userWs = null;
    }
  }

  private syncMarketSubscriptions(previous: Set<string>, next: Set<string>): void {
    if (!this.marketWsConnected || !this.marketWs || this.marketWs.readyState !== WebSocket.OPEN) return;
    const added = Array.from(next).filter((tokenId) => !previous.has(tokenId));
    const removed = Array.from(previous).filter((tokenId) => !next.has(tokenId));
    if (added.length > 0) {
      this.marketWs.send(JSON.stringify({
        assets_ids: added,
        operation: "subscribe",
        custom_feature_enabled: true,
      }));
    }
    if (removed.length > 0) {
      this.marketWs.send(JSON.stringify({
        assets_ids: removed,
        operation: "unsubscribe",
      }));
    }
  }

  private syncUserSubscriptions(previous: Set<string>, next: Set<string>): void {
    if (!this.userWsConnected || !this.userWs || this.userWs.readyState !== WebSocket.OPEN) return;
    const added = Array.from(next).filter((marketId) => !previous.has(marketId));
    const removed = Array.from(previous).filter((marketId) => !next.has(marketId));
    if (added.length > 0) {
      this.userWs.send(JSON.stringify({ markets: added, operation: "subscribe" }));
    }
    if (removed.length > 0) {
      this.userWs.send(JSON.stringify({ markets: removed, operation: "unsubscribe" }));
    }
  }

  private sendMarketSubscription(initial = false): void {
    if (!this.marketWs || this.marketWs.readyState !== WebSocket.OPEN) return;
    const assets = Array.from(this.trackedTokens);
    this.marketWs.send(JSON.stringify(initial
      ? { assets_ids: assets, type: "market", custom_feature_enabled: true }
      : { assets_ids: assets, operation: "subscribe", custom_feature_enabled: true }));
  }

  private sendUserSubscription(initial = false): void {
    if (!this.userWs || this.userWs.readyState !== WebSocket.OPEN || !this.apiCreds) return;
    const markets = Array.from(this.trackedMarkets);
    this.userWs.send(JSON.stringify(initial
      ? {
        auth: {
          apiKey: this.apiCreds.key,
          secret: this.apiCreds.secret,
          passphrase: this.apiCreds.passphrase,
        },
        markets,
        type: "user",
      }
      : { markets, operation: "subscribe" }));
  }

  private handleMarketSocketMessage(message: MarketSocketMessage): void {
    const tokenId = message.asset_id;
    if (message.event_type === "book" && tokenId) {
      const now = Date.now();
      const bidSide = summarizeBookSide(message.bids, "bid");
      const askSide = summarizeBookSide(message.asks, "ask");
      this.localOrderbooks.set(tokenId, {
        bids: buildBookMap(message.bids),
        asks: buildBookMap(message.asks),
        updatedAt: now,
        lastFullSyncAt: now,
        source: "ws",
      });
      const spread = askSide.price != null && bidSide.price != null ? askSide.price - bidSide.price : 1;
      this.orderbookCache.set(tokenId, {
        bid: bidSide.price,
        ask: askSide.price,
        spread,
        askDepth: askSide.depth,
        bidDepth: bidSide.depth,
        updatedAt: Date.now(),
      });
      this.notifyOrderbookUpdate();
      return;
    }

    if (message.event_type === "price_change" && message.price_changes?.length) {
      let updated = false;
      for (const change of message.price_changes) {
        const changeTokenId = change.asset_id;
        if (!changeTokenId) continue;
        const book = this.ensureLocalOrderbook(changeTokenId);
        const side = (change.side || "").toUpperCase() === "BUY" ? book.bids : book.asks;
        const price = parseNum(change.price);
        const size = parseNum(change.size);
        if (price <= 0) continue;
        if (size <= 0) side.delete(price);
        else side.set(price, size);
        this.reconcileKnownBestLevels(book, parseNum(change.best_bid), parseNum(change.best_ask));
        trimBookSide(book.bids, "bid");
        trimBookSide(book.asks, "ask");
        book.updatedAt = Date.now();
        book.source = "ws";
        const snapshot = this.snapshotFromLocalOrderbook(changeTokenId);
        if (!snapshot) continue;
        const bestBid = parseNum(change.best_bid);
        const bestAsk = parseNum(change.best_ask);
        this.orderbookCache.set(changeTokenId, {
          ...snapshot,
          bid: bestBid > 0 ? bestBid : snapshot.bid,
          ask: bestAsk > 0 ? bestAsk : snapshot.ask,
          spread: bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : snapshot.spread,
          updatedAt: Date.now(),
        });
        updated = true;
      }
      if (updated) this.notifyOrderbookUpdate();
      return;
    }

    if (message.event_type === "best_bid_ask" && tokenId) {
      const cached = this.orderbookCache.get(tokenId);
      const bid = parseNum(message.best_bid);
      const ask = parseNum(message.best_ask);
      const nextBid = bid > 0 ? bid : null;
      const nextAsk = ask > 0 ? ask : null;
      const bestBidSize = parseNum(message.best_bid_size);
      const bestAskSize = parseNum(message.best_ask_size);
      const book = this.ensureLocalOrderbook(tokenId);
      this.reconcileTopOfBook(book, bid, bestBidSize, ask, bestAskSize);
      book.updatedAt = Date.now();
      book.source = "ws";
      const snapshot = this.snapshotFromLocalOrderbook(tokenId);
      const spread = parseNum(message.spread) || (nextAsk != null && nextBid != null ? nextAsk - nextBid : cached?.spread || 1);
      this.orderbookCache.set(tokenId, {
        bid: nextBid ?? snapshot?.bid ?? cached?.bid ?? null,
        ask: nextAsk ?? snapshot?.ask ?? cached?.ask ?? null,
        spread,
        askDepth: bestAskSize || snapshot?.askDepth || cached?.askDepth || 0,
        bidDepth: bestBidSize || snapshot?.bidDepth || cached?.bidDepth || 0,
        updatedAt: Date.now(),
      });
      this.notifyOrderbookUpdate();
    }
  }

  private ensureLocalOrderbook(tokenId: string): LocalOrderbook {
    const existing = this.localOrderbooks.get(tokenId);
    if (existing) return existing;
    const created: LocalOrderbook = {
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      updatedAt: 0,
      lastFullSyncAt: 0,
      source: "http",
    };
    this.localOrderbooks.set(tokenId, created);
    return created;
  }

  private reconcileKnownBestLevels(book: LocalOrderbook, bestBid: number, bestAsk: number): void {
    if (bestBid > 0) {
      for (const price of Array.from(book.bids.keys())) {
        if (price > bestBid) book.bids.delete(price);
      }
      for (const price of Array.from(book.asks.keys())) {
        if (price <= bestBid) book.asks.delete(price);
      }
    }
    if (bestAsk > 0) {
      for (const price of Array.from(book.asks.keys())) {
        if (price < bestAsk) book.asks.delete(price);
      }
      for (const price of Array.from(book.bids.keys())) {
        if (price >= bestAsk) book.bids.delete(price);
      }
    }
  }

  private reconcileTopOfBook(book: LocalOrderbook, bestBid: number, bestBidSize: number, bestAsk: number, bestAskSize: number): void {
    this.reconcileKnownBestLevels(book, bestBid, bestAsk);
    if (bestBid > 0 && bestBidSize > 0) {
      book.bids.set(bestBid, bestBidSize);
    }
    if (bestAsk > 0 && bestAskSize > 0) {
      book.asks.set(bestAsk, bestAskSize);
    }
    trimBookSide(book.bids, "bid");
    trimBookSide(book.asks, "ask");
  }

  private isLocalBookCrossed(book: LocalOrderbook): boolean {
    const bestBid = summarizeBookMap(book.bids, "bid").price;
    const bestAsk = summarizeBookMap(book.asks, "ask").price;
    return bestBid != null && bestAsk != null && bestBid >= bestAsk;
  }

  private needsLocalBookRefresh(tokenId: string): boolean {
    const book = this.localOrderbooks.get(tokenId);
    if (!book) return true;
    const now = Date.now();
    if (now - book.updatedAt > LOCAL_BOOK_STALE_MS) return true;
    if (now - book.lastFullSyncAt > LOCAL_BOOK_FULL_SYNC_MS) return true;
    if (this.isLocalBookCrossed(book)) return true;
    return this.snapshotFromLocalOrderbook(tokenId) == null;
  }

  private getTrackedLocalBookIssueCounts(): { staleCount: number; crossedCount: number } {
    const now = Date.now();
    let staleCount = 0;
    let crossedCount = 0;
    for (const tokenId of this.trackedTokens) {
      const book = this.localOrderbooks.get(tokenId);
      if (!book || now - book.updatedAt > LOCAL_BOOK_STALE_MS) {
        staleCount += 1;
        continue;
      }
      if (this.isLocalBookCrossed(book)) crossedCount += 1;
    }
    return { staleCount, crossedCount };
  }

  private snapshotFromLocalOrderbook(tokenId: string): Omit<BestPriceSnapshot, "updatedAt"> | null {
    const book = this.localOrderbooks.get(tokenId);
    if (!book) return null;
    const bids = summarizeBookMap(book.bids, "bid");
    const asks = summarizeBookMap(book.asks, "ask");
    if (bids.price != null && asks.price != null && bids.price >= asks.price) {
      return null;
    }
    return {
      bid: bids.price,
      ask: asks.price,
      spread: asks.price != null && bids.price != null ? asks.price - bids.price : 1,
      askDepth: asks.depth,
      bidDepth: bids.depth,
    };
  }

  private handleUserSocketMessage(message: UserSocketMessage): void {
    if (message.event_type === "order" && message.id) {
      const filled = parseNum(message.size_matched);
      let avgPrice = parseNum(message.price);
      const trades = message.associate_trades || [];
      if (trades.length > 0) {
        let totalQty = 0;
        let totalVal = 0;
        for (const trade of trades) {
          const qty = parseNum(trade.size ?? trade.amount);
          const price = parseNum(trade.price);
          if (qty > 0 && price > 0) {
            totalQty += qty;
            totalVal += qty * price;
          }
        }
        if (totalQty > 0) avgPrice = totalVal / totalQty;
      }
      this.upsertOrderFillCache(message.id, filled, avgPrice, message.status || "UPDATE");
      return;
    }

    if (message.event_type === "trade") {
      if (message.taker_order_id) this.bumpOrderUpdateSignal(message.taker_order_id);
      for (const makerOrder of message.maker_orders || []) {
        if (makerOrder.order_id) this.bumpOrderUpdateSignal(makerOrder.order_id);
      }
    }
  }

  private upsertOrderFillCache(orderId: string, filled: number, avgPrice: number, status: string): void {
    const existing = this.orderFillCache.get(orderId);
    const nextFilled = Math.max(existing?.filled || 0, filled);
    const nextPrice = avgPrice > 0 ? avgPrice : existing?.avgPrice || 0;
    this.orderFillCache.set(orderId, {
      filled: nextFilled,
      avgPrice: nextPrice,
      status,
      updatedAt: Date.now(),
    });
    this.bumpOrderUpdateSignal(orderId);
  }

  private getOrderUpdateVersion(orderId: string): number {
    return this.orderUpdateVersions.get(orderId) || 0;
  }

  private bumpOrderUpdateSignal(orderId: string): void {
    const nextVersion = this.getOrderUpdateVersion(orderId) + 1;
    this.orderUpdateVersions.set(orderId, nextVersion);
    const remaining: OrderUpdateWaiter[] = [];
    for (const waiter of this.orderUpdateWaiters) {
      if (waiter.orderId === orderId && nextVersion > waiter.minVersion) {
        clearTimeout(waiter.timer);
        waiter.resolve(nextVersion);
      } else {
        remaining.push(waiter);
      }
    }
    this.orderUpdateWaiters = remaining;
  }

  private async waitForOrderUpdate(orderId: string, minVersion: number, timeoutMs = ORDER_UPDATE_WAIT_MS): Promise<number> {
    const version = this.getOrderUpdateVersion(orderId);
    if (version > minVersion) return version;
    return new Promise<number>((resolve) => {
      const waiter: OrderUpdateWaiter = {
        orderId,
        minVersion,
        resolve: (nextVersion) => resolve(nextVersion),
        timer: setTimeout(() => {
          this.orderUpdateWaiters = this.orderUpdateWaiters.filter((candidate) => candidate !== waiter);
          resolve(this.getOrderUpdateVersion(orderId));
        }, Math.max(1, timeoutMs)),
      };
      this.orderUpdateWaiters.push(waiter);
    });
  }

  private getCachedOrderFill(orderId: string): { filled: number; avgPrice: number } | null {
    const cached = this.orderFillCache.get(orderId);
    if (!cached) return null;
    return { filled: cached.filled, avgPrice: cached.avgPrice };
  }

  private async fetchOrderFillDetailsOnce(orderId: string): Promise<{ filled: number; avgPrice: number }> {
    const o: any = await this.client.getOrder(orderId);
    const sizeMatched = parseNum(o.size_matched);
    if (sizeMatched <= 0) {
      this.upsertOrderFillCache(orderId, 0, 0, o.status || "OPEN");
      return { filled: 0, avgPrice: 0 };
    }
    const trades: any[] = o.associate_trades || o.trades || [];
    if (trades.length > 0) {
      let totalQty = 0;
      let totalVal = 0;
      for (const trade of trades) {
        const qty = parseNum(trade.size || trade.amount);
        const px = parseNum(trade.price);
        if (qty > 0 && px > 0) {
          totalQty += qty;
          totalVal += qty * px;
        }
      }
      if (totalQty > 0) {
        const filled = Math.min(sizeMatched, totalQty);
        const avgPrice = totalVal / totalQty;
        this.upsertOrderFillCache(orderId, filled, avgPrice, o.status || "MATCHED");
        return { filled, avgPrice };
      }
    }
    const avgPrice = parseNum(o.price);
    this.upsertOrderFillCache(orderId, sizeMatched, avgPrice, o.status || "MATCHED");
    return { filled: sizeMatched, avgPrice };
  }

  private async warmTrackedTokens(tokenIds: string[]): Promise<void> {
    if (tokenIds.length === 0) return;
    let updated = false;
    await Promise.allSettled(tokenIds.map(async (tokenId) => {
      const snapshot = await this.fetchBestPrices(tokenId);
      this.orderbookCache.set(tokenId, { ...snapshot, updatedAt: Date.now() });
      updated = true;
    }));
    if (updated) {
      this.notifyOrderbookUpdate();
    }
  }

  private notifyOrderbookUpdate(): void {
    this.orderbookVersion += 1;
    const version = this.orderbookVersion;
    if (this.orderbookWaiters.length === 0) return;
    let writeIdx = 0;
    for (let i = 0; i < this.orderbookWaiters.length; i++) {
      const waiter = this.orderbookWaiters[i];
      if (version > waiter.minVersion) {
        clearTimeout(waiter.timer);
        waiter.resolve(version);
      } else {
        this.orderbookWaiters[writeIdx++] = waiter;
      }
    }
    this.orderbookWaiters.length = writeIdx;
  }

  getOrderbookVersion(): number {
    return this.orderbookVersion;
  }

  async waitForOrderbookUpdate(minVersion: number, timeoutMs = ORDERBOOK_UPDATE_WAIT_MS): Promise<number> {
    if (this.orderbookVersion > minVersion) return this.orderbookVersion;
    return new Promise<number>((resolve) => {
      const waiter: OrderbookWaiter = {
        minVersion,
        resolve: (version) => resolve(version),
        timer: setTimeout(() => {
          this.orderbookWaiters = this.orderbookWaiters.filter((candidate) => candidate !== waiter);
          resolve(this.orderbookVersion);
        }, Math.max(1, timeoutMs)),
      };
      this.orderbookWaiters.push(waiter);
    });
  }

  peekBestPrices(tokenId: string, maxAgeMs = getAdaptiveCacheTtlMs()): {
    bid: number | null;
    ask: number | null;
    spread: number;
    askDepth: number;
    bidDepth: number;
  } | null {
    const cached = this.orderbookCache.get(tokenId);
    if (cached && Date.now() - cached.updatedAt <= maxAgeMs) {
      return {
        bid: cached.bid,
        ask: cached.ask,
        spread: cached.spread,
        askDepth: cached.askDepth,
        bidDepth: cached.bidDepth,
      };
    }
    const localSnapshot = this.snapshotFromLocalOrderbook(tokenId);
    const book = this.localOrderbooks.get(tokenId);
    if (localSnapshot && book && Date.now() - book.updatedAt <= Math.max(maxAgeMs, LOCAL_BOOK_SNAPSHOT_MAX_AGE_MS)) {
      this.orderbookCache.set(tokenId, { ...localSnapshot, updatedAt: book.updatedAt });
      return localSnapshot;
    }
    return null;
  }

  private async fetchBestPrices(tokenId: string): Promise<Omit<BestPriceSnapshot, "updatedAt">> {
    try {
      const now = Date.now();
      const book = await this.client.getOrderBook(tokenId);
      const bestBid = book.bids?.length ? Math.max(...book.bids.map(b => parseFloat(b.price))) : null;
      const bestAsk = book.asks?.length ? Math.min(...book.asks.map(a => parseFloat(a.price))) : null;
      const spread = (bestAsk != null && bestBid != null) ? bestAsk - bestBid : 1;
      this.localOrderbooks.set(tokenId, {
        bids: buildBookMap(book.bids as MarketBookLevel[] | undefined),
        asks: buildBookMap(book.asks as MarketBookLevel[] | undefined),
        updatedAt: now,
        lastFullSyncAt: now,
        source: "http",
      });
      let askDepth = 0;
      if (book.asks) {
        const sorted = book.asks.slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          askDepth += parseFloat(sorted[i].size || "0");
        }
      }
      let bidDepth = 0;
      if (book.bids) {
        const sorted = book.bids.slice().sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          bidDepth += parseFloat(sorted[i].size || "0");
        }
      }
      return { bid: bestBid, ask: bestAsk, spread, askDepth, bidDepth };
    } catch (e: any) {
      logger.error(`获取盘口失败: ${e.message}`);
      return { bid: null, ask: null, spread: 1, askDepth: 0, bidDepth: 0 };
    }
  }

  getDiagnostics(): TraderDiagnostics {
    const now = Date.now();
    const marketWsAgeMs = this.marketWsLastMessageAt > 0 ? now - this.marketWsLastMessageAt : 0;
    const userWsAgeMs = this.userWsLastMessageAt > 0 ? now - this.userWsLastMessageAt : 0;
    const { staleCount, crossedCount } = this.getTrackedLocalBookIssueCounts();
    const fallbackActive = this.mode === "live" && (!this.marketWsConnected || marketWsAgeMs >= 2_000);
    if (fallbackActive !== this.fallbackActiveState) {
      this.fallbackActiveState = fallbackActive;
      if (fallbackActive) {
        this.fallbackTransitions += 1;
        this.lastFallbackAt = now;
      }
    }
    return {
      marketWsConnected: this.marketWsConnected,
      userWsConnected: this.userWsConnected,
      marketWsAgeMs,
      userWsAgeMs,
      orderbookSource: this.trackedTokens.size === 0 ? "idle" : fallbackActive ? "http" : "ws",
      localBookReady: Array.from(this.trackedTokens).every((tokenId) => this.localOrderbooks.has(tokenId)),
      trackedTokenCount: this.trackedTokens.size,
      localBookTokenCount: this.localOrderbooks.size,
      fallbackActive,
      marketWsDisconnects: this.marketWsDisconnects,
      userWsDisconnects: this.userWsDisconnects,
      marketWsReconnects: this.marketWsReconnects,
      userWsReconnects: this.userWsReconnects,
      fallbackTransitions: this.fallbackTransitions,
      lastFallbackAt: this.lastFallbackAt,
      localBookMaxDepth: LOCAL_BOOK_MAX_LEVELS,
      localBookStaleCount: staleCount,
      localBookCrossedCount: crossedCount,
    };
  }
  private async fillPaperGtcOrder(orderId: string): Promise<PaperOrder | null> {
    const order = this.paperOrders.get(orderId);
    if (!order || order.canceled || order.orderType !== "GTC") return order || null;
    if (order.filled >= order.size) return order;
    const book = await this.getBestPrices(order.tokenId);

    if (order.side === "SELL") {
      if (book.bid == null || book.bidDepth <= 0) return order;
      if (order.price != null && book.bid + 1e-9 < order.price) return order;
      const fillable = Math.min(order.size - order.filled, book.bidDepth);
      if (fillable <= 0) return order;
      const fillPrice = Math.max(order.price || book.bid, book.bid);
      const prevFilled = order.filled;
      order.avgPrice = prevFilled > 0
        ? (prevFilled * order.avgPrice + fillable * fillPrice) / (prevFilled + fillable)
        : fillPrice;
      order.filled += fillable;
      this.paperBalance += fillable * fillPrice * (1 - PAPER_MAKER_FEE); // GTC 挂单成交 = maker 费率
    } else if (order.side === "BUY") {
      if (book.ask == null || book.askDepth <= 0) return order;
      // GTC buy 成交条件: ask ≤ 挂单价
      if (order.price != null && book.ask - 1e-9 > order.price) return order;
      const fillable = Math.min(order.size - order.filled, book.askDepth);
      if (fillable <= 0) return order;
      const fillPrice = Math.min(order.price || book.ask, book.ask);
      const prevFilled = order.filled;
      order.avgPrice = prevFilled > 0
        ? (prevFilled * order.avgPrice + fillable * fillPrice) / (prevFilled + fillable)
        : fillPrice;
      order.filled += fillable;
      // GTC buy 预扣时已扣款，成交价可能比预扣价低，退还差额
      const refund = (order.price! - fillPrice) * fillable * (1 + PAPER_MAKER_FEE);
      if (refund > 0) this.paperBalance += refund;
    }
    return order;
  }

  async getBestPrices(tokenId: string): Promise<{ bid: number | null; ask: number | null; spread: number; askDepth: number; bidDepth: number }> {
    const cached = this.peekBestPrices(tokenId);
    if (cached) {
      return cached;
    }
    const snapshot = await this.fetchBestPrices(tokenId);
    this.orderbookCache.set(tokenId, { ...snapshot, updatedAt: Date.now() });
    this.notifyOrderbookUpdate();
    return snapshot;
  }

  async placeFakBuy(tokenId: string, amount: number, negRisk = false): Promise<any> {
    if (this.mode === "paper") {
      const book = await this.getBestPrices(tokenId);
      if (book.ask == null || book.ask <= 0 || book.askDepth <= 0) {
        logger.warn(`PAPER FAK买入失败: 无可用ask token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const requestedShares = amount / book.ask;
      const affordableShares = this.paperBalance / (book.ask * (1 + PAPER_TAKER_FEE));
      const filled = Math.min(requestedShares, book.askDepth, affordableShares);
      if (filled < 1e-6) {
        logger.warn(`PAPER FAK买入失败: 余额不足或深度不足 token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const orderId = this.nextPaperOrderId("buy");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "BUY",
        orderType: "FAK",
        size: requestedShares,
        filled,
        avgPrice: book.ask,
      });
      this.paperBalance -= filled * book.ask * (1 + PAPER_TAKER_FEE);
      logger.info(`PAPER FAK买入: ${filled.toFixed(2)}份 @$${book.ask.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return { orderID: orderId };
    }
    try {
      const resp = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount, side: Side.BUY },
        { tickSize: "0.01", negRisk },
        OrderType.FAK,
      );
      logger.info(`FAK买入: $${amount.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return resp;
    } catch (e: any) {
      logger.error(`FAK买入失败: ${e.message}`);
      return null;
    }
  }

  async placeFakSell(tokenId: string, shares: number, negRisk = false): Promise<any> {
    if (this.mode === "paper") {
      const book = await this.getBestPrices(tokenId);
      if (book.bid == null || book.bid <= 0 || book.bidDepth <= 0) {
        logger.warn(`PAPER FAK卖出失败: 无可用bid token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const filled = Math.min(shares, book.bidDepth);
      if (filled < 1e-6) {
        logger.warn(`PAPER FAK卖出失败: 深度不足 token=${tokenId.slice(0, 20)}...`);
        return null;
      }
      const orderId = this.nextPaperOrderId("sell");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "SELL",
        orderType: "FAK",
        size: shares,
        filled,
        avgPrice: book.bid,
      });
      this.paperBalance += filled * book.bid * (1 - PAPER_TAKER_FEE);
      logger.info(`PAPER FAK卖出: ${filled.toFixed(2)}份 @$${book.bid.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return { orderID: orderId };
    }
    try {
      const resp = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, amount: shares, side: Side.SELL },
        { tickSize: "0.01", negRisk },
        OrderType.FAK,
      );
      logger.info(`FAK卖出: ${shares}份 token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return resp;
    } catch (e: any) {
      logger.error(`FAK卖出失败: ${e.message}`);
      try {
        logger.info(`FAK卖出重试: FOK市价 ${shares}份`);
        const retry = await this.client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: shares, side: Side.SELL },
          { tickSize: "0.01", negRisk },
          OrderType.FOK,
        );
        return retry;
      } catch (e2: any) {
        logger.error(`卖出重试也失败: ${e2.message}`);
        return null;
      }
    }
  }

  /** 挂 GTC 限价卖单，不等成交，返回 orderID 供调用方追踪 */
  async placeGtcSell(tokenId: string, shares: number, price: number, negRisk = false): Promise<string | null> {
    if (this.mode === "paper") {
      const orderId = this.nextPaperOrderId("gtc");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "SELL",
        orderType: "GTC",
        size: shares,
        filled: 0,
        avgPrice: 0,
        price,
      });
      logger.info(`PAPER GTC限价卖单: ${shares.toFixed(2)}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return orderId;
    }
    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.SELL },
        { tickSize: "0.01", negRisk },
        OrderType.GTC,
      );
      const orderId: string = resp?.orderID || resp?.order_id || "";
      logger.info(`GTC限价卖单: ${shares}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... orderId=${orderId}`);
      return orderId || null;
    } catch (e: any) {
      logger.error(`GTC卖单失败: ${e.message}`);
      return null;
    }
  }

  /** 挂 GTC 限价买单 (maker)，不等成交，返回 orderID 供调用方追踪 */
  async placeGtcBuy(tokenId: string, shares: number, price: number, negRisk = false): Promise<string | null> {
    if (this.mode === "paper") {
      const cost = shares * price * (1 + PAPER_MAKER_FEE);
      if (cost > this.paperBalance) {
        logger.warn(`PAPER GTC买单失败: 余额不足 need=$${cost.toFixed(2)} have=$${this.paperBalance.toFixed(2)}`);
        return null;
      }
      const orderId = this.nextPaperOrderId("gtcbuy");
      this.paperOrders.set(orderId, {
        orderId,
        tokenId,
        side: "BUY",
        orderType: "GTC",
        size: shares,
        filled: 0,
        avgPrice: 0,
        price,
      });
      // 预扣资金
      this.paperBalance -= cost;
      logger.info(`PAPER GTC限价买单: ${shares.toFixed(0)}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... negRisk=${negRisk}`);
      return orderId;
    }
    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID: tokenId, price, size: shares, side: Side.BUY },
        { tickSize: "0.01", negRisk },
        OrderType.GTC,
      );
      const orderId: string = resp?.orderID || resp?.order_id || "";
      logger.info(`GTC限价买单: ${shares}份 @${price.toFixed(2)} token=${tokenId.slice(0, 20)}... orderId=${orderId}`);
      return orderId || null;
    } catch (e: any) {
      logger.error(`GTC买单失败: ${e.message}`);
      return null;
    }
  }

  async cancelAll(): Promise<void> {
    if (this.mode === "paper") {
      for (const order of this.paperOrders.values()) {
        if (order.orderType === "GTC" && !order.canceled) {
          // GTC buy 取消时退还未成交部分的预扣资金 (与 cancelOrder 逻辑一致)
          if (order.side === "BUY" && order.price != null) {
            const unfilled = order.size - order.filled;
            if (unfilled > 0) {
              this.paperBalance += unfilled * order.price * (1 + PAPER_MAKER_FEE);
            }
          }
          order.canceled = true;
        }
      }
      logger.info("已取消所有挂单 (paper)");
      return;
    }
    try {
      await this.client.cancelAll();
      logger.info("已取消所有挂单");
    } catch (e: any) {
      logger.error(`取消失败: ${e.message}`);
      // 重试一次
      try {
        await new Promise(r => setTimeout(r, 1000));
        await this.client.cancelAll();
        logger.info("已取消所有挂单 (重试)");
      } catch (e2: any) {
        logger.error(`取消重试也失败: ${e2.message}`);
      }
    }
  }

  async getOrderFilled(orderId: string): Promise<number> {
    if (this.mode === "paper") {
      const order = await this.fillPaperGtcOrder(orderId);
      return order?.filled || 0;
    }
    const cached = this.getCachedOrderFill(orderId);
    if (cached && cached.filled > 0) return cached.filled;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const details = await this.fetchOrderFillDetailsOnce(orderId);
        return details.filled;
      } catch (e: any) {
        if (attempt < 2) await new Promise(r => setTimeout(r, getAdaptiveOrderRetryMs()));
        else logger.warn(`getOrderFilled failed after 3 attempts (${orderId.slice(0,12)}): ${e.message}`);
      }
    }
    return 0;
  }

  /** 查询订单真实成交: 返回 { filled: 成交份数, avgPrice: 平均成交价 } */
  async getOrderFillDetails(orderId: string): Promise<{ filled: number; avgPrice: number }> {
    if (this.mode === "paper") {
      const order = await this.fillPaperGtcOrder(orderId);
      return order ? { filled: order.filled, avgPrice: order.avgPrice } : { filled: 0, avgPrice: 0 };
    }
    const cached = this.getCachedOrderFill(orderId);
    if (cached && cached.filled > 0) return cached;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.fetchOrderFillDetailsOnce(orderId);
      } catch (e: any) {
        if (attempt < 2) await new Promise(r => setTimeout(r, getAdaptiveOrderRetryMs()));
        else logger.warn(`getOrderFillDetails failed after 3 attempts (${orderId.slice(0,12)}): ${e.message}`);
      }
    }
    return { filled: 0, avgPrice: 0 };
  }

  async waitForOrderFillDetails(orderId: string, timeoutMs: number): Promise<{ filled: number; avgPrice: number }> {
    if (this.mode === "paper") {
      return this.getOrderFillDetails(orderId);
    }
    const deadline = Date.now() + Math.max(getAdaptiveOrderRetryMs(), timeoutMs);
    let version = this.getOrderUpdateVersion(orderId);
    while (Date.now() < deadline) {
      const cached = this.getCachedOrderFill(orderId);
      if (cached && cached.filled > 0) return cached;
      try {
        const fetched = await this.fetchOrderFillDetailsOnce(orderId);
        if (fetched.filled > 0) return fetched;
      } catch {}
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForOrderUpdate(orderId, version, Math.min(remaining, getAdaptiveOrderRetryMs()));
      version = this.getOrderUpdateVersion(orderId);
    }
    return this.getOrderFillDetails(orderId);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.mode === "paper") {
      const order = this.paperOrders.get(orderId);
      if (order) {
        // GTC buy 取消时退还未成交部分的预扣资金
        if (!order.canceled && order.orderType === "GTC" && order.side === "BUY" && order.price != null) {
          const unfilled = order.size - order.filled;
          if (unfilled > 0) {
            const refund = unfilled * order.price * (1 + PAPER_MAKER_FEE);
            this.paperBalance += refund;
          }
        }
        order.canceled = true;
      }
      return;
    }
    try {
      await this.client.cancelOrder({ orderID: orderId });
    } catch (e: any) {
      // 重试1次 (网络抖动)
      try {
        await new Promise(r => setTimeout(r, 500));
        await this.client.cancelOrder({ orderID: orderId });
      } catch (e2: any) {
        logger.warn(`cancelOrder失败 (${orderId.slice(0, 12)}): ${e2.message}`);
      }
    }
  }

  /** 仿真盘结算：将赢得的份额回款加到paperBalance */
  creditSettlement(amount: number): void {
    if (this.mode === "paper" && amount > 0) {
      this.paperBalance += amount;
    }
  }

  async getBalance(): Promise<number> {
    if (this.mode === "paper") {
      return this.paperBalance;
    }
    // Method 1: Polymarket CLOB API
    try {
      const resp = await this.client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
      logger.info(`CLOB balance response: ${JSON.stringify(resp)}`);
      let raw = 0;
      if (resp && typeof resp === "object") {
        for (const key of ["balance", "available", "amount", "collateral"]) {
          const val = (resp as any)[key];
          if (val != null && val !== "" && val !== "0") {
            raw = parseFloat(String(val));
            if (raw > 0) { logger.info(`CLOB balance: found in field '${key}' raw=${raw}`); break; }
          }
        }
        if (raw === 0 && typeof resp === "string") {
          raw = parseFloat(resp);
        }
      }
      const bal = raw >= 10000 ? raw / 1e6 : raw;
      logger.info(`CLOB balance parsed=$${bal.toFixed(4)}`);
      if (bal > 0) return bal;
    } catch (e: any) {
      logger.warn(`CLOB balance query failed: ${e.message}`);
    }

    // Method 2: Direct Polymarket REST API
    try {
      const resp = await fetch(`${Config.CLOB_HOST}/balance`, {
        headers: { Authorization: `Bearer ${(this.client as any).creds?.apiKey || ""}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        logger.info(`REST balance response: ${JSON.stringify(data)}`);
        const raw = parseFloat(data?.balance || data?.available || data?.collateral || "0");
        const bal = raw >= 10000 ? raw / 1e6 : raw;
        if (bal > 0) return bal;
      }
    } catch (e: any) {
      logger.warn(`REST balance query failed: ${e.message}`);
    }

    // Method 3: On-chain RPC query
    const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const RPCS = [Config.POLYGON_RPC, "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"].filter(Boolean);
    const wallet = new Wallet(Config.PRIVATE_KEY);
    const addresses = [Config.FUNDER_ADDRESS, wallet.address].filter(a => a.length > 0);

    const query = async (token: string, address: string): Promise<number> => {
      const addr = address.toLowerCase().replace("0x", "").padStart(64, "0");
      for (const rpc of RPCS) {
        try {
          const resp = await fetch(rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "eth_call",
              params: [{ to: token, data: "0x70a08231" + addr }, "latest"],
              id: 1,
            }),
            signal: AbortSignal.timeout(5000),
          });
          const json = await resp.json();
          if (json.error) continue;
          const result = json.result as string | undefined;
          if (!result || result === "0x" || result === "0x0000000000000000000000000000000000000000000000000000000000000000") return 0;
          const val = parseInt(result, 16) / 1e6;
          if (val > 0) logger.info(`RPC balance: ${token.slice(0,10)}... @ ${address.slice(0,10)}... = $${val.toFixed(2)} (via ${rpc.slice(0,30)})`);
          return val;
        } catch {}
      }
      return 0;
    };

    let totalBal = 0;
    for (const address of addresses) {
      const [b1, b2] = await Promise.all([query(USDC_E, address), query(USDC_NATIVE, address)]);
      totalBal += b1 + b2;
    }
    if (totalBal > 0) logger.info(`RPC total balance: $${totalBal.toFixed(2)}`);
    else logger.warn(`RPC balance fallback: all queries returned 0 for ${addresses.join(",")}`);
    return totalBal;
  }
}
