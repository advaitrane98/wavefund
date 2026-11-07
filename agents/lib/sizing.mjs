// Quote-based trade sizing. Pure given an injected `batch` reader; talks to no chain itself.
//
// WHAT THE ADAPTER GIVES US (WaveV4ProposalMarket quote views, units: credits 6 decimals, LONG/SHORT 18 decimals)
//   quoteBuyLong/Short(r, p, credits)     -> totalOut = credits*1e12 (the retained complete-set leg) + swapOutput.
//   quoteSellLong/Short(r, p, amountIn)   -> (creditsOut, longDust, shortDust). The contract swaps `s` of the sold token and
//                                            pairs the rest with the swap output, so  remaining = amountIn - s
//                                              = creditsOut*1e12 + soldDust   and   swapOutput = creditsOut*1e12 + otherDust.
//                                            Hence  s = amountIn - creditsOut*1e12 - soldDust,  out = creditsOut*1e12 + otherDust.
//   The views return OUTPUT ONLY. There is no post-trade price anywhere, so the terminal price must be derived.
//
// TERMINAL PRICE FROM QUOTES
//   Every trade is one exact-input swap of a token X (the input leg) for the other token. With P = SHORT per LONG (pLong = P/(1+P)),
//   the marginal rate at the END of the swap is  m = d(out)/d(in) = phi * P   when X = LONG,   phi / P   when X = SHORT,
//   where phi = (1 - fee) is the fee/rounding factor. We measure m by a CENTRAL FINITE DIFFERENCE of two quotes around the trade
//   size, never by the average execution price (out/in), which lags the terminal price by half the price impact.
//   phi is calibrated on the same pool at the same block from a micro quote (1 and 2 micro-credits, where price impact is ~1e-7):
//   phi = m0 / P0 (X = LONG) or m0 * P0 (X = SHORT), with P0 from the spot pLong read in the SAME batch. This absorbs the 0.3% pool
//   fee, any protocol fee and the exact-input rounding. Then
//        X = LONG :  pEst = m / (phi + m)           X = SHORT :  pEst = phi / (phi + m)
//
// SEARCH
//   The probability reached is monotone in the trade size. Round 1 evaluates K sizes spread over (0, cap]; the first size that
//   overshoots the target (or is not quotable, e.g. InsufficientDepth) brackets the answer, and up to 4 refinements evaluate K sizes
//   inside the bracket. Each round is ONE batched read, so a size costs at most 5 round trips. The answer is the largest evaluated
//   size that does not pass the target, so the trade never overshoots fair value.
//
// TOLERANCE
//   - finite difference: relative error in m is O((d/x)^2) with d = x/32 (about 1e-3 of the price impact), plus 1-unit output rounding
//     (1e-12 relative at the smallest size). In probability this is far below 1e-4 on a 5-credit pool (tested against exact curves).
//   - bracket: the search stops at a width of max(1, cap/5000) (0.0002 credit for a 1-credit cap), about 0.002 probability points.
//   - the result carries `estX18` (terminal estimate at the chosen size) and `residualX18 = |estX18 - target|` so callers can log it.
export const SCALE = 10n ** 12n; // raw units per credit
const ONE = 10n ** 18n;
export const GRID = 16;
export const MAX_ROUNDS = 5; // 1 grid round + up to 4 refinements

export class SizingError extends Error {
  constructor(message, code = 'sizing') {
    super(message);
    this.name = 'SizingError';
    this.code = code;
  }
}

const OTHER = { long: 'short', short: 'long' };

/** The leg that goes INTO the pool: buying LONG spends SHORT, selling LONG spends LONG, etc. */
export const inputLeg = (kind, side) => (kind === 'buy' ? OTHER[side] : side);
/** Does this trade push pLong up? Buying LONG or selling SHORT. */
export const raisesPLong = (kind, side) => (kind === 'buy') === (side === 'long');

/** Slippage floor on an adapter quote: quote * 995 / 1000. Never a formula, never a constant. */
export function minOutFromQuote(quote, num = 995n, den = 1000n) {
  if (typeof quote !== 'bigint' || quote <= 0n) throw new SizingError('minOut needs a positive adapter quote', 'no-quote');
  return (quote * num) / den;
}

/** Turns one quote result into the swap (in, out) it implies. Returns null if it is unusable. */
export function swapPoint(kind, side, x, value) {
  if (kind === 'buy') {
    const input = x * SCALE;
    if (typeof value !== 'bigint' || value <= input) return null;
    return { inRaw: input, outRaw: value - input, quote: value };
  }
  const { credits, longDust, shortDust } = value ?? {};
  if (credits == null) return null;
  const soldDust = side === 'long' ? longDust : shortDust;
  const otherDust = side === 'long' ? shortDust : longDust;
  const remaining = credits * SCALE + soldDust;
  const inRaw = x - remaining;
  const outRaw = credits * SCALE + otherDust;
  if (inRaw <= 0n || outRaw <= 0n) return null;
  return { inRaw, outRaw, quote: credits };
}

/** Terminal probability (1e18) from a marginal rate m (1e18), calibration phi (1e18) and the input leg. */
export function terminalFromMarginal(m, phi, leg) {
  if (m <= 0n) return null;
  return leg === 'long' ? (m * ONE) / (phi + m) : (phi * ONE) / (phi + m);
}

/** phi from a micro-size marginal rate m0 and the spot pLong (1e18). */
export function calibratePhi(m0, pLongX18, leg) {
  if (m0 <= 0n || pLongX18 <= 0n || pLongX18 >= ONE) throw new SizingError('cannot calibrate fee factor from the quotes', 'calibration');
  const P0 = (pLongX18 * ONE) / (ONE - pLongX18); // SHORT per LONG
  const phi = leg === 'long' ? (m0 * ONE) / P0 : (m0 * P0) / ONE;
  if (phi < ONE / 2n || phi > (ONE * 1001n) / 1000n) throw new SizingError(`fee factor ${Number(phi) / 1e18} from the quotes is implausible`, 'calibration');
  return phi;
}

const marginal = (a, b) => ((b.outRaw - a.outRaw) * ONE) / (b.inRaw - a.inRaw);

function stepFor(kind, x) {
  if (kind === 'buy') return x / 32n > 0n ? x / 32n : 1n;
  const d = x / 32n;
  return d > 10n ** 13n ? d : 10n ** 13n;
}

const keyOf = (kind, side, x) => `${kind}:${side}:${x}`;

/**
 * @param {object} p
 * @param {'buy'|'sell'} p.kind
 * @param {'long'|'short'} p.side            the token being bought or sold
 * @param {bigint} p.targetX18               pFair (1e18)
 * @param {bigint} p.xMax                    cap: micro-credits for a buy, raw token units for a sell
 * @param {Function} p.batch                 async ({ requests: [{kind, side, x}] }) => { pLongX18, results: [{ ok, value } | { ok: false, error }] }
 */
export async function sizeMove({ kind, side, targetX18, xMax, batch, grid = GRID, maxRounds = MAX_ROUNDS }) {
  const base = { kind, side, targetX18, rounds: 0, quotes: 0 };
  if (!(xMax > 0n)) return { ...base, size: 0n, reason: 'no-room', reachable: false };
  const leg = inputLeg(kind, side);
  const raise = raisesPLong(kind, side);
  const calSide = kind === 'buy' ? side : OTHER[side]; // same swap direction, expressed as a buy
  const cache = new Map();
  let pLong0;
  let phi;

  async function run(xs, withCalibration) {
    const reqs = [];
    const want = (k, s, x) => { if (!cache.has(keyOf(k, s, x)) && !reqs.some((r) => keyOf(r.kind, r.side, r.x) === keyOf(k, s, x))) reqs.push({ kind: k, side: s, x }); };
    if (withCalibration) { want('buy', calSide, 1n); want('buy', calSide, 2n); }
    for (const x of xs) {
      want(kind, side, x);
      want(kind, side, x > stepFor(kind, x) ? x - stepFor(kind, x) : 1n);
      want(kind, side, x + stepFor(kind, x));
    }
    const out = await batch({ requests: reqs });
    base.rounds++;
    base.quotes += reqs.length;
    pLong0 = out.pLongX18;
    reqs.forEach((r, i) => cache.set(keyOf(r.kind, r.side, r.x), out.results[i]));
  }

  const point = (k, s, x) => {
    const r = cache.get(keyOf(k, s, x));
    return r?.ok ? swapPoint(k, s, x, r.value) : null;
  };

  function evaluate(x) {
    const mid = point(kind, side, x);
    if (!mid) return { x, quotable: false };
    const step = stepFor(kind, x);
    const lo = point(kind, side, x > step ? x - step : 1n);
    const hi = point(kind, side, x + step);
    const pair = lo && hi && lo.inRaw < hi.inRaw ? [lo, hi] : lo && lo.inRaw < mid.inRaw ? [lo, mid] : null;
    if (!pair || pair[1].outRaw <= pair[0].outRaw) return { x, quotable: false };
    const m = marginal(pair[0], pair[1]);
    const est = terminalFromMarginal(m, phi, leg);
    if (est == null) return { x, quotable: false };
    return { x, quotable: true, estX18: est, over: raise ? est > targetX18 : est < targetX18, quote: mid.quote };
  }

  const spread = (lo, hi, n) => {
    const xs = [];
    for (let i = 1; i <= n; i++) {
      const x = lo + ((hi - lo) * BigInt(i)) / BigInt(n + 1);
      if (x > lo && x < hi && xs[xs.length - 1] !== x) xs.push(x);
    }
    return xs;
  };

  // ---- round 1: calibration + a grid over (0, xMax]
  const first = [];
  for (let i = 1; i <= grid; i++) {
    const x = (xMax * BigInt(i) + BigInt(grid) - 1n) / BigInt(grid);
    if (first[first.length - 1] !== x) first.push(x);
  }
  await run(first, true);
  const c1 = point('buy', calSide, 1n);
  const c2 = point('buy', calSide, 2n);
  if (!c1 || !c2 || c2.inRaw <= c1.inRaw || c2.outRaw <= c1.outRaw) throw new SizingError('micro quotes unavailable: cannot calibrate (pool empty or trading closed)', 'calibration');
  phi = calibratePhi(marginal(c1, c2), pLong0, leg);
  const spotX18 = pLong0;
  const result = { ...base, spotX18, phi };
  if (raise ? spotX18 >= targetX18 : spotX18 <= targetX18) return { ...result, size: 0n, reason: 'spot-at-or-past-target', reachable: false };

  const evals = new Map();
  const evalAll = (xs) => xs.forEach((x) => evals.set(x, evaluate(x)));
  evalAll(first);
  let lo = 0n;
  let hi = null;
  let hiKind = null;
  for (const x of first) {
    const e = evals.get(x);
    if (!e.quotable || e.over) { hi = x; hiKind = e.quotable ? 'over' : 'depth'; break; }
    lo = x;
  }
  const tolerance = xMax / 5000n > 1n ? xMax / 5000n : 1n;
  while (hi != null && hi - lo > tolerance && base.rounds < maxRounds) {
    const xs = spread(lo, hi, grid);
    if (!xs.length) break;
    await run(xs, false);
    evalAll(xs);
    for (const x of xs) {
      const e = evals.get(x);
      if (!e.quotable || e.over) { hi = x; hiKind = e.quotable ? 'over' : 'depth'; break; }
      lo = x;
    }
  }
  const chosen = lo > 0n ? evals.get(lo) : null;
  const capBound = hi == null;
  const out = {
    ...result, rounds: base.rounds, quotes: base.quotes, size: lo, bracket: [lo, hi],
    capBound, depthBound: hiKind === 'depth', reachable: hi != null && hiKind === 'over',
  };
  if (!chosen) return { ...out, reason: hiKind === 'depth' ? 'depth-no-quotable-size' : 'target-within-one-unit', size: 0n, reachable: false };
  const residual = chosen.estX18 > targetX18 ? chosen.estX18 - targetX18 : targetX18 - chosen.estX18;
  return {
    ...out, estX18: chosen.estX18, residualX18: residual, quote: chosen.quote,
    reason: capBound ? 'cap-bound (target not reached)' : hiKind === 'depth' ? 'depth-bound (target not reached)' : 'target reached',
  };
}
