interface MetricSnapshot {
  count: number;
  last: number;
  p50: number;
  p90: number;
}

type ExecutionMetricName =
  | "signalToSubmit"
  | "submitToAck"
  | "ackToFill"
  | "signalToFill"
  | "exitSignalToSubmit"
  | "exitSubmitToAck"
  | "exitAckToFill"
  | "exitSignalToFill"
  | "gtcWaitToFill";

const HISTORY_LIMIT = 200;

const samples: Record<ExecutionMetricName, number[]> = {
  signalToSubmit: [],
  submitToAck: [],
  ackToFill: [],
  signalToFill: [],
  exitSignalToSubmit: [],
  exitSubmitToAck: [],
  exitAckToFill: [],
  exitSignalToFill: [],
  gtcWaitToFill: [],
};

function summarize(values: number[]): MetricSnapshot {
  if (values.length === 0) {
    return { count: 0, last: 0, p50: 0, p90: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    last: values[values.length - 1],
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90: sorted[Math.floor((sorted.length - 1) * 0.9)],
  };
}

export function resetExecutionTelemetry(): void {
  for (const metric of Object.keys(samples) as ExecutionMetricName[]) {
    samples[metric].length = 0;
  }
}

export function recordExecutionLatency(metric: ExecutionMetricName, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
  const bucket = samples[metric];
  bucket.push(Math.round(ms));
  while (bucket.length > HISTORY_LIMIT) bucket.shift();
}

export function getExecutionTelemetry(): Record<ExecutionMetricName, MetricSnapshot> {
  return {
    signalToSubmit: summarize(samples.signalToSubmit),
    submitToAck: summarize(samples.submitToAck),
    ackToFill: summarize(samples.ackToFill),
    signalToFill: summarize(samples.signalToFill),
    exitSignalToSubmit: summarize(samples.exitSignalToSubmit),
    exitSubmitToAck: summarize(samples.exitSubmitToAck),
    exitAckToFill: summarize(samples.exitAckToFill),
    exitSignalToFill: summarize(samples.exitSignalToFill),
    gtcWaitToFill: summarize(samples.gtcWaitToFill),
  };
}