import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { Bot } from "./bot.js";
import { clearLogs, ensureDataDir, fileInfo, paths, readSettings, writeSettings } from "./store.js";
import { jsonlToCsv, recordEvent } from "./recorder.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const adminPassword = process.env.ADMIN_PASSWORD;
const sessions = new Set<string>();
const bot = new Bot();

if (!adminPassword) {
  console.warn("ADMIN_PASSWORD is not set. Login will be disabled until it is configured.");
}

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/login", (_req, res) => res.type("html").send(loginHtml()));
app.post("/api/login", (req, res) => {
  if (!adminPassword) return res.status(500).json({ error: "ADMIN_PASSWORD is not configured" });
  if (req.body?.password !== adminPassword) return res.status(401).json({ error: "Invalid password" });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);
  res.cookie("session", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 86400_000 });
  res.json({ ok: true });
});
app.post("/api/logout", auth, (req, res) => {
  sessions.delete(req.cookies.session);
  res.clearCookie("session");
  res.json({ ok: true });
});

app.use(auth);

app.get("/", (_req, res) => res.type("html").send(appHtml()));
app.get("/api/state", (_req, res) => res.json(bot.getState()));
app.get("/api/settings", async (_req, res) => res.json(await readSettings()));
app.post("/api/settings", async (req, res) => {
  const current = await readSettings();
  await writeSettings({ ...current, ...req.body, paperMode: true });
  await recordEvent("settings_updated", { keys: Object.keys(req.body ?? {}) });
  res.json(await readSettings());
});
app.post("/api/bot/start", async (_req, res) => {
  const settings = await readSettings();
  await writeSettings({ ...settings, botEnabled: true });
  res.json({ ok: true });
});
app.post("/api/bot/stop", async (_req, res) => {
  const settings = await readSettings();
  await writeSettings({ ...settings, botEnabled: false });
  res.json({ ok: true });
});

app.get("/api/logs", async (_req, res) => {
  res.json({
    trades: await fileInfo(paths.trades),
    snapshots: await fileInfo(paths.snapshots),
    events: await fileInfo(paths.events),
    orderbooks: await fileInfo(paths.orderbooks),
    settings: await fileInfo(paths.settings)
  });
});

app.get("/api/logs/:name", async (req, res) => {
  const name = req.params.name;
  if (name === "all.zip") return sendZip(res);
  if (name.endsWith(".csv")) {
    const jsonl = logPath(name.replace(".csv", ".jsonl"));
    if (!jsonl) return res.status(404).send("not found");
    res.attachment(name).type("text/csv").send(await jsonlToCsv(jsonl));
    return;
  }
  const file = logPath(name);
  if (!file || !existsSync(file)) return res.status(404).send("not found");
  res.download(file, name);
});

app.post("/api/logs/clear", async (_req, res) => {
  await clearLogs();
  await recordEvent("logs_cleared");
  res.json({ ok: true });
});

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!adminPassword) return res.redirect("/login");
  const token = req.cookies.session;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.redirect("/login");
}

function logPath(name: string) {
  const map: Record<string, string> = {
    "trades.jsonl": paths.trades,
    "snapshots.jsonl": paths.snapshots,
    "events.jsonl": paths.events,
    "orderbooks.jsonl": paths.orderbooks,
    "settings.json": paths.settings,
    "paper-state.json": paths.state
  };
  return map[name] ?? null;
}

async function sendZip(res: express.Response) {
  const zip = new AdmZip();
  for (const [name, file] of Object.entries({
    "trades.jsonl": paths.trades,
    "snapshots.jsonl": paths.snapshots,
    "events.jsonl": paths.events,
    "orderbooks.jsonl": paths.orderbooks,
    "settings.json": paths.settings,
    "paper-state.json": paths.state
  })) {
    if (existsSync(file)) zip.addLocalFile(file, "", name);
  }
  const tmp = path.join(paths.dataDir, "logs.zip");
  await fs.writeFile(tmp, zip.toBuffer());
  res.download(tmp, "logs.zip");
}

function loginHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><style>${css()}</style></head>
<body><main class="login"><h1>BTC 5m Bot</h1><form id="f"><input type="password" name="password" placeholder="Admin password" autofocus><button>Login</button></form><p id="e"></p></main>
<script>f.onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:f.password.value})});if(r.ok) location='/'; else document.getElementById('e').textContent='Login failed';}</script></body></html>`;
}

function appHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC 5m Bot</title><style>${css()}</style></head>
<body>
<header><h1>BTC 5m Polymarket Bot</h1><div><button id="start">Start</button><button id="stop">Stop</button><button id="logout">Logout</button></div></header>
<main>
  <section class="grid">
    <div><label>Status</label><strong id="status">-</strong></div><div><label>Action</label><strong id="action">-</strong></div><div><label>BTC</label><strong id="btc">-</strong></div><div><label>Move</label><strong id="move">-</strong></div>
    <div><label>Market</label><strong id="market">-</strong></div><div><label>Second</label><strong id="sec">-</strong></div><div><label>Balance</label><strong id="bal">-</strong></div><div><label>PnL</label><strong id="pnl">-</strong></div>
  </section>
  <section class="books"><div><h2>UP</h2><pre id="up">-</pre></div><div><h2>DOWN</h2><pre id="down">-</pre></div><div><h2>Position</h2><pre id="pos">-</pre></div></section>
  <section><h2>Settings</h2><form id="settings" class="settings"></form><button id="save">Save Settings</button></section>
  <section><h2>Logs</h2><div id="logs" class="logs"></div><button id="clear">Clear Logs</button></section>
</main>
<script>
const fields = [
 ['botEnabled','checkbox'],['paperMode','checkbox'],['autoDiscoverMarket','checkbox'],['manualMarketUrl','text'],
 ['entryStartSeconds','number'],['entryEndSeconds','number'],['minBtcMoveBps','number'],['velocityLookbackSeconds','number'],['minBtcVelocityBps','number'],['reversalExitBps','number'],
 ['maxEntryPrice','number'],['minEdgeBps','number'],['maxPositionUsdc','number'],['maxShares','number'],['depthUsageRatio','number'],['minOrderUsdc','number'],
 ['maxEntrySlippageCents','number'],['maxExitSlippageCents','number'],['maxSpreadCents','number'],['repriceIntervalMs','number'],
 ['takeProfitCents','number'],['stopLossCents','number'],['maxHoldSeconds','number'],['exitBeforeResolveSeconds','number'],
 ['panicHedgeEnabled','checkbox'],['panicLossCents','number'],['panicBtcReversalBps','number'],['minExitFillRatio','number'],['hedgeSizeRatio','number'],['maxHedgePrice','number'],['maxHedgeSlippageCents','number'],
 ['paperBalance','number'],['feeBps','number'],['enableSnapshots','checkbox'],['snapshotIntervalMs','number'],['enableOrderbookLogs','checkbox'],['keepMaxLogMb','number']
];
function fmt(n,d=2){return typeof n==='number'&&isFinite(n)?n.toFixed(d):'-'}
function book(b){if(!b)return '-';return 'bid '+(b.bids?.[0]?.price??'-')+' / ask '+(b.asks?.[0]?.price??'-')+'\\n'+JSON.stringify({bids:b.bids?.slice(0,5),asks:b.asks?.slice(0,5)},null,2)}
async function loadSettings(){const s=await (await fetch('/api/settings')).json();settings.innerHTML='';for(const [k,t] of fields){const wrap=document.createElement('label');wrap.textContent=k;const i=document.createElement('input');i.name=k;i.type=t;if(t==='checkbox')i.checked=!!s[k];else{i.value=s[k]??''; if(t==='number')i.step='any'}wrap.appendChild(i);settings.appendChild(wrap)}}
async function saveSettings(){const body={};for(const [k,t] of fields){const el=settings.elements[k];body[k]=t==='checkbox'?el.checked:(t==='number'?Number(el.value):el.value)}await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await loadSettings()}
async function loadState(){const s=await (await fetch('/api/state')).json();status.textContent=s.lastError?'ERROR':(s.running?'running':'stopped');action.textContent=s.lastAction;btc.textContent=s.btc?fmt(s.btc.price,2):'-';move.textContent=fmt(s.moveBps,2)+' bps / v '+fmt(s.velocityBps,2);market.textContent=s.currentMarket?s.currentMarket.slug:'-';sec.textContent=s.secondInBucket;bal.textContent=fmt(s.paperBalance,2);pnl.textContent=fmt(s.realizedPnl,2);up.textContent=book(s.upBook);down.textContent=book(s.downBook);pos.textContent=JSON.stringify(s.position,null,2)}
async function loadLogs(){const l=await (await fetch('/api/logs')).json();logs.innerHTML='';for(const name of ['trades.jsonl','trades.csv','snapshots.jsonl','snapshots.csv','events.jsonl','orderbooks.jsonl','settings.json','paper-state.json','all.zip']){const a=document.createElement('a');a.href='/api/logs/'+name;a.textContent=name;logs.appendChild(a)}const pre=document.createElement('pre');pre.textContent=JSON.stringify(l,null,2);logs.appendChild(pre)}
start.onclick=()=>fetch('/api/bot/start',{method:'POST'});stop.onclick=()=>fetch('/api/bot/stop',{method:'POST'});logout.onclick=()=>fetch('/api/logout',{method:'POST'}).then(()=>location='/login');save.onclick=saveSettings;clear.onclick=()=>fetch('/api/logs/clear',{method:'POST'}).then(loadLogs);
loadSettings();loadState();loadLogs();setInterval(loadState,1000);setInterval(loadLogs,10000);
</script></body></html>`;
}

function css() {
  return `body{font-family:Inter,Arial,sans-serif;margin:0;background:#f5f7f9;color:#1a1f24}header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#101820;color:white}button{border:0;background:#0f766e;color:white;padding:9px 13px;border-radius:6px;margin:4px;cursor:pointer}main{padding:20px;max-width:1320px;margin:auto}section{background:white;border:1px solid #d8e0e7;border-radius:8px;padding:16px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.grid div{border:1px solid #e1e7ed;border-radius:6px;padding:12px}label{display:block;font-size:12px;color:#5c6975;margin-bottom:5px}strong{font-size:18px}.books{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.settings input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cfd8e3;border-radius:6px}.settings input[type=checkbox]{width:auto}.logs a{display:inline-block;margin:4px 8px 4px 0}.login{max-width:360px;margin:12vh auto;background:white;border:1px solid #d8e0e7;border-radius:8px;padding:24px}.login input{width:100%;box-sizing:border-box;margin-bottom:10px;padding:10px}pre{white-space:pre-wrap;overflow:auto;background:#f1f4f7;padding:10px;border-radius:6px}`;
}

await ensureDataDir();
await bot.start();
app.listen(port, () => {
  console.log(`BTC 5m bot listening on ${port}`);
});
