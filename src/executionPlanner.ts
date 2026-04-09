import { DirectionalBias, TradeDirection } from "./strategyEngine";

export interface DirectionalEntryPlanInput {
  dir: TradeDirection;
  askPrice: number;
  oppCurrentAsk: number;
  maxEntryAsk: number;
  minEntryAsk: number;
  maxSumTarget: number;
  entryQualityMaxSum: number;
  directionalBias: DirectionalBias;
}

export interface TrendEntryPlanInput {
  askPrice: number;
  maxEntryAsk: number;
  minShares: number;
  maxShares: number;
  balance: number;
  budgetPct: number;
}

export interface EntryPlanResult {
  allowed: boolean;
  reason?: string;
}

export function planDirectionalEntry(input: DirectionalEntryPlanInput): EntryPlanResult {
  const {
    dir,
    askPrice,
    oppCurrentAsk,
    maxEntryAsk,
    minEntryAsk,
    maxSumTarget,
    entryQualityMaxSum,
    directionalBias,
  } = input;

  if (askPrice > maxEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} > MAX_ENTRY_ASK=${maxEntryAsk}` };
  }
  if (oppCurrentAsk > 0 && askPrice + oppCurrentAsk > maxSumTarget) {
    return { allowed: false, reason: `sum=${(askPrice + oppCurrentAsk).toFixed(2)} > ${maxSumTarget.toFixed(2)}` };
  }
  if (askPrice < minEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} < MIN_ENTRY_ASK=${minEntryAsk}` };
  }
  if (oppCurrentAsk > 0 && askPrice + oppCurrentAsk > maxSumTarget + 0.03) {
    return { allowed: false, reason: `opposite ask too expensive, sum=${(askPrice + oppCurrentAsk).toFixed(2)} >> maxTarget=${maxSumTarget.toFixed(2)}` };
  }
  if (directionalBias !== "flat" && dir !== directionalBias) {
    return { allowed: false, reason: `${dir.toUpperCase()} entry against ${directionalBias.toUpperCase()} round bias` };
  }

  return { allowed: true };
}

export function planTrendEntry(input: TrendEntryPlanInput): EntryPlanResult {
  const { askPrice, maxEntryAsk } = input;
  if (askPrice > maxEntryAsk) {
    return { allowed: false, reason: `trend ask=${askPrice.toFixed(2)} > cap=${maxEntryAsk.toFixed(2)}` };
  }
  return { allowed: true };
}