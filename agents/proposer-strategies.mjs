// Proposer strategies: each outputs a target tETH allocation in bps plus an on-chain rationale (< 280 chars, one line).
//   Momentum         5000 + clamp(z, -2, 2) * 1750, z = ln(price / price 10 min ago) / (sigma_per_minute * sqrt(10))
//   Mean-reversion   5000 - clamp(z, -2, 2) * 1750, z = ln(price / 30-minute average) / (sigma_per_minute * sqrt(30))
//   News             Claude (strict JSON, headlines untrusted) with a deterministic keyword fallback
// All allocations are rounded to 100 bps and bounded to 1000-9000. A diversity step then keeps every proposal at
// least 500 bps from the status quo and from every other proposal.
import { askClaude, fallbackSignal } from './lib/news.mjs';

export const BOUNDS = { min: 1000, max: 9000 };
export const SLOT = 100;
export const MIN_GAP = 500;
export const WINDOW = 30; // contiguous 1-minute closes
export const RATIONALE_LIMIT = 280; // on-chain rationale must be shorter than this

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const toSlot = (bps) => clamp(Math.round(bps / SLOT) * SLOT, BOUNDS.min, BOUNDS.max);
const pct = (bps) => `${bps / 100}%`;
const signed = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

export class DataError extends Error {}

// ---------------------------------------------------------------- signals

/** The latest 30 one-minute closes; they must be contiguous (consecutive timestamps 60 s apart). */
export function latestCloses(candles, n = WINDOW) {
  const w = candles.slice(-n);
  if (w.length < n) throw new DataError(`need ${n} one-minute closes, have ${w.length}`);
  for (let i = 1; i < w.length; i++) {
    if (w[i].t - w[i - 1].t !== 60) throw new DataError(`the last ${n} candles are not contiguous (gap before ${new Date(w[i].t * 1000).toISOString()})`);
  }
  return w.map((c) => c.close);
}

export function sigmaPerMinute(closes) {
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
}

export function momentumSignal(candles) {
  const closes = latestCloses(candles);
  const now = closes[closes.length - 1];
  const ago = closes[closes.length - 1 - 10];
  const trend = Math.log(now / ago);
  const sigma = sigmaPerMinute(closes);
  const z = sigma > 0 ? trend / (sigma * Math.sqrt(10)) : 0;
  return { price: now, trend, sigma, z, rawBps: toSlot(5000 + clamp(z, -2, 2) * 1750) };
}

export function meanReversionSignal(candles) {
  const closes = latestCloses(candles);
  const price = closes[closes.length - 1];
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
  const deviation = Math.log(price / avg);
  const sigma = sigmaPerMinute(closes);
  const z = sigma > 0 ? deviation / (sigma * Math.sqrt(30)) : 0;
  return { price, average: avg, deviation, sigma, z, rawBps: toSlot(5000 - clamp(z, -2, 2) * 1750) };
}

// ---------------------------------------------------------------- diversity

/**
 * Keeps `bps` at least `gap` away from every value in `others`. Walks in 100 bps slots from the signal in the agent's
 * own direction to the nearest valid slot; if there is none inside the bounds it tries the opposite side once;
 * otherwise it skips. `direction` is +1 (more tETH) or -1.
 */
export function diversify({ signalBps, direction, others, gap = MIN_GAP, min = BOUNDS.min, max = BOUNDS.max }) {
  const ok = (x) => others.every((o) => Math.abs(x - o) >= gap);
  if (ok(signalBps)) return { bps: signalBps, shifted: false };
  const walk = (dir) => {
    for (let x = signalBps + dir * SLOT; x >= min && x <= max; x += dir * SLOT) if (ok(x)) return x;
    return null;
  };
  const same = walk(direction);
  if (same != null) return { bps: same, shifted: true, side: 'signal direction' };
  const opposite = walk(-direction);
  if (opposite != null) return { bps: opposite, shifted: true, side: 'opposite direction' };
  return { skip: true, reason: `no slot at least ${gap} bps from [${others.join(', ')}] inside ${min}-${max}` };
}

export function directionOf(signalBps, statusQuoBps) {
  if (signalBps !== 5000) return signalBps > 5000 ? 1 : -1;
  if (statusQuoBps !== 5000) return statusQuoBps < 5000 ? 1 : -1;
  return 1;
}

// ---------------------------------------------------------------- rationale

export function finalizeRationale(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length < RATIONALE_LIMIT ? oneLine : `${oneLine.slice(0, RATIONALE_LIMIT - 4)}...`;
}

function shiftClause(rawBps, d) {
  return `signal suggests ${pct(rawBps)}; shifted to ${pct(d.bps)} to stay distinct`;
}

// ---------------------------------------------------------------- the three proposers

async function newsSignal({ headlines, z, statusQuoBps, env, fetchImpl, llm }) {
  const ask = llm ?? askClaude;
  if (!headlines.length) {
    const fb = fallbackSignal({ headlines, z });
    return { source: 'fallback', why: 'no CoinDesk headlines in the last 24 h; using the trend only', ...fb, rawBps: toSlot(fb.rawBps) };
  }
  const answer = await ask({ headlines, z, statusQuoBps, env, fetchImpl });
  if (answer.ok) {
    return { source: 'claude', why: `Claude (${answer.model ?? 'model'}) returned a valid answer`, rawBps: toSlot(answer.tEthBps), claudeBps: answer.tEthBps, claudeRationale: answer.rationale };
  }
  const fb = fallbackSignal({ headlines, z });
  return { source: 'fallback', why: answer.why, ...fb, rawBps: toSlot(fb.rawBps) };
}

/**
 * Decides one proposer's proposal.
 * @param def            agent definition ({ key, name })
 * @param candles        Coinbase 1-minute candles, oldest first ({ t, close })
 * @param statusQuoBps   the status quo allocation
 * @param others         bps of every other proposal that must stay distinct: existing ones, plus ones chosen earlier this cycle
 * @param headlines      sanitised CoinDesk headlines (News only)
 */
export async function decideProposal({ def, candles, statusQuoBps, others = [], headlines = [], env = process.env, fetchImpl, llm }) {
  const taken = [statusQuoBps, ...others];
  let sig;
  let evidence;
  let source = def.key;
  let why;
  let claudeRationale;
  try {
    if (def.key === 'momentum') {
      sig = momentumSignal(candles);
      evidence = `10m trend ${signed(sig.trend * 100, 3)}% (z ${signed(sig.z)})`;
      why = `z = ${sig.trend.toFixed(6)} / (${sig.sigma.toFixed(6)} * sqrt(10)) = ${sig.z.toFixed(3)}`;
    } else if (def.key === 'mean_reversion') {
      sig = meanReversionSignal(candles);
      evidence = `price ${signed(sig.deviation * 100, 3)}% vs 30m average (z ${signed(sig.z)})`;
      why = `z = ${sig.deviation.toFixed(6)} / (${sig.sigma.toFixed(6)} * sqrt(30)) = ${sig.z.toFixed(3)}`;
    } else if (def.key === 'news') {
      const mom = momentumSignal(candles);
      const n = await newsSignal({ headlines, z: mom.z, statusQuoBps, env, fetchImpl, llm });
      sig = { ...mom, ...n };
      source = n.source;
      why = n.why;
      claudeRationale = n.claudeRationale;
      evidence = n.source === 'claude'
        ? `Claude read ${headlines.length} headlines`
        : `headlines score ${signed(n.newsScore ?? 0)}, trend z ${signed(mom.z)}`;
    } else {
      throw new Error(`unknown proposer ${def.key}`);
    }
  } catch (err) {
    if (err instanceof DataError) return { agent: def.key, action: 'skip', source, skipReason: `market data: ${err.message}` };
    throw err;
  }

  const rawBps = sig.rawBps;
  const direction = directionOf(rawBps, statusQuoBps);
  const d = diversify({ signalBps: rawBps, direction, others: taken });
  const base = {
    agent: def.key, source, why, rawBps, direction, others: taken, z: sig.z,
    signal: { price: sig.price, trend: sig.trend, deviation: sig.deviation, sigma: sig.sigma, newsScore: sig.newsScore, trendNorm: sig.trendNorm, claudeBps: sig.claudeBps },
  };
  if (d.skip) return { ...base, action: 'skip', skipReason: d.reason };

  let rationale;
  if (source === 'claude') {
    rationale = d.shifted ? `${claudeRationale} (${shiftClause(rawBps, d)})` : claudeRationale;
  } else if (source === 'fallback') {
    rationale = d.shifted ? `News (fallback used): ${evidence}; ${shiftClause(rawBps, d)}.` : `News (fallback used): ${evidence} -> ${pct(rawBps)} tETH.`;
  } else {
    const label = def.key === 'momentum' ? 'Momentum' : 'Mean-reversion';
    rationale = d.shifted ? `${label}: ${evidence}; ${shiftClause(rawBps, d)}.` : `${label}: ${evidence} -> ${pct(rawBps)} tETH.`;
  }
  return {
    ...base, action: 'propose', finalBps: d.bps, shifted: d.shifted, shiftSide: d.side, rationale: finalizeRationale(rationale),
  };
}
