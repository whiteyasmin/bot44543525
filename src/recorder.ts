import fs from "node:fs/promises";
import { appendJsonl, paths } from "./store.js";

export async function recordEvent(type: string, payload: Record<string, unknown> = {}, level = "info") {
  await appendJsonl(paths.events, {
    timestamp: new Date().toISOString(),
    level,
    type,
    ...payload
  });
}

export async function recordSnapshot(payload: Record<string, unknown>) {
  await appendJsonl(paths.snapshots, {
    timestamp: new Date().toISOString(),
    ...payload
  });
}

export async function recordTrade(payload: Record<string, unknown>) {
  await appendJsonl(paths.trades, payload);
}

export async function recordOrderbook(payload: Record<string, unknown>) {
  await appendJsonl(paths.orderbooks, {
    timestamp: new Date().toISOString(),
    ...payload
  });
}

export async function jsonlToCsv(file: string) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (rows.length === 0) return "";
    const headers = [...rows.reduce((set: Set<string>, row: Record<string, unknown>) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>())];
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => csvCell(row[h])).join(","));
    }
    return `${lines.join("\n")}\n`;
  } catch {
    return "";
  }
}

function csvCell(value: unknown) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
