import express from "express";
import { createServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as crypto from "crypto";
import * as path from "path";
import { Duplex } from "stream";
import { Config, ServerConfig, updateConfig } from "./config";
import { loadAuditReport } from "./audit";
import { Hedge15mEngine } from "./bot";
import { getDecisionAuditFilePath, getLogFilePath } from "./instancePaths";
import { logger } from "./logger";
import * as fs from "fs";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.set("trust proxy", 1);
app.use(express.json());

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:");
  next();
});

app.use(express.static(path.join(__dirname, "../public")));

// --- Session ---
const SESSION_MAX_AGE = 86_400_000;
const MAX_SESSIONS = 10000;
const sessions = new Map<string, number>();

// --- Brute-force protection ---
const loginAttempts = new Map<string, { count: number; unlockedAt: number; firstAttemptAt: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (rec && now < rec.unlockedAt) return false;
  return true;
}

function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) {
    loginAttempts.set(ip, { count: 1, unlockedAt: 0, firstAttemptAt: now });
  } else if (rec.unlockedAt > 0 && now >= rec.unlockedAt) {
    loginAttempts.set(ip, { count: 1, unlockedAt: 0, firstAttemptAt: now });
  } else {
    rec.count++;
    if (rec.count >= MAX_LOGIN_ATTEMPTS) rec.unlockedAt = now + LOGIN_LOCKOUT_MS;
  }
}

function clearLoginRecord(ip: string): void {
  loginAttempts.delete(ip);
}

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}

function pruneLoginAttempts(): void {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if (rec.unlockedAt > 0 && now >= rec.unlockedAt) {
      loginAttempts.delete(ip);
    } else if (rec.unlockedAt === 0 && now - rec.firstAttemptAt > LOGIN_LOCKOUT_MS) {
      loginAttempts.delete(ip);
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const c: Record<string, string> = {};
  if (!header) return c;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) c[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return c;
}

function auth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = parseCookies(req.headers.cookie).session;
  const expiry = sessions.get(token);
  if (!token || expiry === undefined || Date.now() > expiry) {
    res.status(401).json({ error: "未授权" });
    return;
  }
  next();
}

// --- Bot ---
const bot = new Hedge15mEngine();

// --- Routes ---

app.post("/api/login", (req, res) => {
  const ip = (req.ip || req.socket.remoteAddress || "unknown");
  if (!checkLoginRateLimit(ip)) {
    res.status(429).json({ error: "登录尝试过多，请5分钟后重试" });
    return;
  }
  pruneLoginAttempts();
  const { password } = req.body;
  if (password === ServerConfig.ADMIN_PASSWORD) {
    clearLoginRecord(ip);
    const token = crypto.randomBytes(32).toString("hex");
    pruneExpiredSessions();
    pruneLoginAttempts();
    if (sessions.size >= MAX_SESSIONS) {
      res.status(503).json({ error: "会话数已满，请稍后重试" });
      return;
    }
    sessions.set(token, Date.now() + SESSION_MAX_AGE);
    const isSecure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
    res.cookie("session", token, { httpOnly: true, sameSite: "strict", secure: isSecure, maxAge: SESSION_MAX_AGE });
    res.json({ ok: true });
  } else {
    recordLoginFailure(ip);
    res.status(401).json({ error: "密码错误" });
  }
});

app.post("/api/logout", (req, res) => {
  sessions.delete(parseCookies(req.headers.cookie).session);
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/status", auth, (_req, res) => {
  res.json(bot.getState());
});

app.get("/api/audit", auth, (_req, res) => {
  res.json(loadAuditReport(bot.getHistoryFilePath()));
});

app.post("/api/start", auth, async (req, res) => {
  if (bot.running) {
    res.status(400).json({ error: "机器人已在运行" });
    return;
  }
  const { privateKey, funderAddress, mode, paperBalance, paperSessionMode,
    dumpConfirmCycles, entryWindowPreset, maxEntryAsk, dualSideMaxAsk, kellyFraction } = req.body;
  const tradingMode = mode === "paper" ? "paper" : "live";
  if (privateKey) updateConfig({ PRIVATE_KEY: privateKey });
  if (funderAddress) updateConfig({ FUNDER_ADDRESS: funderAddress });

  if (tradingMode === "live" && (!Config.PRIVATE_KEY || !Config.FUNDER_ADDRESS)) {
    res.status(400).json({ error: "缺少私钥或资金地址" });
    return;
  }
  try {
    await bot.start({
      mode: tradingMode,
      paperBalance: Number(paperBalance) > 0 ? Number(paperBalance) : undefined,
      paperSessionMode: paperSessionMode === "persistent" ? "persistent" : "session",
      dumpConfirmCycles: dumpConfirmCycles != null ? Number(dumpConfirmCycles) : undefined,
      entryWindowPreset: entryWindowPreset || undefined,
      maxEntryAsk: maxEntryAsk != null ? Number(maxEntryAsk) : undefined,
      dualSideMaxAsk: dualSideMaxAsk != null ? Number(dualSideMaxAsk) : undefined,
      kellyFraction: kellyFraction != null ? Number(kellyFraction) : undefined,
    });
    res.json({
      ok: true,
      balance: bot.getState().balance,
      mode: tradingMode,
      paperSessionMode: bot.getState().paperSessionMode,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/stop", auth, (_req, res) => {
  bot.stop();
  res.json({ ok: true });
});

app.get("/api/download-all", auth, (_req, res) => {
  const logPath = getLogFilePath();
  const historyPath = bot.getHistoryFilePath();
  const auditPath = getDecisionAuditFilePath();

  // ── History table ──
  let historyRows: Array<Record<string, unknown>> = [];
  try {
    const raw = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, "utf8")) : {};
    historyRows = Array.isArray(raw) ? raw : Array.isArray(raw.history) ? raw.history : [];
  } catch { /* empty */ }

  const hHeader = "| # | 时间 | 结果 | 方向 | 入场价 | 份数 | 成本 | 盈亏 | 累计 | 来源 | 趋势 | 剩余秒 | 退出理由 |";
  const hSep    = "|---|------|------|------|--------|------|------|------|------|------|------|--------|----------|";
  const hRows = historyRows.map((h: any, i: number) => {
    const price = h.leg1FillPrice > 0 ? h.leg1FillPrice : h.leg1Price || 0;
    const pf = h.profit >= 0 ? `+$${h.profit.toFixed(2)}` : `-$${Math.abs(h.profit).toFixed(2)}`;
    return `| ${i + 1} | ${h.time || ""} | ${h.result || ""} | ${h.leg1Dir || ""} | $${price.toFixed(2)} | ${(h.leg1Shares || 0).toFixed(0)} | $${(h.totalCost || 0).toFixed(2)} | ${pf} | $${(h.cumProfit || 0).toFixed(2)} | ${h.entrySource || "-"} | ${h.entryTrendBias || "-"} | ${h.entrySecondsLeft ?? "-"} | ${(h.exitReason || "-").replace(/\|/g, "/")} |`;
  });

  // ── Decision audit table ──
  let decisions: Array<Record<string, unknown>> = [];
  try {
    const raw = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "";
    decisions = raw.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
  } catch { /* empty */ }

  const dHeader = "| # | 时间 | 事件 | 详情 |";
  const dSep    = "|---|------|------|------|";
  const dRows = decisions.map((d: any, i: number) => {
    const { ts, event, ...rest } = d;
    const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ").replace(/\|/g, "/");
    return `| ${i + 1} | ${ts || ""} | ${event || ""} | ${detail.slice(0, 200)} |`;
  });

  // ── Logs (last 500 lines) ──
  let logLines = "";
  try {
    logLines = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").split("\n").slice(-500).join("\n") : "";
  } catch { /* empty */ }

  // ── Assemble Markdown ──
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const state = bot.getState();
  const summary = [
    `- 余额: $${state.balance.toFixed(2)}`,
    `- 总盈亏: $${state.totalProfit.toFixed(2)}`,
    `- 战绩: ${state.wins}W / ${state.losses}L / ${state.skips}S`,
    `- ROI: ${(state.sessionROI || 0).toFixed(1)}%`,
    `- 模式: ${state.tradingMode}`,
  ].join("\n");

  const md = [
    `# Vortex-15m 导出报告`,
    `> ${new Date().toISOString()}`,
    ``,
    `## 概要`,
    summary,
    ``,
    `## 交易历史 (${historyRows.length}条)`,
    hHeader,
    hSep,
    ...hRows,
    ``,
    `## 决策审计 (${decisions.length}条)`,
    dHeader,
    dSep,
    ...dRows,
    ``,
    `## 日志 (最近500行)`,
    "```",
    logLines,
    "```",
    ``,
  ].join("\n");

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="vortex-15m-report-${ts}.md"`);
  res.send(md);
});

app.get("/api/download-logs", auth, (_req, res) => {
  const logPath = getLogFilePath();
  if (!fs.existsSync(logPath)) {
    res.status(404).json({ error: "日志文件未找到" });
    return;
  }
  const raw = fs.readFileSync(logPath, "utf-8");
  const lines = raw.split("\n");
  const tail = lines.slice(-1000).join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(logPath)}"`);
  res.send(tail);
});

app.get("/api/download-history", auth, (_req, res) => {
  const historyPath = bot.getHistoryFilePath();
  if (!fs.existsSync(historyPath)) {
    res.status(404).json({ error: "历史文件未找到" });
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(historyPath)}"`);
  res.send(fs.readFileSync(historyPath, "utf8"));
});

app.get("/api/download-decision-audit", auth, (_req, res) => {
  const auditPath = getDecisionAuditFilePath();
  if (!fs.existsSync(auditPath)) {
    res.status(404).json({ error: "审计日志文件未找到" });
    return;
  }
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(auditPath)}"`);
  res.send(fs.readFileSync(auditPath, "utf8"));
});

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true, running: bot.running });
});

// --- WebSocket ---

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const token = parseCookies(req.headers.cookie).session;
  const expiry = sessions.get(token);
  if (!token || expiry === undefined || Date.now() > expiry) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Push state at a higher cadence so panel timers and latency ages feel near-real-time.
setInterval(() => {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify({ type: "state", data: bot.getState() });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}, 250);

// --- Start ---

export function startServer(): void {
  const port = ServerConfig.PORT;
  server.listen(port, () => {
    console.log(`15分钟对冲机器人面板: http://localhost:${port}`);
    logger.info(`Server started on port ${port}`);
  });
}
