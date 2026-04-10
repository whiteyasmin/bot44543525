import { DirectionalBias, TradeDirection } from "./strategyEngine";

export interface HedgeEntryPlanInput {
  dir: TradeDirection;
  askPrice: number;
  maxEntryAsk: number;
  minEntryAsk: number;
  directionalBias: DirectionalBias;
}

export interface EntryPlanResult {
  allowed: boolean;
  reason?: string;
}

export function planHedgeEntry(input: HedgeEntryPlanInput): EntryPlanResult {
  const {
    dir,
    askPrice,
    maxEntryAsk,
    minEntryAsk,
    directionalBias,
  } = input;

  if (askPrice > maxEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} > MAX_ENTRY_ASK=${maxEntryAsk}` };
  }
  if (askPrice < minEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} < MIN_ENTRY_ASK=${minEntryAsk}` };
  }
  if (directionalBias !== "flat" && dir !== directionalBias) {
    return { allowed: false, reason: `${dir.toUpperCase()} entry against ${directionalBias.toUpperCase()} round bias` };
  }

  return { allowed: true };
}