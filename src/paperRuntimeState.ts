import * as fs from "fs";
import * as path from "path";
import { getPaperRuntimeStateFilePath } from "./instancePaths";

export interface PaperRuntimeState {
  balance: number;
  initialBankroll: number;
  sessionProfit: number;
  rollingPnL: Array<{ ts: number; profit: number }>;
  updatedAt: string;
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