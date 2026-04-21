export type Side = "UP" | "DOWN";
export type PositionStatus = "open" | "hedged" | "closed";

export interface Settings {
  botEnabled: boolean;
  paperMode: boolean;
  autoDiscoverMarket: boolean;
  manualMarketUrl: string;
  entryStartSeconds: number;
  entryEndSeconds: number;
  minBtcMoveBps: number;
  velocityLookbackSeconds: number;
  minBtcVelocityBps: number;
  reversalExitBps: number;
  maxEntryPrice: number;
  minEdgeBps: number;
  maxPositionUsdc: number;
  maxShares: number;
  depthUsageRatio: number;
  minOrderUsdc: number;
  maxEntrySlippageCents: number;
  maxExitSlippageCents: number;
  maxSpreadCents: number;
  repriceIntervalMs: number;
  takeProfitCents: number;
  stopLossCents: number;
  maxHoldSeconds: number;
  exitBeforeResolveSeconds: number;
  panicHedgeEnabled: boolean;
  panicLossCents: number;
  panicBtcReversalBps: number;
  minExitFillRatio: number;
  hedgeSizeRatio: number;
  maxHedgePrice: number;
  maxHedgeSlippageCents: number;
  paperBalance: number;
  feeBps: number;
  enableSnapshots: boolean;
  snapshotIntervalMs: number;
  enableOrderbookLogs: boolean;
  keepMaxLogMb: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  minOrderSize?: number;
  tickSize?: number;
  timestamp?: string;
}

export interface MarketInfo {
  slug: string;
  url: string;
  bucketStart: number;
  bucketEnd: number;
  conditionId?: string;
  upTokenId: string;
  downTokenId: string;
  title?: string;
}

export interface BtcTick {
  timestamp: number;
  price: number;
  open: number;
}

export interface Position {
  id: string;
  marketSlug: string;
  side: Side;
  status: PositionStatus;
  entryTime: string;
  entrySecond: number;
  bucketStart: number;
  bucketEnd: number;
  shares: number;
  entryAvgPrice: number;
  entryCost: number;
  btcOpen: number;
  btcEntry: number;
  entryMoveBps: number;
  entryVelocityBps: number;
  hedgeSide?: Side;
  hedgeShares?: number;
  hedgeAvgPrice?: number;
  hedgeCost?: number;
}

export interface FillResult {
  shares: number;
  value: number;
  avgPrice: number | null;
  slippageCents: number;
  fillRatio: number;
  bestPrice: number | null;
}

export interface RuntimeState {
  running: boolean;
  lastError: string | null;
  currentMarket: MarketInfo | null;
  btc: BtcTick | null;
  moveBps: number;
  velocityBps: number;
  secondInBucket: number;
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  position: Position | null;
  lastAction: string;
  paperBalance: number;
  realizedPnl: number;
  updatedAt: string | null;
}
