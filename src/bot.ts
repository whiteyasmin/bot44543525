import * as fs from "fs";
import * as path from "path";
import { writeDecisionAudit } from "./decisionAudit";
import { logger } from "./logger";
import { startLatencyMonitor, stopLatencyMonitor, recordLatency, getDynamicParams, getLatencySnapshot } from "./latency";
import { getExecutionTelemetry, recordExecutionLatency, resetExecutionTelemetry } from "./telemetry";
import { getCurrentRound15m, prefetchNextRound, Round15m } from "./market";
import {
  startPriceFeed, getBtcPrice,
  getBtcMovePct, getBtcDirection,
  getTakerFlowRatio, getTakerFlowTrend,
  getVolumeSpikeInfo, getLargeOrderInfo,
  getDepthImbalance, getLiquidationInfo, getFundingRateInfo,
  setRoundSecsLeft, setRoundStartPrice, stopPriceFeed,
  getRecentMomentum,
} from "./btcPrice";
import { HISTORY_FILE, PAPER_HISTORY_FILE } from "./audit";
import { clearPaperRuntimeState, loadPaperRuntimeState, savePaperRuntimeState } from "./paperRuntimeState";
import { RoundMarketState } from "./marketState";
import { estimateFilledShares, evaluateEntryOrderbook } from "./executionManager";
import { planHedgeEntry } from "./executionPlanner";
import {
  evaluateMispricingOpportunity,
  getDirectionalBias as getDirectionalBiasSignal,
} from "./strategyEngine";
import { Trader, type TraderDiagnostics } from "./trader";

// ── 15分钟对冲机器人参数 (延迟相关参数由 getDynamicParams() 提供) ──
const MIN_SHARES      = 3;        // 最少3份, 低于此不开仓 (从5降低, 避免小余额死循环)
const MAX_SHARES      = 150;      // 单腿上限150份 (低价入场EV+大, 允许更大仓位)
const DUMP_THRESHOLD  = 0.10;     // ask 跌幅 ≥10% 触发Leg1
const ENTRY_WINDOW_S  = 660;      // 开局11分钟内监控砸盘, 窗口关闭=ROUND-660=240s=MIN_ENTRY_SECS
const ROUND_DURATION  = 900;      // 15分钟
const TAKER_FEE       = 0.02;     // Polymarket taker fee ~2%
const MIN_ENTRY_SECS  = 240;      // 剩余 <4分钟不开新仓 (放宽: 低价入场EV+即使时间短, 4min足够结算)
const MAX_ENTRY_ASK   = 0.35;     // Leg1 入场价上限 (实盘: ≤$0.35时EV≥$0.15/份@50%胜率)
const MIN_ENTRY_ASK   = 0.25;     // Leg1 入场价下限, 低于此成功概率极低
const DIRECTIONAL_MOVE_PCT = 0.0012;       // 回合内价格移动超过 0.12% 才形成方向偏置
const MOMENTUM_WINDOW_SEC = 60;            // 短期动量窗口 60秒
const MOMENTUM_CONTRA_PCT = 0.0010;        // BTC 60s内反方向移动超过 0.10% 才拒绝dump
const TREND_WINDOW_SEC = 180;              // 中期趋势窗口 180秒
const TREND_CONTRA_PCT = 0.0024;           // BTC 180s内单边超过 0.24% 才视为强真实趋势

const BASE_BUDGET_PCT = 0.18;             // 默认轻仓基准 (Kelly分层会自动覆盖)
const KELLY_WIN_RATE = 0.50;              // Kelly估计胜率 (保守)
const KELLY_FRACTION = 0.5;               // Half-Kelly (避免过度下注)
const LIMIT_RACE_ENABLED = true;           // 启用 Limit+FAK 赛跑
const LIMIT_RACE_OFFSET = 0.01;            // limit 挂单价 = ask - offset
const LIMIT_RACE_FAST_OFFSET = 0.03;       // dump 快速时更激进 (多省1c/份)
const LIMIT_RACE_TIMEOUT_MS = 900;         // limit 等待上限 ms (900ms: maker 0%fee vs taker 2%fee, 多等300ms值得)
const LIMIT_RACE_POLL_MS = 50;             // 每 50ms 检查一次
const LIMIT_RACE_FAST_DUMP_THRESHOLD = 0.15; // dump>=15% 视为快速dump
const DUAL_SIDE_ENABLED = true;            // 启用双侧预挂单做市
const DUAL_SIDE_SUM_CEILING = 0.93;        // 预挂单目标: 双侧sum ≤ 此值 (收紧→只在更便宜的价位挂单→EV+更高)
const DUAL_SIDE_OFFSET = 0.02;             // 挂单价 = currentAsk - offset (最少, 实际用动态offset)
const DUAL_SIDE_REFRESH_MS = 3000;         // 每3秒刷新挂单价格
const DUAL_SIDE_BUDGET_PCT = 0.25;         // 预挂单仓位 (单侧) - 方向性策略EV+加大仓位
const DUAL_SIDE_MIN_SECS = 540;            // 仅在回合前9分钟内预挂
const DUAL_SIDE_MIN_ASK = 0.20;            // 挂单价下限
const DUAL_SIDE_MAX_ASK = 0.35;            // 挂单价上限 (≤0.35保证EV+$0.15/share@50%胜率)

const DUAL_SIDE_MIN_DRIFT = 0.01;          // 价格偏移>此值才重挂

// ── 趋势追涨: 强趋势方向入场 (≤$0.50时60%胜率即EV+$0.10/份) ──
const TREND_TRADE_ENABLED = true;           // 启用趋势追涨
const TREND_MAX_ASK = 0.50;                 // 趋势入场上限 ($0.50: 60%胜率即breakeven, >60%即EV+)
const TREND_KELLY_WIN_RATE = 0.58;          // 趋势Kelly胜率 (强趋势假设58%)
const TREND_MIN_ELAPSED = 120;              // 趋势确认最少120s (比dump的90s更长, 趋势需要更多数据)
const TREND_CONFIRM_CYCLES = 3;             // 连续3个cycle确认趋势才入场
const LIQUIDITY_FILTER_SUM = 1.10;          // UP+DOWN best ask之和>此值 说明spread太大无edge, 不挂预挂单
const SUM_DIVERGENCE_MAX = 1.03;            // 入场时 upAsk+downAsk > 此值 → 拒绝入场 (sum≥1.03=市场公平定价, 无dump错定价edge)
const SUM_DIVERGENCE_MIN = 0.85;            // 入场时 upAsk+downAsk < 此值 → 方向性强、砸盘更可信
const DUMP_CONFIRM_CYCLES = 2;              // 连续 N 个循环看到 dump 才触发入场 (从3降到2: 保留确认但不过分延迟)
const MIN_ENTRY_ELAPSED = 60;               // 回合开始至少60s后才允许反应式入场 (60s够检测砸盘, 更早入场=更多机会)
const TREND_BUDGET_BOOST = 0.03;            // 趋势一致在Kelly基础上再加3%
const TREND_BUDGET_CUT = 0.02;              // 方向中性时在Kelly基础上减2%
const BALANCE_ESTIMATE_MIN_PCT = 0.70;
const BALANCE_ESTIMATE_MAX_PCT = 1.15;

// ── 资金安全守护 ──
const MIN_BALANCE_TO_TRADE = 5;             // 余额<$5停止交易 (不够开最小仓)
const MAX_SESSION_LOSS_PCT = 0.35;          // 单次会话亏损超过初始资金35%→暂停交易 (更早止损保留本金)
const CONSECUTIVE_LOSS_PAUSE = 5;           // 连续亏损5次→暂停1轮冷静期 (更快适应市场regime变化)

export type PaperSessionMode = "session" | "persistent";

export interface Hedge15mState {
  botRunning: boolean;
  tradingMode: "live" | "paper";
  paperSessionMode: PaperSessionMode;
  status: string;
  roundPhase: string;
  roundDecision: string;
  btcPrice: number;
  secondsLeft: number;
  roundElapsed: number;
  roundProgressPct: number;
  entryWindowLeft: number;
  canOpenNewPosition: boolean;
  nextRoundIn: number;
  currentMarket: string;
  upAsk: number;
  downAsk: number;
  balance: number;
  totalProfit: number;
  wins: number;
  losses: number;
  skips: number;
  totalRounds: number;
  history: HedgeHistoryEntry[];
  hedgeState: string;
  hedgeLeg1Dir: string;
  hedgeLeg1Price: number;
  hedgeTotalCost: number;
  dumpDetected: string;
  maxEntryAsk: number;
  activeStrategyMode: string;
  trendBias: string;
  trendTradeEnabled: boolean;
  trendMaxAsk: number;
  trendConfirmCount: number;
  sessionROI: number;
  rolling4hPnL: number;
  effectiveMaxAsk: number;
  askSum: number;
  dumpConfirmCount: number;
  dirAlignedCount: number;
  dirContraCount: number;
  roundMomentumRejects: number;
  roundEntryAskRejects: number;
  preOrderUpPrice: number;
  preOrderDownPrice: number;
  leg1Maker: boolean;
  // L: Taker Flow
  takerFlowRatio: number;
  takerFlowDirection: string;
  takerFlowConfidence: string;
  takerFlowTrend: string;
  takerFlowTrades: number;
  // M: Volume Spike
  volSpikeRatio: number;
  volSpikeIsSpike: boolean;
  volSpikeDirection: string;
  // N: Large Order
  largeBuyCount: number;
  largeSellCount: number;
  largeBuyVol: number;
  largeSellVol: number;
  largeDirection: string;
  largeRecent60s: number;
  // O: Depth Imbalance
  depthRatio: number;
  depthDirection: string;
  depthFresh: boolean;
  // P: Liquidation
  liqBuyVol: number;
  liqSellVol: number;
  liqDirection: string;
  liqIntensity: string;
  // Q: Funding Rate
  fundingRate: number;
  fundingDirection: string;
  fundingExtreme: boolean;
  rtDumpConfirmCycles: number;
  rtEntryWindowS: number;
  rtMinEntrySecs: number;
  rtMaxEntryAsk: number;
  rtDualSideMaxAsk: number;
  rtKellyFraction: number;
  rtTrendEnabled: boolean;
  rtTrendMaxAsk: number;
  latencyP50: number;
  latencyP90: number;
  latencyNetworkSource: string;
  latencyPingP50: number;
  latencyPingP90: number;
  latencyPingCount: number;
  latencyPingLastMs: number;
  latencyPingLastAt: number;
  latencyHttpP50: number;
  latencyHttpP90: number;
  latencyHttpCount: number;
  latencyHttpLastMs: number;
  latencyHttpLastAt: number;
  latencyCacheP50: number;
  latencyCacheP90: number;
  latencyCacheCount: number;
  latencyCacheLastMs: number;
  latencyCacheLastAt: number;
  diagnostics: {
    marketWsConnected: boolean;
    userWsConnected: boolean;
    marketWsAgeMs: number;
    userWsAgeMs: number;
    orderbookSource: string;
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
    execSignalToSubmitP50: number;
    execSubmitToAckP50: number;
    execAckToFillP50: number;
    execSignalToFillP50: number;
    execSignalToFillP90: number;
  };
}

export interface Hedge15mStartOptions {
  mode?: "live" | "paper";
  paperBalance?: number;
  paperSessionMode?: PaperSessionMode;
  // ── 运行时可调参数 ──
  dumpConfirmCycles?: number;       // 砸盘确认周期: 1/2/3
  entryWindowPreset?: "short" | "medium" | "long";  // 入场窗口: 短4min/中6min/长8min
  maxEntryAsk?: number;             // 反应入场上限: 0.35
  dualSideMaxAsk?: number;          // 预挂上限: 0.30/0.35
  kellyFraction?: number;           // 仓位计算: 0.25/0.50/0.75
  trendEnabled?: boolean;           // 趋势追涨: 开/关
  trendMaxAsk?: number;             // 趋势入场上限: 0.45/0.50/0.55
}

export interface HedgeHistoryEntry {
  time: string;
  result: string;
  leg1Dir: string;
  leg1Price: number;        // Leg1 入场 ask (报价)
  totalCost: number;
  profit: number;
  cumProfit: number;
  // ── 真实成交数据 ──
  exitType?: string;        // "settlement"
  exitReason?: string;      // 人类可读退出理由
  leg1Shares?: number;      // Leg1 实际成交份数
  leg1FillPrice?: number;   // Leg1 真实平均成交价
  orderId?: string;         // 关联订单ID (截取前12位)
  estimated?: boolean;      // 是否含估算数据
  profitBreakdown?: string; // 盈亏计算明细
  entrySource?: string;     // dual-side-preorder | reactive-mispricing
  entryTrendBias?: string;  // up | down | flat
  entrySecondsLeft?: number; // 入场时回合剩余秒数
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timeStr(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** 给 Promise 加超时保护，超时返回 null 而不 reject */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function getHotBestPrices(trader: Trader, tokenId: string): Promise<{ bid: number | null; ask: number | null; spread: number; askDepth: number; bidDepth: number } | null> {
  const startedAt = Date.now();
  const cached = trader.peekBestPrices(tokenId);
  if (cached) {
    recordLatency(Math.max(1, Date.now() - startedAt), "cache");
    return cached;
  }
  const result = await withTimeout(trader.getBestPrices(tokenId), getDynamicParams().orderbookTimeoutMs);
  if (result) {
    recordLatency(Math.max(1, Date.now() - startedAt), "http");
  }
  return result;
}

function getDefaultTraderDiagnostics(): TraderDiagnostics {
  return {
    marketWsConnected: false,
    userWsConnected: false,
    marketWsAgeMs: 0,
    userWsAgeMs: 0,
    orderbookSource: "idle",
    localBookReady: false,
    trackedTokenCount: 0,
    localBookTokenCount: 0,
    fallbackActive: false,
    marketWsDisconnects: 0,
    userWsDisconnects: 0,
    marketWsReconnects: 0,
    userWsReconnects: 0,
    fallbackTransitions: 0,
    lastFallbackAt: 0,
    localBookMaxDepth: 0,
    localBookStaleCount: 0,
    localBookCrossedCount: 0,
  };
}

export class Hedge15mEngine {
  running = false;
  private servicesStarted = false;
  private trader: Trader | null = null;
  private tradingMode: "live" | "paper" = "live";
  private paperSessionMode: PaperSessionMode = "session";
  private historyFile = HISTORY_FILE;

  private status = "空闲";
  private balance = 0;
  private initialBankroll = 0;
  private totalProfit = 0;
  private wins = 0;
  private losses = 0;
  private skips = 0;
  private totalRounds = 0;
  private history: HedgeHistoryEntry[] = [];

  private secondsLeft = 0;
  private currentMarket = "";
  private currentConditionId = "";
  private upAsk = 0;
  private downAsk = 0;

  // Hedge state
  private hedgeState: "off" | "watching" | "leg1_pending" | "leg1_filled" | "done" = "off";
  private leg1Dir = "";
  private leg1Price = 0;
  private leg1Shares = 0;
  private leg1Token = "";
  private totalCost = 0;
  private dumpDetected = "";
  private roundStartBtcPrice = 0; // 用于结算方向回退
  private negRisk = false;        // 当前市场的 negRisk 标志
  private sessionProfit = 0;      // 本次会话累计盈亏
  private leg1FillPrice = 0;         // Leg1 真实平均成交价
  private leg1OrderId = "";          // Leg1 订单ID
  private leg1FilledAt = 0;
  private leg1Estimated = false;       // Leg1 成交是否为估算值
  private leg1EntryInFlight = false;
  private leg1AttemptedThisRound = false;
  private roundMomentumRejects = 0;
  private roundEntryAskRejects = 0;
  private loopRunId = 0;
  private activeStrategyMode: "none" | "mispricing" | "trend" = "none";
  private currentTrendBias: "up" | "down" | "flat" = "flat";
  private currentDumpDrop = 0;               // 当前dump跌幅(用于limit race offset)
  private leg1MakerFill = false;             // Leg1是否maker成交
  private preOrderUpId = "";                 // 双侧预挂单: UP token GTC orderId
  private preOrderDownId = "";               // 双侧预挂单: DOWN token GTC orderId
  private preOrderUpPrice = 0;
  private preOrderDownPrice = 0;
  private preOrderUpShares = 0;
  private preOrderDownShares = 0;
  private preOrderUpToken = "";
  private preOrderDownToken = "";
  private preOrderLastRefresh = 0;
  private leg1EntrySource = "";
  private leg1EntryTrendBias: "up" | "down" | "flat" = "flat";
  private leg1EntrySecondsLeft = 0;
  private roundRejectReasonCounts = new Map<string, number>();
  private rollingPnL: Array<{ ts: number; profit: number }> = []; // 滚动P/L记录
  private dumpConfirmCount = 0;             // 连续砸盘确认计数
  private lastDumpCandidateDir = "";        // 上个cycle的dump方向
  private lastEntrySkipKey = "";            // 去重: 上次入场跳过的key (dir:price)
  private lastDumpLogKey = "";              // 去重: 上次SUM过高跳过日志的key
  private lastSignalSkipKey = "";           // 去重: 上次信号门控跳过的key
  private lastRepricingRejectKey = "";      // 去重: 上次重定价拒绝的key
  private dirAlignedCount = 0;              // 入场时方向一致信号数 (7源)
  private dirContraCount = 0;               // 入场时方向反向信号数 (7源)
  private trendConfirmCount = 0;            // 趋势连续确认计数
  private lastTrendConfirmDir = "";         // 上个cycle的趋势方向
  private consecutiveLosses = 0;            // 连续亏损计数 (资金安全守护)

  // ── 运行时可调参数 (覆盖 const) ──
  private rtDumpConfirmCycles = DUMP_CONFIRM_CYCLES;
  private rtEntryWindowS = ENTRY_WINDOW_S;
  private rtMinEntrySecs = MIN_ENTRY_SECS;
  private rtMaxEntryAsk = MAX_ENTRY_ASK;
  private rtDualSideMaxAsk = DUAL_SIDE_MAX_ASK;
  private rtKellyFraction = KELLY_FRACTION;
  private rtTrendEnabled = TREND_TRADE_ENABLED;
  private rtTrendMaxAsk = TREND_MAX_ASK;

  // Market state layer
  private marketState = new RoundMarketState();

  private resetRoundRejectStats(): void {
    this.roundMomentumRejects = 0;
    this.roundEntryAskRejects = 0;
    this.roundRejectReasonCounts.clear();
  }

  private trackRoundRejectReason(reason: string): void {
    const normalized = reason.trim();
    if (!normalized) return;
    this.roundRejectReasonCounts.set(normalized, (this.roundRejectReasonCounts.get(normalized) || 0) + 1);
  }

  private getTopRoundRejectReasons(limit = 5): Array<{ detail: string; count: number }> {
    return Array.from(this.roundRejectReasonCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([detail, count]) => ({ detail, count }));
  }

  private writeRoundAudit(event: string, details: Record<string, unknown> = {}): void {
    writeDecisionAudit(event, {
      tradingMode: this.tradingMode,
      paperSessionMode: this.paperSessionMode,
      market: this.currentMarket,
      conditionId: this.currentConditionId,
      secondsLeft: this.secondsLeft,
      status: this.status,
      hedgeState: this.hedgeState,
      activeStrategyMode: this.activeStrategyMode,
      trendBias: this.currentTrendBias,
      leg1Dir: this.leg1Dir,
      leg1Price: this.leg1Price,
      leg1FillPrice: this.leg1FillPrice,
      leg1Shares: this.leg1Shares,
      totalCost: this.totalCost,
      balance: this.balance,
      totalProfit: this.totalProfit,
      dumpDetected: this.dumpDetected,
      rejectCounts: {
        momentum: this.roundMomentumRejects,
        entryAsk: this.roundEntryAskRejects,
      },
      topRejectReasons: this.getTopRoundRejectReasons(),
      ...details,
    });
  }

  private logRoundRejectSummary(reason: string): void {
    const parts: string[] = [];
    if (this.roundMomentumRejects > 0) parts.push(`momentum=${this.roundMomentumRejects}`);
    if (this.roundEntryAskRejects > 0) parts.push(`entryAsk=${this.roundEntryAskRejects}`);
    const topReasons = Array.from(this.roundRejectReasonCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5);
    if (parts.length > 0) {
      logger.info(`HEDGE15M ROUND SUMMARY: ${reason}, rejects(${parts.join(", ")})`);
      for (const [detail, count] of topReasons) {
        logger.info(`HEDGE15M REJECT DETAIL: ${count}x ${detail}`);
      }
    } else {
      logger.info(`HEDGE15M ROUND SUMMARY: ${reason}, no dump detected`);
    }
    this.writeRoundAudit("round-no-entry", {
      reason,
      summary: parts.length > 0 ? parts.join(", ") : "no_dump_detected",
      topRejectReasons: topReasons.map(([detail, count]) => ({ detail, count })),
    });
  }

  private onLeg1Opened(): void {
    this.leg1AttemptedThisRound = true;
  }

  private isActiveRun(runId: number): boolean {
    return this.running && this.loopRunId === runId;
  }

  private getRoundDirectionalBias(): "up" | "down" | "flat" {
    return getDirectionalBiasSignal({
      roundStartPrice: this.roundStartBtcPrice,
      btcNow: getBtcPrice(),
      shortMomentum: getRecentMomentum(MOMENTUM_WINDOW_SEC),
      trendMomentum: getRecentMomentum(TREND_WINDOW_SEC),
      directionalMovePct: DIRECTIONAL_MOVE_PCT,
      momentumContraPct: MOMENTUM_CONTRA_PCT,
      trendContraPct: TREND_CONTRA_PCT,
    });
  }

  private getEffectiveMaxAsk(): number {
    return this.rtDualSideMaxAsk;
  }

  private getRolling4hPnL(): number {
    const cutoff = Date.now() - 4 * 3600_000;
    this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
    return this.rollingPnL.reduce((sum, item) => sum + item.profit, 0);
  }

  private recordRollingPnL(profit: number): void {
    this.rollingPnL.push({ ts: Date.now(), profit });
    const cutoff = Date.now() - 4 * 3600_000;
    this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
  }

  private getMaxEntryAsk(): number {
    return this.getEffectiveMaxAsk();
  }

  /** 方向信号不提升入场上限: 低价才是真正的edge */
  private getDynamicMaxEntryAsk(_entryDir?: string): number {
    return this.getMaxEntryAsk();
  }

  private getRoundPhase(): string {
    if (!this.running) return "idle";
    if (this.hedgeState === "off") return "booting";
    if (this.hedgeState === "leg1_pending") return "leg1_pending";
    if (this.hedgeState === "leg1_filled") return "leg1_filled";
    if (this.hedgeState === "watching") {
      if (this.secondsLeft < this.rtMinEntrySecs) return "waiting_next_round";
      return "watching";
    }
    if (this.hedgeState === "done") {
      if (this.totalCost > 0) return "settling";
      return "waiting_next_round";
    }
    return this.hedgeState;
  }

  private getRoundDecision(): string {
    if (!this.running) return "已停止";
    if (this.hedgeState === "off") return this.status || "等待首轮市场数据";
    if (this.status.startsWith("跳过:")) return this.status;
    if (this.status === "窗口到期,无砸盘") return this.status;
    if (this.hedgeState === "leg1_pending") return "Leg1 下单中";
    if (this.hedgeState === "leg1_filled") return "已成交Leg1, 持有到结算";
    if (this.hedgeState === "watching") return this.secondsLeft >= this.rtMinEntrySecs ? "本轮仍在观察窗口" : "本轮入场窗已关闭";
    return this.status || "等待中";
  }

  getState(): Hedge15mState {
    const dp = getDynamicParams();
    const latency = getLatencySnapshot();
    const exec = getExecutionTelemetry();
    const traderDiag = this.trader ? this.trader.getDiagnostics() : getDefaultTraderDiagnostics();
    const secondsLeft = Math.max(0, Math.min(ROUND_DURATION, this.secondsLeft));
    const hasRoundClock = secondsLeft > 0;
    const roundElapsed = hasRoundClock ? Math.max(0, Math.min(ROUND_DURATION, ROUND_DURATION - secondsLeft)) : 0;
    const roundProgressPct = hasRoundClock && ROUND_DURATION > 0 ? (roundElapsed / ROUND_DURATION) * 100 : 0;
    const entryWindowLeft = Math.max(0, secondsLeft - this.rtMinEntrySecs);
    return {
      botRunning: this.running,
      tradingMode: this.tradingMode,
      paperSessionMode: this.paperSessionMode,
      status: this.status,
      roundPhase: this.getRoundPhase(),
      roundDecision: this.getRoundDecision(),
      btcPrice: this.servicesStarted ? getBtcPrice() : 0,
      secondsLeft,
      roundElapsed,
      roundProgressPct,
      entryWindowLeft,
      canOpenNewPosition: this.running && this.hedgeState === "watching" && secondsLeft >= this.rtMinEntrySecs,
      nextRoundIn: secondsLeft,
      currentMarket: this.currentMarket,
      upAsk: this.upAsk,
      downAsk: this.downAsk,
      balance: this.balance,
      totalProfit: this.totalProfit,
      wins: this.wins,
      losses: this.losses,
      skips: this.skips,
      totalRounds: this.totalRounds,
      history: this.history.slice(-100),
      hedgeState: this.hedgeState,
      hedgeLeg1Dir: this.leg1Dir,
      hedgeLeg1Price: this.leg1Price,
      hedgeTotalCost: this.totalCost,
      dumpDetected: this.dumpDetected,
      maxEntryAsk: this.getMaxEntryAsk(),
      activeStrategyMode: this.activeStrategyMode,
      trendBias: this.currentTrendBias,
      trendTradeEnabled: this.rtTrendEnabled,
      trendMaxAsk: this.rtTrendMaxAsk,
      trendConfirmCount: this.trendConfirmCount,
      sessionROI: this.initialBankroll > 0 ? (this.totalProfit / this.initialBankroll) * 100 : 0,
      rolling4hPnL: this.getRolling4hPnL(),
      effectiveMaxAsk: this.getEffectiveMaxAsk(),
      askSum: this.upAsk > 0 && this.downAsk > 0 ? this.upAsk + this.downAsk : 0,
      dumpConfirmCount: this.dumpConfirmCount,
      dirAlignedCount: this.dirAlignedCount,
      dirContraCount: this.dirContraCount,
      roundMomentumRejects: this.roundMomentumRejects,
      roundEntryAskRejects: this.roundEntryAskRejects,
      preOrderUpPrice: this.preOrderUpPrice,
      preOrderDownPrice: this.preOrderDownPrice,
      leg1Maker: this.leg1MakerFill,
      // L: Taker Flow
      ...(() => { const tf = getTakerFlowRatio(); return {
        takerFlowRatio: tf.ratio,
        takerFlowDirection: tf.direction,
        takerFlowConfidence: tf.confidence,
        takerFlowTrend: getTakerFlowTrend(),
        takerFlowTrades: tf.trades,
      }; })(),
      // M: Volume Spike
      ...(() => { const vs = getVolumeSpikeInfo(); return {
        volSpikeRatio: vs.spikeRatio,
        volSpikeIsSpike: vs.isSpike,
        volSpikeDirection: vs.direction,
      }; })(),
      // N: Large Order
      ...(() => { const lo = getLargeOrderInfo(); return {
        largeBuyCount: lo.buyCount,
        largeSellCount: lo.sellCount,
        largeBuyVol: lo.buyVol,
        largeSellVol: lo.sellVol,
        largeDirection: lo.direction,
        largeRecent60s: lo.recentCount60s,
      }; })(),
      // O: Depth Imbalance
      ...(() => { const di = getDepthImbalance(); return {
        depthRatio: di.ratio,
        depthDirection: di.direction,
        depthFresh: di.fresh,
      }; })(),
      // P: Liquidation
      ...(() => { const li = getLiquidationInfo(); return {
        liqBuyVol: li.buyVol,
        liqSellVol: li.sellVol,
        liqDirection: li.direction,
        liqIntensity: li.intensity,
      }; })(),
      // Q: Funding Rate
      ...(() => { const fr = getFundingRateInfo(); return {
        fundingRate: fr.rate,
        fundingDirection: fr.direction,
        fundingExtreme: fr.extreme,
      }; })(),
      // 运行时参数 (UI显示)
      rtDumpConfirmCycles: this.rtDumpConfirmCycles,
      rtEntryWindowS: this.rtEntryWindowS,
      rtMinEntrySecs: this.rtMinEntrySecs,
      rtMaxEntryAsk: this.rtMaxEntryAsk,
      rtDualSideMaxAsk: this.rtDualSideMaxAsk,
      rtKellyFraction: this.rtKellyFraction,
      rtTrendEnabled: this.rtTrendEnabled,
      rtTrendMaxAsk: this.rtTrendMaxAsk,
      latencyP50: dp.p50,
      latencyP90: dp.p90,
      latencyNetworkSource: latency.networkSource,
      latencyPingP50: latency.pingP50,
      latencyPingP90: latency.pingP90,
      latencyPingCount: latency.pingCount,
      latencyPingLastMs: latency.pingLastMs,
      latencyPingLastAt: latency.pingLastAt,
      latencyHttpP50: latency.httpP50,
      latencyHttpP90: latency.httpP90,
      latencyHttpCount: latency.httpCount,
      latencyHttpLastMs: latency.httpLastMs,
      latencyHttpLastAt: latency.httpLastAt,
      latencyCacheP50: latency.cacheP50,
      latencyCacheP90: latency.cacheP90,
      latencyCacheCount: latency.cacheCount,
      latencyCacheLastMs: latency.cacheLastMs,
      latencyCacheLastAt: latency.cacheLastAt,
      diagnostics: {
        ...traderDiag,
        execSignalToSubmitP50: exec.signalToSubmit.p50,
        execSubmitToAckP50: exec.submitToAck.p50,
        execAckToFillP50: exec.ackToFill.p50,
        execSignalToFillP50: exec.signalToFill.p50,
        execSignalToFillP90: exec.signalToFill.p90,
      },
    };
  }

  // ── Persistence ──
  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({
        history: this.history,
        wins: this.wins,
        losses: this.losses,
        skips: this.skips,
        totalProfit: this.totalProfit,
        totalRounds: this.totalRounds,
      }, null, 2);
      const tmp = this.historyFile + ".tmp";
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, this.historyFile);
      this.savePaperRuntimeSnapshot();
    } catch (e: any) {
      logger.warn(`Hedge15m history save failed: ${e.message}`);
    }
  }

  private savePaperRuntimeSnapshot(): void {
    if (this.tradingMode !== "paper" || this.paperSessionMode !== "persistent") return;
    try {
      this.getRolling4hPnL();
      savePaperRuntimeState({
        balance: this.balance,
        initialBankroll: this.initialBankroll,
        sessionProfit: this.sessionProfit,
        rollingPnL: this.rollingPnL,
        updatedAt: new Date().toISOString(),
        openPosition: this.hedgeState === "leg1_filled" && this.leg1Shares > 0 ? {
          conditionId: this.currentConditionId,
          leg1Dir: this.leg1Dir,
          leg1Token: this.leg1Token,
          leg1Shares: this.leg1Shares,
          leg1FillPrice: this.leg1FillPrice,
          leg1OrderId: this.leg1OrderId,
          totalCost: this.totalCost,
          roundStartBtcPrice: this.roundStartBtcPrice,
          entrySource: this.leg1EntrySource,
          filledAt: this.leg1FilledAt,
        } : null,
      });
    } catch (e: any) {
      logger.warn(`Paper runtime save failed: ${e.message}`);
    }
  }

  private loadHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) return;
      const d = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      if (Array.isArray(d.history)) this.history = d.history.slice(-200);
      if (typeof d.wins === "number") this.wins = d.wins;
      if (typeof d.losses === "number") this.losses = d.losses;
      if (typeof d.skips === "number") this.skips = d.skips;
      if (typeof d.totalProfit === "number") this.totalProfit = d.totalProfit;
      if (typeof d.totalRounds === "number") this.totalRounds = d.totalRounds;
      logger.info(`Hedge15m history loaded: ${this.history.length} entries, P/L $${this.totalProfit.toFixed(2)}`);
    } catch (e: any) {
      logger.warn(`Hedge15m history load failed: ${e.message}`);
    }
  }

  // ── Lifecycle ──

  getHistoryFilePath(): string {
    return this.historyFile;
  }

  async start(options: Hedge15mStartOptions = {}): Promise<void> {
    if (this.running) throw new Error("Hedge15m already running");
    this.tradingMode = options.mode || "live";
    this.paperSessionMode = options.paperSessionMode === "persistent" ? "persistent" : "session";
    this.historyFile = this.tradingMode === "paper" ? PAPER_HISTORY_FILE : HISTORY_FILE;

    // ── 应用运行时参数 ──
    this.rtDumpConfirmCycles = options.dumpConfirmCycles ?? DUMP_CONFIRM_CYCLES;
    const ewPreset = options.entryWindowPreset ?? "medium";
    if (ewPreset === "short") { this.rtEntryWindowS = 360; this.rtMinEntrySecs = 360; }
    else if (ewPreset === "long") { this.rtEntryWindowS = 660; this.rtMinEntrySecs = 180; }
    else { this.rtEntryWindowS = ENTRY_WINDOW_S; this.rtMinEntrySecs = MIN_ENTRY_SECS; }
    this.rtMaxEntryAsk = options.maxEntryAsk ?? MAX_ENTRY_ASK;
    this.rtDualSideMaxAsk = options.dualSideMaxAsk ?? DUAL_SIDE_MAX_ASK;
    this.rtKellyFraction = options.kellyFraction ?? KELLY_FRACTION;
    this.rtTrendEnabled = options.trendEnabled ?? TREND_TRADE_ENABLED;
    this.rtTrendMaxAsk = options.trendMaxAsk ?? TREND_MAX_ASK;
    logger.info(`RT params: dumpConfirm=${this.rtDumpConfirmCycles} window=${ewPreset}(${this.rtEntryWindowS}s) maxAsk=$${this.rtMaxEntryAsk} dualAsk=$${this.rtDualSideMaxAsk} kelly=${this.rtKellyFraction} trend=${this.rtTrendEnabled}/$${this.rtTrendMaxAsk}`);

    resetExecutionTelemetry();
    this.loopRunId += 1;
    const runId = this.loopRunId;
    this.running = true;
    this.status = this.tradingMode === "paper" ? "仿真盘连接中..." : "连接中...";
    const persistedPaperState = this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? loadPaperRuntimeState()
      : null;
    if (this.tradingMode === "paper" && this.paperSessionMode === "session") {
      clearPaperRuntimeState();
    }
    try {
      this.trader = new Trader();
      const restoredPaperBalance = persistedPaperState && persistedPaperState.balance > 0
        ? persistedPaperState.balance
        : options.paperBalance;
      await this.trader.init({ mode: this.tradingMode, paperBalance: restoredPaperBalance });
    } catch (e: any) {
      this.running = false;
      this.status = "空闲";
      throw e;
    }

    // Fetch balance with retry
    try {
      let bal = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        bal = await this.trader.getBalance();
        if (bal > 0) break;
        if (attempt < 3) await sleep(2000);
      }
      if (bal > 0) {
        this.balance = bal;
        this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
          ? persistedPaperState.initialBankroll
          : bal;
      } else {
        this.balance = 50;
        this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
          ? persistedPaperState.initialBankroll
          : 50;
        logger.warn("Balance query returned 0, using conservative $50 estimate to limit risk");
      }
    } catch (e: any) {
      this.balance = 50;
      this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
        ? persistedPaperState.initialBankroll
        : 50;
      logger.warn(`Balance error: ${e.message}, using conservative $50 estimate`);
    }

    if (!this.servicesStarted) {
      startLatencyMonitor(); // 优先启动, 在连接建立期间积累延迟样本
      await startPriceFeed();
      this.servicesStarted = true;
    }

    this.status = "就绪";
    this.totalRounds = 0;
    this.wins = 0;
    this.losses = 0;
    this.skips = 0;
    this.totalProfit = 0;
    this.sessionProfit = persistedPaperState && this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? persistedPaperState.sessionProfit
      : 0;
    this.rollingPnL = persistedPaperState && this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? persistedPaperState.rollingPnL.filter((item) => item.ts >= Date.now() - 4 * 3600_000)
      : [];
    this.history = [];
    this.loadHistory();

    // ── 崩溃恢复: 检查上次是否有未结算的持仓 ──
    if (persistedPaperState?.openPosition && persistedPaperState.openPosition.leg1Shares > 0) {
      const pos = persistedPaperState.openPosition;
      // 检查持仓是否过期 (超过15分钟已结算)
      const ageMs = Date.now() - pos.filledAt;
      if (ageMs < 20 * 60_000) { // 20min内的持仓可能还在结算中
        logger.warn(`CRASH RECOVERY: found open position ${pos.leg1Dir.toUpperCase()} ${pos.leg1Shares}份 @${pos.leg1FillPrice.toFixed(2)} from ${Math.floor(ageMs/1000)}s ago`);
        this.hedgeState = "leg1_filled";
        this.leg1Dir = pos.leg1Dir;
        this.leg1Token = pos.leg1Token;
        this.leg1Shares = pos.leg1Shares;
        this.leg1FillPrice = pos.leg1FillPrice;
        this.leg1Price = pos.leg1FillPrice;
        this.leg1OrderId = pos.leg1OrderId;
        this.totalCost = pos.totalCost;
        this.roundStartBtcPrice = pos.roundStartBtcPrice;
        this.leg1EntrySource = pos.entrySource;
        this.leg1FilledAt = pos.filledAt;
        this.currentConditionId = pos.conditionId;
        this.leg1AttemptedThisRound = true;
        this.activeStrategyMode = "mispricing";
        this.status = `恢复持仓: ${pos.leg1Dir.toUpperCase()} @${pos.leg1FillPrice.toFixed(2)} x${pos.leg1Shares}`;
        this.writeRoundAudit("crash-recovery", { position: pos, ageMs });
      } else {
        logger.info(`CRASH RECOVERY: stale position (${Math.floor(ageMs/60000)}min old), discarding`);
      }
    }

    this.savePaperRuntimeSnapshot();

    logger.info(`Hedge15m started (${this.tradingMode}), balance=$${this.balance.toFixed(2)}`);

    this.mainLoop(runId).catch((e) => {
      if (runId !== this.loopRunId) return;
      logger.error(`Hedge15m loop fatal: ${e.message}`);
      this.status = `致命错误: ${e.message}`;
      this.running = false;
      if (this.trader) this.trader.cancelAll().catch(() => {});
    });
  }

  stop(): void {
    this.loopRunId += 1;
    this.running = false;
    this.status = "已停止";
    this.savePaperRuntimeSnapshot();
    if (this.trader) {
      this.trader.stopOrderbookLoop();
      this.trader.cancelAll().catch(() => {});
    }
    stopLatencyMonitor();
    stopPriceFeed();
    this.servicesStarted = false;
    logger.info(`Hedge15m stopped. P/L: $${this.totalProfit.toFixed(2)}`);  
  }

  private async refreshBalance(): Promise<void> {
    if (!this.trader) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const fresh = await this.trader.getBalance();
        if (fresh > 0) {
          this.balance = fresh;
          this.savePaperRuntimeSnapshot();
          return;
        }
      } catch {}
      if (attempt < 3) await sleep(1500);
    }
    logger.warn(`refreshBalance: 3次尝试均返回0, 保留本地余额 $${this.balance.toFixed(2)}`);
  }

  private resetRoundState(): void {
    this.hedgeState = "watching";
    this.leg1Dir = "";
    this.leg1Price = 0;
    this.leg1Shares = 0;
    this.leg1Token = "";
    this.totalCost = 0;
    this.dumpDetected = "";
    this.activeStrategyMode = "none";
    this.currentTrendBias = "flat";
    this.marketState.reset();
    this.roundStartBtcPrice = 0;
    this.negRisk = false;
    this.leg1FillPrice = 0;
    this.leg1OrderId = "";
    this.leg1FilledAt = 0;
    this.leg1Estimated = false;
    this.currentDumpDrop = 0;
    this.leg1MakerFill = false;
    this.leg1EntrySource = "";
    this.leg1EntryTrendBias = "flat";
    this.leg1EntrySecondsLeft = 0;
    this.dumpConfirmCount = 0;
    this.lastDumpCandidateDir = "";
    this.lastEntrySkipKey = "";
    this.lastSignalSkipKey = "";
    this.lastRepricingRejectKey = "";
    this.lastDumpLogKey = "";
    this.dirAlignedCount = 0;
    this.dirContraCount = 0;
    this.trendConfirmCount = 0;
    this.lastTrendConfirmDir = "";
    this.preOrderUpId = "";
    this.preOrderDownId = "";
    this.preOrderUpPrice = 0;
    this.preOrderDownPrice = 0;
    this.preOrderUpShares = 0;
    this.preOrderDownShares = 0;
    this.preOrderUpToken = "";
    this.preOrderDownToken = "";
    this.preOrderLastRefresh = 0;
    this.leg1EntryInFlight = false;
    this.leg1AttemptedThisRound = false;
    this.resetRoundRejectStats();
  }

  // ── Main Loop ──

  private async mainLoop(runId: number): Promise<void> {
    const trader = this.trader!;
    let curCid = "";

    while (this.isActiveRun(runId)) {
      try {


        const rnd = await getCurrentRound15m();
        if (!this.isActiveRun(runId)) break;
        if (!rnd) {
          this.status = "无15分钟市场,等待中...";
          this.secondsLeft = 0;
          setRoundSecsLeft(999);
          trader.setTrackedTokens([]);
          trader.setTrackedMarkets([]);
          await sleep(8000);
          continue;
        }

        const cid = rnd.conditionId;
        const secs = rnd.secondsLeft;
        this.currentConditionId = cid;
        this.currentMarket = rnd.question;
        this.secondsLeft = secs;
        setRoundSecsLeft(secs);
        trader.setTrackedTokens([rnd.upToken, rnd.downToken]);
        trader.setTrackedMarkets([rnd.conditionId]);

        // New round
        if (cid !== curCid) {
          if (curCid && this.totalCost > 0) {
            await this.settleHedge();
          }
          curCid = cid;
          this.resetRoundState();
          this.status = "新回合开始";
          this.upAsk = 0;
          this.downAsk = 0;
          await trader.cancelAll();
          await this.refreshBalance();
          this.totalRounds++;
          this.roundStartBtcPrice = getBtcPrice();
          setRoundStartPrice(); // 同步设置 btcPrice 模块的回合基准
          this.negRisk = !!rnd.negRisk;

          // ── 资金安全守护 ──
          if (this.balance < MIN_BALANCE_TO_TRADE) {
            this.hedgeState = "done";
            this.status = `暂停: 余额$${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: balance $${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}, skipping round`);
            this.writeRoundAudit("round-skip-capital", { reason: "low-balance", balance: this.balance });
          } else if (this.initialBankroll > 0 && this.sessionProfit < -(this.initialBankroll * MAX_SESSION_LOSS_PCT)) {
            this.hedgeState = "done";
            this.status = `暂停: 会话亏损$${Math.abs(this.sessionProfit).toFixed(2)} > ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}%本金`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: session loss $${this.sessionProfit.toFixed(2)} exceeds ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}% of bankroll $${this.initialBankroll.toFixed(2)}, skipping`);
            this.writeRoundAudit("round-skip-capital", { reason: "session-loss-limit", sessionProfit: this.sessionProfit, initialBankroll: this.initialBankroll });
          } else if (this.consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE) {
            // 连亏≥5: 不再完全跳过, 而是以最低仓位(×0.4)继续交易 — JSONL数据证明低价入场长期EV+
            const cLossScale = Math.max(0.4, Math.pow(0.85, this.consecutiveLosses));
            logger.warn(`CAPITAL GUARD: ${this.consecutiveLosses} consecutive losses, Kelly scaled to ${(cLossScale*100).toFixed(0)}% (continuing with reduced size)`);
          }
          // 跳过剩余时间不足的回合 — 无法完成 dump检测 + 对冲
          else if (secs < this.rtMinEntrySecs) {
            this.hedgeState = "done";
            this.status = `跳过: 剩余${Math.floor(secs)}s < ${this.rtMinEntrySecs}s`;
            this.skips++;
            logger.info(`HEDGE15M SKIP LATE ROUND: ${Math.floor(secs)}s < ${this.rtMinEntrySecs}s minimum`);
            this.writeRoundAudit("round-skip-late", { secondsLeft: secs, minimumEntrySeconds: this.rtMinEntrySecs, negRisk: this.negRisk });
          } else {
            logger.info(`HEDGE15M ROUND: ${rnd.question}, ${Math.floor(secs)}s left, BTC=$${this.roundStartBtcPrice.toFixed(0)}`);
            this.writeRoundAudit("round-start", { question: rnd.question, secondsLeft: secs, roundStartBtcPrice: this.roundStartBtcPrice, negRisk: this.negRisk });
          }
        }

        // Sample ask prices from live orderbook
        try {
          const t0 = Date.now();
          const [upRes, dnRes] = await Promise.all([
            getHotBestPrices(trader, rnd.upToken),
            getHotBestPrices(trader, rnd.downToken),
          ]);
          if (!this.isActiveRun(runId)) break;
          const callMs = Date.now() - t0;
          void callMs;
          this.upAsk = upRes?.ask ?? 0;
          this.downAsk = dnRes?.ask ?? 0;
        } catch (e: any) {
          logger.warn(`Price sample error: ${e.message}`);
          await sleep(200);
          continue;
        }

        const elapsed = ROUND_DURATION - secs;

        // ═══ State Machine ═══

        if (this.hedgeState === "watching") {
          this.status = `监控砸盘 (${Math.floor(elapsed)}/${this.rtEntryWindowS}s)`;

          if (this.upAsk > 0 && this.downAsk > 0) {
            const { dumpWindowMs, dumpBaselineMs } = getDynamicParams();
            this.marketState.push(this.upAsk, this.downAsk, dumpWindowMs + 500);

            // ── 双侧预挂单做市: 检查成交 + 刷新挂单 ──
            await this.manageDualSideOrders(trader, rnd, secs);
            if (this.hedgeState !== "watching") {
              // 预挂单成交转入 leg1_filled, 跳过dump检测
            } else {

            const dumpBaseline = this.marketState.getDumpBaseline(dumpBaselineMs);
            if (dumpBaseline) {
              const shortMomentum = getRecentMomentum(MOMENTUM_WINDOW_SEC);
              const trendMomentum = getRecentMomentum(TREND_WINDOW_SEC);
              const directionalBias = this.getRoundDirectionalBias();
              this.currentTrendBias = directionalBias;

              const mispricing = evaluateMispricingOpportunity({
                upAsk: this.upAsk,
                downAsk: this.downAsk,
                oldestUpAsk: dumpBaseline.oldest.upAsk,
                oldestDownAsk: dumpBaseline.oldest.downAsk,
                upDrop: dumpBaseline.upDrop,
                downDrop: dumpBaseline.downDrop,
                dumpThreshold: DUMP_THRESHOLD,
                nearThresholdRatio: 0.75,
                shortMomentum,
                trendMomentum,
                momentumContraPct: MOMENTUM_CONTRA_PCT,
                trendContraPct: TREND_CONTRA_PCT,
                momentumWindowSec: MOMENTUM_WINDOW_SEC,
                trendWindowSec: TREND_WINDOW_SEC,
                btcMovePct: getBtcMovePct(),
              });

              if (mispricing.bothSidesDumping) {
                // 双侧都在dump: 选BTC方向一致且ask更低的那侧入场
                const btcDir = getBtcDirection();
                // 优先选与BTC方向一致的侧 (BTC涨→买UP, BTC跌→买DOWN)
                let cheaperDir: "up" | "down";
                const btcAlignedDir: "up" | "down" = btcDir === "up" ? "up" : "down";
                const btcAlignedAsk = btcAlignedDir === "up" ? this.upAsk : this.downAsk;
                const maxAsk = this.getMaxEntryAsk();
                if (btcAlignedAsk > 0 && btcAlignedAsk <= maxAsk && btcAlignedAsk >= MIN_ENTRY_ASK) {
                  cheaperDir = btcAlignedDir;
                } else {
                  cheaperDir = this.upAsk <= this.downAsk ? "up" : "down";
                }
                const cheaperAsk = cheaperDir === "up" ? this.upAsk : this.downAsk;
                if (cheaperAsk > 0 && cheaperAsk <= maxAsk && cheaperAsk >= MIN_ENTRY_ASK) {
                  // BTC方向逆向检查
                  const btcContra = (cheaperDir === "up" && btcDir === "down") || (cheaperDir === "down" && btcDir === "up");
                  if (btcContra) {
                    logger.warn(`HEDGE15M SKIP: both dump → ${cheaperDir.toUpperCase()} but BTC=${btcDir} — 不逆势入场`);
                  } else {
                    logger.info(`HEDGE15M BOTH DUMP → picking ${cheaperDir.toUpperCase()} @${cheaperAsk.toFixed(2)} (BTC=${btcDir}) (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%)`);
                    this.dumpDetected = `BOTH-DUMP → ${cheaperDir.toUpperCase()} @${cheaperAsk.toFixed(2)}`;
                    this.currentDumpDrop = cheaperDir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                    this.activeStrategyMode = "mispricing";
                    const buyToken = cheaperDir === "up" ? rnd.upToken : rnd.downToken;
                    await this.buyLeg1(trader, rnd, cheaperDir, cheaperAsk, buyToken);
                  }
                } else {
                  logger.warn(`HEDGE15M SKIP: both sides dumping (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%) cheapest=${cheaperAsk.toFixed(2)} > maxAsk=$${maxAsk.toFixed(2)}`);
                }
              } else {
                if (mispricing.cautionMessage) {
                  logger.warn(`HEDGE15M CAUTION: ${mispricing.cautionMessage} — proceeding with low ask`);
                }
                if (mispricing.momentumRejects.length > 0) {
                  // 去重: 只用方向做 key, 不含精确百分比 (避免每个cycle都日志)
                  const rejectDirKey = mispricing.momentumRejects.map(r => r.slice(0, 30)).join("||");
                  if (rejectDirKey !== this.lastRepricingRejectKey) {
                    this.lastRepricingRejectKey = rejectDirKey;
                    this.roundMomentumRejects += mispricing.momentumRejects.length;
                    for (const rejectMessage of mispricing.momentumRejects) {
                      logger.warn(`HEDGE15M MOMENTUM REJECT: ${rejectMessage}`);
                    }
                  }
                }

                const candidate = mispricing.candidates[0];
                if (candidate) {
                  // ── 早期价格过滤: ask低于MIN_ENTRY_ASK时不尝试入场 (避免无用循环) ──
                  if (candidate.askPrice < MIN_ENTRY_ASK) {
                    // 去重: 只在首次或方向变化时打日志
                    const skipKey = `minask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped: ask=${candidate.askPrice.toFixed(2)} < MIN_ENTRY_ASK=${MIN_ENTRY_ASK}`);
                    }
                  }
                  // ── 早期价格过滤: ask高于MAX_ENTRY_ASK时不尝试 ──
                  else if (candidate.askPrice > this.getMaxEntryAsk()) {
                    const skipKey = `maxask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped: ask=${candidate.askPrice.toFixed(2)} > MAX_ENTRY_ASK=${this.getMaxEntryAsk()}`);
                    }
                    this.roundEntryAskRejects += 1;
                  }
                  // ── #5 早期入场保护: 回合开始<90s内不允许反应式入场 ──
                  else if (elapsed < MIN_ENTRY_ELAPSED) {
                    this.trackRoundRejectReason(`early_entry: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s`);
                    if (this.dumpConfirmCount <= 1) { // 只在首次打日志避免刷屏
                      logger.info(`HEDGE15M EARLY: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s — waiting for stable data`);
                    }
                  } else {
                    // ── #4 连续砸盘确认: 需连续 N 个cycle看到dump才触发 ──
                    if (candidate.dir === this.lastDumpCandidateDir) {
                      this.dumpConfirmCount++;
                    } else {
                      this.dumpConfirmCount = 1;
                      this.lastDumpCandidateDir = candidate.dir;
                    }
                    if (this.dumpConfirmCount < this.rtDumpConfirmCycles) {
                      // 还未达到确认次数, 继续等
                    } else {
                      // ── #2 Sum分歧度过滤: 市场不确定时拒绝入场 ──
                      const currentSum = this.upAsk + this.downAsk;
                      if (currentSum > SUM_DIVERGENCE_MAX) {
                        this.trackRoundRejectReason(`sum_high: ${currentSum.toFixed(2)} > ${SUM_DIVERGENCE_MAX}`);
                        const sumKey = currentSum.toFixed(2);
                        if (sumKey !== this.lastDumpLogKey) {
                          this.lastDumpLogKey = sumKey;
                          logger.warn(`HEDGE15M SKIP: sum=${currentSum.toFixed(2)} > ${SUM_DIVERGENCE_MAX} — no mispricing edge`);
                        }
                      } else {
                        // ── BTC方向逆向过滤: 买方向与BTC实时走势直接矛盾时拒绝 ──
                        const btcDir = getBtcDirection();
                        const btcContra = (candidate.dir === "up" && btcDir === "down") || (candidate.dir === "down" && btcDir === "up");
                        if (btcContra) {
                          const contraKey = `btccontra:${candidate.dir}:${btcDir}`;
                          if (contraKey !== this.lastSignalSkipKey) {
                            this.lastSignalSkipKey = contraKey;
                            this.trackRoundRejectReason(`btc_contra: buy ${candidate.dir} but BTC=${btcDir}`);
                            logger.warn(`HEDGE15M SKIP: buy ${candidate.dir.toUpperCase()} but BTC=${btcDir} — 重定价而非砸盘`);
                          }
                        } else {
                        // ── 入场: 价格达标 + BTC方向不矛盾 ──
                        this.dumpDetected = candidate.dumpDetected;
                        this.currentDumpDrop = candidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                        this.activeStrategyMode = "mispricing";
                        const flow = getTakerFlowRatio();
                        const depth = getDepthImbalance();
                        const liq = getLiquidationInfo();
                        logger.info(`HEDGE15M DUMP${mispricing.candidates.length > 1 ? ` (选${candidate.dir.toUpperCase()})` : ""}${currentSum <= SUM_DIVERGENCE_MIN ? " [强方向]" : ""}: ${this.dumpDetected} (sum=${currentSum.toFixed(2)} BTC=${btcDir} flow=${flow.ratio.toFixed(2)}/${flow.direction} depth=${depth.ratio.toFixed(2)}/${depth.direction} liq=${liq.direction}/${liq.intensity})`);
                        await this.buyLeg1(
                          trader,
                          rnd,
                          candidate.dir,
                          candidate.askPrice,
                          rnd[candidate.buyTokenKey],
                        );
                        }
                      }
                    }
                  }
                } else {
                  // 无候选 → 重置连续确认
                  this.dumpConfirmCount = 0;
                  this.lastDumpCandidateDir = "";
                }
              }
            }
            } // end dual-side pre-order guard

            // ── 趋势追涨: 无dump时, 强趋势方向ask低于阈值直接入场 ──
            if (this.rtTrendEnabled && !this.leg1AttemptedThisRound && !this.leg1EntryInFlight
                && this.hedgeState === "watching" && elapsed >= TREND_MIN_ELAPSED && secs >= this.rtMinEntrySecs) {
              const trend = this.getRoundDirectionalBias();
              if (trend !== "flat") {
                const trendAsk = trend === "up" ? this.upAsk : this.downAsk;
                const trendToken = trend === "up" ? rnd.upToken : rnd.downToken;
                if (trendAsk > 0 && trendAsk <= this.rtTrendMaxAsk && trendAsk > MIN_ENTRY_ASK) {
                  if (trend === this.lastTrendConfirmDir) {
                    this.trendConfirmCount++;
                  } else {
                    this.trendConfirmCount = 1;
                    this.lastTrendConfirmDir = trend;
                  }
                  if (this.trendConfirmCount >= TREND_CONFIRM_CYCLES) {
                    await this.buyTrendLeg1(trader, rnd, trend, trendAsk, trendToken);
                  }
                } else {
                  this.trendConfirmCount = 0;
                  this.lastTrendConfirmDir = "";
                }
              } else {
                this.trendConfirmCount = 0;
                this.lastTrendConfirmDir = "";
              }
            }
          }

          // Window expired
          if (elapsed >= this.rtEntryWindowS && this.hedgeState === "watching") {
            // 窗口到期, 取消预挂单
            if (this.preOrderUpId || this.preOrderDownId) {
              await this.cancelDualSideOrders(trader);
            }
            this.hedgeState = "done";
            this.status = "窗口到期,无砸盘";
            this.skips++;
            this.logRoundRejectSummary("window expired without entry");
          }
        }

        if (this.hedgeState === "leg1_filled") {
          // ── 方向性策略: 纯持有到结算, 零中途干预 ──
          // 入场价≤$0.35, 即使50%随机胜率也EV+$0.15/share
          // 卖出要付2% taker fee, 持有到结算 0 fee — 任何中途卖出都是EV-
          const entryPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
          const secsHeld = this.leg1FilledAt > 0 ? (Date.now() - this.leg1FilledAt) / 1000 : 0;
          const sourceTag = this.leg1EntrySource === "trend-follow" ? "趋势" : this.leg1EntrySource === "dual-side-preorder" ? "预挂" : "砸盘";
          this.status = `纯持仓[${sourceTag}]: ${this.leg1Dir.toUpperCase()}@$${entryPrice.toFixed(2)} ${this.leg1Shares}份 EV+$${(this.leg1Shares * (1 - entryPrice)).toFixed(2)} ${secs.toFixed(0)}s → 等结算`;
        }

        // 回合最后30秒: 预加载下一轮市场
        // 回合最后30秒: 预加载下一轮市场，消除下轮切换时的冷启动延迟
        if (secs <= 30 && secs > 0) {
          prefetchNextRound().catch(() => {});
        }

        // Near settlement
        if (secs <= 5 && secs > 0 && this.totalCost > 0) {
          this.status = "即将结算...";
        }

        // Round ended
        if (secs <= 0) {
          if (this.totalCost > 0) {
            await this.settleHedge();
          }
          await trader.cancelAll();
          curCid = "";
          setRoundSecsLeft(999);
          await sleep(3000);
          continue;
        }

        const { watchPollMs, idlePollMs } = getDynamicParams();
        const loopVersion = trader.getOrderbookVersion();
        const aggressiveWatchMs = this.currentTrendBias === "flat" ? watchPollMs : Math.max(25, Math.floor(watchPollMs * 0.5));
        await trader.waitForOrderbookUpdate(
          loopVersion,
          this.hedgeState === "watching" ? aggressiveWatchMs : idlePollMs,
        );

      } catch (e: any) {
        if (!this.isActiveRun(runId)) break;
        logger.error(`Hedge15m loop error: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  // ── Trading Actions ──

  private async buyLeg1(
    trader: Trader,
    rnd: Round15m,
    dir: string,
    askPrice: number,
    buyToken: string,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight) return;
    if (this.leg1AttemptedThisRound) {
      logger.warn("Hedge15m Leg1 skipped: order already attempted this round, avoiding duplicate exposure");
      return;
    }

    // 取消双侧预挂单, 释放资金给反应式下单
    if (this.preOrderUpId || this.preOrderDownId) {
      await this.cancelDualSideOrders(trader);
    }

    // ── Leg1价格上限: 只接受足够低价的EV+入场, 强信号时动态提升 ──
    const maxEntryAsk = this.getDynamicMaxEntryAsk(dir);
    const directionalBias = this.getRoundDirectionalBias();

    const plan = planHedgeEntry({
      dir: dir as "up" | "down",
      askPrice,
      maxEntryAsk,
      minEntryAsk: MIN_ENTRY_ASK,
      directionalBias,
    });
    if (!plan.allowed) {
      if (plan.reason?.includes("MAX_ENTRY_ASK")) this.roundEntryAskRejects += 1;
      this.trackRoundRejectReason(`plan: ${plan.reason}`);
      // 只在首次或价格变化时打日志, 避免同价格反复刷屏
      const skipKey = `${dir}:${askPrice.toFixed(2)}`;
      if (skipKey !== this.lastEntrySkipKey) {
        this.lastEntrySkipKey = skipKey;
        logger.warn(`Hedge15m Leg1 skipped: ${plan.reason}`);
      }
      return;
    }

    // ── Half-Kelly分层仓位: 越便宜买越多, 再叠加趋势加权 ──
    // Kelly: f* = (p*b - q) / b, b = (1-ask)/ask, Half-Kelly = f*/2
    const odds = (1 - askPrice) / askPrice;  // 赔率
    const kellyFull = (KELLY_WIN_RATE * odds - (1 - KELLY_WIN_RATE)) / odds;
    // ── EV+分层Kelly上限: 越便宜EV越高, 允许更大仓位 ──
    const kellyCapForPrice = askPrice <= 0.20 ? 0.40 : askPrice <= 0.25 ? 0.35 : askPrice <= 0.30 ? 0.32 : 0.30;
    // 连亏缩仓: 每连亏1次Kelly×0.85, 最低×0.4, 赢1次重置
    const lossScale = this.consecutiveLosses > 0 ? Math.max(0.4, Math.pow(0.85, this.consecutiveLosses)) : 1.0;
    const kellyBase = Math.max(0.08, Math.min(kellyCapForPrice, kellyFull * this.rtKellyFraction * lossScale));
    let budgetPct = kellyBase;
    if (directionalBias === dir) {
      budgetPct += TREND_BUDGET_BOOST; // 趋势一致追加
    } else if (directionalBias === "flat") {
      budgetPct -= TREND_BUDGET_CUT;   // 中性减仓
    }
    // ── 统一7源信号Kelly调权: aligned多→加仓, contra多→减仓 ──
    if (this.dirAlignedCount >= 3) {
      budgetPct *= 1.0 + (this.dirAlignedCount - 2) * 0.05; // 3→+5%, 4→+10%, 5→+15%...
      logger.info(`KELLY SIG BOOST: aligned=${this.dirAlignedCount} contra=${this.dirContraCount} pct=${(budgetPct*100).toFixed(1)}%`);
    } else if (this.dirContraCount >= 3) {
      budgetPct *= 1.0 - (this.dirContraCount - 2) * 0.10; // 3→×0.90, 4→×0.80, 5→×0.70...
      logger.info(`KELLY SIG SHRINK: aligned=${this.dirAlignedCount} contra=${this.dirContraCount} pct=${(budgetPct*100).toFixed(1)}%`);
    }
    budgetPct = Math.max(0.08, Math.min(kellyCapForPrice, budgetPct)); // EV+分层硬限 (低价→高上限)

    await this.openLeg1Position(
      trader,
      dir,
      askPrice,
      buyToken,
      budgetPct,
      "mispricing",
      Date.now(),
    );
  }

  /** 趋势追涨入场: 强趋势方向 ask ≤ TREND_MAX_ASK 时入场 */
  private async buyTrendLeg1(
    trader: Trader,
    rnd: Round15m,
    dir: string,
    askPrice: number,
    buyToken: string,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight) return;
    if (this.leg1AttemptedThisRound) return;

    // 取消双侧预挂单, 释放资金
    if (this.preOrderUpId || this.preOrderDownId) {
      await this.cancelDualSideOrders(trader);
    }

    if (askPrice > this.rtTrendMaxAsk || askPrice < MIN_ENTRY_ASK) return;

    // ── 趋势专用 Kelly: 假设比随机更高的胜率(58%) ──
    const odds = (1 - askPrice) / askPrice;
    const kellyFull = (TREND_KELLY_WIN_RATE * odds - (1 - TREND_KELLY_WIN_RATE)) / odds;
    // 趋势Kelly: 低价趋势EV+大→放开上限
    const trendKellyCap = askPrice <= 0.40 ? 0.22 : 0.18;
    // 连亏缩仓: 趋势入场同样适用
    const trendLossScale = this.consecutiveLosses > 0 ? Math.max(0.4, Math.pow(0.85, this.consecutiveLosses)) : 1.0;
    let budgetPct = Math.max(0.06, Math.min(trendKellyCap, kellyFull * this.rtKellyFraction * trendLossScale));
    // 信号加权 (趋势trade也受信号影响, 但Kelly更保守)
    if (this.dirAlignedCount >= 3) {
      budgetPct *= 1.0 + (this.dirAlignedCount - 2) * 0.04;
    } else if (this.dirContraCount >= 3) {
      budgetPct *= 1.0 - (this.dirContraCount - 2) * 0.08;
    }
    budgetPct = Math.max(0.06, Math.min(trendKellyCap, budgetPct)); // 趋势trade: 6%-18/22%

    this.dumpDetected = `TREND ${dir.toUpperCase()} @${askPrice.toFixed(2)} (${this.trendConfirmCount}cycle)`;
    this.activeStrategyMode = "trend";
    this.currentTrendBias = dir as "up" | "down";
    const flow = getTakerFlowRatio();
    const depth = getDepthImbalance();
    logger.info(`HEDGE15M TREND ENTRY: ${dir.toUpperCase()} @${askPrice.toFixed(2)} budget=${(budgetPct*100).toFixed(1)}% confirmed=${this.trendConfirmCount} flow=${flow.ratio.toFixed(2)}/${flow.direction} depth=${depth.ratio.toFixed(2)}/${depth.direction}`);

    await this.openLeg1Position(
      trader,
      dir,
      askPrice,
      buyToken,
      budgetPct,
      "mispricing",
      Date.now(),
      "trend-follow",
    );
  }

  private async cancelDualSideOrders(trader: Trader): Promise<void> {
    if (this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      logger.info(`DUAL SIDE: cancelled UP pre-order ${this.preOrderUpId.slice(0, 12)}`);
      this.preOrderUpId = "";
    }
    if (this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      logger.info(`DUAL SIDE: cancelled DOWN pre-order ${this.preOrderDownId.slice(0, 12)}`);
      this.preOrderDownId = "";
    }
    this.preOrderUpPrice = 0;
    this.preOrderDownPrice = 0;
    this.preOrderUpShares = 0;
    this.preOrderDownShares = 0;
    this.preOrderLastRefresh = 0;
    // 同步余额: paper 模式下 cancelOrder 已退款到 paperBalance
    await this.refreshBalance();
  }

  /**
   * 双侧预挂单做市:
   * 在 watching 阶段主动挂 GTC limit buy 在 UP 和 DOWN 两侧,
   * 当市场下砸到目标价时以 maker 费率(0%)成交, 实现:
   * 1. 比反应式下单更快 (单已在book中)
   * 2. 省 2% taker fee
   * 3. 如果一侧被吃到 → 等于拿到便宜的 Leg1, 持有到结算
   */
  private async manageDualSideOrders(
    trader: Trader,
    rnd: Round15m,
    secs: number,
  ): Promise<void> {
    if (!DUAL_SIDE_ENABLED) return;
    if (this.hedgeState !== "watching") return;
    if (this.leg1EntryInFlight || this.leg1AttemptedThisRound) return;
    // dump已确认时不挂新预挂单, 避免 挂单→dump取消→挂单 刷屏循环
    if (this.dumpConfirmCount >= this.rtDumpConfirmCycles) return;
    if (secs < this.rtMinEntrySecs) {
      // 时间不足, 取消预挂单
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      return;
    }
    // consecutiveLosses 冷却已移除: 方向性策略每轮独立, 连亏不影响下轮EV

    const upAsk = this.upAsk;
    const downAsk = this.downAsk;
    if (upAsk <= 0 || downAsk <= 0) return;

    // ── 低流动性/高不确定性过滤: spread太大或sum过高时不挂新单(已有单仍检查fill) ──
    const askSum = upAsk + downAsk;
    const lowLiquidity = askSum >= LIQUIDITY_FILTER_SUM || askSum > SUM_DIVERGENCE_MAX;

    // ── 检查已有预挂单是否被成交 ──
    if (this.preOrderUpId) {
      const upFill = await trader.getOrderFillDetails(this.preOrderUpId);
      if (upFill.filled > 0) {
        // UP 侧被成交 → 先取消 UP 余量 + 另一侧
        if (upFill.filled < this.preOrderUpShares) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderUpId);
          if (afterCancel.filled > upFill.filled) {
            upFill.filled = afterCancel.filled;
            upFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: UP ${upFill.filled.toFixed(0)}份 @${upFill.avgPrice.toFixed(2)} (limit@${this.preOrderUpPrice.toFixed(2)}) maker=true`);
        // 取消另一侧 (先cancel再查fill, 避免竞态丢份额)
        if (this.preOrderDownId) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const dnCheck = await trader.getOrderFillDetails(this.preOrderDownId);
          if (dnCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: DOWN also filled ${dnCheck.filled.toFixed(0)}份, selling immediately`);
            await trader.placeFakSell(this.preOrderDownToken, dnCheck.filled, this.negRisk).catch((e: any) => {
              logger.error(`DUAL SIDE GHOST sell failed: ${e.message}`);
            });
          }
          this.preOrderDownId = "";
          this.preOrderDownPrice = 0;
          this.preOrderDownShares = 0;
        }
        this.transitionPreOrderToLeg1(
          "up", this.preOrderUpToken,
          upFill.filled, upFill.avgPrice > 0 ? upFill.avgPrice : this.preOrderUpPrice,
          this.preOrderUpId,
          (upFill.avgPrice > 0 ? upFill.avgPrice : this.preOrderUpPrice) + downAsk,
        );
        this.preOrderUpId = "";
        this.preOrderUpPrice = 0;
        this.preOrderUpShares = 0;
        await this.refreshBalance();
        return;
      }
    }

    if (this.preOrderDownId) {
      const dnFill = await trader.getOrderFillDetails(this.preOrderDownId);
      if (dnFill.filled > 0) {
        // DOWN 侧被成交 → 先取消 DOWN 余量 + 另一侧
        if (dnFill.filled < this.preOrderDownShares) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderDownId);
          if (afterCancel.filled > dnFill.filled) {
            dnFill.filled = afterCancel.filled;
            dnFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: DOWN ${dnFill.filled.toFixed(0)}份 @${dnFill.avgPrice.toFixed(2)} (limit@${this.preOrderDownPrice.toFixed(2)}) maker=true`);
        if (this.preOrderUpId) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const upCheck = await trader.getOrderFillDetails(this.preOrderUpId);
          if (upCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: UP also filled ${upCheck.filled.toFixed(0)}份, selling immediately`);
            await trader.placeFakSell(this.preOrderUpToken, upCheck.filled, this.negRisk).catch((e: any) => {
              logger.error(`DUAL SIDE GHOST sell failed: ${e.message}`);
            });
          }
          this.preOrderUpId = "";
          this.preOrderUpPrice = 0;
          this.preOrderUpShares = 0;
        }
        this.transitionPreOrderToLeg1(
          "down", this.preOrderDownToken,
          dnFill.filled, dnFill.avgPrice > 0 ? dnFill.avgPrice : this.preOrderDownPrice,
          this.preOrderDownId,
          (dnFill.avgPrice > 0 ? dnFill.avgPrice : this.preOrderDownPrice) + upAsk,
        );
        this.preOrderDownId = "";
        this.preOrderDownPrice = 0;
        this.preOrderDownShares = 0;
        await this.refreshBalance();
        return;
      }
    }

    // ── 计算理想挂单价 ──
    // 目标: 如果一侧被吃到, sum = myFillPrice + oppositeAsk ≤ DUAL_SIDE_SUM_CEILING
    // → myLimit ≤ DUAL_SIDE_SUM_CEILING - oppositeCurrentAsk
    // 动态offset: 按ask的6%计算, 至少DUAL_SIDE_OFFSET, ask越高offset越大→EV+更高
    const dynamicUpOffset = Math.max(DUAL_SIDE_OFFSET, Math.round(upAsk * 0.06 * 100) / 100);
    const dynamicDnOffset = Math.max(DUAL_SIDE_OFFSET, Math.round(downAsk * 0.06 * 100) / 100);
    const idealUpLimit = Math.min(
      DUAL_SIDE_SUM_CEILING - downAsk,
      upAsk - dynamicUpOffset,
    );
    const idealDownLimit = Math.min(
      DUAL_SIDE_SUM_CEILING - upAsk,
      downAsk - dynamicDnOffset,
    );

    // 价格精度 0.01
    // ── 预检查: 将limit价钳制到effectiveMaxAsk, 避免边界震荡导致挂→取消循环 ──
    const effectiveMaxAsk = this.getEffectiveMaxAsk();
    const upLimit = Math.min(Math.round(idealUpLimit * 100) / 100, effectiveMaxAsk);
    const downLimit = Math.min(Math.round(idealDownLimit * 100) / 100, effectiveMaxAsk);

    const upInRange = upLimit >= DUAL_SIDE_MIN_ASK;
    const downInRange = downLimit >= DUAL_SIDE_MIN_ASK;

    // ── 趋势方向过滤: 有明确趋势时撤销逆势侧预挂单 ──
    const trend = this.currentTrendBias;
    if (trend === "down" && this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (trendBias=down, avoid counter-trend fill)`);
    }
    if (trend === "up" && this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (trendBias=up, avoid counter-trend fill)`);
    }

    // ── Binance 方向过滤: BTC方向明确时撤销逆向侧预挂单 ──
    const btcDirPre = getBtcDirection();
    const btcMovePre = getBtcMovePct();
    if (btcMovePre >= 0.001) { // BTC 变动≥0.1%才认为方向有意义
    if (btcDirPre === "down" && this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (BTC=down move=${(btcMovePre*100).toFixed(3)}%)`);
    }
    if (btcDirPre === "up" && this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (BTC=up move=${(btcMovePre*100).toFixed(3)}%)`);
    }
    }

    // ── 低流动性过滤: spread过大时撤销所有预挂单 ──
    if (lowLiquidity && (this.preOrderUpId || this.preOrderDownId)) {
      if (this.preOrderUpId) {
        await trader.cancelOrder(this.preOrderUpId).catch(() => {});
        this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      }
      if (this.preOrderDownId) {
        await trader.cancelOrder(this.preOrderDownId).catch(() => {});
        this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      }
      logger.info(`DUAL SIDE: all cancelled (askSum=${askSum.toFixed(2)} >= ${LIQUIDITY_FILTER_SUM}, low liquidity)`);
      return;
    }

    // 单侧预算 = Half-Kelly based on limit price
    // 预挂单价通常在0.20-0.30, Kelly会自动给低价更大仓位
    const avgLimitPrice = (upLimit + downLimit) / 2;
    const preOdds = avgLimitPrice > 0 ? (1 - avgLimitPrice) / avgLimitPrice : 2.0;
    const preKelly = (KELLY_WIN_RATE * preOdds - (1 - KELLY_WIN_RATE)) / preOdds;
    // 预挂单Kelly: 低价EV+更大, 提高上限
    const preKellyCap = avgLimitPrice <= 0.25 ? 0.30 : 0.25;
    // 连亏缩仓: 预挂单同样受连亏缩仓影响
    const preLossScale = this.consecutiveLosses > 0 ? Math.max(0.4, Math.pow(0.85, this.consecutiveLosses)) : 1.0;
    const preBudgetPct = Math.max(0.08, Math.min(preKellyCap, preKelly * this.rtKellyFraction * preLossScale));
    const singleSideBudget = this.balance * preBudgetPct * 0.5;

    const now = Date.now();
    const needRefresh = now - this.preOrderLastRefresh >= DUAL_SIDE_REFRESH_MS;

    // ── UP 侧挂单管理 (趋势down/CL=down时跳过, 低流动性时跳过) ──
    if (!lowLiquidity && trend !== "down" && btcDirPre !== "down" && upInRange) {
      const upShares = Math.min(MAX_SHARES, Math.floor(singleSideBudget / upLimit));
      if (upShares >= MIN_SHARES) {
        const drift = Math.abs(upLimit - this.preOrderUpPrice);
        if (!this.preOrderUpId) {
          // 首次挂单
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            this.preOrderUpToken = rnd.upToken;
            logger.info(`DUAL SIDE: UP pre-order ${upShares}份 @${upLimit.toFixed(2)} (sum target=${(upLimit + downAsk).toFixed(2)})`);
          }
        } else if (needRefresh && drift >= DUAL_SIDE_MIN_DRIFT) {
          // 价格偏移过大, 重挂 — cancel 后检查是否在窗口内成交
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const reFill = await trader.getOrderFillDetails(this.preOrderUpId);
          if (reFill.filled > 0) {
            // cancel 前成交了, 不重挂, 下次循环会走 fill 路径
            logger.info(`DUAL SIDE: UP filled ${reFill.filled.toFixed(0)} during re-place cancel, will handle next tick`);
          } else {
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            logger.info(`DUAL SIDE: UP re-placed ${upShares}份 @${upLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
          } else {
            this.preOrderUpId = "";
            this.preOrderUpPrice = 0;
            this.preOrderUpShares = 0;
          }
          }
        }
      }
    } else if (this.preOrderUpId) {
      // 价格脱离区间, 取消
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = "";
      this.preOrderUpPrice = 0;
      this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (limit=${upLimit.toFixed(2)} out of range)`);
    }

    // ── DOWN 侧挂单管理 (趋势up/CL=up时跳过, 低流动性时跳过) ──
    if (!lowLiquidity && trend !== "up" && btcDirPre !== "up" && downInRange) {
      const dnShares = Math.min(MAX_SHARES, Math.floor(singleSideBudget / downLimit));
      if (dnShares >= MIN_SHARES) {
        const drift = Math.abs(downLimit - this.preOrderDownPrice);
        if (!this.preOrderDownId) {
          const oid = await trader.placeGtcBuy(rnd.downToken, dnShares, downLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderDownId = oid;
            this.preOrderDownPrice = downLimit;
            this.preOrderDownShares = dnShares;
            this.preOrderDownToken = rnd.downToken;
            logger.info(`DUAL SIDE: DOWN pre-order ${dnShares}份 @${downLimit.toFixed(2)} (sum target=${(downLimit + upAsk).toFixed(2)})`);
          }
        } else if (needRefresh && drift >= DUAL_SIDE_MIN_DRIFT) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const reFill = await trader.getOrderFillDetails(this.preOrderDownId);
          if (reFill.filled > 0) {
            logger.info(`DUAL SIDE: DOWN filled ${reFill.filled.toFixed(0)} during re-place cancel, will handle next tick`);
          } else {
          const oid = await trader.placeGtcBuy(rnd.downToken, dnShares, downLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderDownId = oid;
            this.preOrderDownPrice = downLimit;
            this.preOrderDownShares = dnShares;
            logger.info(`DUAL SIDE: DOWN re-placed ${dnShares}份 @${downLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
          } else {
            this.preOrderDownId = "";
            this.preOrderDownPrice = 0;
            this.preOrderDownShares = 0;
          }
          }
        }
      }
    } else if (this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = "";
      this.preOrderDownPrice = 0;
      this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (limit=${downLimit.toFixed(2)} out of range)`);
    }

    if (needRefresh) this.preOrderLastRefresh = now;
  }

  /** 预挂单成交 → 转为 Leg1 持仓 */
  private transitionPreOrderToLeg1(
    dir: string,
    leg1Token: string,
    filledShares: number,
    fillPrice: number,
    orderId: string,
    observedSum = 0,
  ): void {
    this.hedgeState = "leg1_filled";
    this.activeStrategyMode = "mispricing";
    this.leg1Dir = dir;
    this.leg1Price = fillPrice;
    this.leg1FillPrice = fillPrice;
    this.leg1OrderId = orderId.slice(0, 12);
    this.leg1FilledAt = Date.now();
    this.leg1Shares = filledShares;
    this.leg1Token = leg1Token;
    this.leg1MakerFill = true; // 预挂单永远是 maker
    this.leg1EntrySource = "dual-side-preorder";
    this.leg1EntryTrendBias = this.currentTrendBias;
    this.leg1EntrySecondsLeft = Math.floor(this.secondsLeft);
    this.leg1AttemptedThisRound = true;
    this.totalCost = filledShares * fillPrice; // maker fee = 0
    // paper 模式下 placeGtcBuy 已预扣 paperBalance, 不要重复扣; 直接同步
    // live 模式下 balance 是链上余额, 成交已扣款
    // 两种模式统一: 从 trader 读取真实余额
    // 注: refreshBalance 是 async 但 transition 是 sync → 保守处理
    // 在 manageDualSideOrders 调用 transition 前后会 refreshBalance
    // 这里仅设 totalCost 用于后续 P/L 计算, 不扣 balance
    this.onLeg1Opened();
    this.status = `Leg1预挂成交 ${dir.toUpperCase()} @${fillPrice.toFixed(2)} x${filledShares.toFixed(0)} maker, 等结算`;
    logger.info(`HEDGE15M DUAL SIDE → LEG1: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 @${fillPrice.toFixed(2)} maker orderId=${orderId.slice(0, 12)}`);
    this.writeRoundAudit("leg1-filled", {
      strategyMode: "mispricing",
      dir,
      entryAsk: fillPrice,
      fillPrice,
      filledShares,
      orderId: orderId.slice(0, 12),
      maker: true,
      fee: 0,
      source: "dual-side-preorder",
      thinEdgeEntry: false,
      observedEntrySum: observedSum,
      preferredSum: 0,
      hardMaxSum: 0,
    });
  }

  /**
   * Limit+FAK 赛跑: 先挂 limit 等待短暂时间, 未成交则 cancel + FAK fallback
   * 返回 { orderId, filled, avgPrice, maker } 或 null(两者都失败)
   */
  private async limitRaceBuy(
    trader: Trader,
    tokenId: string,
    shares: number,
    currentAsk: number,
    limitOffset: number,
    timeoutMs: number,
    negRisk: boolean,
  ): Promise<{ orderId: string; filled: number; avgPrice: number; maker: boolean } | null> {
    const limitPrice = Math.round((currentAsk - limitOffset) * 100) / 100; // 保持 0.01 精度
    if (limitPrice <= 0.01) {
      // limit 价格太低, 直接 FAK
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // ── Phase 1: 挂 GTC limit buy ──
    const gtcOrderId = await trader.placeGtcBuy(tokenId, shares, limitPrice, negRisk);
    if (!gtcOrderId) {
      logger.warn(`LIMIT RACE: GTC buy failed, fallback to FAK`);
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // ── Phase 2: 轮询等待成交 ──
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const details = await trader.getOrderFillDetails(gtcOrderId);
      if (details.filled >= shares * 0.5) {
        // 成交过半, 取消剩余后视为成功
        await trader.cancelOrder(gtcOrderId);
        const finalDetails = await trader.getOrderFillDetails(gtcOrderId);
        const realFilled = finalDetails.filled > details.filled ? finalDetails.filled : details.filled;
        const realAvg = finalDetails.filled > details.filled ? finalDetails.avgPrice : details.avgPrice;
        logger.info(`LIMIT RACE WIN: ${realFilled.toFixed(0)}/${shares} @${realAvg.toFixed(2)} (limit@${limitPrice.toFixed(2)}) maker=true`);
        return { orderId: gtcOrderId, filled: realFilled, avgPrice: realAvg, maker: true };
      }
      // 检查盘口: ask 是否反弹
      const book = trader.peekBestPrices(tokenId, 500);
      if (book && book.ask != null && book.ask > currentAsk * 1.03) {
        // ask 反弹超 3%, 立刻 cancel → FAK
        logger.info(`LIMIT RACE ABORT: ask rebounded ${book.ask.toFixed(2)} > ${currentAsk.toFixed(2)}*1.03, cancel+FAK`);
        break;
      }
      await new Promise(r => setTimeout(r, LIMIT_RACE_POLL_MS));
    }

    // ── Phase 3: 超时/反弹 → cancel → 检查是否在取消前成交 → FAK fallback ──
    let cancelSucceeded = true;
    try {
      await trader.cancelOrder(gtcOrderId);
    } catch {
      cancelSucceeded = false;
    }
    const finalCheck = await trader.getOrderFillDetails(gtcOrderId);
    if (finalCheck.filled > 0) {
      logger.info(`LIMIT RACE LATE: filled ${finalCheck.filled.toFixed(0)} during cancel @${finalCheck.avgPrice.toFixed(2)}, maker=true`);
      return { orderId: gtcOrderId, filled: finalCheck.filled, avgPrice: finalCheck.avgPrice, maker: true };
    }
    if (!cancelSucceeded) {
      // cancel 可能失败, GTC 可能仍挂着, 不安全发 FAK → 再试一次 cancel
      logger.warn(`LIMIT RACE: cancel may have failed, retry cancel before FAK`);
      await trader.cancelOrder(gtcOrderId).catch(() => {});
      const recheck = await trader.getOrderFillDetails(gtcOrderId);
      if (recheck.filled > 0) {
        return { orderId: gtcOrderId, filled: recheck.filled, avgPrice: recheck.avgPrice, maker: true };
      }
    }

    // 完全未成交, FAK fallback — 使用 limit price 而非原始 ask, 防止溢价成交
    logger.info(`LIMIT RACE MISS: no fill in ${timeoutMs}ms @limit=${limitPrice.toFixed(2)}, fallback FAK @${limitPrice.toFixed(2)}`);
    return this.fakBuyFallback(trader, tokenId, shares, limitPrice, negRisk);
  }

  private async fakBuyFallback(
    trader: Trader,
    tokenId: string,
    shares: number,
    askPrice: number,
    negRisk: boolean,
  ): Promise<{ orderId: string; filled: number; avgPrice: number; maker: boolean } | null> {
    const cost = shares * askPrice;
    const res = await trader.placeFakBuy(tokenId, cost, negRisk);
    if (!res) return null;
    const orderId = res?.orderID || res?.order_id || "";
    if (!orderId) return null;
    const details = await trader.waitForOrderFillDetails(orderId, getDynamicParams().fillCheckMs);
    if (details.filled > 0) {
      return { orderId, filled: details.filled, avgPrice: details.avgPrice > 0 ? details.avgPrice : askPrice, maker: false };
    }
    return null;
  }

  /** 下单入场 */
  private async openLeg1Position(
    trader: Trader,
    dir: string,
    askPrice: number,
    buyToken: string,
    budgetPct: number,
    strategyMode: "mispricing",
    signalDetectedAt = Date.now(),
    entrySource = "reactive-mispricing",
  ): Promise<void> {
    const budget = this.balance * budgetPct;
    const shares = Math.min(MAX_SHARES, Math.floor(budget / askPrice));
    if (shares < MIN_SHARES) {
      this.trackRoundRejectReason(`shares ${shares} < ${MIN_SHARES}`);
      logger.warn(`Hedge15m Leg1 skipped: ${shares}份 < ${MIN_SHARES} (balance=$${this.balance.toFixed(2)}, ask=$${askPrice.toFixed(2)})`);
      return;
    }

    const leg1Book = await getHotBestPrices(trader, buyToken);
    const orderbookPlan = evaluateEntryOrderbook({
      askPrice,
      shares,
      liveAsk: leg1Book?.ask ?? null,
      liveBid: leg1Book?.bid ?? null,
      askDepth: leg1Book?.askDepth ?? 0,
      spreadLimit: 0.20,
      reboundLimit: 1.15,
    });
    if (!orderbookPlan.allowed) {
      this.trackRoundRejectReason(`orderbook: ${orderbookPlan.reason}`);
      logger.warn(`Hedge15m Leg1 skipped: ${orderbookPlan.reason}`);
      return;
    }

    const entryAsk = orderbookPlan.entryAsk;
    const entryShares = Math.min(MAX_SHARES, Math.floor(budget / entryAsk));
    if (entryShares < MIN_SHARES) {
      this.trackRoundRejectReason(`fresh shares ${entryShares} < ${MIN_SHARES}`);
      logger.warn(`Hedge15m Leg1 skipped (fresh): ${entryShares}份 < ${MIN_SHARES} @${entryAsk.toFixed(2)}`);
      return;
    }
    const entryCost = entryShares * entryAsk;

    this.leg1EntryInFlight = true;
    this.leg1AttemptedThisRound = true;
    this.hedgeState = "leg1_pending";
    this.status = `Leg1下单中: ${dir.toUpperCase()} @${entryAsk.toFixed(2)} x${entryShares.toFixed(0)}`;

    try {
      const adjustedShares = entryShares;

      // ── Limit race offset: dump快 → 更激进 ──
      let limitOffset = LIMIT_RACE_OFFSET;
      if (this.currentDumpDrop >= LIMIT_RACE_FAST_DUMP_THRESHOLD) {
        limitOffset = LIMIT_RACE_FAST_OFFSET;
      }
      // EV+: 趋势入场价格更稳定, 给maker更多等待时间 → 省2%fee
      const raceTimeout = entrySource === "trend-follow" ? LIMIT_RACE_TIMEOUT_MS + 400 : LIMIT_RACE_TIMEOUT_MS;

      const adjustedCost = adjustedShares * entryAsk;
      logger.info(`HEDGE15M LEG1 ${strategyMode.toUpperCase()}: ${dir.toUpperCase()} ${adjustedShares}份 @${entryAsk.toFixed(2)} cost=$${adjustedCost.toFixed(2)}${entryAsk !== askPrice ? ` (signal@${askPrice.toFixed(2)})` : ""} negRisk=${this.negRisk} limitRace=${LIMIT_RACE_ENABLED}`);
      const orderSubmitStartedAt = Date.now();
      recordExecutionLatency("signalToSubmit", orderSubmitStartedAt - signalDetectedAt);

      let fillResult: { orderId: string; filled: number; avgPrice: number; maker: boolean } | null = null;
      if (LIMIT_RACE_ENABLED) {
        fillResult = await this.limitRaceBuy(trader, buyToken, adjustedShares, entryAsk, limitOffset, raceTimeout, this.negRisk);
      } else {
        fillResult = await this.fakBuyFallback(trader, buyToken, adjustedShares, entryAsk, this.negRisk);
      }

      const orderAckAt = Date.now();
      recordExecutionLatency("submitToAck", orderAckAt - orderSubmitStartedAt);

      if (!fillResult) {
        this.status = "Leg1下单失败, 本轮不重试";
        logger.warn("HEDGE15M Leg1 entry failed (limit race + FAK)");
        return;
      }

      recordExecutionLatency("signalToFill", orderAckAt - signalDetectedAt);

      const orderId = fillResult.orderId;
      const filledShares = fillResult.filled;
      const realFillPrice = fillResult.avgPrice;
      const isMaker = fillResult.maker;
      const actualFee = isMaker ? 0 : TAKER_FEE;

      this.hedgeState = "leg1_filled";
      this.activeStrategyMode = "mispricing";
      this.leg1Dir = dir;
      this.leg1Price = entryAsk;
      this.leg1FillPrice = realFillPrice;
      this.leg1OrderId = orderId ? orderId.slice(0, 12) : "";
      this.leg1FilledAt = Date.now();
      this.leg1Shares = filledShares;
      this.leg1Token = buyToken;
      this.leg1MakerFill = isMaker;
      this.leg1EntrySource = entrySource;
      this.leg1EntryTrendBias = this.currentTrendBias;
      this.leg1EntrySecondsLeft = Math.floor(this.secondsLeft);
      this.totalCost = filledShares * realFillPrice * (1 + actualFee);
      this.balance -= this.totalCost;
      this.onLeg1Opened();
      this.status = `Leg1 ${dir.toUpperCase()} @${realFillPrice.toFixed(2)} x${filledShares.toFixed(0)}${isMaker ? " maker" : ""}, 等结算`;
      logger.info(`HEDGE15M LEG1 FILLED: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 ask=${entryAsk.toFixed(2)} fill=${realFillPrice.toFixed(2)} orderId=${orderId.slice(0, 12)} maker=${isMaker} fee=${(actualFee * 100).toFixed(0)}%`);
      this.writeRoundAudit("leg1-filled", {
        strategyMode: "mispricing",
        dir,
        entryAsk,
        fillPrice: realFillPrice,
        filledShares,
        orderId: orderId.slice(0, 12),
        maker: isMaker,
        fee: actualFee,
        source: entrySource,
      });
    } finally {
      this.leg1EntryInFlight = false;
      if (this.hedgeState === "leg1_pending") {
        this.hedgeState = "watching";
      }
    }
  }

  private async settleHedge(): Promise<void> {
    const preSettleBalance = this.balance; // 记录结算前余额用于校验
    await sleep(2000); // 等待价格源更新

    // 结算方向判断: Binance BTC 价格对比回合开始价
    const btcNow = getBtcPrice();
    let actualDir: "up" | "down";
    let dirSource = "BTC";
    if (this.roundStartBtcPrice > 0 && btcNow > 0) {
      actualDir = btcNow >= this.roundStartBtcPrice ? "up" : "down";
      logger.info(`HEDGE15M SETTLE: BTC start=$${this.roundStartBtcPrice.toFixed(0)} now=$${btcNow.toFixed(0)} → ${actualDir}`);
    } else {
      dirSource = "BOOK";
      let leg1Score = 0;
      if (this.trader && this.leg1Token) {
        const leg1Book = await getHotBestPrices(this.trader, this.leg1Token).catch(() => null);
        if (leg1Book) {
          const leg1Bid = leg1Book.bid ?? 0;
          const leg1Ask = leg1Book.ask ?? 0;
          leg1Score = leg1Bid > 0 ? leg1Bid : leg1Ask;
        }
      }

      if (leg1Score > 0) {
        actualDir = leg1Score >= 0.50 ? (this.leg1Dir === "down" ? "down" : "up") : (this.leg1Dir === "up" ? "down" : "up");
        logger.error(`HEDGE15M SETTLE: BTC unavailable, using orderbook fallback (L1=${leg1Score.toFixed(2)} → ${actualDir})`);
      } else {
        actualDir = this.leg1Dir === "down" ? "down" : "up";
        dirSource = "LEG1_FALLBACK";
        logger.error(`HEDGE15M SETTLE: unable to determine direction, falling back to leg1Dir=${actualDir}`);
      }
    }

    let returnVal = 0;
    if (this.leg1Dir === actualDir && this.leg1Shares > 0) {
      returnVal = this.leg1Shares;
    }

    const profit = returnVal - this.totalCost;
    const result = profit >= 0 ? "WIN" : "LOSS";

    if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
    else { this.losses++; this.consecutiveLosses++; }
    this.totalProfit += profit;
    this.sessionProfit += profit;
    this.recordRollingPnL(profit);
    this.balance += returnVal;
    this.trader?.creditSettlement(returnVal);

    const settlementReason = `结算: BTC ${actualDir.toUpperCase()}(${dirSource}), ${this.leg1Dir===actualDir?'方向正确→$1/份':'方向错误→$0'}`;

    this.history.push({
      time: timeStr(),
      result,
      leg1Dir: this.leg1Dir.toUpperCase(),
      leg1Price: this.leg1Price,
      totalCost: this.totalCost,
      profit,
      cumProfit: this.totalProfit,
      exitType: "settlement",
      exitReason: settlementReason,
      profitBreakdown: `结算回收$${returnVal.toFixed(2)}(${this.leg1Shares.toFixed(0)}份) - 成本$${this.totalCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
      leg1Shares: this.leg1Shares,
      leg1FillPrice: this.leg1FillPrice,
      orderId: this.leg1OrderId,
      estimated: this.leg1Estimated,
      entrySource: this.leg1EntrySource,
      entryTrendBias: this.leg1EntryTrendBias,
      entrySecondsLeft: this.leg1EntrySecondsLeft,
    });
    if (this.history.length > 200) this.history.shift();
    this.saveHistory();

    this.status = `结算: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (返$${returnVal.toFixed(2)} dir=${actualDir}/${dirSource})`;
    logger.info(`HEDGE15M SETTLED: ${result} dir=${actualDir}(${dirSource}) return=$${returnVal.toFixed(2)} cost=$${this.totalCost.toFixed(2)} profit=$${profit.toFixed(2)} L1fill=${this.leg1FillPrice.toFixed(2)}`);
    this.writeRoundAudit("settlement", {
      result,
      actualDir,
      dirSource,
      returnVal,
      profit,
      settlementReason,
    });

    // 等待链上结算生效后再同步余额
    await sleep(5000);
    await this.refreshBalance();

    // ── 结算 P/L 校验: 链上余额 vs 本地预期 ──
    if (this.tradingMode === "live") {
      const expectedBalance = preSettleBalance + returnVal;
      const drift = Math.abs(this.balance - expectedBalance);
      if (drift > 0.50) {
        logger.warn(`SETTLE P/L DRIFT: expected=$${expectedBalance.toFixed(2)} actual=$${this.balance.toFixed(2)} drift=$${drift.toFixed(2)} (cost=$${this.totalCost.toFixed(2)} return=$${returnVal.toFixed(2)})`);
        this.writeRoundAudit("settle-pl-drift", { preSettleBalance, expectedBalance, actualBalance: this.balance, drift, returnVal, totalCost: this.totalCost });
      }
    }

    this.totalCost = 0;
    this.leg1Shares = 0;
    this.hedgeState = "done";
  }
}
