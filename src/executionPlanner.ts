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
  // 方向偏差不再拒绝入场: ≤$0.35 时 EV 天然为正 (50%胜率即+$0.15/份)
  // 信号仅用于 Kelly 仓位调权, 不阻止入场
  return { allowed: true };
}