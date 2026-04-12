import * as fs from "fs";
import * as path from "path";
import { getPaperRuntimeStateFilePath } from "./instancePaths";

export interface PaperRuntimeState {
  balance: number;
  initialBankroll: number;
  sessionProfit: number;
  rollingPnL: Array<{ ts: number; profit: number }>;
  updatedAt: string;
  // 持仓崩溃恢复
  openPosition?: {
    conditionId: string;
    leg1Dir: string;
    leg1Token: string;
    leg1Shares: number;
    leg1FillPrice: number;
    leg1OrderId: string;
    totalCost: number;
    roundStartBtcPrice: number;
    entrySource: string;
    filledAt: number;
  } | null;
}

const PAPER_RUNTIME_STATE_FILE = getPaperRuntimeStateFilePath();

export function loadPaperRuntimeState(): PaperRuntimeState | null {
  try {
    if (!fs.existsSync(PAPER_RUNTIME_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(PAPER_RUNTIME_STATE_FILE, "utf8"));
    if (typeof raw !== "object" || raw == null) return null;
    return {
      balance: Number(raw.balance) || 0,
      initialBankroll: Number(raw.initialBankroll) || 0,
      sessionProfit: Number(raw.sessionProfit) || 0,
      rollingPnL: Array.isArray(raw.rollingPnL)
        ? raw.rollingPnL
            .map((item: any) => ({
              ts: Number(item?.ts) || 0,
              profit: Number(item?.profit) || 0,
            }))
            .filter((item: { ts: number; profit: number }) => item.ts > 0)
        : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      openPosition: raw.openPosition && typeof raw.openPosition === "object" ? {
        conditionId: String(raw.openPosition.conditionId || ""),
        leg1Dir: String(raw.openPosition.leg1Dir || ""),
        leg1Token: String(raw.openPosition.leg1Token || ""),
        leg1Shares: Number(raw.openPosition.leg1Shares) || 0,
        leg1FillPrice: Number(raw.openPosition.leg1FillPrice) || 0,
        leg1OrderId: String(raw.openPosition.leg1OrderId || ""),
        totalCost: Number(raw.openPosition.totalCost) || 0,
        roundStartBtcPrice: Number(raw.openPosition.roundStartBtcPrice) || 0,
        entrySource: String(raw.openPosition.entrySource || ""),
        filledAt: Number(raw.openPosition.filledAt) || 0,
      } : null,
    };
  } catch {
    return null;
  }
}

export function savePaperRuntimeState(state: PaperRuntimeState): void {
  const dir = path.dirname(PAPER_RUNTIME_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = PAPER_RUNTIME_STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, PAPER_RUNTIME_STATE_FILE);
}

export function clearPaperRuntimeState(): void {
  try {
    if (fs.existsSync(PAPER_RUNTIME_STATE_FILE)) fs.unlinkSync(PAPER_RUNTIME_STATE_FILE);
  } catch {}
}

export function getPaperRuntimeStatePath(): string {
  return PAPER_RUNTIME_STATE_FILE;
}