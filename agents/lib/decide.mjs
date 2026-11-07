// Pure decision rules for the forecasters. All probability comparisons are done on 1e18 integers so that a gap of
// EXACTLY the threshold is never "bigger" because of floating point.
import { FORECAST } from './config.mjs';
import { toX18 } from './fair.mjs';

export const EPSILON_X18 = 5n * 10n ** 15n; // QuantumRound.EPSILON = 0.005e18 (the contract value is read at runtime when available)

/** gap = pMarket - pFair. `thr` is a plain probability (0.005). Strict inequality in both directions. */
export function signalFor({ pMarketX18, pFairX18, threshold }) {
  const thr = toX18(threshold);
  const gapX18 = pMarketX18 - pFairX18;
  if (gapX18 > thr) return { gapX18, thresholdX18: thr, direction: 'lower', note: 'market above fair' };
  if (-gapX18 > thr) return { gapX18, thresholdX18: thr, direction: 'raise', note: 'market below fair' };
  return { gapX18, thresholdX18: thr, direction: null, note: 'inside threshold' };
}

/**
 * Which trade moves the price the way the signal wants?
 *  raise (market low): sell SHORT if we hold some (it is overpriced), otherwise buy LONG.
 *  lower (market high): sell LONG if we hold some, otherwise buy SHORT.
 * `allowSell` is false for the Guardian, which only ever buys protection.
 */
export function stageFor({ direction, position, allowSell, minSellRaw = FORECAST.minSellRaw }) {
  if (!direction) return null;
  if (direction === 'raise') {
    if (allowSell && position.short >= minSellRaw) return { kind: 'sell', side: 'short' };
    return { kind: 'buy', side: 'long' };
  }
  if (allowSell && position.long >= minSellRaw) return { kind: 'sell', side: 'long' };
  return { kind: 'buy', side: 'short' };
}

/**
 * Projected winner exactly as QuantumRound.collapse would pick it from the CURRENT probabilityTwap values
 * (the adapter already extrapolates the last price to tradingEnd): best = highest TWAP among proposals >= 1, lowest id on ties;
 * it wins only if its TWAP is strictly above proposal 0's TWAP plus EPSILON, otherwise the status quo (0) wins.
 * `twaps[i]` is a bigint or null (market not seeded / read failed); null proposals cannot lead.
 */
export function projectedLeader(twaps, epsilon = EPSILON_X18) {
  let best = 0;
  for (let p = 1; p < twaps.length; p++) {
    if (twaps[p] == null) continue;
    if (best === 0 || twaps[p] > twaps[best]) best = p;
  }
  const t0 = twaps[0];
  if (best !== 0 && t0 != null && twaps[best] > t0 + epsilon) return { leader: best, bestChallenger: best, statusQuoWins: false };
  return { leader: 0, bestChallenger: best || null, statusQuoWins: true };
}

/**
 * Guardian candidates: the projected leader plus every proposal whose SPOT price is at or above the status quo's.
 * Returns ids, leader first, then the rest in ascending id.
 */
export function guardianCandidates({ spots, twaps, epsilon }) {
  const { leader } = projectedLeader(twaps, epsilon);
  const ids = new Set([leader, 0]); // Status quo always meets its own spot-price threshold.
  const s0 = spots[0];
  if (s0 != null) for (let p = 1; p < spots.length; p++) if (spots[p] != null && spots[p] >= s0) ids.add(p);
  return { leader, ids: [leader, ...[...ids].filter((i) => i !== leader).sort((a, b) => a - b)] };
}

export const guardianThreshold = ({ now, tradingEnd, twapWindow }, cfg = FORECAST) =>
  (now >= tradingEnd - twapWindow ? cfg.guardianThresholdFinal : cfg.guardianThresholdOutside);

export const inFinalWindow = ({ now, tradingEnd, twapWindow }) => now >= tradingEnd - twapWindow && now < tradingEnd;
