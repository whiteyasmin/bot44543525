export interface AskSnapshot {
  ts: number;
  upAsk: number;
  downAsk: number;
}

export interface DumpBaseline {
  oldest: { upAsk: number; downAsk: number };
  upDrop: number;
  downDrop: number;
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

    const baseSnapshots = oldSnapshots.slice(0, Math.min(3, oldSnapshots.length));
    const oldest = {
      upAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.upAsk, 0) / baseSnapshots.length,
      downAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.downAsk, 0) / baseSnapshots.length,
    };

    const latest = this.askSnapshots[this.askSnapshots.length - 1];
    const upDrop = oldest.upAsk > 0.10 ? (oldest.upAsk - latest.upAsk) / oldest.upAsk : 0;
    const downDrop = oldest.downAsk > 0.10 ? (oldest.downAsk - latest.downAsk) / oldest.downAsk : 0;

    return { oldest, upDrop, downDrop };
  }
}