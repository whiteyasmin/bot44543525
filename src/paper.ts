import type { FillResult, OrderBook } from "./types.js";

export function bestBid(book: OrderBook) {
  return book.bids[0]?.price ?? null;
}

export function bestAsk(book: OrderBook) {
  return book.asks[0]?.price ?? null;
}

export function spreadCents(book: OrderBook) {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid == null || ask == null) return Number.POSITIVE_INFINITY;
  return (ask - bid) * 100;
}

export function askDepthUsdc(book: OrderBook, maxPrice: number) {
  return book.asks.filter((l) => l.price <= maxPrice).reduce((sum, l) => sum + l.price * l.size, 0);
}

export function bidDepthShares(book: OrderBook, minPrice: number) {
  return book.bids.filter((l) => l.price >= minPrice).reduce((sum, l) => sum + l.size, 0);
}

export function simulateBuy(book: OrderBook, targetUsdc: number, maxSlippageCents: number): FillResult {
  const ask = bestAsk(book);
  if (ask == null || targetUsdc <= 0) return emptyFill(0, ask);
  const maxPrice = ask + maxSlippageCents / 100;
  let remaining = targetUsdc;
  let shares = 0;
  let value = 0;

  for (const level of book.asks) {
    if (level.price > maxPrice || remaining <= 0) break;
    const levelUsdc = level.price * level.size;
    const spend = Math.min(remaining, levelUsdc);
    const levelShares = spend / level.price;
    shares += levelShares;
    value += spend;
    remaining -= spend;
  }

  const avgPrice = shares > 0 ? value / shares : null;
  return {
    shares,
    value,
    avgPrice,
    slippageCents: avgPrice == null ? 0 : (avgPrice - ask) * 100,
    fillRatio: targetUsdc > 0 ? value / targetUsdc : 0,
    bestPrice: ask
  };
}

export function simulateSell(book: OrderBook, targetShares: number, maxSlippageCents: number): FillResult {
  const bid = bestBid(book);
  if (bid == null || targetShares <= 0) return emptyFill(targetShares, bid);
  const minPrice = bid - maxSlippageCents / 100;
  let remaining = targetShares;
  let shares = 0;
  let value = 0;

  for (const level of book.bids) {
    if (level.price < minPrice || remaining <= 0) break;
    const levelShares = Math.min(remaining, level.size);
    shares += levelShares;
    value += levelShares * level.price;
    remaining -= levelShares;
  }

  const avgPrice = shares > 0 ? value / shares : null;
  return {
    shares,
    value,
    avgPrice,
    slippageCents: avgPrice == null ? 0 : (bid - avgPrice) * 100,
    fillRatio: targetShares > 0 ? shares / targetShares : 0,
    bestPrice: bid
  };
}

function emptyFill(target: number, bestPrice: number | null): FillResult {
  return { shares: 0, value: 0, avgPrice: null, slippageCents: 0, fillRatio: target > 0 ? 0 : 1, bestPrice };
}
