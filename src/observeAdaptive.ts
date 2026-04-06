const BASE_URL = process.env.HEDGE_BASE_URL || "http://localhost:3001";
const PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const PAPER_BALANCE = Number(process.env.PAPER_BALANCE || "120");
const MAX_EXTRA_ROUNDS = Number(process.env.MAX_EXTRA_ROUNDS || "8");
const POLL_MS = Number(process.env.OBSERVE_POLL_MS || "15000");
const PAPER_PROFILE = process.env.PAPER_PROFILE === "adaptive" ? "adaptive" : "fixed";

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

async function main(): Promise<void> {
  console.log(`[paper:${PAPER_PROFILE}] login`);
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
  });

  const before = JSON.parse(await request("/api/status"));
  if (!before.botRunning) {
    console.log(`[paper:${PAPER_PROFILE}] start paper`);
    await request("/api/start", {
      method: "POST",
      body: JSON.stringify({ mode: "paper", paperBalance: PAPER_BALANCE, paperProfile: PAPER_PROFILE }),
    });
  }

  const initial = JSON.parse(await request("/api/status"));
  const maxRounds = (initial.totalRounds || 0) + MAX_EXTRA_ROUNDS;
  let lastRound = initial.totalRounds || 0;
  let lastAdjustment = "";
  console.log(`[paper:${PAPER_PROFILE}] watch until profit or rounds=${maxRounds}`);

  while (true) {
    await sleep(POLL_MS);
    const status = JSON.parse(await request("/api/status"));

    if (status.totalRounds !== lastRound) {
      lastRound = status.totalRounds;
      console.log(
        `[paper:${PAPER_PROFILE}] round ${lastRound} status=${status.status} profit=${status.totalProfit} trades=${(status.history || []).length} tuning=${Number(status.adaptiveBaseSumTarget || 0).toFixed(2)}->${Number(status.adaptiveMaxSumTarget || 0).toFixed(2)} ask<=${Number(status.adaptiveMaxEntryAsk || 0).toFixed(2)}`,
      );
    }

    if (status.adaptiveLastAdjustment && status.adaptiveLastAdjustment !== lastAdjustment) {
      lastAdjustment = status.adaptiveLastAdjustment;
      console.log(`[paper:${PAPER_PROFILE}] adjust ${lastAdjustment}`);
    }

    const hasPositiveTrade = (status.history || []).some((entry: any) => Number(entry.profit || 0) > 0);
    if (Number(status.totalProfit || 0) > 0 || hasPositiveTrade) {
      console.log(`[paper:${PAPER_PROFILE}] positive profit reached`);
      console.log(`[paper:${PAPER_PROFILE}][audit] ${await request("/api/audit")}`);
      try {
        await request("/api/stop", { method: "POST" });
        console.log(`[paper:${PAPER_PROFILE}] stopped bot`);
      } catch {}
      return;
    }

    if ((status.totalRounds || 0) >= maxRounds) {
      console.log(`[paper:${PAPER_PROFILE}] guardrail reached`);
      console.log(`[paper:${PAPER_PROFILE}][audit] ${await request("/api/audit")}`);
      try {
        await request("/api/stop", { method: "POST" });
        console.log(`[paper:${PAPER_PROFILE}] stopped bot`);
      } catch {}
      return;
    }
  }
}

main().catch((err) => {
  console.error(`[paper:${PAPER_PROFILE}][fatal] ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
});