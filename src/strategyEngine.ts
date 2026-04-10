export type TradeDirection = "up" | "down";
export type DirectionalBias = TradeDirection | "flat";

export interface DirectionalBiasParams {
  roundStartPrice: number;
  btcNow: number;
  shortMomentum: number;
  trendMomentum: number;
  directionalMovePct: number;
  momentumContraPct: number;
  trendContraPct: number;
}

export interface MispricingEvaluationParams {
  upAsk: number;
  downAsk: number;
  oldestUpAsk: number;
  oldestDownAsk: number;
  upDrop: number;
  downDrop: number;
  dumpThreshold: number;
  nearThresholdRatio: number;
  shortMomentum: number;
  trendMomentum: number;
  momentumContraPct: number;
  trendContraPct: number;
  momentumWindowSec: number;
  trendWindowSec: number;
}

export interface MispricingCandidate {
  dir: TradeDirection;
  askPrice: number;
  buyTokenKey: "upToken" | "downToken";
  oppTokenKey: "upToken" | "downToken";
  dumpDetected: string;
}

export interface MispricingEvaluation {
  cautionMessage?: string;
  bothSidesDumping: boolean;
  candidates: MispricingCandidate[];
  momentumRejects: string[];
}

export function getDirectionalBias(params: DirectionalBiasParams): DirectionalBias {
  const {
    roundStartPrice,
    btcNow,
    shortMomentum,
    trendMomentum,
    directionalMovePct,
    momentumContraPct,
    trendContraPct,
  } = params;

  if (roundStartPrice <= 0 || btcNow <= 0) return "flat";
  const roundDeltaPct = (btcNow - roundStartPrice) / roundStartPrice;

  if (
    trendMomentum <= -trendContraPct ||
    (roundDeltaPct <= -directionalMovePct && shortMomentum <= -(momentumContraPct * 0.5))
  ) {
    return "down";
  }
  if (
    trendMomentum >= trendContraPct ||
    (roundDeltaPct >= directionalMovePct && shortMomentum >= (momentumContraPct * 0.5))
  ) {
    return "up";
  }

  return "flat";
}

export function evaluateMispricingOpportunity(params: MispricingEvaluationParams): MispricingEvaluation {
  const {
    upAsk,
    downAsk,
    oldestUpAsk,
    oldestDownAsk,
    upDrop,
    downDrop,
    dumpThreshold,
    nearThresholdRatio,
    shortMomentum,
    trendMomentum,
    momentumContraPct,
    trendContraPct,
    momentumWindowSec,
    trendWindowSec,
  } = params;

  const result: MispricingEvaluation = {
    bothSidesDumping: false,
    candidates: [],
    momentumRejects: [],
  };

  const nearThreshold = dumpThreshold * nearThresholdRatio;
  if (upDrop >= dumpThreshold && downDrop >= dumpThreshold) {
    result.bothSidesDumping = true;
    return result;
  }

  if ((upDrop >= dumpThreshold && downDrop >= nearThreshold) || (downDrop >= dumpThreshold && upDrop >= nearThreshold)) {
    result.cautionMessage = `near-dual-dump (UP -${(upDrop * 100).toFixed(1)}%, DN -${(downDrop * 100).toFixed(1)}%)`;
  }

  const upValid = oldestUpAsk > 0.10 && upDrop >= dumpThreshold;
  const downValid = oldestDownAsk > 0.10 && downDrop >= dumpThreshold;
  const upExtremeDump = upDrop >= dumpThreshold * 1.35;
  const downExtremeDump = downDrop >= dumpThreshold * 1.35;
  const strongDownTrend = trendMomentum <= -trendContraPct && shortMomentum <= -(momentumContraPct * 0.5);
  const strongUpTrend = trendMomentum >= trendContraPct && shortMomentum >= (momentumContraPct * 0.5);
  const alignedDownMove = shortMomentum <= -(momentumContraPct * 1.25) && trendMomentum <= -(trendContraPct * 0.5);
  const alignedUpMove = shortMomentum >= (momentumContraPct * 1.25) && trendMomentum >= (trendContraPct * 0.5);

  const upRejected = upValid && (upExtremeDump ? (strongDownTrend && alignedDownMove) : (strongDownTrend || alignedDownMove));
  if (upRejected) {
    result.momentumRejects.push(
      `UP dump but BTC dropping short=${(shortMomentum * 100).toFixed(3)}%/${momentumWindowSec}s trend=${(trendMomentum * 100).toFixed(3)}%/${trendWindowSec}s`,
    );
  }
  const downRejected = downValid && (downExtremeDump ? (strongUpTrend && alignedUpMove) : (strongUpTrend || alignedUpMove));
  if (downRejected) {
    result.momentumRejects.push(
      `DN dump but BTC rising short=+${(shortMomentum * 100).toFixed(3)}%/${momentumWindowSec}s trend=+${(trendMomentum * 100).toFixed(3)}%/${trendWindowSec}s`,
    );
  }

  if (upValid && !upRejected) {
    result.candidates.push({
      dir: "up",
      askPrice: upAsk,
      buyTokenKey: "upToken",
      oppTokenKey: "downToken",
      dumpDetected: `UP ask ${oldestUpAsk.toFixed(2)}→${upAsk.toFixed(2)} (-${(upDrop * 100).toFixed(1)}%) [BTC${momentumWindowSec} ${(shortMomentum * 100).toFixed(3)}% BTC${trendWindowSec} ${(trendMomentum * 100).toFixed(3)}%]`,
    });
  }

  if (downValid && !downRejected) {
    result.candidates.push({
      dir: "down",
      askPrice: downAsk,
      buyTokenKey: "downToken",
      oppTokenKey: "upToken",
      dumpDetected: `DOWN ask ${oldestDownAsk.toFixed(2)}→${downAsk.toFixed(2)} (-${(downDrop * 100).toFixed(1)}%) [BTC${momentumWindowSec} ${(shortMomentum * 100).toFixed(3)}% BTC${trendWindowSec} ${(trendMomentum * 100).toFixed(3)}%]`,
    });
  }

  result.candidates.sort((left, right) => {
    const leftDrop = left.dir === "up" ? upDrop : downDrop;
    const rightDrop = right.dir === "up" ? upDrop : downDrop;
    return rightDrop - leftDrop;
  });

  return result;
}