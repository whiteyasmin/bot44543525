import * as fs from "fs";
import * as path from "path";
import {
  getPaperHistoryFilePathForInstance,
  getPaperTuningFilePathForInstance,
} from "./instancePaths";

type Profile = "fixed" | "adaptive";

type InstanceConfig = {
  name: string;
  profile: Profile;
  baseUrl: string;
};

type AuditReport = {
  totalTrades: number;
  realizedProfit: number;
  winRatePct: number;
  roiPct: number | null;
  maxDrawdown: number;
  profitFactor: number | null;
  warnings: string[];
};

type StatusShape = {
  botRunning: boolean;
  totalRounds: number;
  totalProfit: number;
  status: string;
  history?: Array<{ profit?: number }>;
};

type PaperTuningConfig = {
  baseSumTarget: number;
  maxSumTarget: number;
  maxEntryAsk: number;
  fixedMinLockedProfit: number;
  fixedMinLockedRoi: number;
  adaptiveMinLockedProfit: number;
  adaptiveMinLockedRoi: number;
};

type InstanceRuntimeState = {
  paperBalance: number;
};

type CycleResult = {
  instance: string;
  profile: Profile;
  batchRounds: number;
  totalProfit: number;
  totalTrades: number;
  roiPct: number | null;
  winRatePct: number;
  maxDrawdown: number;
  warnings: string[];
};

const PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const PAPER_BALANCE = Number(process.env.PAPER_BALANCE || "120");
const POLL_MS = Number(process.env.OBSERVE_POLL_MS || "15000");
const CYCLES = Number(process.env.OPTIMIZE_CYCLES || "6");
const LOSS_SHRINK_THRESHOLD = Number(process.env.LOSS_SHRINK_THRESHOLD || "8");
const DRAWDOWN_SHRINK_THRESHOLD = Number(process.env.DRAWDOWN_SHRINK_THRESHOLD || "10");
const SHRINK_FACTOR = Number(process.env.SHRINK_FACTOR || "0.75");
const RECOVERY_STEP = Number(process.env.RECOVERY_STEP || "10");
const MIN_PAPER_BALANCE = Number(process.env.MIN_PAPER_BALANCE || "40");
const SUMMARY_FILE = path.join(process.cwd(), "data", "dual-optimize-summary.json");

const INSTANCES: InstanceConfig[] = [
  { name: "fixed", profile: "fixed", baseUrl: process.env.FIXED_BASE_URL || "http://localhost:3001" },
  { name: "adaptive", profile: "adaptive", baseUrl: process.env.ADAPTIVE_BASE_URL || "http://localhost:3002" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultTuning(profile: Profile): PaperTuningConfig {
  return {
    baseSumTarget: 0.98,
    maxSumTarget: 1.01,
    maxEntryAsk: profile === "fixed" ? 0.55 : 0.57,
    fixedMinLockedProfit: 1.0,
    fixedMinLockedRoi: 0.015,
    adaptiveMinLockedProfit: 0.5,
    adaptiveMinLockedRoi: 0.005,
  };
}

function loadTuning(instanceName: string, profile: Profile): PaperTuningConfig {
  const filePath = getPaperTuningFilePathForInstance(instanceName);
  if (!fs.existsSync(filePath)) return defaultTuning(profile);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const base = defaultTuning(profile);
    return {
      baseSumTarget: typeof parsed?.baseSumTarget === "number" ? parsed.baseSumTarget : base.baseSumTarget,
      maxSumTarget: typeof parsed?.maxSumTarget === "number" ? parsed.maxSumTarget : base.maxSumTarget,
      maxEntryAsk: typeof parsed?.maxEntryAsk === "number" ? parsed.maxEntryAsk : base.maxEntryAsk,
      fixedMinLockedProfit: typeof parsed?.fixedMinLockedProfit === "number" ? parsed.fixedMinLockedProfit : base.fixedMinLockedProfit,
      fixedMinLockedRoi: typeof parsed?.fixedMinLockedRoi === "number" ? parsed.fixedMinLockedRoi : base.fixedMinLockedRoi,
      adaptiveMinLockedProfit: typeof parsed?.adaptiveMinLockedProfit === "number" ? parsed.adaptiveMinLockedProfit : base.adaptiveMinLockedProfit,
      adaptiveMinLockedRoi: typeof parsed?.adaptiveMinLockedRoi === "number" ? parsed.adaptiveMinLockedRoi : base.adaptiveMinLockedRoi,
    };
  } catch {
    return defaultTuning(profile);
  }
}

function saveTuning(instanceName: string, tuning: PaperTuningConfig): void {
  const filePath = getPaperTuningFilePathForInstance(instanceName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tuning, null, 2), "utf8");
}

function resetPaperHistory(instanceName: string): void {
  const filePath = getPaperHistoryFilePathForInstance(instanceName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function clampTuning(profile: Profile, tuning: PaperTuningConfig): PaperTuningConfig {
  const baseSumTarget = Math.max(0.95, Math.min(1.04, tuning.baseSumTarget));
  const maxSumTarget = Math.max(baseSumTarget, Math.min(1.05, tuning.maxSumTarget));
  const maxEntryAskFloor = profile === "fixed" ? 0.52 : 0.48;
  const maxEntryAskCap = profile === "fixed" ? 0.55 : 0.57;
  return {
    baseSumTarget,
    maxSumTarget,
    maxEntryAsk: Math.max(maxEntryAskFloor, Math.min(maxEntryAskCap, tuning.maxEntryAsk)),
    fixedMinLockedProfit: Math.max(0.5, Math.min(4, tuning.fixedMinLockedProfit)),
    fixedMinLockedRoi: Math.max(0.005, Math.min(0.05, tuning.fixedMinLockedRoi)),
    adaptiveMinLockedProfit: Math.max(0.1, Math.min(3, tuning.adaptiveMinLockedProfit)),
    adaptiveMinLockedRoi: Math.max(0.001, Math.min(0.03, tuning.adaptiveMinLockedRoi)),
  };
}

function evolveTuning(profile: Profile, current: PaperTuningConfig, result: CycleResult): PaperTuningConfig {
  const next = { ...current };

  if (result.totalTrades === 0) {
    next.baseSumTarget += 0.01;
    next.maxSumTarget += 0.01;
    return clampTuning(profile, next);
  }

  if (result.totalProfit < 0) {
    next.baseSumTarget -= 0.01;
    next.maxSumTarget -= 0.01;
    next.maxEntryAsk -= 0.01;
    next.fixedMinLockedProfit += 0.25;
    next.fixedMinLockedRoi += 0.0025;
    next.adaptiveMinLockedProfit += 0.15;
    next.adaptiveMinLockedRoi += 0.001;
    return clampTuning(profile, next);
  }

  if (result.totalProfit > 0 && (result.roiPct || 0) >= 1) {
    next.fixedMinLockedProfit += 0.1;
    next.fixedMinLockedRoi += 0.001;
    next.adaptiveMinLockedProfit += 0.05;
    return clampTuning(profile, next);
  }

  return clampTuning(profile, next);
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`server not ready: ${baseUrl}`);
}

async function createSession(baseUrl: string): Promise<(path: string, options?: RequestInit) => Promise<string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let cookie = "";

  const request = async (requestPath: string, options: RequestInit = {}): Promise<string> => {
    const res = await fetch(`${baseUrl}${requestPath}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
        ...(cookie ? { cookie } : {}),
      },
    });
    const raw = res.headers.get("set-cookie");
    if (raw) cookie = raw.split(";")[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${baseUrl}${requestPath} ${res.status} ${text}`);
    return text;
  };

  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
  });

  return request;
}

async function stopIfRunning(request: (path: string, options?: RequestInit) => Promise<string>): Promise<void> {
  const status = JSON.parse(await request("/api/status")) as StatusShape;
  if (!status.botRunning) return;
  await request("/api/stop", { method: "POST" });
  await sleep(1500);
}

function adjustRuntimeBalance(state: InstanceRuntimeState, result: CycleResult): void {
  const hitLossThreshold = result.totalProfit <= -LOSS_SHRINK_THRESHOLD || result.maxDrawdown >= DRAWDOWN_SHRINK_THRESHOLD;
  if (hitLossThreshold) {
    state.paperBalance = Math.max(MIN_PAPER_BALANCE, Math.round(state.paperBalance * SHRINK_FACTOR));
    return;
  }
  if (result.totalProfit > 0) {
    state.paperBalance = Math.min(PAPER_BALANCE, state.paperBalance + RECOVERY_STEP);
  }
}

async function runBatch(instance: InstanceConfig, state: InstanceRuntimeState, batchRounds: number): Promise<CycleResult> {
  await waitForServer(instance.baseUrl);
  const request = await createSession(instance.baseUrl);
  await stopIfRunning(request);
  resetPaperHistory(instance.name);

  await request("/api/start", {
    method: "POST",
    body: JSON.stringify({
      mode: "paper",
      paperBalance: state.paperBalance,
      paperProfile: instance.profile,
    }),
  });

  const initial = JSON.parse(await request("/api/status")) as StatusShape;
  const targetRounds = (initial.totalRounds || 0) + batchRounds;
  let lastRound = initial.totalRounds || 0;

  while (true) {
    await sleep(POLL_MS);
    const status = JSON.parse(await request("/api/status")) as StatusShape;
    if (status.totalRounds !== lastRound) {
      lastRound = status.totalRounds;
      console.log(`[dual:${instance.name}] round ${lastRound}/${targetRounds} status=${status.status} profit=${status.totalProfit} trades=${(status.history || []).length}`);
    }
    if ((status.totalRounds || 0) >= targetRounds) {
      const audit = JSON.parse(await request("/api/audit")) as AuditReport;
      await request("/api/stop", { method: "POST" });
      return {
        instance: instance.name,
        profile: instance.profile,
        batchRounds,
        totalProfit: Number(audit.realizedProfit || 0),
        totalTrades: audit.totalTrades || 0,
        roiPct: audit.roiPct,
        winRatePct: audit.winRatePct || 0,
        maxDrawdown: audit.maxDrawdown || 0,
        warnings: audit.warnings || [],
      };
    }
  }
}

function printCycleSummary(cycle: number, results: CycleResult[]): void {
  console.log(`[dual] cycle ${cycle} summary`);
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}

async function main(): Promise<void> {
  const runtimeState = new Map<string, InstanceRuntimeState>();
  for (const instance of INSTANCES) {
    saveTuning(instance.name, loadTuning(instance.name, instance.profile));
    runtimeState.set(instance.name, { paperBalance: PAPER_BALANCE });
  }

  const allResults: Array<{ cycle: number; results: CycleResult[] }> = [];

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const batchRounds = cycle % 2 === 1 ? 2 : 3;
    console.log(`[dual] cycle ${cycle} start batchRounds=${batchRounds}`);

    const results = await Promise.all(INSTANCES.map((instance) => runBatch(instance, runtimeState.get(instance.name)!, batchRounds)));
    printCycleSummary(cycle, results);
    allResults.push({ cycle, results });

    for (const result of results) {
      const current = loadTuning(result.instance, result.profile);
      const next = evolveTuning(result.profile, current, result);
      saveTuning(result.instance, next);
      adjustRuntimeBalance(runtimeState.get(result.instance)!, result);
      console.log(`[dual:${result.instance}] tuning => ${JSON.stringify(next)}`);
      console.log(`[dual:${result.instance}] paperBalance => ${runtimeState.get(result.instance)!.paperBalance}`);
    }

    fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(allResults, null, 2), "utf8");
  }

  const flattened = allResults.flatMap((entry) => entry.results);
  const totals = flattened.reduce<Record<string, number>>((acc, item) => {
    acc[item.instance] = (acc[item.instance] || 0) + item.totalProfit;
    return acc;
  }, {});
  const winner = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
  console.log(`[dual] final winner=${winner?.[0] || "n/a"} profit=${winner?.[1]?.toFixed(2) || "0.00"}`);
}

main().catch((err) => {
  console.error(`[dual][fatal] ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
});