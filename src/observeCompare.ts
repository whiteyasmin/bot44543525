import * as fs from "fs";
import { PAPER_HISTORY_FILE, AuditReport } from "./audit";

const BASE_URL = process.env.HEDGE_BASE_URL || "http://localhost:3001";
const PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const PAPER_BALANCE = Number(process.env.PAPER_BALANCE || "120");
const MAX_EXTRA_ROUNDS = Number(process.env.MAX_EXTRA_ROUNDS || "6");
const POLL_MS = Number(process.env.OBSERVE_POLL_MS || "15000");

type PaperStrategyProfile = "fixed" | "adaptive";

type StatusShape = {
  botRunning: boolean;
  totalRounds: number;
  totalProfit: number;
  history?: Array<{ profit?: number }>;
  status: string;
  adaptiveBaseSumTarget?: number;
  adaptiveMaxSumTarget?: number;
  adaptiveMaxEntryAsk?: number;
  adaptiveLastAdjustment?: string;
};

type ComparisonResult = {
  profile: PaperStrategyProfile;
  stopReason: "positive-profit" | "guardrail";
  roundsObserved: number;
  totalProfit: number;
  totalTrades: number;
  audit: AuditReport;
};

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};

let cookie = "";

function updateCookie(res: Response): void {
  const raw = res.headers.get("set-cookie");
  if (raw) cookie = raw.split(";")[0];
}

async function request(path: string, options: RequestInit = {}): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  updateCookie(res);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/api/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("server not ready");
}

async function login(): Promise<void> {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
  });
}

async function stopIfRunning(): Promise<void> {
  const status = JSON.parse(await request("/api/status")) as StatusShape;
  if (!status.botRunning) return;
  await request("/api/stop", { method: "POST" });
  await sleep(1500);
}

function resetPaperHistory(): void {
  if (fs.existsSync(PAPER_HISTORY_FILE)) fs.unlinkSync(PAPER_HISTORY_FILE);
}

async function runProfile(profile: PaperStrategyProfile): Promise<ComparisonResult> {
  await stopIfRunning();
  resetPaperHistory();

  console.log(`[compare:${profile}] start`);
  await request("/api/start", {
    method: "POST",
    body: JSON.stringify({ mode: "paper", paperBalance: PAPER_BALANCE, paperProfile: profile }),
  });

  const initial = JSON.parse(await request("/api/status")) as StatusShape;
  const targetRounds = (initial.totalRounds || 0) + MAX_EXTRA_ROUNDS;
  let lastRound = initial.totalRounds || 0;
  let lastAdjustment = "";

  while (true) {
    await sleep(POLL_MS);
    const status = JSON.parse(await request("/api/status")) as StatusShape;

    if (status.totalRounds !== lastRound) {
      lastRound = status.totalRounds;
      console.log(
        `[compare:${profile}] round ${lastRound} status=${status.status} profit=${status.totalProfit} tuning=${Number(status.adaptiveBaseSumTarget || 0).toFixed(2)}->${Number(status.adaptiveMaxSumTarget || 0).toFixed(2)} ask<=${Number(status.adaptiveMaxEntryAsk || 0).toFixed(2)}`,
      );
    }

    if (status.adaptiveLastAdjustment && status.adaptiveLastAdjustment !== lastAdjustment) {
      lastAdjustment = status.adaptiveLastAdjustment;
      console.log(`[compare:${profile}] adjust ${lastAdjustment}`);
    }

    const hasPositiveTrade = (status.history || []).some((entry) => Number(entry.profit || 0) > 0);
    if (Number(status.totalProfit || 0) > 0 || hasPositiveTrade) {
      const audit = JSON.parse(await request("/api/audit")) as AuditReport;
      await request("/api/stop", { method: "POST" });
      return {
        profile,
        stopReason: "positive-profit",
        roundsObserved: status.totalRounds || 0,
        totalProfit: Number(status.totalProfit || 0),
        totalTrades: audit.totalTrades,
        audit,
      };
    }

    if ((status.totalRounds || 0) >= targetRounds) {
      const audit = JSON.parse(await request("/api/audit")) as AuditReport;
      await request("/api/stop", { method: "POST" });
      return {
        profile,
        stopReason: "guardrail",
        roundsObserved: status.totalRounds || 0,
        totalProfit: Number(status.totalProfit || 0),
        totalTrades: audit.totalTrades,
        audit,
      };
    }
  }
}

function printSummary(results: ComparisonResult[]): void {
  console.log("[compare] summary");
  for (const result of results) {
    console.log(
      JSON.stringify(
        {
          profile: result.profile,
          stopReason: result.stopReason,
          roundsObserved: result.roundsObserved,
          totalProfit: Number(result.totalProfit.toFixed(2)),
          totalTrades: result.totalTrades,
          winRatePct: result.audit.winRatePct,
          roiPct: result.audit.roiPct,
          maxDrawdown: result.audit.maxDrawdown,
          adaptiveLastAdjustment: result.audit.history.length > 0 ? undefined : null,
        },
        null,
        2,
      ),
    );
  }

  const fixed = results.find((entry) => entry.profile === "fixed");
  const adaptive = results.find((entry) => entry.profile === "adaptive");
  if (fixed && adaptive) {
    console.log(
      JSON.stringify(
        {
          compare: {
            profitDelta: Number((adaptive.totalProfit - fixed.totalProfit).toFixed(2)),
            tradeDelta: adaptive.totalTrades - fixed.totalTrades,
            roundsDelta: adaptive.roundsObserved - fixed.roundsObserved,
            betterProfitProfile: adaptive.totalProfit === fixed.totalProfit
              ? "tie"
              : adaptive.totalProfit > fixed.totalProfit
                ? "adaptive"
                : "fixed",
          },
        },
        null,
        2,
      ),
    );
  }
}

async function main(): Promise<void> {
  await waitForServer();
  await login();
  const results: ComparisonResult[] = [];
  results.push(await runProfile("fixed"));
  results.push(await runProfile("adaptive"));
  printSummary(results);
}

main().catch((err) => {
  console.error(`[compare][fatal] ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
});