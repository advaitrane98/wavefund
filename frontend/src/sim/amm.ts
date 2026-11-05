import type { Reserves, Side } from "./types";

/** Slippage tolerance applied to every ticket. */
export const SLIPPAGE = 0.005;

export interface Quote {
  /** Tokens received (buy) or credits received (sell). */
  out: number;
  /** Credits per token. */
  avgPrice: number;
  /** Spot price of the traded side before the trade. */
  spot: number;
  /** Price impact as a fraction (positive = worse for you). */
  impact: number;
  pLongAfter: number;
  reservesAfter: Reserves;
  /** Minimum received after slippage. */
  minOut: number;
}

export const pLongOf = (r: Reserves): number => r.short / (r.long + r.short);

const spotOf = (r: Reserves, side: Side): number =>
  side === "LONG" ? pLongOf(r) : 1 - pLongOf(r);

/**
 * Buy: mint `credits` complete sets, then swap the unwanted side into the pool
 * against a constant-product curve.
 */
export function quoteBuy(r: Reserves, side: Side, credits: number): Quote | null {
  if (!(credits > 0)) return null;
  const k = r.long * r.short;
  let reservesAfter: Reserves;
  let pooled: number;
  if (side === "LONG") {
    const short = r.short + credits;
    const long = k / short;
    reservesAfter = { long, short };
    pooled = r.long - long;
  } else {
    const long = r.long + credits;
    const short = k / long;
    reservesAfter = { long, short };
    pooled = r.short - short;
  }
  const out = credits + pooled;
  const spot = spotOf(r, side);
  const avgPrice = credits / out;
  return {
    out,
    avgPrice,
    spot,
    impact: avgPrice / spot - 1,
    pLongAfter: pLongOf(reservesAfter),
    reservesAfter,
    minOut: out * (1 - SLIPPAGE),
  };
}

/**
 * Sell: give `tokens` of one side to the pool and take out credits so the
 * constant-product invariant holds. Solves
 * (A + x - c)(B - c) = A * B for c, where A is the reserve of the sold side.
 */
export function quoteSell(r: Reserves, side: Side, tokens: number): Quote | null {
  if (!(tokens > 0)) return null;
  const a = side === "LONG" ? r.long : r.short;
  const b = side === "LONG" ? r.short : r.long;
  const sum = a + tokens + b;
  const credits = (sum - Math.sqrt(sum * sum - 4 * tokens * b)) / 2;
  const aAfter = a + tokens - credits;
  const bAfter = b - credits;
  const reservesAfter: Reserves =
    side === "LONG" ? { long: aAfter, short: bAfter } : { long: bAfter, short: aAfter };
  const spot = spotOf(r, side);
  const avgPrice = credits / tokens;
  return {
    out: credits,
    avgPrice,
    spot,
    impact: 1 - avgPrice / spot,
    pLongAfter: pLongOf(reservesAfter),
    reservesAfter,
    minOut: credits * (1 - SLIPPAGE),
  };
}

/** Implied return = rMin + pLong × (rMax − rMin). */
export const impliedReturn = (pLong: number, rMin: number, rMax: number): number =>
  rMin + pLong * (rMax - rMin);

/** Time-weighted average of the last `window` pLong samples. */
export function twapOf(samples: number[], window = 12): number {
  const slice = samples.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
