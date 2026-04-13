export function evaluateMispricingOpportunity(params: MispricingEvaluationParams): MispricingEvaluation {
    const {
      upAsk,
      downAsk,
      oldestUpAsk,
      oldestDownAsk,
      upDrop,
      downDrop,
      upDropMs,
      downDropMs,
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
  }

  if ((upDrop >= dumpThreshold && downDrop >= nearThreshold) || (downDrop >= dumpThreshold && upDrop >= nearThreshold)) {
    result.cautionMessage = "near-dual-dump (UP -" + (upDrop * 100).toFixed(1) + "%, DN -" + (downDrop * 100).toFixed(1) + "%)";
  }

  const upValid = oldestUpAsk > 0.10 && upDrop >= dumpThreshold;
  const downValid = oldestDownAsk > 0.10 && downDrop >= dumpThreshold;
  const upExtremeDump = upDrop >= dumpThreshold * 1.35;
  const downExtremeDump = downDrop >= dumpThreshold * 1.35;
  const strongDownTrend = trendMomentum <= -trendContraPct && shortMomentum <= -(momentumContraPct * 0.5);
  const strongUpTrend = trendMomentum >= trendContraPct && shortMomentum >= (momentumContraPct * 0.5);
  const alignedDownMove = shortMomentum <= -(momentumContraPct * 1.25) && trendMomentum <= -(trendContraPct * 0.5);
  const alignedUpMove = shortMomentum >= (momentumContraPct * 1.25) && trendMomentum >= (trendContraPct * 0.5);

  const softDownAlign = shortMomentum <= -(momentumContraPct * 0.5);
  const softUpAlign = shortMomentum >= (momentumContraPct * 0.5);

  const upRejected = upValid && (upExtremeDump ? (strongDownTrend && alignedDownMove) : (strongDownTrend && softDownAlign));
  if (upRejected) {
    result.momentumRejects.push(
      "UP dump but BTC dropping short=" + (shortMomentum * 100).toFixed(3) + "%/" + momentumWindowSec + "s trend=" + (trendMomentum * 100).toFixed(3) + "%/" + trendWindowSec + "s"
    );
  }
  const downRejected = downValid && (downExtremeDump ? (strongUpTrend && alignedUpMove) : (strongUpTrend && softUpAlign));
  if (downRejected) {
    result.momentumRejects.push(
      "DN dump but BTC rising short=+" + (shortMomentum * 100).toFixed(3) + "%/" + momentumWindowSec + "s trend=+" + (trendMomentum * 100).toFixed(3) + "%/" + trendWindowSec + "s"
    );
  }

    const upRise = oldestUpAsk > 0.10 ? (upAsk - oldestUpAsk) / oldestUpAsk : 0;
    const downRise = oldestDownAsk > 0.10 ? (downAsk - oldestDownAsk) / oldestDownAsk : 0;

    if (upValid && !upRejected) {
      const upVelocity = classifyDumpVelocity(upDropMs);
      const btcDrop = shortMomentum < 0 ? Math.abs(shortMomentum) : 0;
      const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcDrop);
      const dumpRatio = btcDrop > 0.0001 ? upDrop / btcDrop : Infinity;
      const effectiveDumpRatio = upVelocity === "fast" ? dynamicMinDumpRatio * 0.7 : dynamicMinDumpRatio;

      const upOppRatio = upDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
      const oppositeRose = downRise >= upDrop * upOppRatio;
      if (dumpRatio < effectiveDumpRatio) {
        result.momentumRejects.push(
          "UP dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (upDrop*100).toFixed(1) + "% vs BTC drop " + (btcDrop*100).toFixed(3) + "% vel=" + upVelocity + ") - likely correct repricing"
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          "UP dump but DN ask rose +" + (downRise*100).toFixed(1) + "% (>=" + (upDrop*upOppRatio*100).toFixed(1) + "%) - zero-sum repricing"
        );
      } else {
        result.candidates.push({
          dir: "up",
          askPrice: upAsk,
          buyTokenKey: "upToken",
          oppTokenKey: "downToken",
          dumpDetected: "UP ask " + oldestUpAsk.toFixed(2) + "->" + upAsk.toFixed(2) + " (-" + (upDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC" + trendWindowSec + " " + (trendMomentum * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " dnRise=" + (downRise*100).toFixed(1) + "% vel=" + upVelocity + "]",
          dumpVelocity: upVelocity,
        });
      }
    }

    if (downValid && !downRejected) {
      const dnVelocity = classifyDumpVelocity(downDropMs);
      const btcRise = shortMomentum > 0 ? shortMomentum : 0;
      const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcRise);
      const dumpRatio = btcRise > 0.0001 ? downDrop / btcRise : Infinity;
      const effectiveDumpRatio = dnVelocity === "fast" ? dynamicMinDumpRatio * 0.7 : dynamicMinDumpRatio;

      const dnOppRatio = downDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
      const oppositeRose = upRise >= downDrop * dnOppRatio;
      if (dumpRatio < effectiveDumpRatio) {
        result.momentumRejects.push(
          "DN dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (downDrop*100).toFixed(1) + "% vs BTC rise " + (btcRise*100).toFixed(3) + "% vel=" + dnVelocity + ") - likely correct repricing"
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          "DN dump but UP ask rose +" + (upRise*100).toFixed(1) + "% (>=" + (downDrop*dnOppRatio*100).toFixed(1) + "%) - zero-sum repricing"
        );
      } else {
        result.candidates.push({
          dir: "down",
          askPrice: downAsk,
          buyTokenKey: "downToken",
          oppTokenKey: "upToken",
          dumpDetected: "DOWN ask " + oldestDownAsk.toFixed(2) + "->" + downAsk.toFixed(2) + " (-" + (downDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC" + trendWindowSec + " " + (trendMomentum * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " upRise=" + (upRise*100).toFixed(1) + "% vel=" + dnVelocity + "]",
          dumpVelocity: dnVelocity,
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
