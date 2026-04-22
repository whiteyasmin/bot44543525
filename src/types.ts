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
  maxEntryPrice: number;
  maxPositionUsdc: number;
  kellyEnabled: boolean;
  kellyFraction: number;
  kellyLookbackTrades: number;
  kellyMinTrades: number;
  kellyFallbackPct: number;
  kellyMaxPct: number;
  maxShares: number;
  depthUsageRatio: number;
  goodSpreadCents: number;
  okSpreadCents: number;
  minDepthToKellyRatio: number;
  thinDepthMultiplier: number;
  okDepthMultiplier: number;
  minOrderUsdc: number;
  maxEntrySlippageCents: number;
  maxSpreadCents: number;
  repriceIntervalMs: number;
  panicHedgeEnabled: boolean;
  panicLossCents: number;
  hedgeSizeRatio: number;
  minHedgeImprovementPct: number;
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
  source: string;
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
  trendAtEntry?: string;
  tailwind?: boolean;
  btcRegime?: BtcRegime;
  entryPriceBucket?: string;
  entryStrategyType?: string;
  entrySignalTier?: string;
  entrySignalMultiplier?: number;
  entryPressureScore?: number;
  entryTrendPressure?: number;
  entryMispricePressure?: number;
  entryReversalRisk?: number;
  secondsLeftAtEntry?: number;
  kellyPct?: number;
  kellySource?: string;
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
  btcRegime: BtcRegime | null;
  secondInBucket: number;
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  bookUpdatedAt: string | null;
  position: Position | null;
  lastAction: string;
  paperBalance: number;
  realizedPnl: number;
  updatedAt: string | null;
  decision: DecisionState;
}

export interface BtcRegime {
  label: "uptrend" | "downtrend" | "up_reversal" | "down_reversal" | "chop";
  moveDirection: "up" | "down" | "flat";
  velocityDirection: "up" | "down" | "flat";
  entrySide: Side | null;
  strength: number;
}

export interface DecisionState {
  checkedAt: string | null;
  enabled: boolean;
  status: string;
  side: Side | null;
  reason: string;
  details: Record<string, unknown>;
}
