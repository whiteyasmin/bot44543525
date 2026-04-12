export interface AskSnapshot {
  ts: number;
  upAsk: number;
  downAsk: number;
}

export interface DumpBaseline {
  oldest: { upAsk: number; downAsk: number };
  peak: { upAsk: number; downAsk: number };
  upDrop: number;
  downDrop: number;
  upDropMs: number;   // 从峰值到当前经过的毫秒数 (用于计算dump velocity)
  downDropMs: number;
}

export class RoundMarketState {
  private askSnapshots: AskSnapshot[] = [];

  reset(): void {
    this.askSnapshots = [];
  }

  push(upAsk: number, downAsk: number, retainMs: number, now = Date.now()): void {
    this.askSnapshots.push({ ts: now, upAsk, downAsk });
    const cutoff = now - retainMs;
    this.askSnapshots = this.askSnapshots.filter((snapshot) => snapshot.ts >= cutoff);
  }

  getDumpBaseline(minAgeMs: number, now = Date.now()): DumpBaseline | null {
    const oldSnapshots = this.askSnapshots.filter((snapshot) => now - snapshot.ts >= minAgeMs);
    if (oldSnapshots.length === 0) return null;

    // oldest基准: 最早3个快照均值 (原有逻辑)
    const baseSnapshots = oldSnapshots.slice(0, Math.min(3, oldSnapshots.length));
    const oldest = {
      upAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.upAsk, 0) / baseSnapshots.length,
      downAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.downAsk, 0) / baseSnapshots.length,
    };

    // peak基准: 窗口内各侧最高ask (捕捉"从哪里砸下来的")
    let peakUpAsk = 0;
    let peakUpTs = now;
    let peakDownAsk = 0;
    let peakDownTs = now;
    for (const snap of this.askSnapshots) {
      if (snap.upAsk > peakUpAsk) { peakUpAsk = snap.upAsk; peakUpTs = snap.ts; }
      if (snap.downAsk > peakDownAsk) { peakDownAsk = snap.downAsk; peakDownTs = snap.ts; }
    }
    const peak = { upAsk: peakUpAsk, downAsk: peakDownAsk };

    const latest = this.askSnapshots[this.askSnapshots.length - 1];

    // 跌幅取 oldest基准 和 peak基准 中更大者
    const upDropOldest = oldest.upAsk > 0.10 ? (oldest.upAsk - latest.upAsk) / oldest.upAsk : 0;
    const upDropPeak = peakUpAsk > 0.10 ? (peakUpAsk - latest.upAsk) / peakUpAsk : 0;
    const downDropOldest = oldest.downAsk > 0.10 ? (oldest.downAsk - latest.downAsk) / oldest.downAsk : 0;
    const downDropPeak = peakDownAsk > 0.10 ? (peakDownAsk - latest.downAsk) / peakDownAsk : 0;

    const upDrop = Math.max(upDropOldest, upDropPeak);
    const downDrop = Math.max(downDropOldest, downDropPeak);

    // 从峰值到当前的时间跨度 (ms), 用于计算dump velocity
    const upDropMs = Math.max(1, now - peakUpTs);
    const downDropMs = Math.max(1, now - peakDownTs);

    return { oldest, peak, upDrop, downDrop, upDropMs, downDropMs };
  }
}
