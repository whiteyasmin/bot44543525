import { DirectionalBias, TradeDirection } from "./strategyEngine";

export interface HedgeEntryPlanInput {
  dir: TradeDirection;
  askPrice: number;
  maxEntryAsk: number;
  minEntryAsk: number;
  directionalBias: DirectionalBias;
  allowDirectionalContra?: boolean;
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
    allowDirectionalContra = false,
  } = input;

  if (askPrice > maxEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} > MAX_ENTRY_ASK=${maxEntryAsk}` };
  }
  if (askPrice < minEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} < MIN_ENTRY_ASK=${minEntryAsk}` };
  }
  // BTC方向逆向拒绝: 市场重定价而非砸盘 (例: BTC跌时买UP=买反)
  // 仅在偏差直接对立时拒绝, flat不阻止
  if (!allowDirectionalContra && directionalBias === "down" && dir === "up") {
    return { allowed: false, reason: `BTC偏向DOWN但买UP — 重定价而非砸盘` };
  }
  if (!allowDirectionalContra && directionalBias === "up" && dir === "down") {
    return { allowed: false, reason: `BTC偏向UP但买DOWN — 重定价而非砸盘` };
  }
  return { allowed: true };
}
