import Module = require("module");

type Round15m = {
  market: Record<string, unknown>;
  upToken: string;
  downToken: string;
  secondsLeft: number;
  question: string;
  conditionId: string;
  negRisk: boolean;
};

const btcState = {
  latestPrice: 100200,
  roundStartPrice: 100000,
  chainlinkPrice: 100200,
  secsLeft: 600,
  chainlinkFresh: true,
  direction: "up" as "up" | "down",
};

const btcPriceMock = {
  startPriceFeed: async () => {},
  stopPriceFeed: () => {},
  getBtcPrice: () => btcState.latestPrice,
  getChainlinkPrice: () => btcState.chainlinkPrice,
  getChainlinkDirection: () => btcState.direction,
  isChainlinkFresh: () => btcState.chainlinkFresh,
  setRoundSecsLeft: (secs: number) => { btcState.secsLeft = secs; },
  setRoundStartPrice: (price = 0) => { btcState.roundStartPrice = price > 0 ? price : btcState.latestPrice; },
};

const ModuleAny = Module as any;
const originalLoad = ModuleAny._load as (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
ModuleAny._load = function patchedLoad(request: string, parent: NodeModule | undefined, isMain: boolean) {
  if (request === "./btcPrice" && parent?.filename?.endsWith("src\\bot.ts")) {
    return btcPriceMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { Hedge15mEngine } = require("./bot") as typeof import("./bot");

type Book = { bid: number | null; ask: number | null; spread: number; askDepth: number; bidDepth: number };
type FillPlan = { filled: number; avgPrice: number; orderId?: string | null };
type GtcPlan = { orderId: string; filled: number; avgPrice: number };

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
  const scaled = typeof timeout === "number" ? Math.max(1, Math.round(timeout * 0.01)) : 1;
  return realSetTimeout(handler, scaled, ...args);
}) as typeof globalThis.setTimeout;

class SimTrader {
  public books = new Map<string, Book>();
  public balance = 100;
  private buyPlans: FillPlan[] = [];
  private sellPlans: FillPlan[] = [];
  private gtcPlans: GtcPlan[] = [];
  private orderDetails = new Map<string, { filled: number; avgPrice: number }>();

  queueBuy(plan: FillPlan): void {
    this.buyPlans.push(plan);
  }

  queueSell(plan: FillPlan): void {
    this.sellPlans.push(plan);
  }

  queueGtc(plan: GtcPlan): void {
    this.gtcPlans.push(plan);
  }

  async getBestPrices(tokenId: string): Promise<Book> {
    const book = this.books.get(tokenId);
    if (!book) throw new Error(`missing book for ${tokenId}`);
    return book;
  }

  async placeFakBuy(_tokenId: string, amount: number): Promise<any> {
    const plan = this.buyPlans.shift();
    if (!plan) throw new Error(`missing buy plan for amount=${amount}`);
    if (!plan.orderId) return {};
    this.orderDetails.set(plan.orderId, { filled: plan.filled, avgPrice: plan.avgPrice });
    return { orderID: plan.orderId };
  }

  async placeFakSell(_tokenId: string, shares: number): Promise<any> {
    const plan = this.sellPlans.shift();
    if (!plan) throw new Error(`missing sell plan for shares=${shares}`);
    if (!plan.orderId) return {};
    this.orderDetails.set(plan.orderId, { filled: plan.filled, avgPrice: plan.avgPrice });
    return { orderID: plan.orderId };
  }

  async placeGtcSell(_tokenId: string, _shares: number, _price: number): Promise<string | null> {
    const plan = this.gtcPlans.shift();
    if (!plan) return null;
    this.orderDetails.set(plan.orderId, { filled: plan.filled, avgPrice: plan.avgPrice });
    return plan.orderId;
  }

  async cancelOrder(_orderId: string): Promise<void> {
    return;
  }

  async getOrderFilled(orderId: string): Promise<number> {
    return this.orderDetails.get(orderId)?.filled || 0;
  }

  async getOrderFillDetails(orderId: string): Promise<{ filled: number; avgPrice: number }> {
    return this.orderDetails.get(orderId) || { filled: 0, avgPrice: 0 };
  }

  async getBalance(): Promise<number> {
    return this.balance;
  }
}

interface ScenarioResult {
  name: string;
  ok: boolean;
  summary: string;
}

function createRound(): Round15m {
  return {
    market: {},
    upToken: "UP_TOKEN",
    downToken: "DOWN_TOKEN",
    secondsLeft: 600,
    question: "BTC 15m simulated",
    conditionId: "sim-round",
    negRisk: false,
  };
}

function createEngine(balance = 100): { engine: InstanceType<typeof Hedge15mEngine>; trader: SimTrader; rnd: Round15m } {
  const engine = new Hedge15mEngine();
  const trader = new SimTrader();
  const rnd = createRound();
  const e = engine as any;
  e.balance = balance;
  e.initialBankroll = balance;
  e.hedgeState = "watching";
  e.currentMarket = rnd.question;
  e.roundStartBtcPrice = 100000;
  e.trader = trader;
  e.refreshBalance = async () => {
    e.balance = await trader.getBalance();
  };
  trader.books.set(rnd.upToken, { bid: 0.34, ask: 0.36, spread: 0.02, askDepth: 500, bidDepth: 500 });
  trader.books.set(rnd.downToken, { bid: 0.53, ask: 0.55, spread: 0.02, askDepth: 500, bidDepth: 500 });
  btcState.latestPrice = 100200;
  btcState.roundStartPrice = 100000;
  btcState.chainlinkPrice = 100200;
  btcState.secsLeft = 600;
  btcState.chainlinkFresh = true;
  btcState.direction = "up";
  btcPriceMock.setRoundSecsLeft(600);
  btcPriceMock.setRoundStartPrice(100000);
  return { engine, trader, rnd };
}

async function scenarioSettlementWin(): Promise<ScenarioResult> {
  const { engine, trader, rnd } = createEngine();
  const e = engine as any;
  trader.queueBuy({ orderId: "buy-l1", filled: 69, avgPrice: 0.36 });
  trader.queueBuy({ orderId: "buy-l2", filled: 69, avgPrice: 0.55 });
  await e.buyLeg1(trader as any, rnd, "up", 0.36, rnd.upToken, rnd.downToken);
  await e.buyLeg2(trader as any, 0.55, 0.93);
  await e.settleHedge();
  const last = e.history[e.history.length - 1];
  const ok = last?.exitType === "settlement" && last?.profit > 0 && last?.result === "WIN";
  return {
    name: "双腿结算盈利",
    ok,
    summary: `exit=${last?.exitType} profit=$${Number(last?.profit || 0).toFixed(2)} result=${last?.result || "n/a"}`,
  };
}

async function scenarioStopLossSell(): Promise<ScenarioResult> {
  const { engine, trader, rnd } = createEngine();
  const e = engine as any;
  trader.queueBuy({ orderId: "buy-l1", filled: 69, avgPrice: 0.36 });
  trader.queueSell({ orderId: "sell-stop", filled: 69, avgPrice: 0.18 });
  await e.buyLeg1(trader as any, rnd, "up", 0.36, rnd.upToken, rnd.downToken);
  await e.emergencySellLeg1(trader as any, "中途止损", 0.18);
  const last = e.history[e.history.length - 1];
  const ok = last?.exitType === "stop-loss" && last?.sellShares === 69 && last?.result === "LOSS";
  return {
    name: "止损卖出路径",
    ok,
    summary: `exit=${last?.exitType} sold=${last?.sellShares || 0} profit=$${Number(last?.profit || 0).toFixed(2)}`,
  };
}

async function scenarioGtcFallback(): Promise<ScenarioResult> {
  const { engine, trader, rnd } = createEngine();
  const e = engine as any;
  trader.queueBuy({ orderId: "buy-l1", filled: 69, avgPrice: 0.36 });
  trader.queueSell({ orderId: "sell-zero", filled: 0, avgPrice: 0 });
  trader.queueGtc({ orderId: "gtc-sell", filled: 69, avgPrice: 0.31 });
  await e.buyLeg1(trader as any, rnd, "up", 0.36, rnd.upToken, rnd.downToken);
  await e.emergencySellLeg1(trader as any, "超时割肉", 0.32);
  await e.managePendingSell(trader as any, 0.32, 40);
  const last = e.history[e.history.length - 1];
  const ok = last?.exitType === "gtc-fill" && last?.sellShares === 69;
  return {
    name: "FAK失败后GTC成交",
    ok,
    summary: `exit=${last?.exitType} sellPrice=$${Number(last?.sellPrice || 0).toFixed(2)} profit=$${Number(last?.profit || 0).toFixed(2)}`,
  };
}

async function scenarioPartialLeg2Accounting(): Promise<ScenarioResult> {
  const { engine, trader, rnd } = createEngine();
  const e = engine as any;
  trader.queueBuy({ orderId: "buy-l1", filled: 69, avgPrice: 0.36 });
  trader.queueBuy({ orderId: "buy-l2", filled: 40, avgPrice: 0.54 });
  trader.queueSell({ orderId: "trim-l1", filled: 29, avgPrice: 0.33 });
  await e.buyLeg1(trader as any, rnd, "up", 0.36, rnd.upToken, rnd.downToken);
  await e.buyLeg2(trader as any, 0.55, 0.93);
  btcState.latestPrice = 99800;
  btcState.chainlinkPrice = 99800;
  btcState.chainlinkFresh = true;
  btcState.direction = "down";
  await e.settleHedge();
  const last = e.history[e.history.length - 1];
  const ok = last?.exitType === "settlement" && last?.profit > 0 && e.leg1Shares === 0 && e.leg2Shares === 0;
  return {
    name: "Leg2部分成交后成本一致",
    ok,
    summary: `profit=$${Number(last?.profit || 0).toFixed(2)} expectedLocked=$${Number(e.expectedProfit || 0).toFixed(2)} totalCostReset=${e.totalCost === 0}`,
  };
}

async function main(): Promise<void> {
  const scenarios = [
    scenarioSettlementWin,
    scenarioStopLossSell,
    scenarioGtcFallback,
    scenarioPartialLeg2Accounting,
  ];
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await scenario());
  }
  let passed = 0;
  for (const result of results) {
    if (result.ok) passed++;
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.summary}\n`);
  }
  process.stdout.write(`summary: ${passed}/${results.length} scenarios passed\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err) + "\n");
  process.exitCode = 1;
});