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
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><style>${css()}</style></head>
<body><main class="login"><h1>BTC 5分钟机器人</h1><form id="f"><input type="password" name="password" placeholder="管理员密码" autofocus><button>登录</button></form><p id="e"></p></main>
<script>f.onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:f.password.value})});if(r.ok) location='/'; else document.getElementById('e').textContent='登录失败';}</script></body></html>`;
}

function appHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC 5分钟机器人</title><style>${css()}</style></head>
<body>
<header><h1>BTC 5分钟 Polymarket 模拟盘</h1><div><button id="start">启动</button><button id="stop" class="secondary">停止</button><button id="logout" class="ghost">退出</button></div></header>
<main>
  <section class="hero">
    <div><label>状态</label><strong id="status">-</strong><span id="action">-</span></div>
    <div><label>BTC</label><strong id="btc">-</strong><span id="move">-</span></div>
    <div><label>市场</label><strong id="market">-</strong><span id="sec">-</span></div>
    <div><label>资金</label><strong id="bal">-</strong><span id="pnl">-</span></div>
  </section>
  <section class="books"><div><h2>UP 盘口</h2><div id="up" class="book">-</div></div><div><h2>DOWN 盘口</h2><div id="down" class="book">-</div></div><div><h2>当前仓位</h2><div id="pos" class="position">-</div></div></section>
  <section class="logs-panel"><h2>日志下载</h2><div id="logs" class="logs"></div><button id="clear" class="danger">清空日志</button></section>
  <details open><summary>策略参数</summary><section><form id="settings" class="settings"></form><button id="save">保存参数</button></section></details>
</main>
<script>
const labels = {
 botEnabled:'启用机器人', paperMode:'模拟盘模式', autoDiscoverMarket:'自动发现当前市场', manualMarketUrl:'手动市场 URL',
 entryStartSeconds:'允许入场开始秒', entryEndSeconds:'允许入场结束秒', minBtcMoveBps:'最小 BTC 动量 bps', velocityLookbackSeconds:'速度回看秒数', minBtcVelocityBps:'最小 BTC 速度 bps', reversalExitBps:'反转退出 bps',
 maxEntryPrice:'最高入场价格', minEdgeBps:'最小优势 bps', maxPositionUsdc:'最大仓位 USDC', maxShares:'最大份额', depthUsageRatio:'盘口深度使用比例', minOrderUsdc:'最小订单 USDC',
 maxEntrySlippageCents:'最大入场滑点 cents', maxExitSlippageCents:'最大退出滑点 cents', maxSpreadCents:'最大价差 cents', repriceIntervalMs:'刷新间隔毫秒',
 takeProfitCents:'止盈 cents', stopLossCents:'止损 cents', maxHoldSeconds:'最长持仓秒数', exitBeforeResolveSeconds:'结算前退出秒数',
 panicHedgeEnabled:'启用 Panic Hedge', panicLossCents:'Panic 亏损 cents', panicBtcReversalBps:'Panic BTC 反转 bps', minExitFillRatio:'最小退出成交比例', hedgeSizeRatio:'对冲比例', maxHedgePrice:'最高对冲价格', maxHedgeSlippageCents:'最大对冲滑点 cents',
 paperBalance:'模拟初始余额', feeBps:'手续费 bps', enableSnapshots:'记录快照', snapshotIntervalMs:'快照间隔毫秒', enableOrderbookLogs:'记录盘口日志', keepMaxLogMb:'最大日志 MB'
};
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
const actionMap={bot_disabled:'未启用',outside_entry_window:'等待入场窗口',no_signal:'无信号',hold:'持仓中',one_trade_per_bucket:'本桶已交易',entry_skipped_price:'价格过高',entry_skipped_spread:'价差过大',entry_skipped_depth:'深度不足',entry_unfilled:'入场未成交',hold_no_bid:'无买盘',panic_hedge_skipped_price:'对冲价格过高',panic_hedge_unfilled:'对冲未成交'};
function actionText(a){return actionMap[a]||a||'-'}
function bookHtml(b){if(!b)return '-';const rows=[];for(let i=0;i<5;i++){rows.push('<tr><td>'+(b.bids?.[i]?.price??'-')+'</td><td>'+(b.bids?.[i]?.size??'-')+'</td><td>'+(b.asks?.[i]?.price??'-')+'</td><td>'+(b.asks?.[i]?.size??'-')+'</td></tr>')}return '<div class="quote"><b>买一 '+(b.bids?.[0]?.price??'-')+'</b><b>卖一 '+(b.asks?.[0]?.price??'-')+'</b></div><table><thead><tr><th>买价</th><th>量</th><th>卖价</th><th>量</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
function posHtml(p){if(!p)return '<span class="muted">无仓位</span>';return '<div class="posline"><b>'+p.side+'</b><b>'+fmt(p.shares,2)+' 份</b></div><div>均价 '+fmt(p.entryAvgPrice,3)+' / 成本 '+fmt(p.entryCost,2)+'</div><div>状态 '+p.status+' / 入场第 '+p.entrySecond+' 秒</div>'+(p.hedgeSide?'<div>对冲 '+p.hedgeSide+' '+fmt(p.hedgeShares,2)+' 份 @ '+fmt(p.hedgeAvgPrice,3)+'</div>':'')}
async function loadSettings(){const s=await (await fetch('/api/settings')).json();settings.innerHTML='';for(const [k,t] of fields){const wrap=document.createElement('label');wrap.textContent=labels[k]||k;const i=document.createElement('input');i.name=k;i.type=t;if(t==='checkbox')i.checked=!!s[k];else{i.value=s[k]??''; if(t==='number')i.step='any'}wrap.appendChild(i);settings.appendChild(wrap)}}
async function saveSettings(){const body={};for(const [k,t] of fields){const el=settings.elements[k];body[k]=t==='checkbox'?el.checked:(t==='number'?Number(el.value):el.value)}await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await loadSettings()}
async function loadState(){const s=await (await fetch('/api/state')).json();status.textContent=s.lastError?'错误':(s.running?'运行中':'已停止');action.textContent=actionText(s.lastAction);btc.textContent=s.btc?fmt(s.btc.price,2):'-';move.textContent='动量 '+fmt(s.moveBps,2)+' bps / 速度 '+fmt(s.velocityBps,2);market.textContent=s.currentMarket?s.currentMarket.slug.replace('btc-updown-5m-',''):'-';sec.textContent='第 '+s.secondInBucket+' 秒';bal.textContent=fmt(s.paperBalance,2)+' USDC';pnl.textContent='PnL '+fmt(s.realizedPnl,2);up.innerHTML=bookHtml(s.upBook);down.innerHTML=bookHtml(s.downBook);pos.innerHTML=posHtml(s.position)}
async function loadLogs(){const l=await (await fetch('/api/logs')).json();logs.innerHTML='';const main=[['trades.csv','交易 CSV'],['snapshots.csv','快照 CSV'],['all.zip','全部 ZIP'],['settings.json','参数 JSON']];for(const [name,text] of main){const a=document.createElement('a');a.href='/api/logs/'+name;a.textContent=text;logs.appendChild(a)}const meta=document.createElement('span');meta.className='logmeta';meta.textContent='交易 '+size(l.trades.size)+' / 快照 '+size(l.snapshots.size)+' / 事件 '+size(l.events.size)+' / 盘口 '+size(l.orderbooks.size);logs.appendChild(meta)}
function size(n){if(!n)return '0';if(n>1048576)return fmt(n/1048576,1)+' MB';if(n>1024)return fmt(n/1024,1)+' KB';return n+' B'}
start.onclick=()=>fetch('/api/bot/start',{method:'POST'});stop.onclick=()=>fetch('/api/bot/stop',{method:'POST'});logout.onclick=()=>fetch('/api/logout',{method:'POST'}).then(()=>location='/login');save.onclick=saveSettings;clear.onclick=()=>fetch('/api/logs/clear',{method:'POST'}).then(loadLogs);
loadSettings();loadState();loadLogs();setInterval(loadState,1000);setInterval(loadLogs,10000);
</script></body></html>`;
}

function css() {
  return `body{font-family:Inter,Arial,sans-serif;margin:0;background:#eef2f5;color:#172026}header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#101820;color:white;position:sticky;top:0;z-index:3}h1{font-size:17px;margin:0}h2{font-size:14px;margin:0 0 8px}button{border:0;background:#0f766e;color:white;padding:7px 11px;border-radius:6px;margin:2px;cursor:pointer}.secondary{background:#475569}.ghost{background:#1f2937}.danger{background:#b42318}main{padding:12px;max-width:1440px;margin:auto}section{background:white;border:1px solid #d8e0e7;border-radius:8px;padding:10px;margin-bottom:10px}.hero{display:grid;grid-template-columns:1.05fr 1.05fr 1.3fr .9fr;gap:8px}.hero div{background:#f8fafc;border:1px solid #dfe7ee;border-radius:7px;padding:8px;min-width:0}.hero label,label{display:block;font-size:11px;color:#65727e;margin-bottom:3px}.hero strong{display:block;font-size:18px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hero span{display:block;font-size:12px;color:#465461;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.books{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}.book,.position{font-size:12px}.quote{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}.quote b,.posline b{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:6px;text-align:center}.book table{width:100%;border-collapse:collapse;table-layout:fixed}.book th,.book td{padding:4px 5px;border-bottom:1px solid #edf2f7;text-align:right;font-variant-numeric:tabular-nums}.book th{font-size:11px;color:#64748b}.posline{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}.muted{color:#64748b}.logs-panel{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.logs-panel h2{margin:0 8px 0 0}.logs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.logs a{display:inline-block;background:#e7f5f2;color:#075e54;text-decoration:none;border-radius:6px;padding:7px 9px;font-size:13px}.logmeta{color:#64748b;font-size:12px;margin-left:4px}details{margin-bottom:12px}summary{cursor:pointer;background:white;border:1px solid #d8e0e7;border-radius:8px;padding:10px;font-weight:700}details section{border-top:0;border-top-left-radius:0;border-top-right-radius:0}.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.settings input{width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid #cfd8e3;border-radius:6px}.settings input[type=checkbox]{width:auto}.login{max-width:360px;margin:12vh auto;background:white;border:1px solid #d8e0e7;border-radius:8px;padding:24px}.login input{width:100%;box-sizing:border-box;margin-bottom:10px;padding:10px}@media(max-width:900px){.hero,.books{grid-template-columns:1fr 1fr}.books>div:last-child{grid-column:1/-1}}@media(max-width:640px){.hero,.books{grid-template-columns:1fr}header{align-items:flex-start;gap:8px;flex-direction:column}}`;
}

await ensureDataDir();
await bot.start();
app.listen(port, () => {
  console.log(`BTC 5m bot listening on ${port}`);
});
