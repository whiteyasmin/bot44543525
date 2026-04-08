import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { startLatencyMonitor, stopLatencyMonitor, recordLatency, getDynamicParams } from "./latency";
import { getCurrentRound15m, prefetchNextRound, Round15m } from "./market";
import {
  startPriceFeed, getBtcPrice,
  getChainlinkPrice, getChainlinkDirection, isChainlinkFresh,
  setRoundSecsLeft, setRoundStartPrice, stopPriceFeed,
  getRecentMomentum,
} from "./btcPrice";
import { HISTORY_FILE, PAPER_HISTORY_FILE } from "./audit";
import { clearPaperRuntimeState, loadPaperRuntimeState, savePaperRuntimeState } from "./paperRuntimeState";
import { RoundMarketState } from "./marketState";
import { estimateFilledShares, evaluateEntryOrderbook } from "./executionManager";
import { planHedgeEntry, planTrendEntry } from "./executionPlanner";
import {
  evaluateMispricingOpportunity,
  evaluateTrendOpportunity,
  getDirectionalBias as getDirectionalBiasSignal,
} from "./strategyEngine";
import { Trader } from "./trader";

// ── 15分钟对冲机器人参数 (延迟相关参数由 getDynamicParams() 提供) ──
const MIN_SHARES      = 3;        // 最少3份, 低于此不开仓 (从5降低, 避免小余额死循环)
const MAX_SHARES      = 100;      // 单腿上限100份
const SUM_TARGET      = 0.93;     // Leg1 + Leg2 fillPrice ≤ 此值买入Leg2 (利润≈5.1%含手续费)
const DUMP_THRESHOLD  = 0.10;     // ask 跌幅 ≥10% 触发Leg1
const ENTRY_WINDOW_S  = 420;      // 开局7分钟内监控砸盘, 配合MIN_ENTRY_SECS=480
const ROUND_DURATION  = 900;      // 15分钟
const TAKER_FEE       = 0.02;     // Polymarket taker fee ~2%
const MAX_SUM_TARGET  = 0.96;     // 渐进最高放宽到此, 保留~2%利润缓冲
const MIN_ENTRY_SECS  = 480;      // 剩余 <8分钟不开新仓
const LEG1_STOP_LOSS  = 0.82;     // Leg1 bid跌至入场价*82%时止损 (统一用adaptive更紧的止损)
const LEG1_STOP_ABS   = 0.15;     // Leg1 bid绝对下限, 低于此无论入场价都止损
const MAX_ENTRY_ASK   = 0.50;     // Leg1 入场价上限 (实盘)
const MIN_ENTRY_ASK   = 0.25;     // Leg1 入场价下限, 低于此成功对冲概率极低
const PAPER_SUM_TARGET = 0.95;    // 仿真盘sum target (回测最优)
const PAPER_MAX_SUM_TARGET = 0.97;
const PAPER_MAX_ENTRY_ASK = 0.59;
const PAPER_HARD_MAX_SUM_TARGET = 0.99;
const PAPER_SUM_ADJUST_STEP = 0.01;
const PAPER_SKIP_ADJUST_TRIGGER = 2;
const PAPER_DYNAMIC_TUNING_ENABLED = false;
const PAPER_MIN_LOCKED_PROFIT = 0.02;     // 至少锁定 $0.02 (不再是主要门槛)
const PAPER_MIN_LOCKED_ROI = 0.02;        // 至少锁定 2% ROI (主要门槛)
const PAPER_ENTRY_SUM_BUFFER = 0.01;      // 入场时预留对冲空间buffer
const DIRECTIONAL_ENTRY_SUM_BONUS = 0.01; // 顺势且价格足够低时, 允许多拿一点对冲空间
const DIRECTIONAL_ENTRY_ASK_CAP = 0.35;
const DIRECTIONAL_MOVE_PCT = 0.0012;       // 回合内价格移动超过 0.12% 才形成方向偏置
const MOMENTUM_WINDOW_SEC = 60;            // 短期动量窗口 60秒
const MOMENTUM_CONTRA_PCT = 0.0006;        // BTC 60s内反方向移动超过 0.06% 则拒绝dump
const TREND_WINDOW_SEC = 180;              // 中期趋势窗口 180秒
const TREND_CONTRA_PCT = 0.0015;           // BTC 180s内单边超过 0.15% 则视为真实趋势
const TREND_ENTRY_MAX_SECS = 840;          // 趋势单仅在回合前期介入
const TREND_ENTRY_MIN_SECS = 480;          // 趋势单剩余时间过少不追
const TREND_SHORT_TRIGGER_PCT = 0.0018;    // 60s 同向至少 0.18%
const TREND_MEDIUM_TRIGGER_PCT = 0.0025;   // 180s 同向至少 0.25%
const TREND_ROUND_TRIGGER_PCT = 0.0030;    // 本回合累计至少单边 0.30%
const TREND_CONFIRM_TRIGGER = 4;           // 连续4次确认后才视为持续趋势
const TREND_MAX_ENTRY_ASK = 0.68;          // 趋势追价上限
const TREND_BUDGET_PCT = 0.08;             // 趋势单更轻仓
const TREND_TAKE_PROFIT_BID = 0.90;        // 趋势单高胜率先落袋
const TREND_STOP_LOSS_BID = 0.42;          // 趋势失败快速退出
const STRATEGY_POLICY = "mispricing-first" as const;
const BASE_BUDGET_PCT = 0.18;             // 默认轻仓，优先控制回撤
const THIN_EDGE_BUDGET_PCT = 0.12;        // 对冲空间偏薄时进一步缩仓
const HIGH_ASK_BUDGET_PCT = 0.10;         // 高价入场只允许极小仓位
const LEG1_HEDGE_TIMEOUT_SECS = 30;
const LEG1_HEDGE_TIMEOUT_MIN_SECS = 15;
const LEG1_HEDGE_TIMEOUT_SUM_BUFFER = 0.03;
const EARLY_EXIT_AFTER_MS = 90_000;
const EARLY_EXIT_SUM_BUFFER = 0.06;
const BALANCE_ESTIMATE_MIN_PCT = 0.70;
const BALANCE_ESTIMATE_MAX_PCT = 1.15;

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
  hedgeLeg2Price: number;
  hedgeTotalCost: number;
  expectedProfit: number;
  dumpDetected: string;
  tuningEnabled: boolean;
  baseSumTarget: number;
  maxSumTarget: number;
  maxEntryAsk: number;
  adjustmentCount: number;
  lastAdjustment: string;
  activeStrategyMode: string;
  strategyPolicy: string;
  trendBias: string;
  sessionROI: number;
  latencyP50: number;
  latencyP90: number;
}

export interface Hedge15mStartOptions {
  mode?: "live" | "paper";
  paperBalance?: number;
  paperSessionMode?: PaperSessionMode;
}

export interface HedgeHistoryEntry {
  time: string;
  result: string;
  leg1Dir: string;
  leg1Price: number;        // Leg1 入场 ask (报价)
  leg2Price: number;        // Leg2 入场 ask (报价)
  totalCost: number;
  profit: number;
  cumProfit: number;
  // ── 真实成交数据 ──
  exitType?: string;        // "settlement" | "take-profit" | "stop-loss" | "force-exit" | "gtc-fill"
  exitReason?: string;      // 人类可读退出理由
  leg1Shares?: number;      // Leg1 实际成交份数
  leg2Shares?: number;      // Leg2 实际成交份数
  leg1FillPrice?: number;   // Leg1 真实平均成交价
  leg2FillPrice?: number;   // Leg2 真实平均成交价
  sellPrice?: number;       // 卖出真实成交价 (非结算退出时)
  sellShares?: number;      // 卖出份数
  orderId?: string;         // 关联订单ID (截取前12位)
  sellOrderId?: string;     // 卖出订单ID
  estimated?: boolean;      // 是否含估算数据 (无orderId时通过余额推断)
  profitBreakdown?: string; // 盈亏计算明细: "回收$X - 成本$Y = 盈亏$Z"
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
  const cached = trader.peekBestPrices(tokenId);
  if (cached) return cached;
  return withTimeout(trader.getBestPrices(tokenId), getDynamicParams().orderbookTimeoutMs);
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
  private upAsk = 0;
  private downAsk = 0;

  // Hedge state
  private hedgeState: "off" | "watching" | "leg1_pending" | "leg1_filled" | "leg2_filled" | "done" = "off";
  private leg1Dir = "";
  private leg1Price = 0;
  private leg1Shares = 0;
  private leg1Token = "";
  private leg2Token = "";
  private leg2Price = 0;
  private leg2Shares = 0;
  private totalCost = 0;
  private expectedProfit = 0;
  private dumpDetected = "";
  private roundStartBtcPrice = 0; // 用于结算方向回退
  private consecutiveLosses = 0;  // 连亏计数器
  private negRisk = false;        // 当前市场的 negRisk 标志
  private sessionProfit = 0;      // 本次会话累计盈亏, 用于止损判断(不受历史影响)
  private pendingSellOrderId = ""; // GTC卖单追踪，FAK失败时挂限价单
  private pendingSellOrderTime = 0;  // GTC卖单创建时间戳
  private pendingSellPrice = 0;      // GTC卖单挂单价格
  private leg1FillPrice = 0;         // Leg1 真实平均成交价
  private leg2FillPrice = 0;         // Leg2 真实平均成交价
  private leg1OrderId = "";          // Leg1 订单ID
  private leg2OrderId = "";          // Leg2 订单ID
  private leg1FilledAt = 0;
  private leg1Estimated = false;       // Leg1 成交是否为估算值
  private leg2Estimated = false;       // Leg2 成交是否为估算值
  private leg1EntryInFlight = false;
  private leg1AttemptedThisRound = false;
  private adaptiveBaseSumTarget = PAPER_SUM_TARGET;
  private adaptiveMaxSumTarget = PAPER_MAX_SUM_TARGET;
  private adaptiveMaxEntryAsk = PAPER_MAX_ENTRY_ASK;
  private adaptiveAdjustmentCount = 0;
  private adaptiveLastAdjustment = "";
  private adaptiveSumSkipRounds = 0;
  private adaptiveSumOkRounds = 0;
  private adaptiveRoundRejectedBySum = false;
  private adaptiveRoundRejectedByEntryAsk = false;
  private roundMomentumRejects = 0;
  private roundSumRejects = 0;
  private roundEntryAskRejects = 0;
  private minLockedProfit = PAPER_MIN_LOCKED_PROFIT;
  private minLockedRoi = PAPER_MIN_LOCKED_ROI;
  private loopRunId = 0;
  private activeStrategyMode: "none" | "mispricing" | "trend" = "none";
  private currentTrendBias: "up" | "down" | "flat" = "flat";
  private trendSignalStreak = 0;
  private trendSignalDir: "up" | "down" | "flat" = "flat";

  // Market state layer
  private marketState = new RoundMarketState();

  private resetAdaptivePaperTuning(): void {
    this.adaptiveBaseSumTarget = PAPER_SUM_TARGET;
    this.adaptiveMaxSumTarget = PAPER_MAX_SUM_TARGET;
    this.adaptiveMaxEntryAsk = PAPER_MAX_ENTRY_ASK;
    this.adaptiveAdjustmentCount = 0;
    this.adaptiveLastAdjustment = PAPER_DYNAMIC_TUNING_ENABLED ? "" : "动态调参已关闭，使用固定严格参数";
    this.adaptiveSumSkipRounds = 0;
    this.adaptiveSumOkRounds = 0;
    this.adaptiveRoundRejectedBySum = false;
    this.adaptiveRoundRejectedByEntryAsk = false;
    this.minLockedProfit = PAPER_MIN_LOCKED_PROFIT;
    this.minLockedRoi = PAPER_MIN_LOCKED_ROI;
  }

  private clearAdaptiveRoundSkipCounts(): void {
    this.adaptiveRoundRejectedBySum = false;
    this.adaptiveRoundRejectedByEntryAsk = false;
  }

  private resetRoundRejectStats(): void {
    this.roundMomentumRejects = 0;
    this.roundSumRejects = 0;
    this.roundEntryAskRejects = 0;
  }

  private logRoundRejectSummary(reason: string): void {
    const parts: string[] = [];
    if (this.roundMomentumRejects > 0) parts.push(`momentum=${this.roundMomentumRejects}`);
    if (this.roundSumRejects > 0) parts.push(`sum=${this.roundSumRejects}`);
    if (this.roundEntryAskRejects > 0) parts.push(`entryAsk=${this.roundEntryAskRejects}`);
    if (parts.length === 0) return;
    logger.info(`HEDGE15M ROUND SUMMARY: ${reason}, rejects(${parts.join(", ")})`);
  }

  private resetTrendSignalTracking(): void {
    this.trendSignalStreak = 0;
    this.trendSignalDir = "flat";
  }

  private noteTrendSignal(dir: "up" | "down"): number {
    if (this.trendSignalDir === dir) {
      this.trendSignalStreak += 1;
    } else {
      this.trendSignalDir = dir;
      this.trendSignalStreak = 1;
    }
    return this.trendSignalStreak;
  }

  private noteAdaptivePaperSkip(reason: "sum" | "entry-ask"): void {
    if (reason === "sum") this.roundSumRejects += 1;
    else this.roundEntryAskRejects += 1;
    if (this.tradingMode !== "paper" || !PAPER_DYNAMIC_TUNING_ENABLED) return;
    if (reason === "sum") {
      this.adaptiveRoundRejectedBySum = true;
      return;
    }
    this.adaptiveRoundRejectedByEntryAsk = true;
  }

  private finalizeAdaptivePaperRound(): void {
    if (this.tradingMode !== "paper" || !PAPER_DYNAMIC_TUNING_ENABLED) return;

    if (this.adaptiveRoundRejectedBySum) {
      this.adaptiveSumSkipRounds += 1;
      this.adaptiveSumOkRounds = 0;
      if (this.adaptiveSumSkipRounds >= PAPER_SKIP_ADJUST_TRIGGER) {
        this.adaptiveSumSkipRounds = 0;
        this.adjustAdaptivePaperTuning();
      }
    } else {
      this.adaptiveSumSkipRounds = 0;
      this.adaptiveSumOkRounds += 1;
      if (this.adaptiveSumOkRounds >= PAPER_SKIP_ADJUST_TRIGGER) {
        this.adaptiveSumOkRounds = 0;
        this.decayAdaptivePaperTuning();
      }
    }

    if (this.adaptiveRoundRejectedByEntryAsk && !this.adaptiveRoundRejectedBySum) {
      this.adaptiveLastAdjustment = `${timeStr()} 入场价过高，本轮保持 entryAsk 不放宽`;
      logger.info(`PAPER AUTO-TUNE NOTE: ${this.adaptiveLastAdjustment}`);
    }
  }

  private adjustAdaptivePaperTuning(): void {
    if (!PAPER_DYNAMIC_TUNING_ENABLED) return;
    const changes: string[] = [];
    const nextMax = Math.min(PAPER_HARD_MAX_SUM_TARGET, this.adaptiveMaxSumTarget + PAPER_SUM_ADJUST_STEP);
    if (nextMax > this.adaptiveMaxSumTarget) {
      this.adaptiveMaxSumTarget = Math.max(nextMax, this.adaptiveBaseSumTarget);
      changes.push(`maxSum→${this.adaptiveMaxSumTarget.toFixed(2)}`);
    }

    if (changes.length === 0) return;

    this.adaptiveAdjustmentCount += 1;
    this.adaptiveLastAdjustment = `${timeStr()} 连续${PAPER_SKIP_ADJUST_TRIGGER}轮 sum 过高: ${changes.join(", ")}`;
    logger.warn(`PAPER AUTO-TUNE #${this.adaptiveAdjustmentCount}: ${this.adaptiveLastAdjustment}`);
  }

  private decayAdaptivePaperTuning(): void {
    if (!PAPER_DYNAMIC_TUNING_ENABLED) return;
    if (this.adaptiveBaseSumTarget <= PAPER_SUM_TARGET && this.adaptiveMaxSumTarget <= PAPER_MAX_SUM_TARGET) return;
    const changes: string[] = [];
    if (this.adaptiveMaxSumTarget > PAPER_MAX_SUM_TARGET) {
      this.adaptiveMaxSumTarget = Math.max(PAPER_MAX_SUM_TARGET, this.adaptiveMaxSumTarget - PAPER_SUM_ADJUST_STEP);
      if (this.adaptiveMaxSumTarget < this.adaptiveBaseSumTarget) this.adaptiveMaxSumTarget = this.adaptiveBaseSumTarget;
      changes.push(`maxSum→${this.adaptiveMaxSumTarget.toFixed(2)}`);
    }
    if (changes.length === 0) return;
    this.adaptiveAdjustmentCount += 1;
    this.adaptiveLastAdjustment = `${timeStr()} 连续${PAPER_SKIP_ADJUST_TRIGGER}轮正常入场, 收紧: ${changes.join(", ")}`;
    logger.info(`PAPER AUTO-TUNE #${this.adaptiveAdjustmentCount}: ${this.adaptiveLastAdjustment}`);
  }

  private tightenAdaptivePaperAfterLoss(): void {
    if (this.tradingMode !== "paper" || !PAPER_DYNAMIC_TUNING_ENABLED) return;
    const changes: string[] = [];
    if (this.adaptiveMaxSumTarget > PAPER_MAX_SUM_TARGET) {
      this.adaptiveMaxSumTarget = Math.max(PAPER_MAX_SUM_TARGET, this.adaptiveMaxSumTarget - PAPER_SUM_ADJUST_STEP);
      if (this.adaptiveMaxSumTarget < this.adaptiveBaseSumTarget) this.adaptiveMaxSumTarget = this.adaptiveBaseSumTarget;
      changes.push(`maxSum→${this.adaptiveMaxSumTarget.toFixed(2)}`);
    }
    if (changes.length === 0) return;
    this.adaptiveLastAdjustment = `${timeStr()} 亏损后收紧: ${changes.join(", ")}`;
    logger.warn(`PAPER AUTO-TUNE TIGHTEN: ${this.adaptiveLastAdjustment}`);
  }

  private onLeg1Opened(): void {
    this.leg1AttemptedThisRound = true;
    this.adaptiveSumSkipRounds = 0;
    this.clearAdaptiveRoundSkipCounts();
  }

  private isActiveRun(runId: number): boolean {
    return this.running && this.loopRunId === runId;
  }

  private getPaperEntryQualityMaxSum(maxSumTarget: number): number {
    if (this.tradingMode !== "paper") return maxSumTarget;
    const base = this.getBaseSumTarget();
    const buffer = PAPER_ENTRY_SUM_BUFFER;
    return Math.min(maxSumTarget, base + buffer);
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

  private getAdaptiveLegBudgetPct(askPrice: number, oppCurrentAsk: number, preferredMaxSum: number): number {
    let budgetPct = BASE_BUDGET_PCT;
    if (askPrice >= 0.40) {
      budgetPct = Math.min(budgetPct, HIGH_ASK_BUDGET_PCT);
    }
    if (oppCurrentAsk > 0 && askPrice + oppCurrentAsk >= preferredMaxSum - 0.005) {
      budgetPct = Math.min(budgetPct, THIN_EDGE_BUDGET_PCT);
    }
    return budgetPct;
  }

  private getLeg1StopLossThreshold(): number {
    return LEG1_STOP_LOSS;
  }

  private getBaseSumTarget(): number {
    return this.tradingMode === "paper" ? this.adaptiveBaseSumTarget : SUM_TARGET;
  }

  private getMaxSumTarget(): number {
    return this.tradingMode === "paper" ? this.adaptiveMaxSumTarget : MAX_SUM_TARGET;
  }

  private getMaxEntryAsk(): number {
    return this.tradingMode === "paper" ? this.adaptiveMaxEntryAsk : MAX_ENTRY_ASK;
  }

  private getLeg2Target(secs: number): number {
    const base = this.getBaseSumTarget();
    const max = this.getMaxSumTarget();
    const near120 = Math.min(max, base + 0.01);
    const near60 = Math.min(max, base + 0.02);
    if (secs <= 30) return max;
    if (secs <= 60) return near60;
    if (secs <= 120) return near120;
    return base;
  }

  private getRoundPhase(): string {
    if (!this.running) return "idle";
    if (this.hedgeState === "off") return "booting";
    if (this.pendingSellOrderId) return "gtc_pending";
    if (this.hedgeState === "leg2_filled") return "hedged";
    if (this.hedgeState === "leg1_pending") return "leg1_pending";
    if (this.hedgeState === "leg1_filled") return "leg1_filled";
    if (this.hedgeState === "watching") {
      if (this.consecutiveLosses >= 3) return "cooldown";
      if (this.secondsLeft < MIN_ENTRY_SECS) return "waiting_next_round";
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
    if (this.status.startsWith("冷却中")) return this.status;
    if (this.status === "窗口到期,无砸盘") return this.status;
    if (this.pendingSellOrderId) return "已挂GTC卖单, 等待成交";
    if (this.hedgeState === "leg1_pending") return "Leg1 下单中";
    if (this.hedgeState === "leg2_filled") return "双腿已锁定, 等退出/结算";
    if (this.hedgeState === "leg1_filled") return "已成交Leg1, 等Leg2或退出";
    if (this.hedgeState === "watching") return this.secondsLeft >= MIN_ENTRY_SECS ? "本轮仍在观察窗口" : "本轮入场窗已关闭";
    return this.status || "等待中";
  }

  getState(): Hedge15mState {
    const dp = getDynamicParams();
    const secondsLeft = Math.max(0, Math.min(ROUND_DURATION, this.secondsLeft));
    const hasRoundClock = secondsLeft > 0;
    const roundElapsed = hasRoundClock ? Math.max(0, Math.min(ROUND_DURATION, ROUND_DURATION - secondsLeft)) : 0;
    const roundProgressPct = hasRoundClock && ROUND_DURATION > 0 ? (roundElapsed / ROUND_DURATION) * 100 : 0;
    const entryWindowLeft = Math.max(0, secondsLeft - MIN_ENTRY_SECS);
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
      canOpenNewPosition: this.running && this.hedgeState === "watching" && secondsLeft >= MIN_ENTRY_SECS && this.consecutiveLosses < 3,
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
      hedgeLeg2Price: this.leg2Price,
      hedgeTotalCost: this.totalCost,
      expectedProfit: this.expectedProfit,
      dumpDetected: this.dumpDetected,
      tuningEnabled: this.tradingMode === "paper" && PAPER_DYNAMIC_TUNING_ENABLED,
      baseSumTarget: this.getBaseSumTarget(),
      maxSumTarget: this.getMaxSumTarget(),
      maxEntryAsk: this.getMaxEntryAsk(),
      adjustmentCount: this.adaptiveAdjustmentCount,
      lastAdjustment: this.adaptiveLastAdjustment,
      activeStrategyMode: this.activeStrategyMode,
      strategyPolicy: STRATEGY_POLICY,
      trendBias: this.currentTrendBias,
      sessionROI: this.initialBankroll > 0 ? (this.totalProfit / this.initialBankroll) * 100 : 0,
      latencyP50: dp.p50,
      latencyP90: dp.p90,
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
      savePaperRuntimeState({
        balance: this.balance,
        initialBankroll: this.initialBankroll,
        sessionProfit: this.sessionProfit,
        updatedAt: new Date().toISOString(),
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
    this.resetAdaptivePaperTuning();
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
    this.history = [];
    this.loadHistory();
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
    this.leg2Token = "";
    this.leg2Price = 0;
    this.leg2Shares = 0;
    this.totalCost = 0;
    this.expectedProfit = 0;
    this.dumpDetected = "";
    this.activeStrategyMode = "none";
    this.currentTrendBias = "flat";
    this.resetTrendSignalTracking();
    this.marketState.reset();
    this.roundStartBtcPrice = 0;
    this.negRisk = false;
    this.pendingSellOrderId = "";
    this.pendingSellOrderTime = 0;
    this.pendingSellPrice = 0;
    this.leg1FillPrice = 0;
    this.leg2FillPrice = 0;
    this.leg1OrderId = "";
    this.leg2OrderId = "";
    this.leg1FilledAt = 0;
    this.leg1Estimated = false;
    this.leg2Estimated = false;
    this.leg1EntryInFlight = false;
    this.leg1AttemptedThisRound = false;
    this.resetRoundRejectStats();
    this.clearAdaptiveRoundSkipCounts();
  }

  // ── Main Loop ──

  private async mainLoop(runId: number): Promise<void> {
    const trader = this.trader!;
    let curCid = "";

    while (this.isActiveRun(runId)) {
      try {
        // Stop loss: 本次会话亏损超 30% 初始余额
        if (this.initialBankroll > 0 && -this.sessionProfit >= this.initialBankroll * 0.30) {
          this.status = `止损: 本次会话亏损超30%`;
          this.running = false;
          break;
        }

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
          this.upAsk = 0;
          this.downAsk = 0;
          await trader.cancelAll();
          await this.refreshBalance();
          this.totalRounds++;
          this.roundStartBtcPrice = getBtcPrice();
          setRoundStartPrice(); // 同步设置 btcPrice 模块的回合基准, 修正 Chainlink 方向判断
          this.negRisk = !!rnd.negRisk;
          // 跳过剩余时间不足的回合 — 无法完成 dump检测 + 对冲
          if (secs < MIN_ENTRY_SECS) {
            this.hedgeState = "done";
            this.status = `跳过: 剩余${Math.floor(secs)}s < ${MIN_ENTRY_SECS}s`;
            this.skips++;
            logger.info(`HEDGE15M SKIP LATE ROUND: ${Math.floor(secs)}s < ${MIN_ENTRY_SECS}s minimum`);
          } else {
            logger.info(`HEDGE15M ROUND: ${rnd.question}, ${Math.floor(secs)}s left, BTC=$${this.roundStartBtcPrice.toFixed(0)}`);
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
          if (upRes && dnRes) recordLatency(callMs); // 仅成功调用计入延迟样本
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
          this.status = `监控砸盘 (${Math.floor(elapsed)}/${ENTRY_WINDOW_S}s)`;

          if (this.upAsk > 0 && this.downAsk > 0) {
            const { dumpWindowMs, dumpBaselineMs } = getDynamicParams();
            this.marketState.push(this.upAsk, this.downAsk, dumpWindowMs + 500);

            // ── 连亏冷却: 3连亏后跳过1轮 ──
            if (this.consecutiveLosses >= 3) {
              this.status = `冷却中 (连亏${this.consecutiveLosses}次, 跳过本轮)`;
              // 下一轮会重置
            } else {

            const dumpBaseline = this.marketState.getDumpBaseline(dumpBaselineMs);
            if (dumpBaseline) {
              const shortMomentum = getRecentMomentum(MOMENTUM_WINDOW_SEC);
              const trendMomentum = getRecentMomentum(TREND_WINDOW_SEC);
              const btcNow = getBtcPrice();
              const roundDeltaPct = this.roundStartBtcPrice > 0 && btcNow > 0
                ? (btcNow - this.roundStartBtcPrice) / this.roundStartBtcPrice
                : 0;
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
              });

              if (mispricing.bothSidesDumping) {
                logger.warn(`HEDGE15M SKIP: both sides dumping (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%) — liquidity drain`);
              } else {
                if (mispricing.cautionMessage) {
                  logger.warn(`HEDGE15M CAUTION: ${mispricing.cautionMessage} — proceeding with caution`);
                }
                for (const rejectMessage of mispricing.momentumRejects) {
                  this.roundMomentumRejects += 1;
                  logger.warn(`HEDGE15M MOMENTUM REJECT: ${rejectMessage}`);
                }

                const candidate = mispricing.candidates[0];
                if (candidate) {
                  this.dumpDetected = candidate.dumpDetected;
                  this.activeStrategyMode = "mispricing";
                  this.resetTrendSignalTracking();
                  logger.info(`HEDGE15M DUMP${mispricing.candidates.length > 1 ? ` (选${candidate.dir.toUpperCase()})` : ""}: ${this.dumpDetected}`);
                  await this.buyLeg1(
                    trader,
                    rnd,
                    candidate.dir,
                    candidate.askPrice,
                    rnd[candidate.buyTokenKey],
                    rnd[candidate.oppTokenKey],
                  );
                } else if (STRATEGY_POLICY === "mispricing-first") {
                  const trendOpportunity = evaluateTrendOpportunity({
                    secondsLeft: secs,
                    upAsk: this.upAsk,
                    downAsk: this.downAsk,
                    shortMomentum,
                    trendMomentum,
                    directionalBias,
                    minEntrySecs: TREND_ENTRY_MIN_SECS,
                    maxEntrySecsLeft: TREND_ENTRY_MAX_SECS,
                    shortTriggerPct: TREND_SHORT_TRIGGER_PCT,
                    trendTriggerPct: TREND_MEDIUM_TRIGGER_PCT,
                    maxEntryAsk: TREND_MAX_ENTRY_ASK,
                  });
                  if (trendOpportunity) {
                    const sustainedRoundTrend = trendOpportunity.dir === "up"
                      ? roundDeltaPct >= TREND_ROUND_TRIGGER_PCT
                      : roundDeltaPct <= -TREND_ROUND_TRIGGER_PCT;
                    if (sustainedRoundTrend) {
                      const streak = this.noteTrendSignal(trendOpportunity.dir);
                      this.status = `趋势确认中: ${trendOpportunity.dir.toUpperCase()} ${streak}/${TREND_CONFIRM_TRIGGER}`;
                      if (streak >= TREND_CONFIRM_TRIGGER) {
                        this.activeStrategyMode = "trend";
                        logger.info(`HEDGE15M TREND SIGNAL: ${trendOpportunity.reason} round=${(roundDeltaPct * 100).toFixed(3)}% confirm=${streak}/${TREND_CONFIRM_TRIGGER}`);
                        await this.buyTrendLeg(
                          trader,
                          rnd,
                          trendOpportunity.dir,
                          trendOpportunity.askPrice,
                          trendOpportunity.dir === "up" ? rnd.upToken : rnd.downToken,
                          trendOpportunity.dir === "up" ? rnd.downToken : rnd.upToken,
                        );
                      }
                    } else {
                      this.resetTrendSignalTracking();
                    }
                  } else {
                    this.resetTrendSignalTracking();
                  }
                } else {
                  this.resetTrendSignalTracking();
                }
              }
            }
            } // end consecutive loss guard
          }

          // Window expired
          if (elapsed >= ENTRY_WINDOW_S && this.hedgeState === "watching") {
            this.hedgeState = "done";
            this.status = "窗口到期,无砸盘";
            this.skips++;
            this.logRoundRejectSummary("window expired without entry");
            this.finalizeAdaptivePaperRound();
            if (this.consecutiveLosses >= 3) {
              this.consecutiveLosses = 0;
              logger.info(`HEDGE15M: cooldown round done, loss streak reset`);
            }
          }
        }

        if (this.hedgeState === "leg1_filled") {
          try {
            const [leg1Res, oppRes] = await Promise.all([
              getHotBestPrices(trader, this.leg1Token),
              getHotBestPrices(trader, this.leg2Token),
            ]);
            if (!this.isActiveRun(runId)) break;
            const leg1Bid = leg1Res?.bid ?? null;
            const oppAsk = oppRes?.ask ?? null;

            // ── 优先管理已挂出的GTC卖单 (独立于TP/SL条件) ──
            if (this.pendingSellOrderId) {
              await this.managePendingSell(trader, leg1Bid, secs);
            }

            // ── 无挂单时: TP/SL/Leg2 逻辑 ──
            if (!this.pendingSellOrderId && this.hedgeState === "leg1_filled") {
              if (this.activeStrategyMode === "trend") {
                await this.manageTrendLeg(trader, leg1Bid, secs);
              }
              else {
              // ── Leg1 止盈: 仅当反转风险 > 手续费损失时才卖 ──
              // bid=B 卖出回收 B*0.98; 持有到结算EV=B*$1=B
              // 只有当认为方向可能反转时才值得卖: >300s时反转风险较高
              // 但 bid≥0.95 说明市场95%确定, 反转概率极低, 不值得丢手续费
              // 新策略: 仅在 >300s 且 bid≥0.95 时止盈(锁定95%利润, 防小概率反转)
              //          90-300s: 不止盈, 等结算拿100%
              //          ≤90s: 不卖, 结算拿满
              if (leg1Bid != null && leg1Bid >= 0.95 && secs > 300) {
                logger.info(`HEDGE15M LEG1 TAKE-PROFIT: bid=${leg1Bid.toFixed(2)} >= 0.95, locking ${(leg1Bid*0.98*100).toFixed(1)}% with ${secs.toFixed(0)}s left (reversal risk > fee)`);
                await this.emergencySellLeg1(trader, "止盈", leg1Bid);
              }
              // ── Leg1 止损: 全时段生效(secs>30), 消陨15-120s空窗 ──
              // 相对阈值(入场价*75%) 或 绝对阈值(bid<0.15)
              else if (leg1Bid != null && secs > 30 && (
                leg1Bid < this.leg1Price * this.getLeg1StopLossThreshold() ||   // adaptive 更早止损
                leg1Bid < LEG1_STOP_ABS                         // 绝对: 低于15%, 方向几乎错误
              )) {
                const stopLossThreshold = this.getLeg1StopLossThreshold();
                const reason = leg1Bid < LEG1_STOP_ABS
                  ? `绝对止损 bid=${leg1Bid.toFixed(2)}<${LEG1_STOP_ABS}`
                  : `中途止损 bid=${leg1Bid.toFixed(2)}<entry*${stopLossThreshold}=${(this.leg1Price*stopLossThreshold).toFixed(2)}`;
                logger.info(`HEDGE15M LEG1 STOP-LOSS: ${reason}, ${secs.toFixed(0)}s left`);
                await this.emergencySellLeg1(trader, "中途止损", leg1Bid);
              }
              // ── 渐进式 SUM_TARGET(用真实成交价): 越接近结算越放宽 ──
              else if (oppAsk != null && oppAsk > 0) {
                // ── 如果Leg1方向高度确定(bid≥0.80), 跳过Leg2等结算拿$1 ──
                if (leg1Bid != null && leg1Bid >= 0.80 && secs <= 120) {
                  this.status = `Leg1方向确定(bid=${leg1Bid.toFixed(2)}≥0.80), 等结算拿$1`;
                  // 不买Leg2, 结算拿满比花钱对冲更优
                }
                else {
                  const target = this.getLeg2Target(secs);

                  // 用真实成交价而非ask报价, 避免滑点导致利润误判
                  const fillPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
                  const sum = fillPrice + oppAsk;
                  this.status = `等Leg2: L1=${this.leg1Dir.toUpperCase()}@${fillPrice.toFixed(2)} 对面ask=${oppAsk.toFixed(2)} sum=${sum.toFixed(2)} target≤${target.toFixed(2)} ${secs<=60?'⏰':''}`;

                  if (sum <= target) {
                    await this.buyLeg2(trader, oppAsk, target);
                  }
                }
              }

              if (
                !this.pendingSellOrderId &&
                this.hedgeState === "leg1_filled" &&
                oppAsk != null &&
                oppAsk > 0 &&
                secs <= LEG1_HEDGE_TIMEOUT_SECS &&
                secs > LEG1_HEDGE_TIMEOUT_MIN_SECS
              ) {
                const fillPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
                const timeoutTarget = Math.max(this.getMaxSumTarget(), this.getLeg2Target(secs));
                const timeoutSum = fillPrice + oppAsk;
                if (timeoutSum > timeoutTarget + LEG1_HEDGE_TIMEOUT_SUM_BUFFER) {
                  logger.info(`HEDGE15M HEDGE TIMEOUT: ${secs.toFixed(0)}s left, sum=${timeoutSum.toFixed(2)} > ${timeoutTarget.toFixed(2)}+${LEG1_HEDGE_TIMEOUT_SUM_BUFFER.toFixed(2)}, exit Leg1`);
                  await this.emergencySellLeg1(trader, "对冲超时", leg1Bid ?? undefined);
                }
              }

              if (
                !this.pendingSellOrderId &&
                this.hedgeState === "leg1_filled" &&
                this.leg1FilledAt > 0 &&
                Date.now() - this.leg1FilledAt >= EARLY_EXIT_AFTER_MS &&
                oppAsk != null &&
                oppAsk > 0
              ) {
                const fillPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
                const adaptiveSum = fillPrice + oppAsk;
                if (adaptiveSum > this.getMaxSumTarget() + EARLY_EXIT_SUM_BUFFER) {
                  logger.info(`HEDGE15M EARLY EXIT: held naked ${(Date.now() - this.leg1FilledAt) / 1000}s, sum=${adaptiveSum.toFixed(2)} still too high`);
                  await this.emergencySellLeg1(trader, "对冲超时", leg1Bid ?? undefined);
                }
              }
              }
            }

            // ── 最后30秒: 方向可能错误时割肉, 否则持有到结算 ──
            // EV分析: 卖出回收 = bid*0.98; 持有EV = bid*$1 + (1-bid)*$0
            // 卖出更优当: bid*0.98 > bid → 永远不成立 (0.98<1)
            // 但如果方向错误(bid很低), 卖出回收 bid*0.98 > 0 (vs 结算得$0)
            // 真实EV: 卖出=bid*0.98; 持有=bid (bid是市场概率估计)
            // bid<0.50时方向可能错, 但卖出回收也很低; 只有bid在“不确定区”时割肉才有意义
            // 实际策略: bid<0.35时割肉(方向极可能错, 收回残值>0 优于结算得$0)
            if (!this.pendingSellOrderId && this.hedgeState === "leg1_filled" && secs <= 30) {
              if (leg1Bid != null && leg1Bid < 0.35 && leg1Bid >= 0.05) {
                logger.info(`HEDGE15M FORCE EXIT: ${secs.toFixed(0)}s left, bid=${leg1Bid.toFixed(2)} < 0.35, salvaging residual value`);
                await this.emergencySellLeg1(trader, "超时割肉", leg1Bid);
              } else if (secs <= 15) {
                logger.info(`HEDGE15M HOLD TO SETTLE: bid=${(leg1Bid??0).toFixed(2)}, holding for settlement`);
              }
            }
          } catch (e: any) {
            logger.warn(`Leg2 monitor error: ${e.message}`);
          }
        }

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
          // 若有 GTC 挂单未成交，先检查成交量并更新份数，再结算
          if (this.pendingSellOrderId) {
            const gtcDetails = await trader.getOrderFillDetails(this.pendingSellOrderId);
            if (gtcDetails.filled > 0 && gtcDetails.filled <= this.leg1Shares) {
              const realPrice = gtcDetails.avgPrice > 0 ? gtcDetails.avgPrice : (this.pendingSellPrice > 0 ? this.pendingSellPrice : this.leg1Price);
              logger.info(`HEDGE15M 回合结束: GTC已成交 ${gtcDetails.filled.toFixed(0)}份 @${realPrice.toFixed(2)}`);
              const recovered = gtcDetails.filled * realPrice * (1 - TAKER_FEE);
              this.leg1Shares -= gtcDetails.filled;
              this.totalCost = this.leg1Shares > 0 ? this.leg1Shares * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE) : 0;
              this.balance += recovered;
              logger.info(`HEDGE15M GTC部分结算: 剩余${this.leg1Shares.toFixed(0)}份 totalCost=$${this.totalCost.toFixed(2)}`);
            }
            this.pendingSellOrderId = ""; this.pendingSellOrderTime = 0; this.pendingSellPrice = 0;
          }
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
    oppToken: string,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight) return;
    if (this.leg1AttemptedThisRound) {
      logger.warn("Hedge15m Leg1 skipped: order already attempted this round, avoiding duplicate exposure");
      return;
    }

    // ── Leg1价格上限: 过高入场对冲空间不足 ──
    const maxEntryAsk = this.getMaxEntryAsk();
    const oppCurrentAsk = dir === "up" ? this.downAsk : this.upAsk;
    const maxSumTarget = this.getMaxSumTarget();
    let entryQualityMaxSum = this.getPaperEntryQualityMaxSum(maxSumTarget);
    const directionalBias = this.getRoundDirectionalBias();
    if (directionalBias === dir && askPrice <= DIRECTIONAL_ENTRY_ASK_CAP) {
      entryQualityMaxSum = Math.min(maxSumTarget, entryQualityMaxSum + DIRECTIONAL_ENTRY_SUM_BONUS);
    }

    const plan = planHedgeEntry({
      dir: dir as "up" | "down",
      askPrice,
      oppCurrentAsk,
      maxEntryAsk,
      minEntryAsk: MIN_ENTRY_ASK,
      maxSumTarget,
      entryQualityMaxSum,
      directionalBias,
    });
    if (!plan.allowed) {
      if (plan.reason?.includes("MAX_ENTRY_ASK")) this.noteAdaptivePaperSkip("entry-ask");
      if (plan.reason?.includes("sum=")) this.noteAdaptivePaperSkip("sum");
      logger.warn(`Hedge15m Leg1 skipped: ${plan.reason}`);
      return;
    }

    const budgetPct = this.getAdaptiveLegBudgetPct(askPrice, oppCurrentAsk, entryQualityMaxSum);
    await this.openLeg1Position(trader, dir, askPrice, buyToken, oppToken, budgetPct, "mispricing");
  }

  private async buyTrendLeg(
    trader: Trader,
    rnd: Round15m,
    dir: "up" | "down",
    askPrice: number,
    buyToken: string,
    oppToken: string,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight) return;
    if (this.leg1AttemptedThisRound) return;

    const plan = planTrendEntry({
      askPrice,
      maxEntryAsk: TREND_MAX_ENTRY_ASK,
      minShares: MIN_SHARES,
      maxShares: MAX_SHARES,
      balance: this.balance,
      budgetPct: TREND_BUDGET_PCT,
    });
    if (!plan.allowed) {
      logger.warn(`HEDGE15M TREND skipped: ${plan.reason}`);
      return;
    }

    this.dumpDetected = `TREND ${dir.toUpperCase()} BTC${MOMENTUM_WINDOW_SEC}/${TREND_WINDOW_SEC}`;
    await this.openLeg1Position(trader, dir, askPrice, buyToken, oppToken, TREND_BUDGET_PCT, "trend");
  }

  private async openLeg1Position(
    trader: Trader,
    dir: string,
    askPrice: number,
    buyToken: string,
    oppToken: string,
    budgetPct: number,
    strategyMode: "mispricing" | "trend",
  ): Promise<void> {
    const budget = this.balance * budgetPct;
    const shares = Math.min(MAX_SHARES, Math.floor(budget / askPrice));
    if (shares < MIN_SHARES) {
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
      spreadLimit: strategyMode === "trend" ? 0.12 : 0.15,
      reboundLimit: strategyMode === "trend" ? 1.05 : 1.10,
    });
    if (!orderbookPlan.allowed) {
      logger.warn(`Hedge15m Leg1 skipped: ${orderbookPlan.reason}`);
      return;
    }

    const entryAsk = orderbookPlan.entryAsk;
    const entryShares = Math.min(MAX_SHARES, Math.floor(budget / entryAsk));
    if (entryShares < MIN_SHARES) {
      logger.warn(`Hedge15m Leg1 skipped (fresh): ${entryShares}份 < ${MIN_SHARES} @${entryAsk.toFixed(2)}`);
      return;
    }
    const entryCost = entryShares * entryAsk;

    this.leg1EntryInFlight = true;
    this.leg1AttemptedThisRound = true;
    this.hedgeState = "leg1_pending";
    this.status = strategyMode === "trend"
      ? `趋势单下单中: ${dir.toUpperCase()} @${entryAsk.toFixed(2)} x${entryShares.toFixed(0)}`
      : `Leg1下单中: ${dir.toUpperCase()} @${entryAsk.toFixed(2)} x${entryShares.toFixed(0)}`;

    try {
      logger.info(`HEDGE15M LEG1 ${strategyMode.toUpperCase()}: ${dir.toUpperCase()} ${entryShares}份 @${entryAsk.toFixed(2)} cost=$${entryCost.toFixed(2)}${entryAsk !== askPrice ? ` (signal@${askPrice.toFixed(2)})` : ""} negRisk=${this.negRisk}`);
      const res = await trader.placeFakBuy(buyToken, entryCost, this.negRisk);
      if (!res) {
        this.status = "Leg1下单失败, 本轮不重试";
        logger.warn("HEDGE15M Leg1 FAK failed");
        return;
      }

      const orderId = res?.orderID || res?.order_id || "";
      let filledShares = entryShares;
      let realFillPrice = entryAsk;
      if (orderId) {
        const details = await trader.waitForOrderFillDetails(orderId, getDynamicParams().fillCheckMs);
        if (details.filled > 0) {
          filledShares = details.filled;
          if (details.avgPrice > 0) realFillPrice = details.avgPrice;
        } else {
          this.status = "Leg1零成交, 本轮不重试";
          logger.warn("HEDGE15M Leg1 zero fill");
          return;
        }
      } else {
        logger.warn("HEDGE15M Leg1: no orderId returned, checking balance for fill confirmation");
        const balBefore = this.balance;
        await this.refreshBalance();
        const spent = balBefore - this.balance;
        const expectedSpend = entryCost * (1 + TAKER_FEE);
        const estimatedFill = estimateFilledShares({
          spent,
          entryAsk,
          takerFee: TAKER_FEE,
          minBalancePct: BALANCE_ESTIMATE_MIN_PCT,
          maxBalancePct: BALANCE_ESTIMATE_MAX_PCT,
          expectedSpend,
          minShares: MIN_SHARES,
        });
        if (estimatedFill.confirmed) {
          filledShares = estimatedFill.shares;
          this.leg1Estimated = true;
          logger.info(`HEDGE15M Leg1: estimated fill from balance: ${filledShares} shares (spent=$${spent.toFixed(2)})`);
        } else {
          this.status = "Leg1回报不确定, 本轮锁定避免重复加仓";
          logger.warn(`HEDGE15M Leg1: ambiguous balance delta $${spent.toFixed(2)} (expected≈$${expectedSpend.toFixed(2)}), locking round to avoid duplicate fills`);
          return;
        }
      }

      this.hedgeState = "leg1_filled";
      this.activeStrategyMode = strategyMode;
      this.leg1Dir = dir;
      this.leg1Price = entryAsk;
      this.leg1FillPrice = realFillPrice;
      this.leg1OrderId = orderId ? orderId.slice(0, 12) : "";
      this.leg1FilledAt = Date.now();
      this.leg1Shares = filledShares;
      this.leg1Token = buyToken;
      this.leg2Token = oppToken;
      this.totalCost = filledShares * realFillPrice * (1 + TAKER_FEE);
      this.balance -= this.totalCost;
      this.onLeg1Opened();
      this.status = strategyMode === "trend"
        ? `趋势持仓 ${dir.toUpperCase()} @${realFillPrice.toFixed(2)} x${filledShares.toFixed(0)}`
        : `Leg1 ${dir.toUpperCase()} @${realFillPrice.toFixed(2)} x${filledShares.toFixed(0)}, 等Leg2`;
      logger.info(`HEDGE15M LEG1 FILLED [${strategyMode.toUpperCase()}]: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 ask=${entryAsk.toFixed(2)} fill=${realFillPrice.toFixed(2)} orderId=${orderId.slice(0, 12)}`);
    } finally {
      this.leg1EntryInFlight = false;
      if (this.hedgeState === "leg1_pending") {
        this.hedgeState = "watching";
      }
    }
  }

  private async manageTrendLeg(trader: Trader, leg1Bid: number | null, secs: number): Promise<void> {
    if (this.hedgeState !== "leg1_filled") return;
    if (leg1Bid == null || leg1Bid <= 0) return;

    this.status = `趋势持仓中: ${this.leg1Dir.toUpperCase()} bid=${leg1Bid.toFixed(2)} ${secs.toFixed(0)}s left`;

    if (leg1Bid >= TREND_TAKE_PROFIT_BID && secs > 180) {
      logger.info(`HEDGE15M TREND TAKE-PROFIT: bid=${leg1Bid.toFixed(2)} >= ${TREND_TAKE_PROFIT_BID.toFixed(2)}`);
      await this.emergencySellLeg1(trader, "止盈", leg1Bid);
      return;
    }

    if (leg1Bid <= TREND_STOP_LOSS_BID && secs > 60) {
      logger.info(`HEDGE15M TREND STOP-LOSS: bid=${leg1Bid.toFixed(2)} <= ${TREND_STOP_LOSS_BID.toFixed(2)}`);
      await this.emergencySellLeg1(trader, "中途止损", leg1Bid);
      return;
    }

    if (secs <= 45 && leg1Bid < 0.55) {
      logger.info(`HEDGE15M TREND LATE EXIT: ${secs.toFixed(0)}s left, bid=${leg1Bid.toFixed(2)} < 0.55`);
      await this.emergencySellLeg1(trader, "超时割肉", leg1Bid);
    }
  }

  private async buyLeg2(trader: Trader, oppAsk: number, sumTarget: number): Promise<void> {
    // 匹配Leg1实际成交份数, 保证对称对冲
    const sharesToBuy = this.leg1Shares;

    // ── Leg2 Spread/深度保护 ──
    const leg2Book = await getHotBestPrices(trader, this.leg2Token);
    if (leg2Book && leg2Book.ask != null && leg2Book.bid != null) {
      const spread = leg2Book.ask - leg2Book.bid;
      if (spread > 0.15) {
        logger.warn(`Hedge15m Leg2 skipped: spread=$${spread.toFixed(2)} > $0.15`);
        return;
      }
      if (leg2Book.askDepth < sharesToBuy * 0.5) {
        logger.warn(`Hedge15m Leg2 skipped: askDepth=${leg2Book.askDepth.toFixed(0)} < ${(sharesToBuy * 0.5).toFixed(0)} needed`);
        return;
      }
      if (leg2Book.ask > oppAsk * 1.08) {
        logger.warn(`Hedge15m Leg2 skipped: fresh ask $${leg2Book.ask.toFixed(2)} >> passed $${oppAsk.toFixed(2)}`);
        return;
      }
    }

    // 使用实时盘口ask(如可用), 避免滞后的oppAsk导致cost偏差
    let actualAsk = oppAsk;
    if (leg2Book && leg2Book.ask != null && leg2Book.ask > 0) {
      actualAsk = leg2Book.ask;
    }
    const actualCost = sharesToBuy * actualAsk;
    const fillPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;

    // ── Sum re-check: 用实时ask重新验证, 防止ask上涨导致sum超标 ──
    if (fillPrice + actualAsk > sumTarget) {
      logger.warn(`Hedge15m Leg2 skipped: sum=${(fillPrice + actualAsk).toFixed(2)} > target=${sumTarget.toFixed(2)} (actualAsk=${actualAsk.toFixed(2)})`);
      return;
    }

    // ── Profit gate: 锁利过薄不做Leg2 ──
    {
      const projectedLockedCost = sharesToBuy * fillPrice * (1 + TAKER_FEE) + sharesToBuy * actualAsk * (1 + TAKER_FEE);
      const projectedLockedProfit = sharesToBuy - projectedLockedCost;
      const projectedLockedRoi = projectedLockedCost > 0 ? projectedLockedProfit / projectedLockedCost : 0;
      if (
        projectedLockedProfit < this.minLockedProfit ||
        projectedLockedRoi < this.minLockedRoi
      ) {
        this.status = `Leg2跳过: 锁利过薄 +$${projectedLockedProfit.toFixed(2)} (${(projectedLockedRoi * 100).toFixed(2)}%)`;
        logger.warn(`Hedge15m Leg2 skipped: locked profit $${projectedLockedProfit.toFixed(2)} / ROI ${(projectedLockedRoi * 100).toFixed(2)}% below floor $${this.minLockedProfit.toFixed(2)} / ${(this.minLockedRoi * 100).toFixed(2)}%`);
        return;
      }
    }

    // ── Affordability check: 完整对冲sum≤target必盈利, 仅检查余额是否足够 ──
    const leg2CostWithFee = actualCost * (1 + TAKER_FEE);
    if (leg2CostWithFee > this.balance) {
      logger.warn(`Hedge15m Leg2 skipped: cost+fee $${leg2CostWithFee.toFixed(2)} > balance $${this.balance.toFixed(2)}`);
      return;
    }
    const leg2Dir = this.leg1Dir === "up" ? "DOWN" : "UP";
    logger.info(`HEDGE15M LEG2: ${leg2Dir} ${sharesToBuy.toFixed(0)}份 @${actualAsk.toFixed(2)} (passed=${oppAsk.toFixed(2)})`);
    const res = await trader.placeFakBuy(this.leg2Token, actualCost, this.negRisk);
    if (!res) {
      logger.warn("HEDGE15M Leg2 FAK failed");
      return;
    }

    const orderId = res?.orderID || res?.order_id || "";
    let filledShares = sharesToBuy;
    let leg2RealPrice = oppAsk;
    if (orderId) {
      const details = await trader.waitForOrderFillDetails(orderId, getDynamicParams().fillCheckMs);
      if (details.filled > 0) {
        filledShares = details.filled;
        if (details.avgPrice > 0) leg2RealPrice = details.avgPrice;
      } else {
        // Leg2 zero fill: Leg1仍在裸仓, 需主动管理
        logger.warn("HEDGE15M Leg2 zero fill, Leg1 remains unhedged — will rely on TP/SL/settlement");
        return;
      }
    } else {
      // 无orderId: 通过余额变化推断成交
      logger.warn("HEDGE15M Leg2: no orderId returned, checking balance for fill confirmation");
      const balBefore = this.balance;
      await this.refreshBalance();
      const spent = balBefore - this.balance;
      const expectedSpend = actualCost * (1 + TAKER_FEE);
      const estimatedFill = estimateFilledShares({
        spent,
        entryAsk: actualAsk,
        takerFee: TAKER_FEE,
        minBalancePct: BALANCE_ESTIMATE_MIN_PCT,
        maxBalancePct: BALANCE_ESTIMATE_MAX_PCT,
        expectedSpend,
        minShares: 1,
      });
      if (estimatedFill.confirmed) {
        filledShares = estimatedFill.shares;
        this.leg2Estimated = true;
        logger.info(`HEDGE15M Leg2: estimated fill from balance: ${filledShares} shares (spent=$${spent.toFixed(2)})`);
      } else {
        logger.warn(`HEDGE15M Leg2: ambiguous balance delta $${spent.toFixed(2)} (expected≈$${expectedSpend.toFixed(2)}), assuming no fill`);
        return;
      }
    }

    // ── Leg2 部分成交: 卖掉多余 Leg1 份数, 避免裸仓风险 ──
    if (filledShares < this.leg1Shares) {
      const unhedged = this.leg1Shares - filledShares;
      logger.warn(`HEDGE15M Leg2 partial: ${filledShares.toFixed(0)}/${this.leg1Shares.toFixed(0)} → selling ${unhedged.toFixed(0)} unhedged Leg1`);
      const leg1Prices = await getHotBestPrices(trader, this.leg1Token);
      const leg1Bid = leg1Prices?.bid ?? this.leg1Price * 0.85;
      const sellRes = await trader.placeFakSell(this.leg1Token, unhedged, this.negRisk);
      if (sellRes) {
        const sellOrderId = sellRes?.orderID || sellRes?.order_id || "";
        let actualSold = unhedged;
        let actualPrice = leg1Bid;
        if (sellOrderId) {
          const sellDetails = await trader.waitForOrderFillDetails(sellOrderId, getDynamicParams().fillCheckMs);
          if (sellDetails.filled > 0) {
            actualSold = sellDetails.filled;
            if (sellDetails.avgPrice > 0) actualPrice = sellDetails.avgPrice;
          }
        }
        const sellRecovered = actualSold * actualPrice * (1 - TAKER_FEE);
        const soldCostBasis = actualSold * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
        this.balance += sellRecovered;
        this.totalCost = Math.max(0, this.totalCost - soldCostBasis);
        this.leg1Shares = this.leg1Shares - actualSold;
        if (actualSold < unhedged) {
          logger.warn(`HEDGE15M: partial sell of excess Leg1: ${actualSold.toFixed(0)}/${unhedged.toFixed(0)}, ${(unhedged - actualSold).toFixed(0)} still at risk`);
        }
        logger.info(`HEDGE15M: sold ${actualSold.toFixed(0)} excess Leg1 @${actualPrice.toFixed(2)}, recovered=$${sellRecovered.toFixed(2)} costBasis=$${soldCostBasis.toFixed(2)}`);
      } else {
        logger.warn(`HEDGE15M: failed to sell unhedged Leg1, ${unhedged.toFixed(0)} shares at risk`);
      }
    }

    this.leg2Price = oppAsk;
    this.leg2FillPrice = leg2RealPrice;
    this.leg2OrderId = orderId ? orderId.slice(0, 12) : "";
    this.leg2Shares = filledShares;
    const leg2Cost = filledShares * leg2RealPrice * (1 + TAKER_FEE);
    this.totalCost += leg2Cost;
    this.balance -= leg2Cost;
    this.hedgeState = "leg2_filled";

    const hedgedShares = Math.min(this.leg1Shares, filledShares);
    const residualShares = Math.max(0, this.leg1Shares - hedgedShares);
    const leg1UnitCost = (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
    const lockedCost = hedgedShares * leg1UnitCost + filledShares * leg2RealPrice * (1 + TAKER_FEE);
    this.expectedProfit = hedgedShares > 0 ? hedgedShares - lockedCost : 0;
    this.status = residualShares > 0
      ? `部分对冲: 锁定+$${this.expectedProfit.toFixed(2)}, 裸露${residualShares.toFixed(0)}份`
      : `双腿锁定! L1=${this.leg1Dir.toUpperCase()}@${this.leg1FillPrice.toFixed(2)} L2=@${leg2RealPrice.toFixed(2)} 预期+$${this.expectedProfit.toFixed(2)}`;
    logger.info(`HEDGE15M LOCKED: hedged=${hedgedShares.toFixed(0)} residual=${residualShares.toFixed(0)} L1 fill=${this.leg1FillPrice.toFixed(2)} L2 fill=${leg2RealPrice.toFixed(2)} totalCost=$${this.totalCost.toFixed(2)} lockedProfit=$${this.expectedProfit.toFixed(2)}`);
  }

  /** 独立管理 GTC 挂单: 检查成交、自动降价追单、超时处理 */
  private async managePendingSell(trader: Trader, currentBid: number | null, secs: number): Promise<void> {
    if (!this.pendingSellOrderId) return;

    const filled = await trader.getOrderFilled(this.pendingSellOrderId);

    if (filled > 0) {
      // GTC 已(部分)成交 — 查询真实成交价
      const gtcDetails = await trader.getOrderFillDetails(this.pendingSellOrderId);
      await trader.cancelOrder(this.pendingSellOrderId);
      const actualFilled = gtcDetails.filled > 0 ? gtcDetails.filled : filled;
      const soldShares = Math.min(actualFilled, this.leg1Shares);
      const unsold = this.leg1Shares - soldShares;
      const sellPrice = gtcDetails.avgPrice > 0 ? gtcDetails.avgPrice
        : (this.pendingSellPrice > 0 ? this.pendingSellPrice
          : (currentBid && currentBid > 0 ? currentBid : this.leg1Price * 0.85));
      const soldCost = soldShares * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
      const recovered = soldShares * sellPrice * (1 - TAKER_FEE);
      const profit = recovered - soldCost;
      const result = profit >= 0 ? "WIN" : "LOSS";
      if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
      else { this.losses++; this.consecutiveLosses++; this.tightenAdaptivePaperAfterLoss(); }
      this.totalProfit += profit;
      this.sessionProfit += profit;
      this.balance += recovered;
      this.history.push({
        time: timeStr(), result, leg1Dir: this.leg1Dir.toUpperCase(),
        leg1Price: this.leg1Price, leg2Price: this.leg2Price, totalCost: soldCost,
        profit, cumProfit: this.totalProfit,
        exitType: "gtc-fill",
        exitReason: `GTC限价卖单成交: ${soldShares.toFixed(0)}份@$${sellPrice.toFixed(2)}${unsold > 0 ? `, 剩余${unsold.toFixed(0)}份待结算` : ''}`,
        profitBreakdown: `回收$${recovered.toFixed(2)}(${soldShares.toFixed(0)}×$${sellPrice.toFixed(2)}×0.98) - 成本$${soldCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
        leg1Shares: this.leg1Shares, leg2Shares: this.leg2Shares,
        leg1FillPrice: this.leg1FillPrice, leg2FillPrice: this.leg2FillPrice,
        sellPrice, sellShares: soldShares,
        orderId: this.leg1OrderId,
        sellOrderId: this.pendingSellOrderId.slice(0, 12),
        estimated: gtcDetails.avgPrice <= 0,
      });
      if (this.history.length > 200) this.history.shift();
      this.saveHistory();
      if (unsold > 0) {
        this.totalCost = unsold * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
        this.leg1Shares = unsold;
      } else {
        this.totalCost = 0; this.leg1Shares = 0; this.hedgeState = "done";
      }
      this.pendingSellOrderId = ""; this.pendingSellOrderTime = 0; this.pendingSellPrice = 0;
      this.status = `GTC成交: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
      logger.info(`HEDGE15M GTC FILLED: sold ${soldShares.toFixed(0)} @${sellPrice.toFixed(2)}, P/L=$${profit.toFixed(2)}`);
      return;
    }

    // 未成交 — 根据剩余时间和挂单时长决定策略
    const elapsed = Date.now() - this.pendingSellOrderTime;

    // ── 最后20秒: 取消GTC, 立即FAK市价强卖 (不留空隙) ──
    if (secs <= 20) {
      // 先检查是否已成交
      const lastCheck = await trader.getOrderFilled(this.pendingSellOrderId);
      if (lastCheck > 0) {
        return this.managePendingSell(trader, currentBid, secs);
      }
      logger.info(`HEDGE15M: ${secs.toFixed(0)}s left, cancel GTC → immediate FAK sell`);
      await trader.cancelOrder(this.pendingSellOrderId);
      this.pendingSellOrderId = ""; this.pendingSellOrderTime = 0; this.pendingSellPrice = 0;
      // 立即尝试FAK卖出, 不留15-20秒空隙
      if (this.leg1Shares > 0 && this.leg1Token) {
        const sellRes = await trader.placeFakSell(this.leg1Token, this.leg1Shares, this.negRisk);
        if (sellRes) {
          const sellId = sellRes?.orderID || sellRes?.order_id || "";
          if (sellId) {
            const det = await trader.waitForOrderFillDetails(sellId, getDynamicParams().fillCheckMs);
            if (det.filled > 0) {
              const sellPrice = det.avgPrice > 0 ? det.avgPrice : (currentBid && currentBid > 0 ? currentBid : this.leg1Price * 0.85);
              const recovered = det.filled * sellPrice * (1 - TAKER_FEE);
              const soldCost = det.filled * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
              const profit = recovered - soldCost;
              const result = profit >= 0 ? "WIN" : "LOSS";
              if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
              else { this.losses++; this.consecutiveLosses++; this.tightenAdaptivePaperAfterLoss(); }
              this.totalProfit += profit;
              this.sessionProfit += profit;
              this.balance += recovered;
              const isEstimated = det.avgPrice <= 0;
              this.history.push({
                time: timeStr(), result, leg1Dir: this.leg1Dir.toUpperCase(),
                leg1Price: this.leg1Price, leg2Price: this.leg2Price, totalCost: soldCost,
                profit, cumProfit: this.totalProfit,
                exitType: "force-exit",
                exitReason: `最后${secs.toFixed(0)}s: GTC未成交→FAK强卖${det.filled.toFixed(0)}份@$${sellPrice.toFixed(2)}`,
                profitBreakdown: `回收$${recovered.toFixed(2)}(${det.filled.toFixed(0)}×$${sellPrice.toFixed(2)}×0.98) - 成本$${soldCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
                leg1Shares: this.leg1Shares, leg2Shares: this.leg2Shares,
                leg1FillPrice: this.leg1FillPrice, leg2FillPrice: this.leg2FillPrice,
                sellPrice, sellShares: det.filled,
                orderId: this.leg1OrderId,
                sellOrderId: sellId.slice(0, 12),
                estimated: isEstimated,
              });
              if (this.history.length > 200) this.history.shift();
              this.saveHistory();
              this.leg1Shares -= det.filled;
              if (this.leg1Shares <= 0) { this.totalCost = 0; this.hedgeState = "done"; }
              else { this.totalCost = this.leg1Shares * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE); }
              logger.info(`HEDGE15M GTC→FAK: sold ${det.filled.toFixed(0)} @${sellPrice.toFixed(2)}, P/L=$${profit.toFixed(2)}`);
              return;
            }
          }
        }
        // FAK也失败: 持仓等待结算(最后~15秒, 不再挂新单)
        logger.warn(`HEDGE15M: GTC→FAK sell failed at ${secs.toFixed(0)}s, holding to settlement`);
      }
      return;
    }

    // ── 每20秒未成交: 取消旧单, 降价1 tick重挂 ──
    if (elapsed > 20_000) {
      // 先再次检查成交, 防止cancel前刚好被吃到导致重复挂单
      const recheck = await trader.getOrderFilled(this.pendingSellOrderId);
      if (recheck > 0) {
        logger.info(`HEDGE15M: GTC filled during reprice check (${recheck} shares), delegating to fill handler`);
        // 递归调用自身处理成交逻辑(filled > 0分支)
        return this.managePendingSell(trader, currentBid, secs);
      }
      const freshBid = currentBid && currentBid > 0 ? currentBid : this.pendingSellPrice;
      // 取当前bid和旧挂单价的较低者再减1 tick, 确保越来越激进
      const basePrice = Math.min(freshBid, this.pendingSellPrice);
      const newPrice = Math.max(0.01, Math.round((basePrice - 0.01) * 100) / 100);

      if (newPrice < 0.05) {
        // 价格过低, 取消挂单持有到结算(结算赢了拿$1比卖$0.04好)
        logger.info(`HEDGE15M: GTC price would be ${newPrice.toFixed(2)} < 0.05, cancel and hold to settlement`);
        await trader.cancelOrder(this.pendingSellOrderId);
        this.pendingSellOrderId = ""; this.pendingSellOrderTime = 0; this.pendingSellPrice = 0;
        return;
      }

      await trader.cancelOrder(this.pendingSellOrderId);
      const gtcId = await trader.placeGtcSell(this.leg1Token, this.leg1Shares, newPrice, this.negRisk);
      if (gtcId) {
        this.pendingSellOrderId = gtcId;
        this.pendingSellOrderTime = Date.now();
        this.pendingSellPrice = newPrice;
        this.status = `GTC降价追单: @${newPrice.toFixed(2)} (${this.leg1Shares.toFixed(0)}份)`;
        logger.info(`HEDGE15M GTC REPRICE: @${newPrice.toFixed(2)} (was @${basePrice.toFixed(2)})`);
      } else {
        this.pendingSellOrderId = ""; this.pendingSellOrderTime = 0; this.pendingSellPrice = 0;
        logger.warn(`HEDGE15M: GTC reprice failed, order cancelled, holding`);
      }
      return;
    }

    // 仍在等待期内
    this.status = `GTC卖单等待: @${this.pendingSellPrice.toFixed(2)} ${(elapsed/1000).toFixed(0)}s/${this.leg1Shares.toFixed(0)}份`;
  }

  /** GTC 限价卖单回退: FAK失败时挂单, 低于bid一个tick主动吃单 */
  private async placeGtcSellFallback(trader: Trader, reason: string, currentBid?: number): Promise<void> {
    const bidPrice = currentBid && currentBid > 0 ? currentBid : this.leg1Price * 0.85;
    // 低于当前 bid 一个 tick ($0.01), 主动穿越价差以提高成交概率
    const gtcPrice = Math.max(0.01, Math.round((bidPrice - 0.01) * 100) / 100);
    logger.warn(`HEDGE15M ${reason}: FAK未成交, 挂GTC @${gtcPrice.toFixed(2)} (bid=${bidPrice.toFixed(2)}-0.01) ${this.leg1Shares.toFixed(0)}份`);
    const gtcId = await trader.placeGtcSell(this.leg1Token, this.leg1Shares, gtcPrice, this.negRisk);
    if (gtcId) {
      this.pendingSellOrderId = gtcId;
      this.pendingSellOrderTime = Date.now();
      this.pendingSellPrice = gtcPrice;
      this.hedgeState = "leg1_filled"; // 确保mainLoop的managePendingSell能管理此GTC
      this.status = `${reason}: GTC @${gtcPrice.toFixed(2)} 等待成交`;
    } else {
      logger.warn(`HEDGE15M ${reason}: GTC挂单也失败, 持仓等待结算`);
      this.hedgeState = "leg1_filled"; // 恢复状态让主循环继续管理
    }
  }

  /** 紧急卖出Leg1: 止盈/止损/超时退出 (仅在无挂单时调用) */
  private async emergencySellLeg1(trader: Trader, reason: string, currentBid?: number): Promise<void> {
    if (this.leg1Shares <= 0 || !this.leg1Token) return;
    if (this.pendingSellOrderId) return; // 有挂单时由 managePendingSell 管理

    // 标记正在卖出, 防止主循环并发触发重复卖出
    this.hedgeState = "done";
    const sharesToSell = this.leg1Shares;  // 缓存, emergencySell期间不应变
    const res = await trader.placeFakSell(this.leg1Token, sharesToSell, this.negRisk);
    if (res) {
      // 检查实际成交量和真实成交价
      const orderId: string = res?.orderID || res?.order_id || "";
      let soldShares = this.leg1Shares;
      let realSellPrice = 0;
      if (orderId) {
        const details = await trader.waitForOrderFillDetails(orderId, getDynamicParams().fillCheckMs);
        if (details.filled > 0) {
          soldShares = details.filled;
          realSellPrice = details.avgPrice;
        } else {
          // FAK 返回了 orderId 但0成交 → 挂 GTC
          this.hedgeState = "leg1_filled"; // 恢复状态让 GTC 管理
          await this.placeGtcSellFallback(trader, reason, currentBid);
          return;
        }
      } else {
        // FAK 无 orderID: SDK 可能已成交但未返回ID, 查余额确认后再决定
        logger.warn(`HEDGE15M ${reason}: FAK returned no orderID, checking balance to avoid duplicate sell`);
        const balBefore = this.balance;
        await this.refreshBalance();
        // 如果余额增加了(说明FAK已成交), 不再重复卖出
        if (this.balance > balBefore + this.leg1Shares * 0.05) {
          logger.info(`HEDGE15M ${reason}: balance increased $${balBefore.toFixed(2)}→$${this.balance.toFixed(2)}, FAK likely filled`);
          // 用估算价格记录
          soldShares = this.leg1Shares;
          realSellPrice = currentBid && currentBid > 0 ? currentBid : this.leg1Price * 0.85;
        } else {
          // 余额未变, 可能确实没成交 → 挂 GTC
          this.hedgeState = "leg1_filled";
          await this.placeGtcSellFallback(trader, reason, currentBid);
          return;
        }
      }

      // 用真实成交价, 无则回退到bid报价
      const sellPrice = realSellPrice > 0 ? realSellPrice : (currentBid && currentBid > 0 ? currentBid : this.leg1Price * 0.85);
      const recovered = soldShares * sellPrice * (1 - TAKER_FEE);
      const unsold = sharesToSell - soldShares;
      const soldCost = soldShares * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
      const profit = recovered - soldCost;
      const result = profit >= 0 ? "WIN" : "LOSS";

      if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
      else { this.losses++; this.consecutiveLosses++; this.tightenAdaptivePaperAfterLoss(); }
      this.totalProfit += profit;
      this.sessionProfit += profit;
      this.balance += recovered;

      const exitType = reason === "止盈" ? "take-profit" : reason === "超时割肉" || reason === "对冲超时" ? "force-exit" : "stop-loss";
      const exitReasons: Record<string, string> = {
        "止盈": `bid=$${(currentBid??0).toFixed(2)}≥0.95且>300s, 锁定利润防反转(回收${((currentBid??0)*0.98*100).toFixed(1)}%)`,
        "中途止损": `bid=$${(currentBid??0).toFixed(2)}跌破止损线(entry*${LEG1_STOP_LOSS}或<$${LEG1_STOP_ABS}), 截断亏损`,
        "对冲超时": `剩余${LEG1_HEDGE_TIMEOUT_MIN_SECS}-${LEG1_HEDGE_TIMEOUT_SECS}s仍未对冲, 且sum持续劣化, 主动退出裸仓`,
        "超时割肉": `剩余≤30s, bid=$${(currentBid??0).toFixed(2)}<0.35, 回收残值优于结算得$0`,
      };
      const isEstimated = realSellPrice <= 0 || !orderId;
      this.history.push({
        time: timeStr(),
        result,
        leg1Dir: this.leg1Dir.toUpperCase(),
        leg1Price: this.leg1Price,
        leg2Price: this.leg2Price,
        totalCost: soldCost,
        profit,
        cumProfit: this.totalProfit,
        exitType,
        exitReason: exitReasons[reason] || reason,
        profitBreakdown: `回收$${recovered.toFixed(2)}(${soldShares.toFixed(0)}×$${sellPrice.toFixed(2)}×0.98) - 成本$${soldCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
        leg1Shares: sharesToSell,
        leg2Shares: this.leg2Shares,
        leg1FillPrice: this.leg1FillPrice,
        leg2FillPrice: this.leg2FillPrice,
        sellPrice,
        sellShares: soldShares,
        orderId: this.leg1OrderId,
        sellOrderId: orderId.slice(0, 12),
        estimated: isEstimated,
      });
      if (this.history.length > 200) this.history.shift();
      this.saveHistory();

      if (unsold > 0) {
        logger.warn(`HEDGE15M ${reason}: 部分成交 ${soldShares.toFixed(0)}/${sharesToSell.toFixed(0)}, ${unsold.toFixed(0)}份未卖出`);
        this.totalCost = unsold * (this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price) * (1 + TAKER_FEE);
        this.leg1Shares = unsold;
        // 未卖出部分挂 GTC 继续追卖, 不干等结算
        await this.placeGtcSellFallback(trader, reason, currentBid);
      } else {
        // 全部卖出: 清零 totalCost 防止 settleHedge 再次触发
        this.totalCost = 0;
        this.leg1Shares = 0;
        this.hedgeState = "done";
      }

      this.status = `${reason}: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}${unsold > 0 ? ` (${unsold.toFixed(0)}份待结算)` : ''}`;
      logger.info(`HEDGE15M ${reason}: sold ${soldShares.toFixed(0)}/${sharesToSell.toFixed(0)} Leg1 ${this.leg1Dir.toUpperCase()}, recovered≈$${recovered.toFixed(2)}, P/L=$${profit.toFixed(2)}`);
      // 退出后同步链上余额, 防止长期运行累积偏差
      if (unsold <= 0) this.refreshBalance().catch(() => {});
    } else {
      // FAK 完全失败 — 改挂 GTC 而不是放弃
      this.hedgeState = "leg1_filled"; // 恢复状态让 GTC 管理
      logger.warn(`HEDGE15M ${reason}: FAK sell failed, falling back to GTC`);
      await this.placeGtcSellFallback(trader, reason, currentBid);
    }
  }

  private async settleHedge(): Promise<void> {
    for (let w = 0; w < 8; w++) {
      await sleep(2000);
      if (isChainlinkFresh()) break;
    }

    // 结算方向判断: 优先 Chainlink (链上结算数据源), 回退到 BTC 价格对比
    const clFresh = isChainlinkFresh() && getChainlinkPrice() > 0;
    const btcNow = getBtcPrice();
    const actualDir = clFresh
      ? getChainlinkDirection()
      : (this.roundStartBtcPrice > 0 && btcNow > 0
          ? (btcNow >= this.roundStartBtcPrice ? "up" : "down")
          : "up"); // 两个数据源都不可用, 保守猜 up
    if (!clFresh) {
      logger.warn(`HEDGE15M SETTLE: Chainlink not fresh, using BTC price fallback (start=$${this.roundStartBtcPrice.toFixed(0)} now=$${btcNow.toFixed(0)} → ${actualDir})`);
    }

    let returnVal = 0;
    if (this.leg1Dir === actualDir && this.leg1Shares > 0) {
      returnVal += this.leg1Shares;
    }
    if (this.leg2Shares > 0) {
      const leg2Dir = this.leg1Dir === "up" ? "down" : "up";
      if (leg2Dir === actualDir) {
        returnVal += this.leg2Shares;
      }
    }

    const profit = returnVal - this.totalCost;
    const result = profit >= 0 ? "WIN" : "LOSS";

    if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
    else { this.losses++; this.consecutiveLosses++; this.tightenAdaptivePaperAfterLoss(); }
    this.totalProfit += profit;
    this.sessionProfit += profit;
    this.balance += returnVal;
    this.trader?.creditSettlement(returnVal);

    const dirSource = isChainlinkFresh() ? "CL" : "BTC";
    const winLeg = this.leg1Dir === actualDir ? 'Leg1' : (this.leg2Shares > 0 ? 'Leg2' : '无');
    const settlementReason = this.leg2Shares > 0
      ? `双腱结算: BTC ${actualDir.toUpperCase()}(${dirSource}), ${winLeg}赢得$${returnVal.toFixed(2)}`
      : `单腱结算: BTC ${actualDir.toUpperCase()}(${dirSource}), ${this.leg1Dir===actualDir?'方向正确→$1/份':'方向错误→$0'}`;

    this.history.push({
      time: timeStr(),
      result,
      leg1Dir: this.leg1Dir.toUpperCase(),
      leg1Price: this.leg1Price,
      leg2Price: this.leg2Price,
      totalCost: this.totalCost,
      profit,
      cumProfit: this.totalProfit,
      exitType: "settlement",
      exitReason: settlementReason,
      profitBreakdown: `结算回收$${returnVal.toFixed(2)}${this.leg2Shares > 0 ? `(L1:${this.leg1Shares.toFixed(0)}份+L2:${this.leg2Shares.toFixed(0)}份)` : `(${this.leg1Shares.toFixed(0)}份)`} - 成本$${this.totalCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
      leg1Shares: this.leg1Shares,
      leg2Shares: this.leg2Shares,
      leg1FillPrice: this.leg1FillPrice,
      leg2FillPrice: this.leg2FillPrice,
      orderId: this.leg1OrderId,
      estimated: this.leg1Estimated || this.leg2Estimated,
    });
    if (this.history.length > 200) this.history.shift();
    this.saveHistory();

    this.status = `结算: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (返$${returnVal.toFixed(2)} dir=${actualDir}/${dirSource})`;
    logger.info(`HEDGE15M SETTLED: ${result} dir=${actualDir}(${dirSource}) return=$${returnVal.toFixed(2)} cost=$${this.totalCost.toFixed(2)} profit=$${profit.toFixed(2)} L1fill=${this.leg1FillPrice.toFixed(2)} L2fill=${this.leg2FillPrice.toFixed(2)}`);

    // 等待链上结算生效后再同步余额
    await sleep(5000);
    await this.refreshBalance();
    this.totalCost = 0;
    this.leg1Shares = 0;
    this.leg2Shares = 0;
    this.hedgeState = "done";
  }
}
