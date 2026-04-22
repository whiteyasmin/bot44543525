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

export async function recordShadowSignal(payload: Record<string, unknown>) {
  await appendJsonl(paths.shadowSignals, {
    timestamp: new Date().toISOString(),
    ...payload
  });
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
        ["时间风险参数", `最早 ${num(settings.entryStartSeconds)}s / 普通截止 ${num(settings.entryEndSeconds)}s`],
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

export async function buildShadowMarkdownReport() {
  const generatedAt = new Date().toISOString();
  const [settings, shadowSignals] = await Promise.all([
    readJson(paths.settings),
    readJsonlObjects(paths.shadowSignals)
  ]);
  const settled = dedupeShadowSignals(shadowSignals);
  const pending = dedupePendingShadowSignals(shadowSignals, settled);
  const lines: string[] = [
    "# BTC 5m \u5f71\u5b50\u4fe1\u53f7\u56de\u6d4b",
    "",
    `\u751f\u6210\u65f6\u95f4: ${generatedAt}`,
    "",
    "## \u5f53\u524d\u53c2\u6570",
    "",
    table(
      ["\u53c2\u6570", "\u503c"],
      [
        ["\u771f\u5b9e\u6700\u9ad8\u4e70\u5165\u4ef7", num(settings.maxEntryPrice, 3)],
        ["\u5f71\u5b50\u89c2\u5bdf\u6700\u9ad8\u4ef7", "0.900"],
        ["\u6700\u65e9\u8bc4\u4f30\u79d2", num(settings.entryStartSeconds, 0)],
        ["\u666e\u901a\u622a\u6b62\u79d2", num(settings.entryEndSeconds, 0)],
        ["BTC \u52a8\u91cf\u9608\u503c", `${num(settings.minBtcMoveBps)} bps`],
        ["\u901f\u5ea6\u56de\u770b", `${num(settings.velocityLookbackSeconds)}s`],
        ["BTC \u901f\u5ea6\u9608\u503c", `${num(settings.minBtcVelocityBps)} bps`],
        ["\u6700\u5927\u4ef7\u5dee", `${num(settings.maxSpreadCents)} cents`],
        ["\u6837\u672c\u4e0d\u8db3\u4ed3\u4f4d", `${num(settings.kellyFallbackPct)}%`],
        ["Kelly \u6700\u5927\u4ed3\u4f4d", `${num(settings.kellyMaxPct)}%`],
        ["\u76d8\u53e3\u4f7f\u7528\u6bd4\u4f8b", `${num(n(settings.depthUsageRatio) * 100)}%`]
      ]
    ),
    "",
    "## \u5f71\u5b50\u6c47\u603b",
    "",
    shadowSummaryTable(settled),
    "",
    "## \u5df2\u7ed3\u7b97\u5f71\u5b50\u4fe1\u53f7",
    "",
    settled.length ? shadowTable(settled) : "_\u6682\u65e0\u5df2\u7ed3\u7b97\u5f71\u5b50\u4fe1\u53f7_",
    "",
    "## \u672a\u7ed3\u7b97\u5f71\u5b50\u4fe1\u53f7",
    "",
    pending.length ? pendingShadowTable(pending) : "_\u6682\u65e0\u672a\u7ed3\u7b97\u5f71\u5b50\u4fe1\u53f7_",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function dedupeShadowSignals(rows: Row[]) {
  const settled = rows.filter((row) => row.type === "shadow_settled");
  const seen = new Set<string>();
  return settled.filter((row, index) => {
    const key = String(row.shadowId ?? index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupePendingShadowSignals(rows: Row[], settledRows: Row[]) {
  const settledIds = new Set(settledRows.map((row) => String(row.shadowId)));
  const seen = new Set<string>();
  return rows.filter((row, index) => {
    if (row.type !== "shadow_signal") return false;
    const key = String(row.shadowId ?? index);
    if (settledIds.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    ["#", "\u5165\u573a", "\u65b9\u5411", "\u5165\u573a\u79d2", "\u5269\u4f59\u79d2", "BTC\u5165\u573a", "\u52a8\u91cf", "\u901f\u5ea6", "\u538b\u529b", "\u8d8b\u52bf\u538b\u529b", "\u9519\u4ef7\u538b\u529b", "\u53cd\u8f6c\u98ce\u9669", "\u6307\u6807", "\u7b56\u7565", "\u5206\u5c42", "\u4e70\u5165\u4ef7", "\u4efd\u989d", "\u5bf9\u51b2", "\u7ed3\u679c", "PnL"],
    trades.map((t, index) => [
      String(index + 1),
      shortTime(t.entryTime),
      side(t.side),
      num(t.entrySecond, 0),
      num(t.secondsLeft, 0),
      num(t.btcEntry ?? t.btcOpen, 2),
      bps(t.entryMoveBps),
      bps(t.entryVelocityBps),
      num(t.entryPressureScore, 2),
      num(t.entryTrendPressure, 2),
      num(t.entryMispricePressure, 2),
      num(t.entryReversalRisk, 2),
      regime(t.btcRegimeAtEntry ?? t.trendAtEntry),
      strategy(t.entryStrategyType),
      tier(t.entrySignalTier),
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
        event.type === "entry_filled" ? `${strategy((event.entrySignal as Row | undefined)?.strategyType)} / ${tier((event.entrySignal as Row | undefined)?.tier)} / ${sizingText(event.sizing)}` : "\u89e6\u53d1 panic hedge"
      ];
    })
  );
}

function shadowTable(rows: Row[]) {
  return table(
    ["#", "\u65f6\u95f4", "\u5c40\u5185\u79d2", "\u5269\u4f59\u79d2", "\u65b9\u5411", "\u7c7b\u578b", "\u4ef7\u683c", "\u4ef7\u683c\u6bb5", "\u8d85\u5b9e\u76d8\u4e0a\u9650", "\u4f1a\u5b9e\u76d8\u4e0b\u5355", "\u6a21\u62df\u91d1\u989d", "\u6a21\u62df\u4efd\u989d", "\u9650\u5236", "BTC\u5165\u573a", "\u52a8\u91cf", "\u901f\u5ea6", "\u8d8b\u52bf\u538b\u529b", "\u9519\u4ef7\u538b\u529b", "\u53cd\u8f6c", "\u7ed3\u679c", "PnL"],
    rows.slice(-200).map((row, index) => [
      String(index + 1),
      shortTime(row.entryTime),
      num(row.secondInBucket, 0),
      num(row.secondsLeft, 0),
      side(row.side),
      shadowKind(row.kind),
      num(row.ask, 3),
      observationBand(row.observationBand),
      row.overRealMaxEntry ? "\u662f" : "\u5426",
      row.shadowWouldTrade ? "\u662f" : "\u5426",
      num(row.shadowTargetUsdc, 2),
      num(row.shadowShares, 2),
      String(row.shadowLimitedBy ?? "-"),
      num(row.btcEntry, 2),
      bps(row.moveBps),
      bps(row.velocityBps),
      num(row.trendPressure, 2),
      num(row.mispricePressure, 2),
      num(row.reversalRisk, 2),
      side(row.resolvedWinner),
      num(row.netPnl, 3)
    ])
  );
}

function pendingShadowTable(rows: Row[]) {
  return table(
    ["#", "\u65f6\u95f4", "\u5c40\u5185\u79d2", "\u5269\u4f59\u79d2", "\u65b9\u5411", "\u7c7b\u578b", "\u4ef7\u683c", "\u4ef7\u683c\u6bb5", "\u4f1a\u5b9e\u76d8\u4e0b\u5355", "\u6a21\u62df\u91d1\u989d", "\u9650\u5236", "\u52a8\u91cf", "\u901f\u5ea6", "\u53c2\u6570"],
    rows.slice(-120).map((row, index) => [
      String(index + 1),
      shortTime(row.entryTime),
      num(row.secondInBucket, 0),
      num(row.secondsLeft, 0),
      side(row.side),
      shadowKind(row.kind),
      num(row.ask, 3),
      observationBand(row.observationBand),
      row.shadowWouldTrade ? "\u662f" : "\u5426",
      num(row.shadowTargetUsdc, 2),
      String(row.shadowLimitedBy ?? "-"),
      bps(row.moveBps),
      bps(row.velocityBps),
      shadowParams(row)
    ])
  );
}

function shadowSummaryTable(rows: Row[]) {
  const pnl = rows.map((row) => n(row.netPnl)).filter(Number.isFinite);
  const wins = pnl.filter((value) => value > 0);
  const overMax = rows.filter((row) => row.overRealMaxEntry);
  const wouldTrade = rows.filter((row) => row.shadowWouldTrade);
  return table(
    ["\u6307\u6807", "\u503c"],
    [
      ["\u5df2\u7ed3\u7b97\u5f71\u5b50\u6570", String(rows.length)],
      ["\u80dc\u7387", pnl.length ? `${num(wins.length / pnl.length * 100)}%` : "-"],
      ["\u5355\u4efd\u603b PnL", num(sum(pnl), 3)],
      ["\u5e73\u5747\u5355\u4efd PnL", pnl.length ? num(sum(pnl) / pnl.length, 3) : "-"],
      ["\u8d85\u5b9e\u76d8\u4e0a\u9650\u6570", String(overMax.length)],
      ["\u6309\u5f53\u524d\u5b9e\u76d8\u89c4\u5219\u4f1a\u4e0b\u5355", String(wouldTrade.length)]
    ]
  );
}

function snapshotTable(snapshots: Row[]) {
  return table(
    ["\u65f6\u95f4", "\u5c40\u5185\u79d2", "\u5269\u4f59\u79d2", "BTC", "\u52a8\u91cf", "\u901f\u5ea6", "\u6307\u6807", "\u4fe1\u53f7", "\u52a8\u4f5c", "\u539f\u56e0", "UP\u5356\u4e00", "DOWN\u5356\u4e00", "\u76ee\u6807\u4ed3\u4f4d", "\u9650\u5236"],
    snapshots.map((s) => [
      shortTime(s.timestamp),
      num(s.secondInBucket, 0),
      num(s.secondsLeft, 0),
      num(s.btcPrice, 2),
      bps(s.moveBps),
      bps(s.velocityBps),
      regime(s.btcRegime ?? s.regimeLabel ?? s.trendAtEntry),
      side(s.signalSide),
      action(s.action),
      decisionReason(s.decisionReason),
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

function tier(value: unknown) {
  const map: Record<string, string> = {
    cheap_confirmed: "\u4f4e\u4ef7\u786e\u8ba4",
    cheap_probe: "\u4f4e\u4ef7\u8bd5\u4ed3",
    cheap_velocity_probe: "\u4f4e\u4ef7\u901f\u5ea6\u8bd5\u4ed3",
    hard_misprice: "\u786c\u9519\u4ef7",
    supported_misprice: "\u538b\u529b\u652f\u6301\u9519\u4ef7",
    standard: "\u6807\u51c6",
    strong_chase: "\u5f3a\u52bf\u8ffd\u5355",
    trend_standard: "\u6807\u51c6\u8d8b\u52bf",
    trend_strong_chase: "\u5f3a\u8d8b\u52bf\u8ffd\u5355",
    reverse_favorite: "\u53cd\u5411\u7a33\u8fb9"
  };
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function strategy(value: unknown) {
  const map: Record<string, string> = {
    trend_entry: "\u8d8b\u52bf\u5165\u573a",
    misprice_entry: "\u9519\u4ef7\u5165\u573a",
    reverse_favorite_entry: "\u53cd\u5411\u8d4c\u8d62"
  };
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function shadowKind(value: unknown) {
  const map: Record<string, string> = {
    strategy_signal: "\u7b56\u7565\u4fe1\u53f7",
    cheap_up: "UP \u4f4e\u4ef7",
    cheap_down: "DOWN \u4f4e\u4ef7",
    balanced_up: "UP \u5747\u8861\u4ef7",
    balanced_down: "DOWN \u5747\u8861\u4ef7",
    tailwind_up: "UP \u987a\u98ce",
    tailwind_down: "DOWN \u987a\u98ce",
    tailwind_chase_up: "UP \u9ad8\u4ef7\u987a\u98ce",
    tailwind_chase_down: "DOWN \u9ad8\u4ef7\u987a\u98ce",
    reversal_watch: "\u53cd\u8f6c\u89c2\u5bdf"
  };
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function observationBand(value: unknown) {
  const map: Record<string, string> = {
    deep_cheap: "\u6781\u4f4e\u4ef7",
    cheap: "\u4f4e\u4ef7",
    balanced: "\u5747\u8861",
    tailwind_standard: "\u987a\u98ce\u5e38\u89c4",
    real_max_area: "\u5b9e\u76d8\u4e0a\u9650\u5185",
    above_real_max: "\u8d85\u5b9e\u76d8\u4e0a\u9650",
    extreme_chase: "\u6781\u7aef\u8ffd\u9ad8"
  };
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function shadowParams(row: Row) {
  return `M${num(row.paramMinBtcMoveBps)}/V${num(row.paramMinBtcVelocityBps)}/T${num(row.paramEntryStartSeconds, 0)}-${num(row.paramEntryEndSeconds, 0)}/Max${num(row.paramMaxEntryPrice, 2)}`;
}

function action(value: unknown) {
  const map: Record<string, string> = {
    idle: "\u542f\u52a8\u4e2d",
    bot_disabled: "\u7b56\u7565\u6682\u505c",
    outside_entry_window: "\u7b49\u5f85\u5165\u573a\u7a97\u53e3",
    waiting_next_market_after_start: "\u5c40\u4e2d\u542f\u52a8\uff0c\u7b49\u4e0b\u4e00\u5c40",
    no_signal: "\u7b49\u5f85\u4fe1\u53f7",
    hold: "\u6301\u4ed3\u4e2d",
    hold_hedged: "\u5df2\u5bf9\u51b2\u6301\u6709",
    one_trade_per_bucket: "\u672c\u5c40\u5df2\u4ea4\u6613",
    entry_skipped_no_ask: "\u65e0\u5356\u76d8",
    entry_skipped_price: "\u4ef7\u683c\u8fc7\u9ad8",
    entry_skipped_spread: "\u4ef7\u5dee\u8fc7\u5927",
    entry_skipped_depth: "\u6df1\u5ea6\u4e0d\u8db3",
    entry_unfilled: "\u5165\u573a\u672a\u6210\u4ea4",
    panic_hedge_skipped_price: "\u5bf9\u51b2\u4ef7\u683c\u8fc7\u9ad8",
    panic_hedge_unfilled: "\u5bf9\u51b2\u672a\u6210\u4ea4"
  };
  const text = String(value ?? "-");
  return map[text] ?? text;
}

function decisionReason(value: unknown) {
  const map: Record<string, string> = {
    "\u7b56\u7565\u5df2\u6682\u505c\uff0c\u542f\u52a8\u540e\u624d\u4f1a\u51b3\u7b56": "\u7b56\u7565\u6682\u505c",
    "\u6b63\u5728\u68c0\u67e5\u5165\u573a\u548c\u6301\u4ed3\u6761\u4ef6": "\u68c0\u67e5\u4e2d",
    "\u5c40\u4e2d\u542f\u52a8\uff0c\u7b49\u5f85\u4e0b\u4e00\u5c40\u518d\u5165\u573a": "\u5c40\u4e2d\u542f\u52a8\u7b49\u4e0b\u4e00\u5c40",
    "\u52a8\u91cf\u3001\u901f\u5ea6\u3001\u65f6\u95f4\u7ec4\u5408\u672a\u6ee1\u8db3": "\u4fe1\u53f7\u4e0d\u591f",
    "\u5f53\u524d 5 \u5206\u949f\u5e02\u573a\u5df2\u4ea4\u6613\uff0c\u7b49\u5f85\u4e0b\u4e00\u5c40": "\u672c\u5c40\u5df2\u4ea4\u6613"
  };
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
