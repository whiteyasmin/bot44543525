import * as path from "path";

function sanitizeInstanceId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function suffixFor(instanceId: string): string {
  const safeId = sanitizeInstanceId(instanceId || "default");
  return safeId && safeId !== "default" ? `-${safeId}` : "";
}

export function getInstanceId(): string {
  return sanitizeInstanceId(process.env.INSTANCE_ID || "default");
}

function suffix(): string {
  return suffixFor(getInstanceId());
}

export function getLogFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), `bot${suffixFor(instanceId)}.log`);
}

export function getLiveHistoryFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `hedge15m-history${suffixFor(instanceId)}.json`);
}

export function getPaperHistoryFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `hedge15m-history-paper${suffixFor(instanceId)}.json`);
}

export function getPaperTuningFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `paper-tuning${suffixFor(instanceId)}.json`);
}

export function getLogFilePath(): string {
  return process.env.LOG_FILE || path.join(process.cwd(), `bot${suffix()}.log`);
}

export function getDecisionAuditFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `hedge15m-decisions${suffixFor(instanceId)}.jsonl`);
}

export function getDecisionAuditFilePath(): string {
  return process.env.DECISION_AUDIT_FILE || path.join(process.cwd(), "data", `hedge15m-decisions${suffix()}.jsonl`);
}

export function getLiveHistoryFilePath(): string {
  return process.env.HISTORY_FILE || path.join(process.cwd(), "data", `hedge15m-history${suffix()}.json`);
}

export function getPaperHistoryFilePath(): string {
  return process.env.PAPER_HISTORY_FILE || path.join(process.cwd(), "data", `hedge15m-history-paper${suffix()}.json`);
}

export function getPaperTuningFilePath(): string {
  return process.env.PAPER_TUNING_FILE || path.join(process.cwd(), "data", `paper-tuning${suffix()}.json`);
}

export function getPaperRuntimeStateFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `paper-runtime${suffixFor(instanceId)}.json`);
}

export function getPaperRuntimeStateFilePath(): string {
  return process.env.PAPER_RUNTIME_FILE || path.join(process.cwd(), "data", `paper-runtime${suffix()}.json`);
}