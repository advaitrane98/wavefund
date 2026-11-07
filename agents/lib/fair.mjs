// Fair-value model shared by Quant and Guardian (pure functions, no I/O).
//
//   candles (1-minute, oldest first)
//     -> price S0 = last close
//     -> log drift  m_hat  = ln(S_last / S_first) / minutes spanned          (per minute)
//     -> volatility sigma  = sd of the per-minute log returns                 (per sqrt(minute))
//   shrunk drift  mu    = clamp(0.5 * m_hat, -CAP, +CAP)                      (CAP = FORECAST.driftCapPerMin)
//   horizon       T     = (evaluationEnd - tradingEnd) / 60                   (minutes)
//   expected ETH gross return  G = E[S_T] / S0 = exp(mu*T + 0.5*sigma^2*T)    (lognormal mean, consistent with a LOG drift)
//   expected vault return, proposal with tETH share w = tEthBps / 10000:
//                                E[R] = 1 + w * (G - 1)                       (the rest of the vault stays in USDC)
//   fair LONG probability        pFair = clamp((E[R] - rMin) / (rMax - rMin), 0.02, 0.98)   with the ROUND's own rMin/rMax
//
// Proposal 0 (status quo) goes through exactly the same formula with the status quo allocation.
import { FORECAST } from './config.mjs';

export class ModelError extends Error {
  constructor(message, code = 'invalid-data') {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** Round horizon in MINUTES from on-chain SECONDS. Anything outside (0, 24h] is a unit mistake. */
export function horizonMinutes(horizonSeconds, maxSec = FORECAST.maxHorizonSec) {
  if (!finite(horizonSeconds) || horizonSeconds <= 0) throw new ModelError(`horizon must be a positive number of seconds, got ${horizonSeconds}`, 'invalid-horizon');
  if (horizonSeconds > maxSec) throw new ModelError(`horizon ${horizonSeconds}s is longer than ${maxSec}s: seconds expected (not ms)`, 'invalid-horizon');
  return horizonSeconds / 60;
}

/** Seconds between the end of trading and the end of evaluation. Throws on a malformed round. */
export const roundHorizonSeconds = (round) => horizonMinutes(Number(round.evaluationEnd) - Number(round.tradingEnd)) * 60;

/**
 * Builds the market model from candles ({ t (unix s), close }), oldest first. `nowSec` enables the staleness check.
 * Throws ModelError on anything unusable; callers must treat that as "no forecast", never as zero drift.
 */
export function buildModel(candles, { nowSec, cfg = FORECAST } = {}) {
  if (!Array.isArray(candles)) throw new ModelError('candles missing');
  const rows = candles.slice(-cfg.candleWindow);
  if (rows.length < cfg.minCandles) throw new ModelError(`need at least ${cfg.minCandles} candles, have ${rows.length}`, 'too-few-candles');
  for (const c of rows) {
    if (!finite(c.t) || !finite(c.close) || c.close <= 0) throw new ModelError('candle with a non-finite time or a non-positive close', 'invalid-candle');
  }
  let dtSum = 0;
  const logRets = [];
  const dts = [];
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i].t - rows[i - 1].t) / 60;
    if (!(dt > 0)) throw new ModelError('candles are not strictly increasing in time', 'unordered-candles');
    dts.push(dt);
    dtSum += dt;
    logRets.push(Math.log(rows[i].close / rows[i - 1].close));
  }
  const last = rows[rows.length - 1];
  if (nowSec != null && nowSec - last.t > cfg.maxCandleAgeSec) {
    throw new ModelError(`newest candle is ${Math.round(nowSec - last.t)}s old (limit ${cfg.maxCandleAgeSec}s)`, 'stale-candles');
  }
  const driftRaw = Math.log(last.close / rows[0].close) / dtSum; // log drift per minute
  // Brownian motion with drift: each return r_i over dt_i minutes has variance sigma^2 * dt_i.
  const varSum = logRets.reduce((a, r, i) => a + ((r - driftRaw * dts[i]) ** 2) / dts[i], 0);
  const sigma = Math.sqrt(varSum / (logRets.length - 1));
  if (!finite(driftRaw) || !finite(sigma)) throw new ModelError('drift or volatility is not finite');
  const shrunk = driftRaw * cfg.driftShrink;
  const drift = Math.max(-cfg.driftCapPerMin, Math.min(cfg.driftCapPerMin, shrunk));
  return {
    price: last.close, lastCandleT: last.t, candles: rows.length, spanMinutes: dtSum,
    driftRaw, driftShrunk: shrunk, drift, driftCapped: drift !== shrunk, sigma,
  };
}

/** Expected gross ETH return over `minutes`, E[S_T]/S0 for a log drift (lognormal mean). */
export const expectedGross = (model, minutes) => Math.exp(model.drift * minutes + 0.5 * model.sigma * model.sigma * minutes);

/** Expected vault return for a proposal that holds `tEthBps` of the vault in ETH. */
export function expectedVaultReturn(model, { tEthBps, horizonSeconds }) {
  if (!Number.isInteger(tEthBps) || tEthBps < 0 || tEthBps > 10_000) throw new ModelError(`tEthBps ${tEthBps} is not an integer in 0..10000`, 'invalid-allocation');
  const minutes = horizonMinutes(horizonSeconds);
  const gross = expectedGross(model, minutes);
  return { expectedReturn: 1 + (tEthBps / 10_000) * (gross - 1), gross, expectedPrice: model.price * gross, minutes };
}

/** Fair LONG probability. `rMin`/`rMax` are the round's return bounds as numbers (e.g. 0.99 and 1.01). */
export function fairFor(model, { tEthBps, horizonSeconds, rMin, rMax, cfg = FORECAST }) {
  if (!finite(rMin) || !finite(rMax) || !(rMax > rMin)) throw new ModelError(`invalid return bounds rMin ${rMin}, rMax ${rMax}`, 'invalid-bounds');
  const e = expectedVaultReturn(model, { tEthBps, horizonSeconds });
  const raw = (e.expectedReturn - rMin) / (rMax - rMin);
  const pFair = Math.max(cfg.pFairMin, Math.min(cfg.pFairMax, raw));
  return { ...e, pFairRaw: raw, pFair, pFairX18: toX18(pFair), clamped: pFair !== raw };
}

/** Probability (0..1 number) to 1e18 fixed point. */
export const toX18 = (p) => BigInt(Math.round(p * 1e12)) * 10n ** 6n;
export const fromX18 = (x) => Number(x) / 1e18;

/** Round bounds from on-chain 1e18 values. */
export const boundsFromRound = (round) => ({ rMin: fromX18(round.rMin), rMax: fromX18(round.rMax) });
