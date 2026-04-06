import * as fs from "fs";
import * as path from "path";
import { getPaperTuningFilePath } from "./instancePaths";

export interface PaperTuningConfig {
  baseSumTarget?: number;
  maxSumTarget?: number;
  maxEntryAsk?: number;
  fixedMinLockedProfit?: number;
  fixedMinLockedRoi?: number;
  adaptiveMinLockedProfit?: number;
  adaptiveMinLockedRoi?: number;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function loadPaperTuning(): PaperTuningConfig {
  const filePath = getPaperTuningFilePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      baseSumTarget: safeNumber(parsed?.baseSumTarget),
      maxSumTarget: safeNumber(parsed?.maxSumTarget),
      maxEntryAsk: safeNumber(parsed?.maxEntryAsk),
      fixedMinLockedProfit: safeNumber(parsed?.fixedMinLockedProfit),
      fixedMinLockedRoi: safeNumber(parsed?.fixedMinLockedRoi),
      adaptiveMinLockedProfit: safeNumber(parsed?.adaptiveMinLockedProfit),
      adaptiveMinLockedRoi: safeNumber(parsed?.adaptiveMinLockedRoi),
    };
  } catch {
    return {};
  }
}

export function savePaperTuning(config: PaperTuningConfig): void {
  const filePath = getPaperTuningFilePath();
  const payload = JSON.stringify(config, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, payload, "utf8");
}