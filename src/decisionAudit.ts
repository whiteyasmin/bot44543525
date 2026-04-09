import * as fs from "fs";
import * as path from "path";
import { getDecisionAuditFilePath } from "./instancePaths";

const AUDIT_FILE = getDecisionAuditFilePath();
const MAX_AUDIT_SIZE = 20 * 1024 * 1024; // 20MB per file
const MAX_AUDIT_FILES = 30;

fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });

let auditStream = fs.createWriteStream(AUDIT_FILE, { flags: "a" });
let auditRotateCounter = 0;

function rotateBackups(baseFile: string, maxFiles: number): void {
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = `${baseFile}.${index}`;
    const to = `${baseFile}.${index + 1}`;
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) fs.unlinkSync(to);
      fs.renameSync(from, to);
    }
  }
  const firstBackup = `${baseFile}.1`;
  if (fs.existsSync(firstBackup)) fs.unlinkSync(firstBackup);
  fs.renameSync(baseFile, firstBackup);
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size > MAX_AUDIT_SIZE) {
      auditStream.end();
      rotateBackups(AUDIT_FILE, MAX_AUDIT_FILES);
      auditStream = fs.createWriteStream(AUDIT_FILE, { flags: "a" });
    }
  } catch {}
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ts: nowIso(), event: "serialization-error" });
  }
}

function normalizeDecisionAuditRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...record };
  if (normalized.event === "hedge-locked") {
    normalized.event = "position-paired";
  }
  if (normalized.positionState == null && typeof normalized.hedgeState === "string") {
    normalized.positionState = normalized.hedgeState;
  }
  if (normalized.pairedShares == null && typeof normalized.hedgedShares === "number") {
    normalized.pairedShares = normalized.hedgedShares;
  }
  delete normalized.hedgeState;
  delete normalized.hedgedShares;
  return normalized;
}

export function normalizeDecisionAuditContent(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return safeStringify(normalizeDecisionAuditRecord(parsed));
      } catch {
        return line;
      }
    })
    .join("\n");
}

export function normalizeDecisionAuditFileInPlace(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  const normalized = normalizeDecisionAuditContent(raw);
  if (normalized === raw) return false;
  const finalText = normalized.length > 0 ? `${normalized}\n` : normalized;
  fs.writeFileSync(filePath, finalText, "utf8");
  return true;
}

export function writeDecisionAudit(event: string, payload: Record<string, unknown>): void {
  const line = safeStringify({ ts: nowIso(), event, ...payload });
  auditStream.write(line + "\n");
  if (++auditRotateCounter >= 50) {
    auditRotateCounter = 0;
    rotateIfNeeded();
  }
}
