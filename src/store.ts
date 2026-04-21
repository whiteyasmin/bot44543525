import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { Settings } from "./types.js";
import { defaultSettings } from "./defaults.js";

const dataDir = path.resolve(process.cwd(), "data");
const settingsPath = path.join(dataDir, "settings.json");
const statePath = path.join(dataDir, "paper-state.json");

export const paths = {
  dataDir,
  settings: settingsPath,
  state: statePath,
  trades: path.join(dataDir, "trades.jsonl"),
  snapshots: path.join(dataDir, "snapshots.jsonl"),
  events: path.join(dataDir, "events.jsonl"),
  orderbooks: path.join(dataDir, "orderbooks.jsonl")
};

export async function ensureDataDir() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

export async function readSettings(): Promise<Settings> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return sanitizeSettings({ ...defaultSettings, ...JSON.parse(raw) });
  } catch {
    await writeSettings(defaultSettings);
    return defaultSettings;
  }
}

export async function writeSettings(settings: Settings) {
  await ensureDataDir();
  await fs.writeFile(settingsPath, `${JSON.stringify(sanitizeSettings(settings), null, 2)}\n`);
}

function sanitizeSettings(input: Settings): Settings {
  const s = { ...defaultSettings, ...input };
  s.paperMode = true;
  s.repriceIntervalMs = clamp(s.repriceIntervalMs, 500, 10000);
  s.snapshotIntervalMs = clamp(s.snapshotIntervalMs, 500, 60000);
  s.entryStartSeconds = clamp(s.entryStartSeconds, 0, 260);
  s.entryEndSeconds = clamp(s.entryEndSeconds, s.entryStartSeconds, 260);
  s.exitBeforeResolveSeconds = clamp(s.exitBeforeResolveSeconds, 5, 120);
  s.maxHoldSeconds = clamp(s.maxHoldSeconds, 5, 260);
  s.minBtcMoveBps = clamp(s.minBtcMoveBps, 0, 100);
  s.minBtcVelocityBps = clamp(s.minBtcVelocityBps, 0, 100);
  s.maxEntryPrice = clamp(s.maxEntryPrice, 0.01, 0.99);
  s.maxHedgePrice = clamp(s.maxHedgePrice, 0.01, 0.99);
  s.kellyFraction = clamp(s.kellyFraction, 0, 1);
  s.kellyLookbackTrades = Math.round(clamp(s.kellyLookbackTrades, 1, 1000));
  s.kellyMinTrades = Math.round(clamp(s.kellyMinTrades, 1, s.kellyLookbackTrades));
  s.kellyMaxPct = clamp(s.kellyMaxPct, 0.1, 100);
  s.kellyFallbackPct = clamp(s.kellyFallbackPct, 0.1, s.kellyMaxPct);
  s.depthUsageRatio = clamp(s.depthUsageRatio, 0.01, 1);
  s.goodSpreadCents = clamp(s.goodSpreadCents, 0, 20);
  s.okSpreadCents = clamp(s.okSpreadCents, s.goodSpreadCents, 50);
  s.maxSpreadCents = clamp(s.maxSpreadCents, s.okSpreadCents, 100);
  s.minDepthToKellyRatio = clamp(s.minDepthToKellyRatio, 0, 10);
  s.thinDepthMultiplier = clamp(s.thinDepthMultiplier, 0, 1);
  s.okDepthMultiplier = clamp(s.okDepthMultiplier, s.thinDepthMultiplier, 1);
  s.minOrderUsdc = clamp(s.minOrderUsdc, 0.01, 100000);
  s.maxEntrySlippageCents = clamp(s.maxEntrySlippageCents, 0, 50);
  s.maxExitSlippageCents = clamp(s.maxExitSlippageCents, 0, 100);
  s.minExitFillRatio = clamp(s.minExitFillRatio, 0, 1);
  s.hedgeSizeRatio = clamp(s.hedgeSizeRatio, 0, 2);
  s.maxHedgeSlippageCents = clamp(s.maxHedgeSlippageCents, 0, 100);
  s.feeBps = clamp(s.feeBps, 0, 1000);
  s.paperBalance = clamp(s.paperBalance, 0, 1_000_000_000);
  return s;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

export async function appendJsonl(file: string, value: unknown) {
  await ensureDataDir();
  await fs.appendFile(file, `${JSON.stringify(value)}\n`);
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  await ensureDataDir();
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(file: string, value: unknown) {
  await ensureDataDir();
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function fileInfo(file: string) {
  try {
    const stat = await fs.stat(file);
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

export async function clearLogs() {
  await ensureDataDir();
  await Promise.all([paths.trades, paths.snapshots, paths.events, paths.orderbooks].map((p) => fs.writeFile(p, "")));
}

export async function readRecentJsonl(file: string, limit = 20): Promise<unknown[]> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
}

export async function readAllJsonl<T = unknown>(file: string): Promise<T[]> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
