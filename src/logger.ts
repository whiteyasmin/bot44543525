import * as fs from "fs";
import { getLogFilePath } from "./instancePaths";

const LOG_FILE = getLogFilePath();
const MAX_LOG_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_LOG_FILES = 12;
let stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

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
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      stream.end();
      rotateBackups(LOG_FILE, MAX_LOG_FILES);
      stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    }
  } catch {}
}

let rotateCounter = 0;

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function write(level: string, msg: string): void {
  const line = `${ts()} [${level}] ${msg}`;
  stream.write(line + "\n");
  process.stdout.write(line + "\n");
  if (++rotateCounter >= 100) {
    rotateCounter = 0;
    rotateIfNeeded();
  }
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify({ note: "unserializable" });
  }
}

export const logger = {
  info(msg: string) { write("INFO", msg); },
  warn(msg: string) { write("WARN", msg); },
  error(msg: string) { write("ERROR", msg); },
  event(name: string, data: Record<string, unknown>, level: "INFO" | "WARN" | "ERROR" = "INFO") {
    write(level, `[EVENT] ${name} ${safeJson(data)}`);
  },
};
