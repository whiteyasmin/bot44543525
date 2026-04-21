import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { Bot } from "./bot.js";
import { clearLogs, ensureDataDir, fileInfo, paths, readRecentJsonl, readSettings, writeSettings } from "./store.js";
import { buildMarkdownReport, jsonlToCsv, recordEvent } from "./recorder.js";

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
app.get("/api/dashboard", async (_req, res) => {
  res.json({
    state: bot.getState(),
    settings: await readSettings(),
    recentTrades: await readRecentJsonl(paths.trades, 10),
    recentEvents: await readRecentJsonl(paths.events, 10)
  });
});
app.get("/api/settings", async (_req, res) => res.json(await readSettings()));
app.post("/api/settings", async (req, res) => {
  try {
    const current = await readSettings();
    const previousBalance = current.paperBalance;
    const next = { ...current, ...req.body, paperMode: true };
    await writeSettings(next);
    if (typeof req.body?.paperBalance === "number" && req.body.paperBalance !== previousBalance) {
      await bot.setPaperBalance(req.body.paperBalance);
    }
    await recordEvent("settings_updated", { keys: Object.keys(req.body ?? {}) });
    res.json(await readSettings());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
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
  if (name === "report.md") {
    res.attachment("btc-5m-report.md").type("text/markdown").send(await buildMarkdownReport());
    return;
  }
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
  zip.addFile("btc-5m-report.md", Buffer.from(await buildMarkdownReport(), "utf8"));
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
<header><h1>BTC 5分钟模拟盘</h1><div><button id="start">启动策略</button><button id="stop" class="secondary">暂停策略</button><button id="logout" class="ghost">退出</button></div></header>
<main>
  <section class="hero">
    <div id="statusCard"><label>策略状态</label><strong id="status">-</strong><span id="action">-</span></div>
    <div><label>BTC / 动量</label><strong id="btc">-</strong><span id="move">-</span></div>
    <div><label>当前市场</label><strong id="market">-</strong><span id="sec">-</span></div>
    <div><label>模拟资金</label><strong id="bal">-</strong><span id="pnl">-</span></div>
  </section>
  <section class="decision-panel"><h2>当前决策</h2><div id="decision">等待数据...</div></section>
  <section class="main-grid"><div><h2>UP 盘口</h2><div id="up" class="book">-</div></div><div><h2>DOWN 盘口</h2><div id="down" class="book">-</div></div><div><h2>当前仓位</h2><div id="pos" class="position">-</div></div></section>
  <section class="trade-grid"><div><h2>最近交易</h2><div id="trades" class="trades">暂无交易</div></div><div><h2>最近事件</h2><div id="events" class="events">暂无事件</div></div></section>
  <section><h2>你只需要填这里</h2><p class="hint">仓位、止盈、止损、入场阈值先交给我用日志回测后调整。你现在只填模拟余额。</p><form id="quickSettings" class="quick-settings single"></form><button id="saveQuick">保存余额</button></section>
  <section class="live-note"><h2>实盘</h2><p>当前版本只跑模拟盘，不会真实下单。钱包私钥和 Polymarket API 凭证不放 UI；以后接实盘时应放 Railway 环境变量，避免进入浏览器、日志和 Markdown 报告。</p></section>
  <details><summary>高级参数</summary><section><form id="advancedSettings" class="settings"></form><button id="saveAdvanced">保存全部参数</button></section></details>
  <section class="logs-panel"><h2>日志</h2><div id="logs" class="logs"></div><button id="clear" class="danger">清空日志</button></section>
</main>
<script>
const labels = {
 autoDiscoverMarket:'自动当前市场', manualMarketUrl:'手动市场 URL', entryStartSeconds:'入场开始秒', entryEndSeconds:'入场结束秒',
 minBtcMoveBps:'BTC 动量 bps', velocityLookbackSeconds:'速度回看秒', minBtcVelocityBps:'BTC 速度 bps', reversalExitBps:'反转退出 bps',
 maxEntryPrice:'最高买入价', maxPositionUsdc:'固定仓位 USDC', kellyEnabled:'启用 1/2 Kelly', kellyFraction:'Kelly 系数', kellyLookbackTrades:'Kelly 回看交易数', kellyMinTrades:'Kelly 最小样本', kellyFallbackPct:'样本不足仓位 %', kellyMaxPct:'Kelly 最大仓位 %', maxShares:'最大份额', depthUsageRatio:'使用盘口比例', goodSpreadCents:'好价差 cents', okSpreadCents:'可接受价差 cents', minDepthToKellyRatio:'最小深度/Kelly', thinDepthMultiplier:'薄盘口折扣', okDepthMultiplier:'一般盘口折扣', minOrderUsdc:'最小订单 USDC',
 maxEntrySlippageCents:'入场滑点 cents', maxExitSlippageCents:'退出滑点 cents', maxSpreadCents:'最大价差 cents', repriceIntervalMs:'刷新毫秒',
 takeProfitCents:'止盈 cents', stopLossCents:'止损 cents', maxHoldSeconds:'最长持仓秒', exitBeforeResolveSeconds:'结算前退出秒',
 panicHedgeEnabled:'启用 panic hedge', panicLossCents:'panic 亏损 cents', panicBtcReversalBps:'panic 反转 bps', minExitFillRatio:'最小退出成交率',
 hedgeSizeRatio:'对冲比例', maxHedgePrice:'最高对冲价', maxHedgeSlippageCents:'对冲滑点 cents', paperBalance:'模拟余额 USDC',
 feeBps:'手续费 bps', enableSnapshots:'记录快照', snapshotIntervalMs:'快照间隔毫秒', enableOrderbookLogs:'记录盘口', keepMaxLogMb:'最大日志 MB'
};
const quickFields = [
 ['paperBalance','number']
];
const advancedFields = [
 ['entryStartSeconds','number'],['entryEndSeconds','number'],['minBtcMoveBps','number'],['velocityLookbackSeconds','number'],['minBtcVelocityBps','number'],['reversalExitBps','number'],
 ['maxEntryPrice','number'],['kellyEnabled','checkbox'],['kellyFraction','number'],['kellyLookbackTrades','number'],['kellyMinTrades','number'],['kellyFallbackPct','number'],['kellyMaxPct','number'],['maxPositionUsdc','number'],['maxShares','number'],['depthUsageRatio','number'],['goodSpreadCents','number'],['okSpreadCents','number'],['minDepthToKellyRatio','number'],['thinDepthMultiplier','number'],['okDepthMultiplier','number'],['minOrderUsdc','number'],
 ['maxEntrySlippageCents','number'],['maxExitSlippageCents','number'],['maxSpreadCents','number'],['repriceIntervalMs','number'],
 ['takeProfitCents','number'],['stopLossCents','number'],['maxHoldSeconds','number'],['exitBeforeResolveSeconds','number'],
 ['panicHedgeEnabled','checkbox'],['panicLossCents','number'],['panicBtcReversalBps','number'],['minExitFillRatio','number'],['hedgeSizeRatio','number'],['maxHedgePrice','number'],['maxHedgeSlippageCents','number'],
 ['paperBalance','number'],['feeBps','number'],['enableSnapshots','checkbox'],['snapshotIntervalMs','number'],['enableOrderbookLogs','checkbox'],['keepMaxLogMb','number']
];
function fmt(n,d=2){return typeof n==='number'&&isFinite(n)?n.toFixed(d):'-'}
const actionMap={idle:'启动中',bot_disabled:'策略暂停',outside_entry_window:'等待入场窗口',no_signal:'等待信号',hold:'持仓中',one_trade_per_bucket:'本桶已交易',entry_skipped_no_ask:'无卖盘',entry_skipped_price:'价格过高',entry_skipped_spread:'价差过大',entry_skipped_depth:'深度不足',entry_unfilled:'入场未成交',hold_no_bid:'无买盘',panic_hedge_skipped_price:'对冲价格过高',panic_hedge_unfilled:'对冲未成交'};
function actionText(a){return actionMap[a]||a||'-'}
function bookHtml(b,t){if(!b)return '-';const rows=[];for(let i=0;i<5;i++){rows.push('<tr><td>'+(b.bids?.[i]?.price??'-')+'</td><td>'+(b.bids?.[i]?.size??'-')+'</td><td>'+(b.asks?.[i]?.price??'-')+'</td><td>'+(b.asks?.[i]?.size??'-')+'</td></tr>')}return '<div class="fresh">盘口 '+fresh(t)+'</div><div class="quote"><b>买一 '+(b.bids?.[0]?.price??'-')+'</b><b>卖一 '+(b.asks?.[0]?.price??'-')+'</b></div><table><thead><tr><th>买价</th><th>量</th><th>卖价</th><th>量</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
function posHtml(p){if(!p)return '<span class="muted">无仓位</span>';return '<div class="posline"><b>'+p.side+'</b><b>'+fmt(p.shares,2)+' 份</b></div><div>均价 '+fmt(p.entryAvgPrice,3)+' / 成本 '+fmt(p.entryCost,2)+'</div><div>状态 '+p.status+' / 入场第 '+p.entrySecond+' 秒</div>'+(p.hedgeSide?'<div>对冲 '+p.hedgeSide+' '+fmt(p.hedgeShares,2)+' 份 @ '+fmt(p.hedgeAvgPrice,3)+'</div>':'')}
function decisionHtml(d){if(!d)return '<span class="muted">等待决策</span>';const side=d.side?'<b>'+d.side+'</b> ':'';return '<div class="decision-head">'+side+d.reason+'</div><div class="fresh">检查 '+fresh(d.checkedAt)+' / 状态 '+d.status+'</div>'+detailList(d.details)}
function detailList(obj){if(!obj)return '';return '<div class="detail-grid">'+Object.entries(obj).slice(0,12).map(([k,v])=>'<div><span>'+k+'</span><b>'+valueText(v)+'</b></div>').join('')+'</div>'}
function valueText(v){if(v==null)return '-';if(typeof v==='number')return Number.isInteger(v)?String(v):fmt(v,4);if(typeof v==='object')return JSON.stringify(v).slice(0,80);return String(v)}
function renderForm(form, fields, s){form.innerHTML='';for(const [k,t] of fields){const wrap=document.createElement('label');wrap.textContent=labels[k]||k;const i=document.createElement('input');i.name=k;i.type=t;if(t==='checkbox')i.checked=!!s[k];else{i.value=s[k]??''; if(t==='number')i.step='any'}wrap.appendChild(i);form.appendChild(wrap)}}
async function loadSettings(){const s=await (await fetch('/api/settings')).json();renderForm(quickSettings,quickFields,s);renderForm(advancedSettings,advancedFields,s)}
function collect(form, fields){const body={};for(const [k,t] of fields){const el=form.elements[k];body[k]=t==='checkbox'?el.checked:(t==='number'?Number(el.value):el.value)}return body}
async function saveForm(form, fields){const r=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collect(form,fields))});if(!r.ok){alert((await r.json()).error||'保存失败')}await loadSettings();await loadDashboard()}
async function loadDashboard(){const d=await (await fetch('/api/dashboard')).json();const s=d.state, cfg=d.settings;status.textContent=s.lastError?'错误':(cfg.botEnabled?'策略运行':'策略暂停');statusCard.className=cfg.botEnabled?'on':'off';action.textContent=s.lastError||actionText(s.lastAction);btc.textContent=s.btc?fmt(s.btc.price,2):'-';move.textContent='动量 '+fmt(s.moveBps,2)+' bps / 速度 '+fmt(s.velocityBps,2)+' / '+(s.btc?.source||'无数据源');market.textContent=s.currentMarket?s.currentMarket.slug.replace('btc-updown-5m-',''):'-';sec.textContent='第 '+s.secondInBucket+' 秒 / 剩余 '+Math.max(0,300-s.secondInBucket)+' 秒 / '+fresh(s.bookUpdatedAt);bal.textContent=fmt(s.paperBalance,2)+' USDC';pnl.textContent='PnL '+fmt(s.realizedPnl,2);decision.innerHTML=decisionHtml(s.decision);up.innerHTML=bookHtml(s.upBook,s.bookUpdatedAt);down.innerHTML=bookHtml(s.downBook,s.bookUpdatedAt);pos.innerHTML=posHtml(s.position);trades.innerHTML=tradeRows(d.recentTrades);events.innerHTML=eventRows(d.recentEvents)}
function tradeRows(rows){if(!rows.length)return '<span class="muted">暂无交易</span>';return '<table><thead><tr><th>时间</th><th>方向</th><th>结果</th><th>PnL</th><th>原因</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+shortTime(r.exitTime||r.entryTime)+'</td><td>'+r.side+'</td><td>'+r.status+'</td><td>'+fmt(r.netPnl,2)+'</td><td>'+r.exitReason+'</td></tr>').join('')+'</tbody></table>'}
function eventRows(rows){if(!rows.length)return '<span class="muted">暂无事件</span>';return rows.slice(0,6).map(r=>'<div class="event"><b>'+shortTime(r.timestamp)+'</b> '+r.type+'</div>').join('')}
function shortTime(t){if(!t)return '-';const d=new Date(t);return isNaN(d.getTime())?String(t).slice(11,19):d.toLocaleTimeString('zh-CN',{hour12:false})}
function fresh(t){if(!t)return '未更新';const ms=Date.now()-new Date(t).getTime();if(!isFinite(ms))return '时间异常';return shortTime(t)+' / 延迟 '+Math.max(0,ms/1000).toFixed(1)+'s'}
async function loadLogs(){const l=await (await fetch('/api/logs')).json();logs.innerHTML='';const main=[['report.md','完整 MD'],['trades.csv','交易 CSV'],['snapshots.csv','快照 CSV'],['all.zip','全部 ZIP']];for(const [name,text] of main){const a=document.createElement('a');a.href='/api/logs/'+name;a.textContent=text;logs.appendChild(a)}const meta=document.createElement('span');meta.className='logmeta';meta.textContent='交易 '+size(l.trades.size)+' / 快照 '+size(l.snapshots.size)+' / 事件 '+size(l.events.size)+' / 盘口 '+size(l.orderbooks.size);logs.appendChild(meta)}
function size(n){if(!n)return '0';if(n>1048576)return fmt(n/1048576,1)+' MB';if(n>1024)return fmt(n/1024,1)+' KB';return n+' B'}
start.onclick=async()=>{action.textContent='启动请求已发送';await fetch('/api/bot/start',{method:'POST'});await loadDashboard()};stop.onclick=async()=>{action.textContent='暂停请求已发送';await fetch('/api/bot/stop',{method:'POST'});await loadDashboard()};logout.onclick=()=>fetch('/api/logout',{method:'POST'}).then(()=>location='/login');saveQuick.onclick=()=>saveForm(quickSettings,quickFields);saveAdvanced.onclick=()=>saveForm(advancedSettings,advancedFields);clear.onclick=()=>fetch('/api/logs/clear',{method:'POST'}).then(()=>{loadLogs();loadDashboard()});
loadSettings();loadDashboard();loadLogs();setInterval(loadDashboard,1000);setInterval(loadLogs,10000);
</script></body></html>`;
}

function css() {
  return `body{font-family:Inter,Arial,sans-serif;margin:0;background:#eef2f5;color:#172026}header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#101820;color:white;position:sticky;top:0;z-index:3}h1{font-size:17px;margin:0}h2{font-size:14px;margin:0 0 8px}button{border:0;background:#0f766e;color:white;padding:7px 11px;border-radius:6px;margin:2px;cursor:pointer}.secondary{background:#475569}.ghost{background:#1f2937}.danger{background:#b42318}main{padding:12px;max-width:1440px;margin:auto}section{background:white;border:1px solid #d8e0e7;border-radius:8px;padding:10px;margin-bottom:10px}.hero{display:grid;grid-template-columns:1.05fr 1.05fr 1.3fr .9fr;gap:8px}.hero div{background:#f8fafc;border:1px solid #dfe7ee;border-radius:7px;padding:8px;min-width:0}.hero .on{border-color:#0f766e;background:#ecfdf5}.hero .off{border-color:#cbd5e1;background:#f8fafc}.hero label,label{display:block;font-size:11px;color:#65727e;margin-bottom:3px}.hero strong{display:block;font-size:18px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hero span{display:block;font-size:12px;color:#465461;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.decision-panel{border-color:#b9d7ff;background:#f7fbff}.decision-head{font-size:15px;font-weight:700;margin-bottom:4px}.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin-top:8px}.detail-grid div{background:white;border:1px solid #dbeafe;border-radius:6px;padding:6px}.detail-grid span{display:block;color:#64748b;font-size:11px}.detail-grid b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.main-grid,.trade-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}.trade-grid{grid-template-columns:2fr 1fr}.book,.position,.trades,.events{font-size:12px}.fresh{font-size:11px;color:#64748b;margin-bottom:6px}.quote{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}.quote b,.posline b{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:6px;text-align:center}.book table,.trades table{width:100%;border-collapse:collapse;table-layout:fixed}.book th,.book td,.trades th,.trades td{padding:4px 5px;border-bottom:1px solid #edf2f7;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.book th,.trades th{font-size:11px;color:#64748b}.posline{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}.event{padding:4px 0;border-bottom:1px solid #edf2f7}.muted{color:#64748b}.hint{margin:0 0 8px;color:#64748b;font-size:12px}.quick-settings,.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.quick-settings.single{max-width:260px}.settings{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.quick-settings input,.settings input{width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid #cfd8e3;border-radius:6px}.quick-settings input[type=checkbox],.settings input[type=checkbox]{width:auto}.live-note{background:#fff8eb;border-color:#f1d9aa}.live-note p{margin:0;color:#6b4f16;font-size:13px;line-height:1.5}.logs-panel{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.logs-panel h2{margin:0 8px 0 0}.logs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.logs a{display:inline-block;background:#e7f5f2;color:#075e54;text-decoration:none;border-radius:6px;padding:7px 9px;font-size:13px}.logmeta{color:#64748b;font-size:12px;margin-left:4px}details{margin-bottom:12px}summary{cursor:pointer;background:white;border:1px solid #d8e0e7;border-radius:8px;padding:10px;font-weight:700}details section{border-top:0;border-top-left-radius:0;border-top-right-radius:0}.login{max-width:360px;margin:12vh auto;background:white;border:1px solid #d8e0e7;border-radius:8px;padding:24px}.login input{width:100%;box-sizing:border-box;margin-bottom:10px;padding:10px}@media(max-width:1000px){.hero,.main-grid{grid-template-columns:1fr 1fr}.main-grid>div:last-child{grid-column:1/-1}.trade-grid{grid-template-columns:1fr}}@media(max-width:640px){.hero,.main-grid{grid-template-columns:1fr}header{align-items:flex-start;gap:8px;flex-direction:column}}`;
}

await ensureDataDir();
await bot.start();
app.listen(port, () => {
  console.log(`BTC 5m bot listening on ${port}`);
});
