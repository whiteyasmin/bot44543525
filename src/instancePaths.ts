import * as fs from "fs";
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

function dataFile(baseName: string, fileSuffix: string): string {
  return path.join(process.cwd(), "data", `${baseName}${fileSuffix}`);
}

function pickCompatiblePath(primaryPath: string, legacyPath: string): string {
  if (fs.existsSync(primaryPath)) return primaryPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  return primaryPath;
}

type MigrationPair = {
  from: string;
  to: string;
};

function migrateIfNeeded(from: string, to: string, moves: MigrationPair[]): void {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  moves.push({ from, to });
}

export function getLogFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), `bot${suffixFor(instanceId)}.log`);
}

export function getLiveHistoryFilePathForInstance(instanceId: string): string {
  return dataFile("directional15m-history", `${suffixFor(instanceId)}.json`);
}

export function getPaperHistoryFilePathForInstance(instanceId: string): string {
  return dataFile("directional15m-history-paper", `${suffixFor(instanceId)}.json`);
}

function getLegacyLiveHistoryFilePathForInstance(instanceId: string): string {
  return dataFile("hedge15m-history", `${suffixFor(instanceId)}.json`);
}

function getLegacyPaperHistoryFilePathForInstance(instanceId: string): string {
  return dataFile("hedge15m-history-paper", `${suffixFor(instanceId)}.json`);
}

export function getPaperTuningFilePathForInstance(instanceId: string): string {
  return path.join(process.cwd(), "data", `paper-tuning${suffixFor(instanceId)}.json`);
}

export function getLogFilePath(): string {
  return process.env.LOG_FILE || path.join(process.cwd(), `bot${suffix()}.log`);
}

export function getDecisionAuditFilePathForInstance(instanceId: string): string {
  return dataFile("directional15m-decisions", `${suffixFor(instanceId)}.jsonl`);
}

function getLegacyDecisionAuditFilePathForInstance(instanceId: string): string {
  return dataFile("hedge15m-decisions", `${suffixFor(instanceId)}.jsonl`);
}

export function getDecisionAuditFilePath(): string {
  return process.env.DECISION_AUDIT_FILE || getDecisionAuditFilePathForInstance(getInstanceId());
}

export function getLiveHistoryFilePath(): string {
  return process.env.HISTORY_FILE || getLiveHistoryFilePathForInstance(getInstanceId());
}

export function getPaperHistoryFilePath(): string {
  return process.env.PAPER_HISTORY_FILE || getPaperHistoryFilePathForInstance(getInstanceId());
}

export function resolveCompatibleLiveHistoryFilePath(): string {
  if (process.env.HISTORY_FILE) return process.env.HISTORY_FILE;
  return pickCompatiblePath(
    getLiveHistoryFilePathForInstance(getInstanceId()),
    getLegacyLiveHistoryFilePathForInstance(getInstanceId()),
  );
}

export function resolveCompatiblePaperHistoryFilePath(): string {
  if (process.env.PAPER_HISTORY_FILE) return process.env.PAPER_HISTORY_FILE;
  return pickCompatiblePath(
    getPaperHistoryFilePathForInstance(getInstanceId()),
    getLegacyPaperHistoryFilePathForInstance(getInstanceId()),
  );
}

export function resolveCompatibleDecisionAuditFilePath(): string {
  if (process.env.DECISION_AUDIT_FILE) return process.env.DECISION_AUDIT_FILE;
  return pickCompatiblePath(
    getDecisionAuditFilePathForInstance(getInstanceId()),
    getLegacyDecisionAuditFilePathForInstance(getInstanceId()),
  );
}

export function migrateLegacyDirectionalFiles(instanceId = getInstanceId()): MigrationPair[] {
  const moves: MigrationPair[] = [];

  if (!process.env.HISTORY_FILE) {
    migrateIfNeeded(
      getLegacyLiveHistoryFilePathForInstance(instanceId),
      getLiveHistoryFilePathForInstance(instanceId),
      moves,
    );
  }

  if (!process.env.PAPER_HISTORY_FILE) {
    migrateIfNeeded(
      getLegacyPaperHistoryFilePathForInstance(instanceId),
      getPaperHistoryFilePathForInstance(instanceId),
      moves,
    );
  }

  if (!process.env.DECISION_AUDIT_FILE) {
    migrateIfNeeded(
      getLegacyDecisionAuditFilePathForInstance(instanceId),
      getDecisionAuditFilePathForInstance(instanceId),
      moves,
    );
  }

  return moves;
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