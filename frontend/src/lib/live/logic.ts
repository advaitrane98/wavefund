/** Pure helpers for live mode: round phases, implied return, and the pLong-after estimate. */

export type RoundPhase =
  | "none"
  | "trading"
  | "closed"
  | "evaluating"
  | "awaiting-settlement"
  | "settled"
  | "cancelled";

/** QuantumRound's RoundStatus enum: None, Trading, Collapsed, Settled, Cancelled. */
export const STATUS = { None: 0, Trading: 1, Collapsed: 2, Settled: 3, Cancelled: 4 } as const;

export function computePhase(
  status: number,
  nowSec: number,
  tradingEnd: number,
  evaluationEnd: number,
): RoundPhase {
  switch (status) {
    case STATUS.Trading:
      return nowSec < tradingEnd ? "trading" : "closed";
    case STATUS.Collapsed:
      return nowSec < evaluationEnd ? "evaluating" : "awaiting-settlement";
    case STATUS.Settled:
      return "settled";
    case STATUS.Cancelled:
      return "cancelled";
    default:
      return "none";
  }
}

/** True during the last `twapWindow` seconds of trading. */
export const inFinalWindow = (nowSec: number, tradingEnd: number, twapWindow: number): boolean =>
  nowSec >= tradingEnd - twapWindow && nowSec < tradingEnd;

/** A 1e18 return ratio (R = NAV now / NAV at decision) as a fraction change, e.g. 1.034e18 -> 0.034. */
export const ratioToReturn = (ratio: bigint): number => Number(ratio) / 1e18 - 1;

/** Implied return = rMin + pLong x (rMax - rMin), as a fraction change. Inputs are 1e18 fixed point. */
export function impliedReturn(pLong: bigint, rMin: bigint, rMax: bigint): number {
  const ratio = rMin + (pLong * (rMax - rMin)) / 10n ** 18n;
  return ratioToReturn(ratio);
}

export const PROBABILITY_MIN = 0.01;
export const PROBABILITY_MAX = 0.99;
/** Warn when a trade would leave pLong within this margin of a bound. */
export const BOUND_WARNING_MARGIN = 0.02;

export function nearBound(pLong: number): boolean {
  return (
    pLong <= PROBABILITY_MIN + BOUND_WARNING_MARGIN || pLong >= PROBABILITY_MAX - BOUND_WARNING_MARGIN
  );
}

const clamp = (x: number): number => Math.min(PROBABILITY_MAX, Math.max(PROBABILITY_MIN, x));

/**
 * Estimates pLong after a trade from the adapter's quote.
 *
 * The market is one concentrated-liquidity position with liquidity L = seedCredits x 1e12. With
 * P = pLong / pShort (SHORT per LONG) and s = sqrt(P), its virtual reserves are LONG = L / s and
 * SHORT = L x s. A swap that takes `legOutCredits` (in credit-sized units, raw / 1e12) of one leg out
 * of the pool moves s by legOut / L. This is an estimate, labelled as such in the UI.
 *
 * `legOutCredits` is the swap output: for a buy, quoteOut minus the credits spent; for a sell, the
 * matched credits plus the returned dust of the output leg.
 */
export function estimatePLongAfter(args: {
  action: "buy" | "sell";
  side: "LONG" | "SHORT";
  pLong: number;
  seedCredits: number;
  legOutCredits: number;
}): number {
  const { action, side, pLong, seedCredits, legOutCredits } = args;
  if (!(seedCredits > 0) || !(legOutCredits >= 0)) return pLong;
  const s = Math.sqrt(clamp(pLong) / (1 - clamp(pLong)));
  const outputLeg: "LONG" | "SHORT" =
    action === "buy" ? side : side === "LONG" ? "SHORT" : "LONG";

  let next: number;
  if (outputLeg === "LONG") {
    // LONG leaves the pool: LONG reserve L / s shrinks, so s grows.
    const inv = 1 / s - legOutCredits / seedCredits;
    next = inv <= 0 ? Number.POSITIVE_INFINITY : 1 / inv;
  } else {
    // SHORT leaves the pool: SHORT reserve L x s shrinks, so s falls.
    next = s - legOutCredits / seedCredits;
    if (next <= 0) next = 0;
  }
  const p = (next * next) / (1 + next * next);
  return Number.isFinite(next) ? clamp(p) : PROBABILITY_MAX;
}

/** Seconds as a compact countdown, e.g. 3725 -> "1h 02m 05s". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
