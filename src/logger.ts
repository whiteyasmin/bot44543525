import * as fs from "fs";
import { getLogFilePath } from "./instancePaths";

const LOG_FILE = getLogFilePath();
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
let stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      stream.end();
      const backup = LOG_FILE + ".old";
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(LOG_FILE, backup);
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
