import * as fs from "fs";
import { HedgeHistoryEntry } from "./bot";
import { getLiveHistoryFilePath, getPaperHistoryFilePath } from "./instancePaths";

export const HISTORY_FILE = getLiveHistoryFilePath();
export const PAPER_HISTORY_FILE = getPaperHistoryFilePath();

export interface AuditReport {
  fileExists: boolean;
  totalTrades: number;
  realizedProfit: number;
  estimatedTrades: number;
  estimatedTradePct: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgProfit: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  largestWin: number;
  largestLoss: number;
  totalCost: number;
  totalReturn: number;
  roiPct: number | null;
  exitTypeBreakdown: Record<string, number>;
  warnings: string[];
  history: HedgeHistoryEntry[];
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return round2((num / den) * 100);
}

export function loadHistoryEntries(filePath = HISTORY_FILE): HedgeHistoryEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.history) ? parsed.history as HedgeHistoryEntry[] : [];
}

export function buildAuditReport(history: HedgeHistoryEntry[], filePath = HISTORY_FILE): AuditReport {
  let realizedProfit = 0;
  let totalCost = 0;
  let totalReturn = 0;
  let wins = 0;
  let losses = 0;
  let estimatedTrades = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let peak = 0;
  let runningProfit = 0;
  let maxDrawdown = 0;
  const exitTypeBreakdown: Record<string, number> = {};
  const warnings: string[] = [];

  for (const trade of history) {
    const profit = safeNumber(trade.profit);
    const cost = safeNumber(trade.totalCost);
    const leg1Shares = safeNumber(trade.leg1Shares);
    const exitType = trade.exitType || "unknown";

    exitTypeBreakdown[exitType] = (exitTypeBreakdown[exitType] || 0) + 1;
    realizedProfit += profit;
    totalCost += cost;
    if (trade.estimated) estimatedTrades++;
    if (profit >= 0) wins++;
    else losses++;
    if (profit > largestWin) largestWin = profit;
    if (profit < largestLoss) largestLoss = profit;

    if (exitType === "settlement" && trade.result === "WIN") {
      totalReturn += leg1Shares;
    }

    runningProfit += profit;
    if (runningProfit > peak) peak = runningProfit;
    const drawdown = peak - runningProfit;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (cost <= 0) {
      warnings.push(`发现 totalCost<=0 的交易记录: ${trade.time} ${trade.exitType || "unknown"}`);
    }
    if (trade.estimated && !trade.orderId && exitType === "settlement") {
      warnings.push(`存在估算成交且无orderId的结算记录: ${trade.time} ${trade.leg1Dir}`);
    }

  }

  const avgProfit = history.length > 0 ? realizedProfit / history.length : 0;
  const grossWin = history.filter(x => safeNumber(x.profit) > 0).reduce((sum, x) => sum + safeNumber(x.profit), 0);
  const grossLoss = Math.abs(history.filter(x => safeNumber(x.profit) < 0).reduce((sum, x) => sum + safeNumber(x.profit), 0));
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLoss = losses > 0 ? -grossLoss / losses : 0;
  const profitFactor = grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? null : 0);

  if (history.length === 0) {
    warnings.push("暂无交易历史，无法判断策略是否真实盈利");
  }
  if (history.length > 0 && estimatedTrades / history.length > 0.2) {
    warnings.push(`估算成交占比过高: ${estimatedTrades}/${history.length}，盈利统计可信度不足`);
  }
  if (losses > 0 && grossLoss >= grossWin) {
    warnings.push("历史上亏损总额不小于盈利总额，当前未证明有正期望");
  }
  if (maxDrawdown > Math.max(10, Math.abs(realizedProfit) * 0.8)) {
    warnings.push(`最大回撤 $${round2(maxDrawdown).toFixed(2)} 偏高，策略稳定性不足`);
  }

  return {
    fileExists: history.length > 0 || fs.existsSync(filePath),
    totalTrades: history.length,
    realizedProfit: round2(realizedProfit),
    estimatedTrades,
    estimatedTradePct: pct(estimatedTrades, history.length),
    wins,
    losses,
    winRatePct: pct(wins, history.length),
    avgProfit: round2(avgProfit),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    profitFactor,
    maxDrawdown: round2(maxDrawdown),
    largestWin: round2(largestWin),
    largestLoss: round2(largestLoss),
    totalCost: round2(totalCost),
    totalReturn: round2(totalReturn),
    roiPct: totalCost > 0 ? pct(realizedProfit, totalCost) : null,
    exitTypeBreakdown,
    warnings: [...new Set(warnings)],
    history,
  };
}

export function loadAuditReport(filePath = HISTORY_FILE): AuditReport {
  const history = loadHistoryEntries(filePath);
  return buildAuditReport(history, filePath);
}