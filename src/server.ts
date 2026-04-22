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
  if (!adminPassword) return res.status(500).json({ error: "ADMIN_PASSWORD 未配置" });
  if (req.body?.password !== adminPassword) return res.status(401).json({ error: "密码错误" });
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
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "未登录" });
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
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC 5分钟机器人</title><style>${css()}</style><style>.param-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.param-grid>div{border:1px solid #e2e8f0;border-radius:7px;padding:8px;background:#f8fafc}.param-grid h3{font-size:13px;margin:0 0 8px}.settings.compact{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}.settings.compact input{padding:5px 6px}@media(max-width:1000px){.param-grid{grid-template-columns:1fr 1fr}}@media(max-width:640px){.param-grid{grid-template-columns:1fr}}</style></head>
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
  <section><h2>你只需要填这里</h2><p class="hint">仓位、入场阈值、对冲阈值先交给我用日志回测后调整。你现在只填模拟余额。</p><form id="quickSettings" class="quick-settings single"></form><button id="saveQuick">保存余额</button></section>
  <section class="live-note"><h2>实盘</h2><p>当前版本只跑模拟盘，不会真实下单。钱包私钥和 Polymarket API 凭证不放 UI；以后接实盘时应放 Railway 环境变量，避免进入浏览器、日志和 Markdown 报告。</p></section>
  <section class="param-panel"><h2>策略参数</h2><div class="param-grid">
    <div><h3>基础</h3><form id="baseSettings" class="settings compact"></form><button id="saveBase">保存基础</button></div>
    <div><h3>趋势 / 错价</h3><form id="trendSettings" class="settings compact"></form><button id="saveTrend">保存信号</button></div>
    <div><h3>仓位</h3><form id="sizingSettings" class="settings compact"></form><button id="saveSizing">保存仓位</button></div>
    <div><h3>对冲</h3><form id="hedgeSettings" class="settings compact"></form><button id="saveHedge">保存对冲</button></div>
  </div></section>
  <details><summary>高级参数</summary><section><form id="advancedSettings" class="settings"></form><button id="saveAdvanced">保存高级</button></section></details>
  <section class="logs-panel"><h2>日志</h2><div id="logs" class="logs"></div><button id="clear" class="danger">清空日志</button></section>
</main>
<script>
const labels = {
 autoDiscoverMarket:'自动当前市场', manualMarketUrl:'手动市场 URL', entryStartSeconds:'最早评估秒', entryEndSeconds:'普通截止秒',
 minBtcMoveBps:'BTC 动量 bps', velocityLookbackSeconds:'速度回看秒', minBtcVelocityBps:'BTC 速度 bps',
 maxEntryPrice:'最高买入价', maxPositionUsdc:'固定仓位 USDC', kellyEnabled:'启用 1/2 Kelly', kellyFraction:'Kelly 系数', kellyLookbackTrades:'Kelly 回看交易数', kellyMinTrades:'Kelly 最小样本', kellyFallbackPct:'样本不足仓位 %', kellyMaxPct:'Kelly 最大仓位 %', maxShares:'最大份额', depthUsageRatio:'使用盘口比例', goodSpreadCents:'好价差 cents', okSpreadCents:'可接受价差 cents', minDepthToKellyRatio:'最小深度/Kelly', thinDepthMultiplier:'薄盘口折扣', okDepthMultiplier:'一般盘口折扣', minOrderUsdc:'最小订单 USDC',
 maxEntrySlippageCents:'入场滑点 cents', maxSpreadCents:'最大价差 cents', repriceIntervalMs:'刷新毫秒',
 panicHedgeEnabled:'启用 panic hedge', panicLossCents:'panic 亏损 cents',
  hedgeSizeRatio:'最大对冲比例', minHedgeImprovementPct:'最小对冲改善 %', maxHedgePrice:'最高对冲价', maxHedgeSlippageCents:'对冲滑点 cents', paperBalance:'模拟余额 USDC',
  feeBps:'额外费用缓冲 bps', enableSnapshots:'记录快照', snapshotIntervalMs:'快照间隔毫秒', enableOrderbookLogs:'记录盘口', keepMaxLogMb:'最大日志 MB'
};
const detailLabels = {
 market:'市场', secondInBucket:'局内秒', moveBps:'局内动量', velocityBps:'短线速度', btcPrice:'BTC 价格', btcSource:'BTC 数据源',
 minBtcMoveBps:'动量阈值', minBtcVelocityBps:'速度阈值', btcRegime:'BTC 指标', ask:'卖一', maxEntryPrice:'最高买入价',
 spreadCents:'价差 cents', maxSpreadCents:'最大价差 cents', shares:'份额', avgPrice:'均价', cost:'成本',
 bid:'买一', entryAvgPrice:'入场均价', profitCents:'浮盈 cents', elapsedSeconds:'持仓秒', hedgeSide:'对冲方向',
  panicLoss:'达到 panic 亏损', severePanicLoss:'极端亏损', adverseRegime:'指标逆风', confirmedAdverseTrend:'反向趋势确认',
  hedgeAgeOk:'持仓时间足够', panicIndicator:'对冲触发确认', severePanic:'极端对冲兜底',
  hedgeAsk:'对冲卖一', hedgeRatio:'动态对冲比例', hedgeCost:'对冲成本', unhedgedWorstLoss:'不对冲最坏亏损',
  hedgedWorstLoss:'对冲后最坏亏损', hedgeImprovementPct:'对冲改善 %', minHedgeImprovementPct:'最小对冲改善 %',
  trendAtEntry:'入场指标', tailwind:'顺风', entryPriceBucket:'入场价格段',
  entrySignal:'入场信号', entryStrategyType:'入场策略', entrySignalTier:'入场分层', entrySignalMultiplier:'入场仓位倍率', entryPressureScore:'入场压力分',
  pressureScore:'压力分', trendPressure:'趋势压力', mispricePressure:'错价压力', reversalRisk:'反转风险', score:'信号分数', adversePressure:'反向压力', strongAdversePressure:'强反向压力', hedgeTimeOk:'剩余时间足够',
  upAsk:'UP 卖一', downAsk:'DOWN 卖一',
 secondsLeftAtEntry:'入场剩余秒', timing:'时间风险', phase:'时间阶段', secondsLeft:'剩余秒', thresholdMultiplier:'阈值倍数', pricePenalty:'价格折扣', sizeMultiplier:'仓位倍数', reason:'原因', sizing:'仓位计算', fill:'成交', positionMarket:'原市场', currentMarket:'当前市场',
 resolvePrice:'结算 BTC', pnl:'盈亏'
};
const regimeMap={uptrend:'上行顺风',downtrend:'下行顺风',up_reversal:'上涨转弱',down_reversal:'下跌转强',chop:'震荡'};
const directionMap={up:'向上',down:'向下',flat:'横盘'};
const strategyMap={trend_entry:'趋势入场',misprice_entry:'错价入场',reverse_favorite_entry:'反向赌赢'};
const tierMap={trend_standard:'标准趋势',trend_strong_chase:'强趋势追单',hard_misprice:'硬错价',supported_misprice:'压力支持错价',reverse_favorite:'反向稳边',cheap_confirmed:'低价确认',cheap_probe:'低价试仓',cheap_velocity_probe:'低价速度试仓',standard:'标准',strong_chase:'强势追单'};
const quickFields = [['paperBalance','number']];
const baseFields = [['paperBalance','number'],['entryStartSeconds','number'],['entryEndSeconds','number'],['maxEntryPrice','number'],['minOrderUsdc','number']];
const trendFields = [['minBtcMoveBps','number'],['velocityLookbackSeconds','number'],['minBtcVelocityBps','number'],['maxSpreadCents','number'],['maxEntrySlippageCents','number']];
const sizingFields = [['kellyEnabled','checkbox'],['kellyFraction','number'],['kellyFallbackPct','number'],['kellyMaxPct','number'],['kellyLookbackTrades','number'],['kellyMinTrades','number'],['depthUsageRatio','number'],['maxShares','number']];
const hedgeFields = [['panicHedgeEnabled','checkbox'],['panicLossCents','number'],['hedgeSizeRatio','number'],['minHedgeImprovementPct','number'],['maxHedgePrice','number'],['maxHedgeSlippageCents','number']];
const advancedFields = [['maxPositionUsdc','number'],['goodSpreadCents','number'],['okSpreadCents','number'],['minDepthToKellyRatio','number'],['thinDepthMultiplier','number'],['okDepthMultiplier','number'],['repriceIntervalMs','number'],['feeBps','number'],['enableSnapshots','checkbox'],['snapshotIntervalMs','number'],['enableOrderbookLogs','checkbox'],['keepMaxLogMb','number']];
function fmt(n,d=2){return typeof n==='number'&&isFinite(n)?n.toFixed(d):'-'}
const actionMap={idle:'启动中',bot_disabled:'策略暂停',outside_entry_window:'等待入场窗口',no_signal:'等待信号',hold:'持仓中',hold_hedged:'已对冲持有',one_trade_per_bucket:'本局已交易',entry_skipped_no_ask:'无卖盘',entry_skipped_price:'价格过高',entry_skipped_spread:'价差过大',entry_skipped_depth:'深度不足',entry_unfilled:'入场未成交',hold_no_bid:'无买盘',panic_hedge_skipped_price:'对冲价格过高',panic_hedge_unfilled:'对冲未成交'};
const eventMap={error:'错误',market_discovered:'发现当前市场',entry_filled:'模拟买入成交',panic_hedge_triggered:'触发 panic hedge',settings_updated:'参数已更新',paper_balance_reset:'模拟余额已重置',bot_started:'机器人已启动',logs_cleared:'日志已清空'};
const statusMap={settled:'已结算',closed:'已平仓',open:'持仓中',hedged:'已对冲'};
const reasonMap={settlement:'到期结算'};
function actionText(a){return actionMap[a]||a||'-'}
function bookHtml(b,t){if(!b)return '-';const rows=[];for(let i=0;i<5;i++){rows.push('<tr><td>'+(b.bids?.[i]?.price??'-')+'</td><td>'+(b.bids?.[i]?.size??'-')+'</td><td>'+(b.asks?.[i]?.price??'-')+'</td><td>'+(b.asks?.[i]?.size??'-')+'</td></tr>')}return '<div class="fresh">盘口 '+fresh(t)+'</div><div class="quote"><b>买一 '+(b.bids?.[0]?.price??'-')+'</b><b>卖一 '+(b.asks?.[0]?.price??'-')+'</b></div><table><thead><tr><th>买价</th><th>量</th><th>卖价</th><th>量</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
function posHtml(p){if(!p)return '<span class="muted">无仓位</span>';return '<div class="posline"><b>'+p.side+'</b><b>'+fmt(p.shares,2)+' 份</b></div><div>均价 '+fmt(p.entryAvgPrice,3)+' / 成本 '+fmt(p.entryCost,2)+'</div><div>状态 '+text(statusMap,p.status)+' / 入场第 '+p.entrySecond+' 秒</div>'+(p.hedgeSide?'<div>对冲 '+p.hedgeSide+' '+fmt(p.hedgeShares,2)+' 份 @ '+fmt(p.hedgeAvgPrice,3)+'</div>':'')}
function decisionHtml(d){if(!d)return '<span class="muted">等待决策</span>';const side=d.side?'<b>'+d.side+'</b> ':'';return '<div class="decision-head">'+side+reasonText(d.reason)+'</div><div class="fresh">检查 '+fresh(d.checkedAt)+' / 状态 '+statusText(d.status)+'</div>'+detailList(d.details)}
function detailList(obj){if(!obj)return '';const priority=['entryStrategyType','entrySignalTier','score','entryPressureScore','trendPressure','mispricePressure','reversalRisk','pressureScore','adversePressure','upAsk','downAsk','ask','bid','profitCents','elapsedSeconds','secondsLeft','hedgeImprovementPct','unhedgedWorstLoss','hedgedWorstLoss'];const used=new Set();const entries=[];for(const k of priority){if(Object.prototype.hasOwnProperty.call(obj,k)){entries.push([k,obj[k]]);used.add(k)}}for(const item of Object.entries(obj)){if(!used.has(item[0]))entries.push(item)}return '<div class="detail-grid">'+entries.slice(0,16).map(([k,v])=>'<div><span>'+fieldText(k)+'</span><b>'+valueText(k,v)+'</b></div>').join('')+'</div>'}
function fieldText(k){return detailLabels[k]||labels[k]||k}
function valueText(k,v){if(v==null)return '-';if(k==='btcRegime'&&typeof v==='object')return regimeText(v);if(typeof v==='boolean')return v?'是':'否';if(typeof v==='number')return Number.isInteger(v)?String(v):fmt(v,4);if(typeof v==='object')return compactObject(v);if(typeof v==='string')return strategyMap[v]||tierMap[v]||regimeMap[v]||directionMap[v]||v;return String(v)}
function regimeText(r){return (regimeMap[r.label]||r.label||'-')+' / 动量 '+(directionMap[r.moveDirection]||r.moveDirection||'-')+' / 速度 '+(directionMap[r.velocityDirection]||r.velocityDirection||'-')}
function compactObject(v){const entries=Object.entries(v).slice(0,4).map(([k,val])=>fieldText(k)+':'+valueText(k,val));return entries.join('，')}
function reasonText(r){const map={'Strategy is paused; enable bot to make decisions':'策略已暂停，启动后才会决策','Checking entry and position conditions':'正在检查入场和持仓条件','Previous market ended; settling paper position':'上一局已结束，正在模拟结算','Open position: checking panic hedge, then holding to settlement':'已有仓位，检查是否需要 panic hedge，然后持有到结算','This 5m market was already traded; waiting for next market':'当前 5 分钟市场已交易，等待下一局','Momentum or velocity has not reached entry threshold':'动量或速度未达到入场阈值','Target side has no ask; cannot buy':'目标方向没有卖盘，无法买入','Target side price is above max entry price':'目标方向价格高于最高买入价','Spread is too wide':'盘口价差过大','Kelly size or book depth is below effective minimum order':'Kelly 仓位或盘口深度低于最小订单','Simulated fill is below effective minimum order':'模拟成交低于最小订单','No bid on held side; still holding to settlement':'持仓方向没有买盘，继续持有到结算','Panic hedge triggered; buy opposite side and keep main position to settlement':'触发 panic hedge，买入反方向保护成本，主仓持有到结算','Hedged; holding to settlement':'已对冲，继续持有到结算','Holding to settlement; hedge not triggered':'继续持有到结算，未触发对冲'};if(r&&r.startsWith('Signal '))return r.replace('Signal UP; checking book and sizing','出现 UP 信号，检查盘口和仓位').replace('Signal DOWN; checking book and sizing','出现 DOWN 信号，检查盘口和仓位');if(r&&r.startsWith('Paper bought '))return r.replace('Paper bought UP as panic hedge','已模拟买入 UP 对冲').replace('Paper bought DOWN as panic hedge','已模拟买入 DOWN 对冲').replace('Paper bought UP','已模拟买入 UP').replace('Paper bought DOWN','已模拟买入 DOWN');if(r&&r.startsWith('Market settled; winner '))return r.replace('Market settled; winner UP','市场已结算，结果 UP').replace('Market settled; winner DOWN','市场已结算，结果 DOWN');return map[r]||r||'-'}
function statusText(s){const map={starting:'启动中',paused:'已暂停',checking:'检查中',settling:'结算中',managing_position:'管理仓位',skip:'跳过',wait_signal:'等待信号',signal:'出现信号',entered:'已入场',hold:'持有',panic_hedge:'准备对冲',hedged:'已对冲',settled:'已结算',error:'错误'};return map[s]||s||'-'}
function renderForm(form, fields, s){form.innerHTML='';for(const [k,t] of fields){const wrap=document.createElement('label');wrap.textContent=labels[k]||k;const i=document.createElement('input');i.name=k;i.type=t;if(t==='checkbox')i.checked=!!s[k];else{i.value=s[k]??''; if(t==='number')i.step='any'}wrap.appendChild(i);form.appendChild(wrap)}}
async function loadSettings(){const s=await (await fetch('/api/settings')).json();renderForm(quickSettings,quickFields,s);renderForm(baseSettings,baseFields,s);renderForm(trendSettings,trendFields,s);renderForm(sizingSettings,sizingFields,s);renderForm(hedgeSettings,hedgeFields,s);renderForm(advancedSettings,advancedFields,s)}
function collect(form, fields){const body={};for(const [k,t] of fields){const el=form.elements[k];body[k]=t==='checkbox'?el.checked:(t==='number'?Number(el.value):el.value)}return body}
async function saveForm(form, fields){const r=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collect(form,fields))});if(!r.ok){alert((await r.json()).error||'保存失败')}await loadSettings();await loadDashboard()}
async function loadDashboard(){const d=await (await fetch('/api/dashboard')).json();const s=d.state, cfg=d.settings;status.textContent=s.lastError?'错误':(cfg.botEnabled?'策略运行':'策略暂停');statusCard.className=cfg.botEnabled?'on':'off';action.textContent=s.lastError||actionText(s.lastAction);btc.textContent=s.btc?fmt(s.btc.price,2):'-';move.textContent='动量 '+fmt(s.moveBps,2)+' bps / 速度 '+fmt(s.velocityBps,2)+' / 指标 '+(s.btcRegime?regimeText(s.btcRegime):'-')+' / '+(s.btc?.source||'无数据源');market.textContent=s.currentMarket?s.currentMarket.slug.replace('btc-updown-5m-',''):'-';sec.textContent='第 '+s.secondInBucket+' 秒 / 剩余 '+Math.max(0,300-s.secondInBucket)+' 秒 / '+fresh(s.bookUpdatedAt);bal.textContent=fmt(s.paperBalance,2)+' USDC';pnl.textContent='PnL '+fmt(s.realizedPnl,2);decision.innerHTML=decisionHtml(s.decision);up.innerHTML=bookHtml(s.upBook,s.bookUpdatedAt);down.innerHTML=bookHtml(s.downBook,s.bookUpdatedAt);pos.innerHTML=posHtml(s.position);trades.innerHTML=tradeRows(d.recentTrades);events.innerHTML=eventRows(d.recentEvents)}
function tradeRows(rows){if(!rows.length)return '<span class="muted">暂无交易</span>';return '<table><thead><tr><th>时间</th><th>方向</th><th>策略</th><th>分层</th><th>价</th><th>压力</th><th>PnL</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+shortTime(r.exitTime||r.entryTime)+'</td><td>'+sideText(r.side)+'</td><td>'+valueText('entryStrategyType',r.entryStrategyType)+'</td><td>'+valueText('entrySignalTier',r.entrySignalTier)+'</td><td>'+fmt(r.entryAvgPrice,3)+'</td><td>'+fmt(r.entryPressureScore,2)+'</td><td>'+fmt(r.netPnl,2)+'</td></tr>').join('')+'</tbody></table>'}
function eventRows(rows){if(!rows.length)return '<span class="muted">暂无事件</span>';return rows.slice(0,8).map(r=>'<div class="event"><b>'+shortTime(r.timestamp)+'</b> '+eventText(r)+'</div>').join('')}
function eventText(r){if(r.type==='entry_filled'){const sig=r.entrySignal||{};const fill=r.fill||{};return '入场 '+sideText(r.side)+' / '+valueText('entryStrategyType',sig.strategyType)+' / '+valueText('entrySignalTier',sig.tier)+' / 均价 '+fmt(fill.avgPrice,3)+' / 金额 '+fmt(fill.value,2)}if(r.type==='panic_hedge_triggered'){const fill=r.hedgeFill||{};return '对冲 '+sideText(r.hedgeSide)+' / 均价 '+fmt(fill.avgPrice,3)+' / 金额 '+fmt(fill.value,2)}return text(eventMap,r.type)}
function text(map,key){return map[key]||key||'-'}
function sideText(s){return s==='UP'?'看涨 UP':(s==='DOWN'?'看跌 DOWN':(s||'-'))}
function shortTime(t){if(!t)return '-';const d=new Date(t);return isNaN(d.getTime())?String(t).slice(11,19):d.toLocaleTimeString('zh-CN',{hour12:false})}
function fresh(t){if(!t)return '未更新';const ms=Date.now()-new Date(t).getTime();if(!isFinite(ms))return '时间异常';return shortTime(t)+' / 延迟 '+Math.max(0,ms/1000).toFixed(1)+'s'}
async function loadLogs(){const l=await (await fetch('/api/logs')).json();logs.innerHTML='';const main=[['report.md','完整 MD'],['trades.csv','交易 CSV'],['snapshots.csv','快照 CSV'],['all.zip','全部 ZIP']];for(const [name,text] of main){const a=document.createElement('a');a.href='/api/logs/'+name;a.textContent=text;logs.appendChild(a)}const meta=document.createElement('span');meta.className='logmeta';meta.textContent='交易 '+size(l.trades.size)+' / 快照 '+size(l.snapshots.size)+' / 事件 '+size(l.events.size)+' / 盘口 '+size(l.orderbooks.size);logs.appendChild(meta)}
function size(n){if(!n)return '0';if(n>1048576)return fmt(n/1048576,1)+' MB';if(n>1024)return fmt(n/1024,1)+' KB';return n+' B'}
start.onclick=async()=>{action.textContent='启动请求已发送';await fetch('/api/bot/start',{method:'POST'});await loadDashboard()};stop.onclick=async()=>{action.textContent='暂停请求已发送';await fetch('/api/bot/stop',{method:'POST'});await loadDashboard()};logout.onclick=()=>fetch('/api/logout',{method:'POST'}).then(()=>location='/login');saveQuick.onclick=()=>saveForm(quickSettings,quickFields);saveBase.onclick=()=>saveForm(baseSettings,baseFields);saveTrend.onclick=()=>saveForm(trendSettings,trendFields);saveSizing.onclick=()=>saveForm(sizingSettings,sizingFields);saveHedge.onclick=()=>saveForm(hedgeSettings,hedgeFields);saveAdvanced.onclick=()=>saveForm(advancedSettings,advancedFields);clear.onclick=()=>fetch('/api/logs/clear',{method:'POST'}).then(()=>{loadLogs();loadDashboard()});
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
