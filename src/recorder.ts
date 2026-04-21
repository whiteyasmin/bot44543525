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
  const [settings, state, trades, snapshots] = await Promise.all([
    readJson(paths.settings),
    readJson(paths.state),
    readJsonlObjects(paths.trades),
    readJsonlObjects(paths.snapshots)
  ]);
  const signalSnapshots = usefulSnapshots(snapshots);

  const lines: string[] = [
    "# BTC 5m 策略回测日志",
    "",
    `生成时间: ${generatedAt}`,
    "",
    "## 策略参数",
    "",
    table(
      ["参数", "值"],
      [
        ["入场窗口", `${num(settings.entryStartSeconds)}s - ${num(settings.entryEndSeconds)}s`],
        ["动量阈值", `${num(settings.minBtcMoveBps)} bps`],
        ["速度回看", `${num(settings.velocityLookbackSeconds)}s`],
        ["速度阈值", `${num(settings.minBtcVelocityBps)} bps`],
        ["最高买入价", num(settings.maxEntryPrice, 3)],
        ["最大价差", `${num(settings.maxSpreadCents)} cents`],
        ["Kelly 最大仓位", `${num(settings.kellyMaxPct)}%`],
        ["样本不足仓位", `${num(settings.kellyFallbackPct)}%`],
        ["盘口使用比例", `${num(n(settings.depthUsageRatio) * 100)}%`],
        ["panic 浮亏阈值", `${num(settings.panicLossCents)} cents`],
        ["对冲比例", `${num(n(settings.hedgeSizeRatio) * 100)}%`],
        ["最高对冲价", num(settings.maxHedgePrice, 3)],
        ["手续费", `${num(settings.feeBps)} bps`]
      ]
    ),
    "",
    "## 当前资金",
    "",
    table(
      ["项目", "值"],
      [
        ["模拟余额", num(state.paperBalance, 2)],
        ["已实现 PnL", num(state.realizedPnl, 2)],
        ["当前仓位", positionText(state.position)]
      ]
    ),
    "",
    "## 交易汇总",
    "",
    summaryTable(trades),
    "",
    "## 交易记录",
    "",
    trades.length ? tradeTable(trades) : "_暂无交易_",
    "",
    "## 信号快照",
    "",
    signalSnapshots.length ? snapshotTable(signalSnapshots) : "_暂无可回测快照_",
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

function summaryTable(trades: Row[]) {
  const pnl = trades.map((t) => n(t.netPnl)).filter(Number.isFinite);
  const wins = pnl.filter((v) => v > 0);
  const losses = pnl.filter((v) => v < 0);
  const total = sum(pnl);
  return table(
    ["指标", "值"],
    [
      ["交易数", String(trades.length)],
      ["胜率", pnl.length ? `${num(wins.length / pnl.length * 100)}%` : "-"],
      ["总 PnL", num(total, 2)],
      ["平均 PnL", pnl.length ? num(total / pnl.length, 2) : "-"],
      ["平均盈利", wins.length ? num(sum(wins) / wins.length, 2) : "-"],
      ["平均亏损", losses.length ? num(sum(losses) / losses.length, 2) : "-"],
      ["对冲次数", String(trades.filter((t) => Boolean(t.hedgeActive)).length)]
    ]
  );
}

function tradeTable(trades: Row[]) {
  return table(
    ["#", "入场", "方向", "入场秒", "剩余秒", "BTC入场", "动量", "速度", "指标", "买入价", "份额", "对冲", "结果", "PnL"],
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

function snapshotTable(snapshots: Row[]) {
  return table(
    ["时间", "局内秒", "剩余秒", "BTC", "动量", "速度", "指标", "信号", "UP卖一", "DOWN卖一", "目标仓位", "限制"],
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

function usefulSnapshots(rows: Row[]) {
  return rows
    .filter((r) => r.signalSide || r.positionSide || r.action !== "no_signal")
    .slice(-300);
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
  if (!t.hedgeActive) return "无";
  return `${side(t.hedgeSide)} ${num(t.hedgeShares, 2)} @ ${num(t.hedgeAvgPrice, 3)}`;
}

function positionText(value: unknown) {
  if (!value || typeof value !== "object") return "无";
  const position = value as Row;
  return `${side(position.side)} ${num(position.shares, 2)} 份 @ ${num(position.entryAvgPrice, 3)}`;
}

function regime(value: unknown) {
  const map: Record<string, string> = {
    uptrend: "上行顺风",
    downtrend: "下行顺风",
    up_reversal: "上涨转弱",
    down_reversal: "下跌转强",
    chop: "震荡",
    up: "上行",
    down: "下行",
    flat: "横盘"
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
