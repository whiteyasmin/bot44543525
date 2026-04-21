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

export async function buildMarkdownReport() {
  const generatedAt = new Date().toISOString();
  const [settings, state, trades, snapshots, events, orderbooks] = await Promise.all([
    readText(paths.settings),
    readText(paths.state),
    readJsonlObjects(paths.trades),
    readJsonlObjects(paths.snapshots),
    readJsonlObjects(paths.events),
    readJsonlObjects(paths.orderbooks)
  ]);

  const lines: string[] = [
    "# BTC 5m Polymarket Bot 完整日志",
    "",
    `生成时间: ${generatedAt}`,
    "",
    "## 回测说明",
    "",
    "- 这是模拟盘日志，不包含真实钱包或私钥。",
    "- `trades` 是完整交易记录。",
    "- `snapshots` 是每次策略快照，用于复盘信号和盘口。",
    "- `events` 是机器人事件。",
    "- `orderbooks` 是入场、退出、panic hedge 等关键动作的盘口快照。",
    "",
    "## 当前设置",
    "",
    fencedJson(settings ? JSON.parse(settings) : {}),
    "",
    "## 当前模拟状态",
    "",
    fencedJson(state ? JSON.parse(state) : {}),
    "",
    section("交易记录 trades", trades),
    section("策略快照 snapshots", snapshots),
    section("事件 events", events),
    section("盘口快照 orderbooks", orderbooks)
  ];

  return `${lines.join("\n")}\n`;
}

async function readText(file: string) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function readJsonlObjects(file: string) {
  const raw = await readText(file);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
}

function section(title: string, rows: unknown[]) {
  const lines = [`## ${title}`, "", `记录数: ${rows.length}`, ""];
  if (rows.length === 0) {
    lines.push("_暂无记录_", "");
    return lines.join("\n");
  }
  rows.forEach((row, index) => {
    lines.push(`### ${index + 1}`, "", fencedJson(row), "");
  });
  return lines.join("\n");
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function csvCell(value: unknown) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
