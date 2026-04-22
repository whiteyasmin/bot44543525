import type { BtcTick, MarketInfo, OrderBook, Position, RuntimeState, Settings, Side } from "./types.js";
import { bookForSide, currentBucketStart, discoverMarket, extractSlug, getBtcCloseForBucket, getBtcTick, getOrderBook, marketSlugForBucket } from "./market.js";
import type { BtcRegime } from "./types.js";
import { askDepthUsdc, bestAsk, bestBid, bidDepthShares, simulateBuy, spreadCents } from "./paper.js";
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

interface EntrySizing {
  targetUsdc: number;
  effectiveMinOrderUsdc: number;
  kellyTargetUsdc: number;
  depthCapUsdc: number;
  depthRawUsdc: number;
  spreadCents: number;
  depthToKellyRatio: number;
  qualityMultiplier: number;
  entryTierMultiplier: number;
  limitedBy: string;
  kelly: KellySizing;
}

interface EntrySignal {
  side: Side;
  strategyType: string;
  tier: string;
  multiplier: number;
  pressureScore: number;
  reason: string;
  timing: EntryTiming;
}

interface EntryTiming {
  phase: "too_early" | "early_confirm" | "normal" | "late_confirm" | "last_chance" | "too_late";
  allowed: boolean;
  secondsLeft: number;
  thresholdMultiplier: number;
  pricePenalty: number;
  sizeMultiplier: number;
  reason: string;
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
    btcRegime: null,
    secondInBucket: 0,
    upBook: null,
    downBook: null,
    bookUpdatedAt: null,
    position: null,
    lastAction: "idle",
    paperBalance: 10000,
    realizedPnl: 0,
    updatedAt: null,
    decision: {
      checkedAt: null,
      enabled: false,
      status: "starting",
      side: null,
      reason: "机器人启动中",
      details: {}
    }
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
      const btcRegime = classifyBtcRegime(settings, moveBps, velocityBps);

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
        btcRegime,
        secondInBucket,
        upBook,
        downBook,
        bookUpdatedAt,
        updatedAt: new Date().toISOString(),
        lastError: null
      };

      if (settings.botEnabled) {
        await this.evaluate(settings, market, btc, moveBps, velocityBps, btcRegime, secondInBucket, upBook, downBook);
      } else {
        this.state.lastAction = "bot_disabled";
        this.decide("paused", null, "策略已暂停，启动后才会决策", { secondInBucket });
      }

      if (settings.enableSnapshots && nowMs - this.lastSnapshotAt >= settings.snapshotIntervalMs) {
        this.lastSnapshotAt = nowMs;
        await this.snapshot(market, btc, moveBps, velocityBps, btcRegime, secondInBucket, upBook, downBook);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = message;
      this.state.updatedAt = new Date().toISOString();
      this.state.lastAction = "error";
      this.decide("error", null, message, {});
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
    btcRegime: BtcRegime,
    secondInBucket: number,
    upBook: OrderBook,
    downBook: OrderBook
  ) {
    const position = this.state.position;
    this.decide("checking", null, "正在检查入场和持仓条件", {
      market: market.slug,
      secondInBucket,
      moveBps,
      velocityBps,
      btcRegime,
      btcPrice: btc.price,
      btcSource: btc.source
    });
    if (position && position.marketSlug !== market.slug) {
      this.decide("settling", position.side, "上一局已结束，正在模拟结算", { positionMarket: position.marketSlug, currentMarket: market.slug });
      await this.settleExpired(position, btc.price);
      return;
    }

    if (position) {
      this.decide("managing_position", position.side, "已有仓位，检查是否需要 panic hedge，然后持有到结算", {
        shares: position.shares,
        entryAvgPrice: position.entryAvgPrice
      });
      await this.managePosition(settings, market, btcRegime, moveBps, velocityBps, secondInBucket, upBook, downBook, position);
      return;
    }

    if (this.lastBucketAction === market.slug) {
      this.state.lastAction = "one_trade_per_bucket";
      this.decide("skip", null, "当前 5 分钟市场已交易，等待下一局", { market: market.slug });
      return;
    }
    const upAsk = bestAsk(upBook);
    const downAsk = bestAsk(downBook);
    const entrySignal = this.entrySignal(settings, moveBps, velocityBps, secondInBucket, upAsk, downAsk);
    if (!entrySignal) {
      this.state.lastAction = "no_signal";
      this.decide("wait_signal", null, "动量、速度、时间组合未满足", {
        moveBps,
        minBtcMoveBps: settings.minBtcMoveBps,
        velocityBps,
        minBtcVelocityBps: settings.minBtcVelocityBps,
        timing: entryTiming(settings, secondInBucket, pressureScore(moveBps, velocityBps), velocityBps),
        btcRegime,
        upAsk,
        downAsk
      });
      return;
    }
    this.decide("signal", entrySignal.side, `出现 ${entrySignal.side} ${entrySignal.strategyType} 信号，检查盘口和仓位`, { moveBps, velocityBps, btcRegime, entrySignal, upAsk, downAsk });
    await this.enter(settings, market, btc, moveBps, velocityBps, btcRegime, secondInBucket, entrySignal, bookForSide(entrySignal.side, upBook, downBook));
  }

  private entrySignal(settings: Settings, moveBps: number, velocityBps: number, secondInBucket: number, upAsk: number | null, downAsk: number | null): EntrySignal | null {
    const pressure = pressureScore(moveBps, velocityBps);
    const timing = entryTiming(settings, secondInBucket, pressure, velocityBps);
    if (!timing.allowed) return null;
    const pressureSide: Side | null = pressure >= settings.minBtcMoveBps ? "UP" : pressure <= -settings.minBtcMoveBps ? "DOWN" : null;
    const trend = pressureSide ? trendEntryForSide(settings, pressureSide, pressureSide === "UP" ? upAsk : downAsk, pressure, moveBps, velocityBps, timing) : null;
    if (trend) return trend;

    const upMisprice = mispriceEntryForSide(settings, "UP", upAsk, pressure, timing);
    const downMisprice = mispriceEntryForSide(settings, "DOWN", downAsk, pressure, timing);
    const misprice = bestSignal(upMisprice, downMisprice);
    if (misprice) return misprice;

    const reverse = reverseFavoriteEntry(settings, pressure, upAsk, downAsk, timing);
    if (reverse) return reverse;
    return null;
  }

  private async enter(settings: Settings, market: MarketInfo, btc: BtcTick, moveBps: number, velocityBps: number, btcRegime: BtcRegime, secondInBucket: number, signal: EntrySignal, book: OrderBook) {
    const side = signal.side;
    const ask = bestAsk(book);
    if (ask == null) {
      this.decide("skip", side, "目标方向没有卖盘，无法买入", {});
      return this.action("entry_skipped_no_ask");
    }
    if (ask > settings.maxEntryPrice) {
      this.decide("skip", side, "目标方向价格高于最高买入价", { ask, maxEntryPrice: settings.maxEntryPrice });
      return this.action("entry_skipped_price");
    }
    const spread = spreadCents(book);
    if (spread > settings.maxSpreadCents) {
      this.decide("skip", side, "盘口价差过大", { spreadCents: spread, maxSpreadCents: settings.maxSpreadCents });
      return this.action("entry_skipped_spread");
    }

    const sizing = await this.entrySizing(settings, book, ask, spread, signal.multiplier);
    if (sizing.targetUsdc < sizing.effectiveMinOrderUsdc) {
      this.decide("skip", side, "Kelly 仓位或盘口深度低于最小订单", {
        ...sizing,
        kelly: undefined
      });
      return this.action("entry_skipped_depth");
    }

    const fill = simulateBuy(book, sizing.targetUsdc, settings.maxEntrySlippageCents);
    if (!fill.avgPrice || fill.value < sizing.effectiveMinOrderUsdc) {
      this.decide("skip", side, "模拟成交低于最小订单", { sizing, fill });
      return this.action("entry_unfilled");
    }

    const trendAtEntry = btcRegime.label;
    const tailwind = btcRegime.entrySide === side;
    const entryPriceBucket = priceBucket(fill.avgPrice);
    const secondsLeftAtEntry = 300 - secondInBucket;

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
      trendAtEntry,
      tailwind,
      btcRegime,
      entryPriceBucket,
      entryStrategyType: signal.strategyType,
      entrySignalTier: signal.tier,
      entrySignalMultiplier: signal.multiplier,
      entryPressureScore: signal.pressureScore,
      secondsLeftAtEntry,
      kellyPct: sizing.kelly.kellyPct,
      kellySource: sizing.kelly.source
    };
    this.state.paperBalance -= fill.value;
    this.state.position = position;
    this.lastBucketAction = market.slug;
    this.state.lastAction = `entered_${side}`;
    this.decide("entered", side, `已模拟买入 ${side}`, {
      shares: fill.shares,
      avgPrice: fill.avgPrice,
      cost: fill.value,
      trendAtEntry,
      tailwind,
      btcRegime,
      entryPriceBucket,
      entryStrategyType: signal.strategyType,
      entrySignalTier: signal.tier,
      entrySignalMultiplier: signal.multiplier,
      entryPressureScore: signal.pressureScore,
      secondsLeftAtEntry,
      sizing
    });
    await this.persist();
    await recordEvent("entry_filled", { marketSlug: market.slug, side, fill, sizing, entrySignal: signal });
    if (settings.enableOrderbookLogs) await recordOrderbook({ marketSlug: market.slug, token: side, reason: "entry", bids: book.bids, asks: book.asks });
  }

  private async managePosition(settings: Settings, market: MarketInfo, btcRegime: BtcRegime, moveBps: number, velocityBps: number, secondInBucket: number, upBook: OrderBook, downBook: OrderBook, position: Position) {
    const book = bookForSide(position.side, upBook, downBook);
    const bid = bestBid(book);
    if (bid == null) {
      this.decide("hold", position.side, "持仓方向没有买盘，继续持有到结算", { shares: position.shares });
      return this.action("hold_no_bid");
    }

    const elapsed = (Date.now() - Date.parse(position.entryTime)) / 1000;
    const profitCents = (bid - position.entryAvgPrice) * 100;
    const hedgeSide: Side = position.side === "UP" ? "DOWN" : "UP";
    const panicLoss = profitCents <= -settings.panicLossCents;
    const severePanicLoss = profitCents <= -settings.panicLossCents * 1.5;
    const adverseRegime = isAdverseRegime(position.side, btcRegime, profitCents);
    const confirmedAdverseTrend = btcRegime.entrySide === hedgeSide;
    const currentPressureScore = pressureScore(moveBps, velocityBps);
    const adversePressure = hedgeSide === "UP" ? currentPressureScore : -currentPressureScore;
    const strongAdversePressure = adversePressure >= settings.minBtcMoveBps * 2;
    const secondsLeft = 300 - secondInBucket;
    const hedgeAgeOk = elapsed >= 60;
    const hedgeTimeOk = secondsLeft >= 120;
    const panicIndicator = panicLoss && confirmedAdverseTrend && strongAdversePressure && hedgeAgeOk && hedgeTimeOk;
    const severePanic = severePanicLoss && adverseRegime && strongAdversePressure && hedgeAgeOk && hedgeTimeOk;

    const shouldHedge = settings.panicHedgeEnabled && !position.hedgeSide && (
      panicIndicator ||
      severePanic
    );

    if (shouldHedge) {
      this.decide("panic_hedge", position.side, "触发 panic hedge，买入反方向保护成本，主仓持有到结算", {
        bid,
        entryAvgPrice: position.entryAvgPrice,
        profitCents,
        moveBps,
        velocityBps,
        pressureScore: currentPressureScore,
        adversePressure,
        btcRegime,
        secondInBucket,
        secondsLeft,
        elapsedSeconds: elapsed,
        panicLoss,
        severePanicLoss,
        adverseRegime,
        confirmedAdverseTrend,
        strongAdversePressure,
        hedgeAgeOk,
        hedgeTimeOk,
        panicIndicator,
        severePanic
      });
      await this.panicHedge(settings, market, position, hedgeSide, upBook, downBook, null);
      return;
    }

    this.decide("hold", position.side, position.hedgeSide ? "已对冲，继续持有到结算" : "继续持有到结算，未触发对冲", {
      bid,
      entryAvgPrice: position.entryAvgPrice,
      profitCents,
      moveBps,
      velocityBps,
      pressureScore: currentPressureScore,
      adversePressure,
      btcRegime,
      secondInBucket,
      secondsLeft,
      elapsedSeconds: elapsed,
      hedgeSide: position.hedgeSide ?? null,
      panicLoss,
      severePanicLoss,
      adverseRegime,
      confirmedAdverseTrend,
      strongAdversePressure,
      hedgeAgeOk,
      hedgeTimeOk,
      panicIndicator,
      severePanic
    });
    return this.action(position.hedgeSide ? "hold_hedged" : "hold");

  }

  private async panicHedge(settings: Settings, market: MarketInfo, position: Position, hedgeSide: Side, upBook: OrderBook, downBook: OrderBook, exitAttempt: unknown) {
    const hedgeBook = bookForSide(hedgeSide, upBook, downBook);
    const ask = bestAsk(hedgeBook);
    if (ask == null || ask > settings.maxHedgePrice) return this.action("panic_hedge_skipped_price");
    const hedgeRatio = dynamicHedgeRatio(settings.hedgeSizeRatio, ask);
    const targetShares = position.shares * hedgeRatio;
    const targetUsdc = targetShares * ask;
    const hedgeFill = simulateBuy(hedgeBook, targetUsdc, settings.maxHedgeSlippageCents);
    if (!hedgeFill.avgPrice || hedgeFill.shares <= 0) return this.action("panic_hedge_unfilled");
    const hedgeEffect = hedgeImprovement(settings, position, hedgeFill.value, hedgeFill.shares, hedgeFill.avgPrice);
    if (hedgeEffect.improvementPct < settings.minHedgeImprovementPct) {
      this.decide("hold", position.side, "对冲改善不足，跳过贵对冲", {
        hedgeSide,
        hedgeAsk: ask,
        hedgeRatio,
        hedgeShares: hedgeFill.shares,
        hedgeCost: hedgeFill.value,
        unhedgedWorstLoss: hedgeEffect.unhedgedWorstLoss,
        hedgedWorstLoss: hedgeEffect.hedgedWorstLoss,
        hedgeImprovementPct: hedgeEffect.improvementPct,
        minHedgeImprovementPct: settings.minHedgeImprovementPct
      });
      await recordEvent("panic_hedge_skipped_inefficient", {
        marketSlug: market.slug,
        hedgeSide,
        ask,
        hedgeRatio,
        hedgeFill,
        hedgeEffect,
        minHedgeImprovementPct: settings.minHedgeImprovementPct
      });
      return this.action("panic_hedge_skipped_inefficient");
    }

    position.status = "hedged";
    position.hedgeSide = hedgeSide;
    position.hedgeShares = hedgeFill.shares;
    position.hedgeAvgPrice = hedgeFill.avgPrice;
    position.hedgeCost = hedgeFill.value;
    this.state.paperBalance -= hedgeFill.value;
    this.state.position = position;
    this.state.lastAction = `panic_hedged_${hedgeSide}`;
    this.decide("hedged", hedgeSide, `已模拟买入 ${hedgeSide} 对冲`, {
      hedgeShares: hedgeFill.shares,
      hedgeAvgPrice: hedgeFill.avgPrice,
      hedgeCost: hedgeFill.value,
      hedgeRatio,
      unhedgedWorstLoss: hedgeEffect.unhedgedWorstLoss,
      hedgedWorstLoss: hedgeEffect.hedgedWorstLoss,
      hedgeImprovementPct: hedgeEffect.improvementPct
    });
    await this.persist();
    await recordEvent("panic_hedge_triggered", { marketSlug: market.slug, hedgeSide, hedgeRatio, hedgeFill, hedgeEffect, exitAttempt });
    if (settings.enableOrderbookLogs) await recordOrderbook({ marketSlug: market.slug, token: hedgeSide, reason: "panic_hedge", bids: hedgeBook.bids, asks: hedgeBook.asks });
  }

  private async settleExpired(position: Position, btcPrice: number) {
    const settings = await readSettings();
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
    const fees = tradeFee(settings, position.shares, position.entryAvgPrice) +
      (position.hedgeShares && position.hedgeAvgPrice ? tradeFee(settings, position.hedgeShares, position.hedgeAvgPrice) : 0);
    const grossPnl = totalValue - totalCost;
    const pnl = grossPnl - fees;
    const duplicateSettlement = (await readAllJsonl<{ tradeId?: string; exitReason?: string }>(paths.trades))
      .some((trade) => trade.tradeId === position.id && trade.exitReason === "settlement");
    if (duplicateSettlement) {
      this.state.position = null;
      this.state.lastAction = `settlement_duplicate_${winner}`;
      this.decide("settled", winner, "市场已结算，重复结算记录已跳过", { resolvePrice });
      await this.persist();
      await recordEvent("settlement_duplicate_skipped", {
        tradeId: position.id,
        marketSlug: position.marketSlug,
        resolvedWinner: winner
      });
      return;
    }

    this.state.paperBalance += totalValue - fees;
    this.state.realizedPnl += pnl;
    this.state.position = null;
    this.state.lastAction = `settled_${winner}`;
    this.decide("settled", winner, `市场已结算，结果 ${winner}`, { resolvePrice, pnl });
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
      btcEntry: position.btcEntry,
      btcResolve: resolvePrice,
      entrySecond: position.entrySecond,
      entryMoveBps: position.entryMoveBps,
      entryVelocityBps: position.entryVelocityBps,
      trendAtEntry: position.trendAtEntry ?? null,
      tailwind: position.tailwind ?? null,
      btcRegimeAtEntry: position.btcRegime ?? null,
      entryPriceBucket: position.entryPriceBucket ?? null,
      entryStrategyType: position.entryStrategyType ?? null,
      entrySignalTier: position.entrySignalTier ?? null,
      entrySignalMultiplier: position.entrySignalMultiplier ?? null,
      entryPressureScore: position.entryPressureScore ?? null,
      secondsLeft: position.secondsLeftAtEntry ?? null,
      entryAvgPrice: position.entryAvgPrice,
      entryShares: position.shares,
      entryCost: position.entryCost,
      hedgeActive: position.status === "hedged",
      hedgeSide: position.hedgeSide ?? null,
      hedgeShares: position.hedgeShares ?? 0,
      hedgeAvgPrice: position.hedgeAvgPrice ?? null,
      hedgeCost: position.hedgeCost ?? 0,
      mainValue,
      hedgeValue,
      totalCost,
      grossPnl,
      fees,
      netPnl: pnl,
      roiPct: totalCost > 0 ? pnl / totalCost * 100 : 0,
      exitReason: "settlement",
      resolvedWinner: winner
    });
  }

  private async snapshot(market: MarketInfo, btc: BtcTick, moveBps: number, velocityBps: number, btcRegime: BtcRegime, secondInBucket: number, upBook: OrderBook, downBook: OrderBook) {
    const settings = await readSettings();
    const kelly = await this.kellySizing(settings);
    const upAsk = bestAsk(upBook);
    const downAsk = bestAsk(downBook);
    const signal = this.entrySignal(settings, moveBps, velocityBps, secondInBucket, upAsk, downAsk);
    const signalSide = signal?.side ?? null;
    const trendAtEntry = btcRegime.label;
    const signalBook = signalSide ? bookForSide(signalSide, upBook, downBook) : null;
    const signalAsk = signalBook ? bestAsk(signalBook) : null;
    const signalSpread = signalBook ? spreadCents(signalBook) : null;
    const sizing = signalBook && signalAsk != null && signalSpread != null
      ? await this.entrySizing(settings, signalBook, signalAsk, signalSpread, signal?.multiplier ?? 1)
      : null;
    await recordSnapshot({
      marketSlug: market.slug,
      secondInBucket,
      btcPrice: btc.price,
      btcOpen: btc.open,
      btcSource: btc.source,
      moveBps,
      velocityBps,
      btcRegime,
      regimeLabel: btcRegime.label,
      regimeMoveDirection: btcRegime.moveDirection,
      regimeVelocityDirection: btcRegime.velocityDirection,
      regimeStrength: btcRegime.strength,
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
      kellySource: kelly.source,
      signalSide,
      trendAtEntry,
      tailwind: signalSide ? btcRegime.entrySide === signalSide : null,
      secondsLeft: 300 - secondInBucket,
      entryPriceBucket: signalAsk != null ? priceBucket(signalAsk) : null,
      entryStrategyType: signal?.strategyType ?? null,
      entrySignalTier: signal?.tier ?? null,
      entrySignalMultiplier: signal?.multiplier ?? null,
      entryPressureScore: signal?.pressureScore ?? null,
      depthQualityTargetUsdc: sizing?.targetUsdc ?? null,
      depthCapUsdc: sizing?.depthCapUsdc ?? null,
      depthToKellyRatio: sizing?.depthToKellyRatio ?? null,
      qualityMultiplier: sizing?.qualityMultiplier ?? null,
      sizeLimitedBy: sizing?.limitedBy ?? null
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

  private async entrySizing(settings: Settings, book: OrderBook, ask: number, spread: number, entryTierMultiplier = 1): Promise<EntrySizing> {
    const maxPrice = ask + settings.maxEntrySlippageCents / 100;
    const depthRawUsdc = askDepthUsdc(book, maxPrice);
    const depthCapUsdc = depthRawUsdc * settings.depthUsageRatio;
    const kelly = await this.kellySizing(settings);
    const depthToKellyRatio = kelly.targetUsdc > 0 ? depthCapUsdc / kelly.targetUsdc : 0;
    const qualityMultiplier = this.qualityMultiplier(settings, spread, depthToKellyRatio);
    const maxShareUsdc = settings.maxShares * ask;
    const preQualityTarget = Math.min(kelly.targetUsdc, depthCapUsdc, maxShareUsdc, this.state.paperBalance);
    const targetUsdc = preQualityTarget * qualityMultiplier * entryTierMultiplier;
    const effectiveMinOrderUsdc = this.effectiveMinOrderUsdc(settings, kelly.targetUsdc * entryTierMultiplier);
    const caps = [
      ["kelly", kelly.targetUsdc],
      ["depth", depthCapUsdc],
      ["shares", maxShareUsdc],
      ["balance", this.state.paperBalance]
    ] as const;
    const limitedBy = caps.reduce((best, item) => item[1] < best[1] ? item : best, caps[0])[0];

    return {
      targetUsdc,
      effectiveMinOrderUsdc,
      kellyTargetUsdc: kelly.targetUsdc,
      depthCapUsdc,
      depthRawUsdc,
      spreadCents: spread,
      depthToKellyRatio,
      qualityMultiplier,
      entryTierMultiplier,
      limitedBy,
      kelly
    };
  }

  private qualityMultiplier(settings: Settings, spread: number, depthToKellyRatio: number) {
    let spreadMultiplier = 1;
    if (spread > settings.okSpreadCents) spreadMultiplier = 0;
    else if (spread > settings.goodSpreadCents) spreadMultiplier = 0.7;

    let depthMultiplier = 1;
    if (depthToKellyRatio < settings.minDepthToKellyRatio) depthMultiplier = settings.thinDepthMultiplier;
    else if (depthToKellyRatio < 1) depthMultiplier = settings.okDepthMultiplier;

    return clamp(spreadMultiplier * depthMultiplier, 0, 1);
  }

  private effectiveMinOrderUsdc(settings: Settings, kellyTargetUsdc: number) {
    return Math.max(1, Math.min(settings.minOrderUsdc, Math.max(kellyTargetUsdc, 0)));
  }

  private action(action: string) {
    this.state.lastAction = action;
  }

  private decide(status: string, side: Side | null, reason: string, details: Record<string, unknown>) {
    this.state.decision = {
      checkedAt: new Date().toISOString(),
      enabled: status !== "paused",
      status,
      side,
      reason,
      details
    };
  }
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function priceBucket(price: number) {
  if (price <= 0.35) return "<=0.35";
  if (price <= 0.50) return "0.36-0.50";
  if (price <= 0.60) return "0.51-0.60";
  if (price <= 0.70) return "0.61-0.70";
  if (price <= 0.80) return "0.71-0.80";
  return ">0.80";
}

function pressureScore(moveBps: number, velocityBps: number) {
  return moveBps + velocityBps * 1.5;
}

function sidePressure(side: Side, pressure: number) {
  return side === "UP" ? pressure : -pressure;
}

function signal(side: Side, strategyType: string, tier: string, multiplier: number, pressure: number, reason: string, timing: EntryTiming): EntrySignal {
  return { side, strategyType, tier, multiplier, pressureScore: pressure, reason, timing };
}

function bestSignal(...signals: Array<EntrySignal | null>) {
  const valid = signals.filter(Boolean) as EntrySignal[];
  if (!valid.length) return null;
  return valid.sort((a, b) => {
    if (b.multiplier !== a.multiplier) return b.multiplier - a.multiplier;
    return Math.abs(b.pressureScore) - Math.abs(a.pressureScore);
  })[0];
}

function trendEntryForSide(settings: Settings, side: Side, ask: number | null, pressure: number, moveBps: number, velocityBps: number, timing: EntryTiming): EntrySignal | null {
  if (ask == null || ask > settings.maxEntryPrice) return null;
  const support = sidePressure(side, pressure);
  const moveSupport = side === "UP" ? moveBps : -moveBps;
  const velocitySupport = side === "UP" ? velocityBps : -velocityBps;
  const trendConfirmed = moveSupport >= settings.minBtcMoveBps * 0.8 * timing.thresholdMultiplier && velocitySupport >= settings.minBtcVelocityBps * timing.thresholdMultiplier;
  const strongTrendConfirmed = moveSupport >= settings.minBtcMoveBps * 2 * timing.thresholdMultiplier && velocitySupport >= settings.minBtcVelocityBps * 2 * timing.thresholdMultiplier;
  if (ask <= 0.62 - timing.pricePenalty && trendConfirmed && support >= settings.minBtcMoveBps * timing.thresholdMultiplier) {
    return signal(side, "trend_entry", "trend_standard", 1 * timing.sizeMultiplier, pressure, "趋势顺风入场", timing);
  }
  if (ask <= 0.68 - timing.pricePenalty && strongTrendConfirmed && support >= settings.minBtcMoveBps * 2.2 * timing.thresholdMultiplier) {
    return signal(side, "trend_entry", "trend_strong_chase", 0.45 * timing.sizeMultiplier, pressure, "强趋势追单减仓", timing);
  }
  return null;
}

function mispriceEntryForSide(settings: Settings, side: Side, ask: number | null, pressure: number, timing: EntryTiming): EntrySignal | null {
  if (ask == null || ask > settings.maxEntryPrice) return null;
  const support = sidePressure(side, pressure);
  const hardSupport = timing.phase === "normal" ? 0 : settings.minBtcMoveBps * (timing.thresholdMultiplier - 1);
  if (ask <= 0.45 - timing.pricePenalty * 0.5 && support >= hardSupport) {
    return signal(side, "misprice_entry", "hard_misprice", 0.85 * timing.sizeMultiplier, pressure, "硬错价入场", timing);
  }
  if (ask <= 0.52 - timing.pricePenalty && support >= settings.minBtcVelocityBps * 2 * timing.thresholdMultiplier) {
    return signal(side, "misprice_entry", "supported_misprice", 0.75 * timing.sizeMultiplier, pressure, "压力支持错价", timing);
  }
  return null;
}

function reverseFavoriteEntry(settings: Settings, pressure: number, upAsk: number | null, downAsk: number | null, timing: EntryTiming): EntrySignal | null {
  const pressureSide: Side | null = pressure >= settings.minBtcMoveBps ? "UP" : pressure <= -settings.minBtcMoveBps ? "DOWN" : null;
  if (!pressureSide) return null;
  const favoriteAsk = pressureSide === "UP" ? upAsk : downAsk;
  const weakAsk = pressureSide === "UP" ? downAsk : upAsk;
  if (favoriteAsk == null || weakAsk == null) return null;
  const support = Math.abs(pressure);
  if (weakAsk <= 0.58 && weakAsk > 0.45 && favoriteAsk <= 0.62 - timing.pricePenalty && support >= settings.minBtcMoveBps * 1.5 * timing.thresholdMultiplier) {
    return signal(pressureSide, "reverse_favorite_entry", "reverse_favorite", 0.8 * timing.sizeMultiplier, pressure, "弱错价不接，买压力方向", timing);
  }
  return null;
}

function entryTiming(settings: Settings, secondInBucket: number, pressure: number, velocityBps: number): EntryTiming {
  const secondsLeft = Math.max(0, 300 - secondInBucket);
  const strength = Math.abs(pressure);
  const velocityStrength = Math.abs(velocityBps);
  const strongPressure = strength >= settings.minBtcMoveBps * 2.2;
  const strongVelocity = velocityStrength >= settings.minBtcVelocityBps * 1.5;

  if (secondInBucket < 15) {
    return {
      phase: "too_early",
      allowed: false,
      secondsLeft,
      thresholdMultiplier: 99,
      pricePenalty: 0.12,
      sizeMultiplier: 0,
      reason: "开局数据太少"
    };
  }

  if (secondInBucket < settings.entryStartSeconds) {
    return {
      phase: "early_confirm",
      allowed: strongPressure && strongVelocity,
      secondsLeft,
      thresholdMultiplier: 1.35,
      pricePenalty: 0.04,
      sizeMultiplier: 0.55,
      reason: "早段只接强动量强速度"
    };
  }

  if (secondInBucket <= settings.entryEndSeconds) {
    return {
      phase: "normal",
      allowed: true,
      secondsLeft,
      thresholdMultiplier: 1,
      pricePenalty: 0,
      sizeMultiplier: 1,
      reason: "正常信号区"
    };
  }

  if (secondsLeft >= 90) {
    return {
      phase: "late_confirm",
      allowed: strength >= settings.minBtcMoveBps * 1.6 && velocityStrength >= settings.minBtcVelocityBps,
      secondsLeft,
      thresholdMultiplier: 1.2,
      pricePenalty: 0.04,
      sizeMultiplier: 0.7,
      reason: "后段需要更强信号和更低价格"
    };
  }

  if (secondsLeft >= 60) {
    return {
      phase: "last_chance",
      allowed: strongPressure && strongVelocity,
      secondsLeft,
      thresholdMultiplier: 1.45,
      pricePenalty: 0.08,
      sizeMultiplier: 0.45,
      reason: "末段只接极强信号"
    };
  }

  return {
    phase: "too_late",
    allowed: false,
    secondsLeft,
    thresholdMultiplier: 99,
    pricePenalty: 0.12,
    sizeMultiplier: 0,
    reason: "剩余时间太少"
  };
}

function classifyBtcRegime(settings: Settings, moveBps: number, velocityBps: number): BtcRegime {
  const moveDirection = direction(moveBps, settings.minBtcMoveBps);
  const velocityDirection = direction(velocityBps, settings.minBtcVelocityBps);
  const strength = Math.abs(moveBps) + Math.abs(velocityBps);

  if (moveDirection === "up" && velocityDirection === "up") {
    return { label: "uptrend", moveDirection, velocityDirection, entrySide: "UP", strength };
  }
  if (moveDirection === "down" && velocityDirection === "down") {
    return { label: "downtrend", moveDirection, velocityDirection, entrySide: "DOWN", strength };
  }
  if (moveDirection === "up" && velocityDirection === "down") {
    return { label: "up_reversal", moveDirection, velocityDirection, entrySide: null, strength };
  }
  if (moveDirection === "down" && velocityDirection === "up") {
    return { label: "down_reversal", moveDirection, velocityDirection, entrySide: null, strength };
  }
  return { label: "chop", moveDirection, velocityDirection, entrySide: null, strength };
}

function direction(value: number, threshold: number): BtcRegime["moveDirection"] {
  if (value >= threshold) return "up";
  if (value <= -threshold) return "down";
  return "flat";
}

function dynamicHedgeRatio(baseRatio: number, ask: number) {
  if (ask <= 0.45) return baseRatio;
  if (ask <= 0.55) return baseRatio * 0.75;
  return baseRatio * 0.5;
}

function hedgeImprovement(settings: Settings, position: Position, hedgeCost: number, hedgeShares: number, hedgeAvgPrice: number) {
  const entryFee = tradeFee(settings, position.shares, position.entryAvgPrice);
  const hedgeFee = tradeFee(settings, hedgeShares, hedgeAvgPrice);
  const unhedgedWorstLoss = position.entryCost + entryFee;
  const totalCost = position.entryCost + hedgeCost;
  const fees = entryFee + hedgeFee;
  const mainWinsPnl = position.shares - totalCost - fees;
  const hedgeWinsPnl = hedgeShares - totalCost - fees;
  const hedgedWorstLoss = Math.max(0, -mainWinsPnl, -hedgeWinsPnl);
  const improvementPct = unhedgedWorstLoss > 0 ? (unhedgedWorstLoss - hedgedWorstLoss) / unhedgedWorstLoss * 100 : 0;
  return {
    unhedgedWorstLoss,
    hedgedWorstLoss,
    improvementPct,
    mainWinsPnl,
    hedgeWinsPnl,
    entryFee,
    hedgeFee
  };
}

function tradeFee(settings: Settings, shares: number, price: number) {
  const cryptoFee = shares * 0.072 * price * (1 - price);
  const extraBuffer = shares * price * settings.feeBps / 10000;
  return cryptoFee + extraBuffer;
}

function isAdverseRegime(side: Side, regime: BtcRegime, profitCents: number) {
  if (profitCents >= 0) return false;

  if (side === "UP") {
    if (regime.label === "downtrend") return true;
    if (regime.label === "up_reversal" && profitCents < 0) return true;
    return regime.velocityDirection === "down" && regime.moveDirection !== "up";
  }

  if (regime.label === "uptrend") return true;
  if (regime.label === "down_reversal" && profitCents < 0) return true;
  return regime.velocityDirection === "up" && regime.moveDirection !== "down";
}
