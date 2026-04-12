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
  btcMovePct: number;           // CL价格变动幅度 (abs), 用于计算dumpRatio
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

// ask跌幅 / BTC变动 的最低比值 — 低于此值说明BTC变动可以解释ask下跌, 是正确定价而非砸盘
const MIN_DUMP_RATIO = 20;
// 对侧ask上涨阈值 — 一侧跌N%, 对侧涨 ≥ N*此比例 说明市场在重定价而非恐慌
const OPPOSITE_RISE_RATIO = 0.65; // 回调→0.65: btc_contra已提供方向保护, 0.45过严导致35轮0入场

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
      btcMovePct,
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

// ── 对侧ask变动: 检测重定价 vs 真砸盘 ──
    const upRise = oldestUpAsk > 0.10 ? (upAsk - oldestUpAsk) / oldestUpAsk : 0;  // UP侧涨幅(正=涨)
    const downRise = oldestDownAsk > 0.10 ? (downAsk - oldestDownAsk) / oldestDownAsk : 0;

    if (upValid && !upRejected) {
      // dumpRatio: ask跌幅 vs BTC变动 — BTC大幅变动可解释ask下跌 = 正确定价
      const dumpRatio = btcMovePct > 0.0001 ? upDrop / btcMovePct : Infinity;
      // 对侧验证: DOWN ask 上涨 ≥ UP跌幅的50% → 市场零和重定价
      const oppositeRose = downRise >= upDrop * OPPOSITE_RISE_RATIO;
      if (dumpRatio < MIN_DUMP_RATIO) {
        result.momentumRejects.push(
          `UP dump ratio=${dumpRatio.toFixed(1)} < ${MIN_DUMP_RATIO} (ask-${(upDrop*100).toFixed(1)}% vs BTC ${(btcMovePct*100).toFixed(3)}%) — likely correct repricing`,
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          `UP dump but DN ask rose +${(downRise*100).toFixed(1)}% (≥${(upDrop*OPPOSITE_RISE_RATIO*100).toFixed(1)}%) — zero-sum repricing`,
        );
      } else {
        result.candidates.push({
          dir: "up",
          askPrice: upAsk,
          buyTokenKey: "upToken",
          oppTokenKey: "downToken",
          dumpDetected: `UP ask ${oldestUpAsk.toFixed(2)}→${upAsk.toFixed(2)} (-${(upDrop * 100).toFixed(1)}%) [BTC${momentumWindowSec} ${(shortMomentum * 100).toFixed(3)}% BTC${trendWindowSec} ${(trendMomentum * 100).toFixed(3)}% ratio=${dumpRatio.toFixed(0)} dnΔ=${(downRise*100).toFixed(1)}%]`,
        });
      }
    }

    if (downValid && !downRejected) {
      const dumpRatio = btcMovePct > 0.0001 ? downDrop / btcMovePct : Infinity;
      const oppositeRose = upRise >= downDrop * OPPOSITE_RISE_RATIO;
      if (dumpRatio < MIN_DUMP_RATIO) {
        result.momentumRejects.push(
          `DN dump ratio=${dumpRatio.toFixed(1)} < ${MIN_DUMP_RATIO} (ask-${(downDrop*100).toFixed(1)}% vs BTC ${(btcMovePct*100).toFixed(3)}%) — likely correct repricing`,
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          `DN dump but UP ask rose +${(upRise*100).toFixed(1)}% (≥${(downDrop*OPPOSITE_RISE_RATIO*100).toFixed(1)}%) — zero-sum repricing`,
        );
      } else {
        result.candidates.push({
          dir: "down",
          askPrice: downAsk,
          buyTokenKey: "downToken",
          oppTokenKey: "upToken",
          dumpDetected: `DOWN ask ${oldestDownAsk.toFixed(2)}→${downAsk.toFixed(2)} (-${(downDrop * 100).toFixed(1)}%) [BTC${momentumWindowSec} ${(shortMomentum * 100).toFixed(3)}% BTC${trendWindowSec} ${(trendMomentum * 100).toFixed(3)}% ratio=${dumpRatio.toFixed(0)} upΔ=${(upRise*100).toFixed(1)}%]`,
        });
      }
  }

  result.candidates.sort((left, right) => {
    const leftDrop = left.dir === "up" ? upDrop : downDrop;
    const rightDrop = right.dir === "up" ? upDrop : downDrop;
    return rightDrop - leftDrop;
  });

  return result;
}