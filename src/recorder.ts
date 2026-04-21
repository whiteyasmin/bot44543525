import fs from "node:fs/promises";
import { appendJsonl, paths } from "./store.js";

type Row = Record<string, unknown>;

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
    const headers = [...rows.reduce((set: Set<string>, row: Row) => {
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
  const [settings, state, trades, snapshots, events] = await Promise.all([
    readJson(paths.settings),
    readJson(paths.state),
    readJsonlObjects(paths.trades),
    readJsonlObjects(paths.snapshots),
    readJsonlObjects(paths.events)
  ]);
  const signalSnapshots = usefulSnapshots(snapshots);
  const actionEvents = usefulEvents(events);
  const uniqueTrades = dedupeTrades(trades);

  const lines: string[] = [
    "# BTC 5m \u7b56\u7565\u56de\u6d4b\u65e5\u5fd7",
    "",
    `\u751f\u6210\u65f6\u95f4: ${generatedAt}`,
    "",
    "## \u7b56\u7565\u53c2\u6570",
    "",
    table(
      ["\u53c2\u6570", "\u503c"],
      [
        ["\u5165\u573a\u7a97\u53e3", `${num(settings.entryStartSeconds)}s - ${num(settings.entryEndSeconds)}s`],
        ["\u52a8\u91cf\u9608\u503c", `${num(settings.minBtcMoveBps)} bps`],
        ["\u901f\u5ea6\u56de\u770b", `${num(settings.velocityLookbackSeconds)}s`],
        ["\u901f\u5ea6\u9608\u503c", `${num(settings.minBtcVelocityBps)} bps`],
        ["\u6700\u9ad8\u4e70\u5165\u4ef7", num(settings.maxEntryPrice, 3)],
        ["\u6700\u5927\u4ef7\u5dee", `${num(settings.maxSpreadCents)} cents`],
        ["Kelly \u6700\u5927\u4ed3\u4f4d", `${num(settings.kellyMaxPct)}%`],
        ["\u6837\u672c\u4e0d\u8db3\u4ed3\u4f4d", `${num(settings.kellyFallbackPct)}%`],
        ["\u76d8\u53e3\u4f7f\u7528\u6bd4\u4f8b", `${num(n(settings.depthUsageRatio) * 100)}%`],
        ["panic \u6d6e\u4e8f\u9608\u503c", `${num(settings.panicLossCents)} cents`],
        ["\u5bf9\u51b2\u6bd4\u4f8b", `${num(n(settings.hedgeSizeRatio) * 100)}%`],
        ["\u6700\u5c0f\u5bf9\u51b2\u6539\u5584", `${num(settings.minHedgeImprovementPct)}%`],
        ["\u6700\u9ad8\u5bf9\u51b2\u4ef7", num(settings.maxHedgePrice, 3)],
        ["crypto \u52a8\u6001\u624b\u7eed\u8d39", "\u5b98\u65b9\u516c\u5f0f"],
        ["\u989d\u5916\u8d39\u7528\u7f13\u51b2", `${num(settings.feeBps)} bps`]
      ]
    ),
    "",
    "## \u5f53\u524d\u8d44\u91d1",
    "",
    table(
      ["\u9879\u76ee", "\u503c"],
      [
        ["\u6a21\u62df\u4f59\u989d", num(state.paperBalance, 2)],
        ["\u5df2\u5b9e\u73b0 PnL", num(state.realizedPnl, 2)],
        ["\u5f53\u524d\u4ed3\u4f4d", positionText(state.position)]
      ]
    ),
    "",
    "## \u4ea4\u6613\u6c47\u603b",
    "",
    summaryTable(uniqueTrades, actionEvents, trades.length - uniqueTrades.length),
    "",
    "## \u5df2\u7ed3\u7b97\u4ea4\u6613",
    "",
    uniqueTrades.length ? tradeTable(uniqueTrades) : "_\u6682\u65e0\u5df2\u7ed3\u7b97\u4ea4\u6613_",
    "",
    "## \u6210\u4ea4\u52a8\u4f5c\u6d41\u6c34",
    "",
    actionEvents.length ? actionTable(actionEvents) : "_\u6682\u65e0\u5165\u573a\u6216\u5bf9\u51b2\u52a8\u4f5c_",
    "",
    "## \u4fe1\u53f7\u5feb\u7167",
    "",
    signalSnapshots.length ? snapshotTable(signalSnapshots) : "_\u6682\u65e0\u53ef\u56de\u6d4b\u5feb\u7167_",
    ""
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

async function readJson(file: string): Promise<Row> {
  const raw = await readText(file);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readJsonlObjects(file: string): Promise<Row[]> {
  const raw = await readText(file);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Row;
      } catch {
        return { parseError: true };
      }
    });
}

function dedupeTrades(trades: Row[]) {
  const seen = new Set<string>();
  return trades.filter((trade, index) => {
    const key = String(trade.tradeId ?? `${trade.marketSlug ?? "unknown"}-${trade.entryTime ?? index}-${trade.exitReason ?? "exit"}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summaryTable(trades: Row[], actionEvents: Row[], duplicateTrades: number) {
  const pnl = trades.map((t) => n(t.netPnl)).filter(Number.isFinite);
  const wins = pnl.filter((v) => v > 0);
  const losses = pnl.filter((v) => v < 0);
  const total = sum(pnl);
  return table(
    ["\u6307\u6807", "\u503c"],
    [
      ["\u5df2\u7ed3\u7b97\u4ea4\u6613\u6570", String(trades.length)],
      ["\u91cd\u590d\u7ed3\u7b97\u5df2\u5ffd\u7565", String(Math.max(0, duplicateTrades))],
      ["\u5165\u573a\u52a8\u4f5c\u6570", String(actionEvents.filter((e) => e.type === "entry_filled").length)],
      ["\u5bf9\u51b2\u52a8\u4f5c\u6570", String(actionEvents.filter((e) => e.type === "panic_hedge_triggered").length)],
      ["\u80dc\u7387", pnl.length ? `${num(wins.length / pnl.length * 100)}%` : "-"],
      ["\u603b PnL", num(total, 2)],
      ["\u5e73\u5747 PnL", pnl.length ? num(total / pnl.length, 2) : "-"],
      ["\u5e73\u5747\u76c8\u5229", wins.length ? num(sum(wins) / wins.length, 2) : "-"],
      ["\u5e73\u5747\u4e8f\u635f", losses.length ? num(sum(losses) / losses.length, 2) : "-"]
    ]
  );
}

function tradeTable(trades: Row[]) {
  return table(
    ["#", "\u5165\u573a", "\u65b9\u5411", "\u5165\u573a\u79d2", "\u5269\u4f59\u79d2", "BTC\u5165\u573a", "\u52a8\u91cf", "\u901f\u5ea6", "\u6307\u6807", "\u4e70\u5165\u4ef7", "\u4efd\u989d", "\u5bf9\u51b2", "\u7ed3\u679c", "PnL"],
    trades.map((t, index) => [
      String(index + 1),
      shortTime(t.entryTime),
      side(t.side),
      num(t.entrySecond, 0),
      num(t.secondsLeft, 0),
      num(t.btcEntry ?? t.btcOpen, 2),
      bps(t.entryMoveBps),
      bps(t.entryVelocityBps),
      regime(t.btcRegimeAtEntry ?? t.trendAtEntry),
      num(t.entryAvgPrice, 3),
      num(t.entryShares, 2),
      hedgeText(t),
      `${side(t.resolvedWinner)} / ${t.exitReason ?? "-"}`,
      num(t.netPnl, 2)
    ])
  );
}

function actionTable(events: Row[]) {
  return table(
    ["\u65f6\u95f4", "\u52a8\u4f5c", "\u5e02\u573a", "\u65b9\u5411", "\u4efd\u989d", "\u5747\u4ef7", "\u91d1\u989d", "\u6ed1\u70b9", "\u8bf4\u660e"],
    events.map((event) => {
      const fill = fillFromEvent(event);
      return [
        shortTime(event.timestamp),
        event.type === "entry_filled" ? "\u5165\u573a\u4e70\u5165" : "\u5bf9\u51b2\u4e70\u5165",
        String(event.marketSlug ?? "-"),
        side(event.side ?? event.hedgeSide),
        num(fill.shares, 2),
        num(fill.avgPrice, 3),
        num(fill.value, 2),
        num(fill.slippageCents, 2),
        event.type === "entry_filled" ? sizingText(event.sizing) : "\u89e6\u53d1 panic hedge"
      ];
    })
  );
}

function snapshotTable(snapshots: Row[]) {
  return table(
    ["\u65f6\u95f4", "\u5c40\u5185\u79d2", "\u5269\u4f59\u79d2", "BTC", "\u52a8\u91cf", "\u901f\u5ea6", "\u6307\u6807", "\u4fe1\u53f7", "UP\u5356\u4e00", "DOWN\u5356\u4e00", "\u76ee\u6807\u4ed3\u4f4d", "\u9650\u5236"],
    snapshots.map((s) => [
      shortTime(s.timestamp),
      num(s.secondInBucket, 0),
      num(s.secondsLeft, 0),
      num(s.btcPrice, 2),
      bps(s.moveBps),
      bps(s.velocityBps),
      regime(s.btcRegime ?? s.regimeLabel ?? s.trendAtEntry),
      side(s.signalSide),
      num(s.upAsk, 3),
      num(s.downAsk, 3),
      num(s.depthQualityTargetUsdc, 2),
      String(s.sizeLimitedBy ?? "-")
    ])
  );
}

function usefulEvents(rows: Row[]) {
  return rows.filter((row) => row.type === "entry_filled" || row.type === "panic_hedge_triggered");
}

function usefulSnapshots(rows: Row[]) {
  return rows
    .filter((r) => r.signalSide || r.positionSide || r.action !== "no_signal")
    .slice(-500);
}

function fillFromEvent(event: Row) {
  const fill = event.type === "panic_hedge_triggered" ? event.hedgeFill : event.fill;
  return fill && typeof fill === "object" ? fill as Row : {};
}

function sizingText(value: unknown) {
  if (!value || typeof value !== "object") return "-";
  const sizing = value as Row;
  return `Kelly ${num(sizing.kellyTargetUsdc, 2)} / \u6df1\u5ea6 ${num(sizing.depthCapUsdc, 2)} / \u9650\u5236 ${sizing.limitedBy ?? "-"}`;
}

function table(headers: string[], rows: unknown[][]) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function markdownCell(value: unknown) {
  return String(value ?? "-").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function hedgeText(t: Row) {
  if (!t.hedgeActive) return "\u65e0";
  return `${side(t.hedgeSide)} ${num(t.hedgeShares, 2)} @ ${num(t.hedgeAvgPrice, 3)}`;
}

function positionText(value: unknown) {
  if (!value || typeof value !== "object") return "\u65e0";
  const position = value as Row;
  return `${side(position.side)} ${num(position.shares, 2)} \u4efd @ ${num(position.entryAvgPrice, 3)}`;
}

function regime(value: unknown) {
  const map: Record<string, string> = {
    uptrend: "\u4e0a\u884c\u987a\u98ce",
    downtrend: "\u4e0b\u884c\u987a\u98ce",
    up_reversal: "\u4e0a\u6da8\u8f6c\u5f31",
    down_reversal: "\u4e0b\u8dcc\u8f6c\u5f3a",
    chop: "\u9707\u8361",
    up: "\u4e0a\u884c",
    down: "\u4e0b\u884c",
    flat: "\u6a2a\u76d8"
  };
  if (typeof value === "object" && value) {
    const label = String((value as Row).label ?? "-");
    return map[label] ?? label;
  }
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function side(value: unknown) {
  if (value === "UP") return "UP";
  if (value === "DOWN") return "DOWN";
  return value == null ? "-" : String(value);
}

function shortTime(value: unknown) {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function bps(value: unknown) {
  return `${num(value, 2)} bps`;
}

function n(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function num(value: unknown, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function csvCell(value: unknown) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
