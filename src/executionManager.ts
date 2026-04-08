export interface EntryOrderbookCheckInput {
  askPrice: number;
  shares: number;
  liveAsk: number | null;
  liveBid: number | null;
  askDepth: number;
  spreadLimit: number;
  reboundLimit: number;
}

export interface EntryOrderbookCheckResult {
  allowed: boolean;
  entryAsk: number;
  reason?: string;
}

export interface EstimatedFillInput {
  spent: number;
  entryAsk: number;
  takerFee: number;
  minBalancePct: number;
  maxBalancePct: number;
  expectedSpend: number;
  minShares: number;
}

export interface EstimatedFillResult {
  confirmed: boolean;
  shares: number;
}

export function evaluateEntryOrderbook(input: EntryOrderbookCheckInput): EntryOrderbookCheckResult {
  const {
    askPrice,
    shares,
    liveAsk,
    liveBid,
    askDepth,
    spreadLimit,
    reboundLimit,
  } = input;

  if (liveAsk != null && liveBid != null) {
    const spread = liveAsk - liveBid;
    if (spread > spreadLimit) {
      return { allowed: false, entryAsk: askPrice, reason: `spread=$${spread.toFixed(2)} > $${spreadLimit.toFixed(2)}, too wide` };
    }
    if (askDepth < shares * 0.5) {
      return { allowed: false, entryAsk: askPrice, reason: `askDepth=${askDepth.toFixed(0)} < ${(shares * 0.5).toFixed(0)} needed (50%)` };
    }
    if (liveAsk > askPrice * reboundLimit) {
      return {
        allowed: false,
        entryAsk: askPrice,
        reason: `price rebounded ${askPrice.toFixed(2)}→${liveAsk.toFixed(2)} (+${((liveAsk / askPrice - 1) * 100).toFixed(1)}%)`,
      };
    }
    return { allowed: true, entryAsk: liveAsk > 0 ? liveAsk : askPrice };
  }

  return { allowed: true, entryAsk: askPrice };
}

export function estimateFilledShares(input: EstimatedFillInput): EstimatedFillResult {
  const {
    spent,
    entryAsk,
    takerFee,
    minBalancePct,
    maxBalancePct,
    expectedSpend,
    minShares,
  } = input;

  if (spent < expectedSpend * minBalancePct || spent > expectedSpend * maxBalancePct) {
    return { confirmed: false, shares: 0 };
  }

  return {
    confirmed: true,
    shares: Math.max(minShares, Math.floor(spent / (entryAsk * (1 + takerFee)))),
  };
}