import type { BtcTick, MarketInfo, OrderBook, Position, RuntimeState, Settings, Side } from "./types.js";
import { bookForSide, currentBucketStart, discoverMarket, extractSlug, getBtcCloseForBucket, getBtcTick, getOrderBook, marketSlugForBucket } from "./market.js";
import { askDepthUsdc, bestAsk, bestBid, bidDepthShares, simulateBuy, simulateSell, spreadCents } from "./paper.js";
import { paths, readAllJsonl, readJsonFile, readSettings, writeJsonFile } from "./store.js";
import { recordEvent, recordOrderbook, recordSnapshot, recordTrade } from "./recorder.js";

interface PersistedPaperState {
  paperBalance: number;
  realizedPnl: number;
  position: Position | null;
}

interface TradeRow {
  netPnl?: number;
  entryCost?: number;
}

interface KellySizing {
  targetUsdc: number;
  kellyPct: number;
  rawKellyPct: number;
  winRate: number | null;
  payoffRatio: number | null;
  sampleSize: number;
  source: "fallback" | "kelly" | "disabled";
}

export class Bot {
  private timer: NodeJS.Timeout | null = null;
  private priceHistory: BtcTick[] = [];
  private lastSnapshotAt = 0;
  private lastBucketAction: string | null = null;
  private state: RuntimeState = {
    running: false,
    lastError: null,
    currentMarket: null,
    btc: null,
    moveBps: 0,
    velocityBps: 0,
    secondInBucket: 0,
    upBook: null,
    downBook: null,
    bookUpdatedAt: null,
    position: null,
    lastAction: "idle",
    paperBalance: 10000,
    realizedPnl: 0,
    updatedAt: null
  };

  async start() {
    const settings = await readSettings();
    const persisted = await readJsonFile<PersistedPaperState>(paths.state, {
      paperBalance: settings.paperBalance,
      realizedPnl: 0,
      position: null
    });
    this.state.paperBalance = persisted.paperBalance;
    this.state.realizedPnl = persisted.realizedPnl;
    this.state.position = persisted.position;
    this.state.running = true;
    await recordEvent("bot_started", { paperBalance: this.state.paperBalance });
    this.timer = setInterval(() => void this.tick(), Math.max(500, settings.repriceIntervalMs));
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
  }

  getState(): RuntimeState {
    return this.state;
  }

  async setPaperBalance(amount: number) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid paper balance");
    if (this.state.position) throw new Error("Cannot reset paper balance while a position is open");
    this.state.paperBalance = amount;
    this.state.realizedPnl = 0;
    await this.persist();
    await recordEvent("paper_balance_reset", { paperBalance: amount });
  }

  private async persist() {
    await writeJsonFile(paths.state, {
      paperBalance: this.state.paperBalance,
      realizedPnl: this.state.realizedPnl,
      position: this.state.position
    });
  }

  private async tick() {
    try {
      const settings = await readSettings();
      const nowMs = Date.now();
      const bucketStart = currentBucketStart(nowMs);
      const secondInBucket = Math.floor(nowMs / 1000) - bucketStart;
      const slug = settings.autoDiscoverMarket
        ? marketSlugForBucket(bucketStart)
        : extractSlug(settings.manualMarketUrl) || marketSlugForBucket(bucketStart);

      const btc = await getBtcTick();
      this.priceHistory.push(btc);
      this.priceHistory = this.priceHistory.filter((p) => p.timestamp >= nowMs - 120000);
      const moveBps = ((btc.price / btc.open) - 1) * 10000;
      const velocityBps = this.velocityBps(settings.velocityLookbackSeconds, btc.price);

      const market = await this.marketFor(slug, bucketStart);
      const [upBook, downBook] = await Promise.all([
        getOrderBook(market.upTokenId),
        getOrderBook(market.downTokenId)
      ]);
      const bookUpdatedAt = new Date().toISOString();

      this.state = {
        ...this.state,
        currentMarket: market,
        btc,
        moveBps,
        velocityBps,
        secondInBucket,
        upBook,
        downBook,
        bookUpdatedAt,
        updatedAt: new Date().toISOString(),
        lastError: null
      };

      if (settings.botEnabled) {
        await this.evaluate(settings, market, btc, moveBps, velocityBps, secondInBucket, upBook, downBook);
      } else {
        this.state.lastAction = "bot_disabled";
      }

      if (settings.enableSnapshots && nowMs - this.lastSnapshotAt >= settings.snapshotIntervalMs) {
        this.lastSnapshotAt = nowMs;
        await this.snapshot(market, btc, moveBps, velocityBps, secondInBucket, upBook, downBook);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = message;
      this.state.updatedAt = new Date().toISOString();
      this.state.lastAction = "error";
      await recordEvent("error", { message }, "error");
    }
  }

  private velocityBps(lookbackSeconds: number, currentPrice: number) {
    const targetTime = Date.now() - lookbackSeconds * 1000;
    const old = [...this.priceHistory].reverse().find((p) => p.timestamp <= targetTime) ?? this.priceHistory[0];
    if (!old) return 0;
    return ((currentPrice / old.price) - 1) * 10000;
  }

  private async marketFor(slug: string, bucketStart: number): Promise<MarketInfo> {
    if (this.state.currentMarket?.slug === slug) return this.state.currentMarket;
    const market = await discoverMarket(slug, bucketStart);
    this.lastBucketAction = null;
    await recordEvent("market_discovered", {
      marketSlug: market.slug,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      title: market.title
    });
    return market;
  }

  private async evaluate(
    settings: Settings,
    market: MarketInfo,
    btc: BtcTick,
    moveBps: number,
    velocityBps: number,
    secondInBucket: number,
    upBook: OrderBook,
    downBook: OrderBook
  ) {
    const position = this.state.position;
    if (position && position.marketSlug !== market.slug) {
      await this.settleExpired(position, btc.price);
      return;
    }

    if (position) {
      await this.managePosition(settings, market, btc, moveBps, secondInBucket, upBook, downBook, position);
      return;
    }

    if (this.lastBucketAction === market.slug) {
      this.state.lastAction = "one_trade_per_bucket";
      return;
    }
    if (secondInBucket < settings.entryStartSeconds || secondInBucket > settings.entryEndSeconds) {
      this.state.lastAction = "outside_entry_window";
      return;
    }

    const side = this.signal(settings, moveBps, velocityBps);
    if (!side) {
      this.state.lastAction = "no_signal";
      return;
    }
    await this.enter(settings, market, btc, moveBps, velocityBps, secondInBucket, side, bookForSide(side, upBook, downBook));
  }

  private signal(settings: Settings, moveBps: number, velocityBps: number): Side | null {
    if (moveBps >= settings.minBtcMoveBps && velocityBps >= settings.minBtcVelocityBps) return "UP";
    if (moveBps <= -settings.minBtcMoveBps && velocityBps <= -settings.minBtcVelocityBps) return "DOWN";
    return null;
  }

  private async enter(settings: Settings, market: MarketInfo, btc: BtcTick, moveBps: number, velocityBps: number, secondInBucket: number, side: Side, book: OrderBook) {
    const ask = bestAsk(book);
    if (ask == null) return this.action("entry_skipped_no_ask");
    if (ask > settings.maxEntryPrice) return this.action("entry_skipped_price");
    if (spreadCents(book) > settings.maxSpreadCents) return this.action("entry_skipped_spread");

    const maxPrice = ask + settings.maxEntrySlippageCents / 100;
    const depthLimitedUsdc = askDepthUsdc(book, maxPrice) * settings.depthUsageRatio;
    const kelly = await this.kellySizing(settings);
    const targetUsdc = Math.min(kelly.targetUsdc, depthLimitedUsdc, settings.maxShares * ask, this.state.paperBalance);
    if (targetUsdc < settings.minOrderUsdc) return this.action("entry_skipped_depth");

    const fill = simulateBuy(book, targetUsdc, settings.maxEntrySlippageCents);
    if (!fill.avgPrice || fill.value < settings.minOrderUsdc) return this.action("entry_unfilled");

    const position: Position = {
      id: `${new Date().toISOString()}-${market.slug}-${side}`,
      marketSlug: market.slug,
      side,
      status: "open",
      entryTime: new Date().toISOString(),
      entrySecond: secondInBucket,
      bucketStart: market.bucketStart,
      bucketEnd: market.bucketEnd,
      shares: fill.shares,
      entryAvgPrice: fill.avgPrice,
      entryCost: fill.value,
      btcOpen: btc.open,
      btcEntry: btc.price,
      entryMoveBps: moveBps,
      entryVelocityBps: velocityBps,
      kellyPct: kelly.kellyPct,
      kellySource: kelly.source
    };
    this.state.paperBalance -= fill.value;
    this.state.position = position;
    this.lastBucketAction = market.slug;
    this.state.lastAction = `entered_${side}`;
    await this.persist();
    await recordEvent("entry_filled", { marketSlug: market.slug, side, fill, kelly });
    if (settings.enableOrderbookLogs) await recordOrderbook({ marketSlug: market.slug, token: side, reason: "entry", bids: book.bids, asks: book.asks });
  }

  private async managePosition(settings: Settings, market: MarketInfo, btc: BtcTick, moveBps: number, secondInBucket: number, upBook: OrderBook, downBook: OrderBook, position: Position) {
    const book = bookForSide(position.side, upBook, downBook);
    const bid = bestBid(book);
    if (bid == null) return this.action("hold_no_bid");

    const elapsed = (Date.now() - Date.parse(position.entryTime)) / 1000;
    const profitCents = (bid - position.entryAvgPrice) * 100;
    const isUp = position.side === "UP";
    const reversal = isUp ? moveBps <= settings.reversalExitBps : moveBps >= -settings.reversalExitBps;
    const nearResolve = secondInBucket >= 300 - settings.exitBeforeResolveSeconds;

    let reason: string | null = null;
    if (profitCents >= settings.takeProfitCents) reason = "take_profit";
    if (profitCents <= -settings.stopLossCents) reason = "stop_loss";
    if (reversal) reason = "btc_reversal";
    if (elapsed >= settings.maxHoldSeconds) reason = "max_hold";
    if (nearResolve) reason = "exit_before_resolve";

    const panic = settings.panicHedgeEnabled && (
      profitCents <= -settings.panicLossCents ||
      (isUp ? moveBps <= settings.panicBtcReversalBps : moveBps >= -settings.panicBtcReversalBps)
    );

    if (!reason && !panic) return this.action("hold");

    const sell = simulateSell(book, position.shares, settings.maxExitSlippageCents);
    if (sell.avgPrice && sell.fillRatio >= settings.minExitFillRatio) {
      await this.closePosition(position, market, btc, moveBps, sell, reason ?? "panic_exit", book, settings);
      return;
    }

    if (panic && position.status !== "hedged") {
      await this.panicHedge(settings, market, position, position.side === "UP" ? "DOWN" : "UP", upBook, downBook, sell);
      return;
    }

    this.state.lastAction = `exit_failed_${reason ?? "panic"}`;
  }

  private async panicHedge(settings: Settings, market: MarketInfo, position: Position, hedgeSide: Side, upBook: OrderBook, downBook: OrderBook, exitAttempt: unknown) {
    const hedgeBook = bookForSide(hedgeSide, upBook, downBook);
    const ask = bestAsk(hedgeBook);
    if (ask == null || ask > settings.maxHedgePrice) return this.action("panic_hedge_skipped_price");
    const targetShares = position.shares * settings.hedgeSizeRatio;
    const targetUsdc = targetShares * ask;
    const hedgeFill = simulateBuy(hedgeBook, targetUsdc, settings.maxHedgeSlippageCents);
    if (!hedgeFill.avgPrice || hedgeFill.shares <= 0) return this.action("panic_hedge_unfilled");

    position.status = "hedged";
    position.hedgeSide = hedgeSide;
    position.hedgeShares = hedgeFill.shares;
    position.hedgeAvgPrice = hedgeFill.avgPrice;
    position.hedgeCost = hedgeFill.value;
    this.state.paperBalance -= hedgeFill.value;
    this.state.position = position;
    this.state.lastAction = `panic_hedged_${hedgeSide}`;
    await this.persist();
    await recordEvent("panic_hedge_triggered", { marketSlug: market.slug, hedgeSide, hedgeFill, exitAttempt });
    if (settings.enableOrderbookLogs) await recordOrderbook({ marketSlug: market.slug, token: hedgeSide, reason: "panic_hedge", bids: hedgeBook.bids, asks: hedgeBook.asks });
  }

  private async closePosition(position: Position, market: MarketInfo, btc: BtcTick, moveBps: number, sell: { value: number; shares: number; avgPrice: number | null; slippageCents: number; bestPrice: number | null }, reason: string, book: OrderBook, settings: Settings) {
    const fees = (position.entryCost + sell.value) * settings.feeBps / 10000;
    const hedgeCost = position.hedgeCost ?? 0;
    const pnl = sell.value - position.entryCost - hedgeCost - fees;
    this.state.paperBalance += sell.value;
    this.state.realizedPnl += pnl;
    this.state.position = null;
    this.state.lastAction = `closed_${reason}`;
    await this.persist();
    await recordTrade({
      tradeId: position.id,
      marketSlug: position.marketSlug,
      marketUrl: market.url,
      side: position.side,
      status: "closed",
      entryTime: position.entryTime,
      exitTime: new Date().toISOString(),
      bucketStart: position.bucketStart,
      bucketEnd: position.bucketEnd,
      entrySecond: position.entrySecond,
      exitSecond: this.state.secondInBucket,
      btcOpen: position.btcOpen,
      btcEntry: position.btcEntry,
      btcExit: btc.price,
      entryMoveBps: position.entryMoveBps,
      entryVelocityBps: position.entryVelocityBps,
      kellyPct: position.kellyPct ?? null,
      kellySource: position.kellySource ?? null,
      exitMoveBps: moveBps,
      entryAvgPrice: position.entryAvgPrice,
      entryShares: position.shares,
      entryCost: position.entryCost,
      exitBid: sell.bestPrice,
      exitAvgPrice: sell.avgPrice,
      exitShares: sell.shares,
      exitValue: sell.value,
      exitSlippageCents: sell.slippageCents,
      hedgeActive: position.status === "hedged",
      hedgeSide: position.hedgeSide ?? null,
      hedgeShares: position.hedgeShares ?? 0,
      hedgeCost,
      hedgeAvgPrice: position.hedgeAvgPrice ?? null,
      grossPnl: sell.value - position.entryCost - hedgeCost,
      fees,
      netPnl: pnl,
      roiPct: position.entryCost > 0 ? pnl / position.entryCost * 100 : 0,
      exitReason: reason
    });
    await recordEvent("exit_filled", { marketSlug: market.slug, reason, sell, pnl });
    if (settings.enableOrderbookLogs) await recordOrderbook({ marketSlug: market.slug, token: position.side, reason: "exit", bids: book.bids, asks: book.asks });
  }

  private async settleExpired(position: Position, btcPrice: number) {
    let resolvePrice = btcPrice;
    try {
      resolvePrice = await getBtcCloseForBucket(position.bucketStart);
    } catch {
      resolvePrice = btcPrice;
    }
    const winner: Side = resolvePrice >= position.btcOpen ? "UP" : "DOWN";
    const mainValue = winner === position.side ? position.shares : 0;
    const hedgeValue = winner === position.hedgeSide ? (position.hedgeShares ?? 0) : 0;
    const totalValue = mainValue + hedgeValue;
    const totalCost = position.entryCost + (position.hedgeCost ?? 0);
    const pnl = totalValue - totalCost;
    this.state.paperBalance += totalValue;
    this.state.realizedPnl += pnl;
    this.state.position = null;
    this.state.lastAction = `settled_${winner}`;
    await this.persist();
    await recordTrade({
      tradeId: position.id,
      marketSlug: position.marketSlug,
      side: position.side,
      status: "settled",
      entryTime: position.entryTime,
      exitTime: new Date().toISOString(),
      bucketStart: position.bucketStart,
      bucketEnd: position.bucketEnd,
      btcOpen: position.btcOpen,
      btcResolve: resolvePrice,
      entryAvgPrice: position.entryAvgPrice,
      entryShares: position.shares,
      entryCost: position.entryCost,
      hedgeActive: position.status === "hedged",
      hedgeSide: position.hedgeSide ?? null,
      hedgeShares: position.hedgeShares ?? 0,
      hedgeCost: position.hedgeCost ?? 0,
      grossPnl: pnl,
      fees: 0,
      netPnl: pnl,
      roiPct: totalCost > 0 ? pnl / totalCost * 100 : 0,
      exitReason: "settlement",
      resolvedWinner: winner
    });
  }

  private async snapshot(market: MarketInfo, btc: BtcTick, moveBps: number, velocityBps: number, secondInBucket: number, upBook: OrderBook, downBook: OrderBook) {
    const settings = await readSettings();
    const kelly = await this.kellySizing(settings);
    await recordSnapshot({
      marketSlug: market.slug,
      secondInBucket,
      btcPrice: btc.price,
      btcOpen: btc.open,
      moveBps,
      velocityBps,
      upBid: bestBid(upBook),
      upAsk: bestAsk(upBook),
      upSpreadCents: spreadCents(upBook),
      upAskDepth: askDepthUsdc(upBook, (bestAsk(upBook) ?? 0) + 0.03),
      upBidDepth: bidDepthShares(upBook, (bestBid(upBook) ?? 0) - 0.03),
      downBid: bestBid(downBook),
      downAsk: bestAsk(downBook),
      downSpreadCents: spreadCents(downBook),
      downAskDepth: askDepthUsdc(downBook, (bestAsk(downBook) ?? 0) + 0.03),
      downBidDepth: bidDepthShares(downBook, (bestBid(downBook) ?? 0) - 0.03),
      action: this.state.lastAction,
      positionSide: this.state.position?.side ?? null,
      positionShares: this.state.position?.shares ?? 0,
      paperBalance: this.state.paperBalance,
      kellyPct: kelly.kellyPct,
      kellyTargetUsdc: kelly.targetUsdc,
      kellySampleSize: kelly.sampleSize,
      kellySource: kelly.source
    });
  }

  private async kellySizing(settings: Settings): Promise<KellySizing> {
    if (!settings.kellyEnabled) {
      const pct = Math.min(settings.maxPositionUsdc / Math.max(this.state.paperBalance, 1) * 100, 100);
      return {
        targetUsdc: Math.min(settings.maxPositionUsdc, this.state.paperBalance),
        kellyPct: pct,
        rawKellyPct: pct,
        winRate: null,
        payoffRatio: null,
        sampleSize: 0,
        source: "disabled"
      };
    }

    const trades = (await readAllJsonl<TradeRow>(paths.trades))
      .filter((t) => Number.isFinite(t.netPnl) && Number.isFinite(t.entryCost) && Number(t.entryCost) > 0)
      .slice(-settings.kellyLookbackTrades);

    if (trades.length < settings.kellyMinTrades) {
      const fallbackPct = clamp(settings.kellyFallbackPct, 0, settings.kellyMaxPct);
      return {
        targetUsdc: this.state.paperBalance * fallbackPct / 100,
        kellyPct: fallbackPct,
        rawKellyPct: fallbackPct,
        winRate: null,
        payoffRatio: null,
        sampleSize: trades.length,
        source: "fallback"
      };
    }

    const wins = trades.filter((t) => Number(t.netPnl) > 0).map((t) => Number(t.netPnl));
    const losses = trades.filter((t) => Number(t.netPnl) < 0).map((t) => Math.abs(Number(t.netPnl)));
    const winRate = wins.length / trades.length;
    const avgWin = average(wins);
    const avgLoss = average(losses);
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
    const rawKelly = payoffRatio > 0 ? winRate - (1 - winRate) / payoffRatio : 0;
    const halfKellyPct = Math.max(0, rawKelly * settings.kellyFraction * 100);
    const kellyPct = clamp(halfKellyPct, 0, settings.kellyMaxPct);

    return {
      targetUsdc: this.state.paperBalance * kellyPct / 100,
      kellyPct,
      rawKellyPct: rawKelly * 100,
      winRate,
      payoffRatio,
      sampleSize: trades.length,
      source: "kelly"
    };
  }

  private action(action: string) {
    this.state.lastAction = action;
  }
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
