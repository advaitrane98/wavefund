import assert from 'node:assert/strict';
import test from 'node:test';
import { FORECAST } from '../lib/config.mjs';
import { ModelError, buildModel, expectedGross, fairFor, horizonMinutes, roundHorizonSeconds, toX18 } from '../lib/fair.mjs';
import { makeCandles } from './forecast-fixtures.mjs';

const NOW = 1_800_000_000;
const model = (opts) => buildModel(makeCandles({ endT: NOW, noise: 0, ...opts }), { nowSec: NOW });
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('drift is shrunk toward zero by HALF', () => {
  const m = model({ drift: 4e-5 });
  near(m.driftRaw, 4e-5, 1e-12);
  near(m.drift, 2e-5, 1e-12);
  assert.equal(m.driftCapped, false);
  near(model({ drift: -3e-5 }).drift, -1.5e-5, 1e-12);
});

test('the shrunk drift is capped at +/-0.5 bp per minute (documented numeric cap)', () => {
  assert.equal(FORECAST.driftCapPerMin, 5e-5);
  const up = model({ drift: 3e-4 });
  near(up.drift, 5e-5, 1e-15);
  assert.equal(up.driftCapped, true);
  near(model({ drift: -3e-4 }).drift, -5e-5, 1e-15);
  // just inside the cap after shrinking is not "capped"
  assert.equal(model({ drift: 9e-5 }).driftCapped, false);
  near(model({ drift: 9e-5 }).drift, 4.5e-5, 1e-12);
});

test('expected vault return uses the lognormal mean, the proposal allocation, and the round bounds', () => {
  const m = model({ drift: 3e-4 }); // capped to 5e-5 per minute, sigma 0
  const f = fairFor(m, { tEthBps: 5000, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 });
  near(f.gross, Math.exp(5e-5 * 10), 1e-12);
  near(f.expectedReturn, 1 + 0.5 * (Math.exp(5e-4) - 1), 1e-12);
  near(f.pFair, (f.expectedReturn - 0.99) / 0.02, 1e-12);
  near(f.pFair, 0.5125, 1e-5);
  // with volatility the log-drift mean is convexity-adjusted: E[S_T]/S0 = exp(mu*T + 0.5*sigma^2*T)
  const noisy = buildModel(makeCandles({ endT: NOW, noise: 0.002, drift: 2e-5 }), { nowSec: NOW });
  assert.ok(noisy.sigma > 0.0005);
  near(expectedGross(noisy, 10), Math.exp(noisy.drift * 10 + 0.5 * noisy.sigma ** 2 * 10), 1e-15);
  assert.ok(expectedGross(noisy, 10) > Math.exp(noisy.drift * 10), 'the convexity term is positive');
  near(f.expectedPrice, m.price * f.gross, 1e-6);
});

test('the status quo (proposal 0) goes through the same formula', () => {
  const m = model({ drift: 3e-4 });
  const a = fairFor(m, { tEthBps: 0, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 });
  near(a.expectedReturn, 1, 1e-15); // all USDC: no ETH return
  near(a.pFair, 0.5, 1e-12);
  const b = fairFor(m, { tEthBps: 10_000, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 });
  assert.ok(b.pFair > a.pFair, 'more ETH exposure, higher fair LONG probability when the drift is positive');
});

test('pFair is clamped to [0.02, 0.98]', () => {
  const up = fairFor(model({ drift: 3e-4 }), { tEthBps: 10_000, horizonSeconds: 600, rMin: 0.9995, rMax: 1.0005 });
  assert.equal(up.pFair, 0.98);
  assert.equal(up.clamped, true);
  assert.ok(up.pFairRaw > 0.98);
  const down = fairFor(model({ drift: -3e-4 }), { tEthBps: 10_000, horizonSeconds: 600, rMin: 0.9995, rMax: 1.0005 });
  assert.equal(down.pFair, 0.02);
  assert.equal(toX18(0.02), 20_000_000_000_000_000n);
});

test('it uses the ACTUAL round bounds, not fixed ones', () => {
  const m = model({ drift: 3e-4 });
  const narrow = fairFor(m, { tEthBps: 5000, horizonSeconds: 600, rMin: 0.995, rMax: 1.005 });
  const wide = fairFor(m, { tEthBps: 5000, horizonSeconds: 600, rMin: 0.98, rMax: 1.02 });
  assert.ok(narrow.pFair - 0.5 > 2 * (wide.pFair - 0.5) * 0.99);
});

test('invalid candles are rejected, never read as zero drift', () => {
  const good = makeCandles({ endT: NOW });
  assert.throws(() => buildModel(good.slice(-5), { nowSec: NOW }), /at least 20 candles/);
  assert.throws(() => buildModel(null), ModelError);
  assert.throws(() => buildModel(good.map((c, i) => (i === 50 ? { ...c, close: NaN } : c)), { nowSec: NOW }), /non-positive close/);
  assert.throws(() => buildModel(good.map((c, i) => (i === 50 ? { ...c, close: -1 } : c)), { nowSec: NOW }), /non-positive close/);
  assert.throws(() => buildModel(good.map((c, i) => (i === 50 ? { ...c, close: 0 } : c)), { nowSec: NOW }), /non-positive close/);
  const shuffled = [...good];
  [shuffled[10], shuffled[11]] = [shuffled[11], shuffled[10]];
  assert.throws(() => buildModel(shuffled, { nowSec: NOW }), /strictly increasing/);
  assert.throws(() => buildModel(good, { nowSec: NOW + 301 }), /newest candle is 301s old/);
  assert.doesNotThrow(() => buildModel(good, { nowSec: NOW + 300 }));
});

test('invalid parameters are rejected: bounds, allocation, horizon', () => {
  const m = model({});
  assert.throws(() => fairFor(m, { tEthBps: 5000, horizonSeconds: 600, rMin: 1.01, rMax: 0.99 }), /invalid return bounds/);
  assert.throws(() => fairFor(m, { tEthBps: 5000, horizonSeconds: 600, rMin: NaN, rMax: 1.01 }), /invalid return bounds/);
  assert.throws(() => fairFor(m, { tEthBps: 10_001, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 }), /tEthBps/);
  assert.throws(() => fairFor(m, { tEthBps: 5000.5, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 }), /tEthBps/);
  assert.throws(() => fairFor(m, { tEthBps: -1, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 }), /tEthBps/);
  for (const bad of [0, -5, NaN, Infinity]) assert.throws(() => horizonMinutes(bad), /positive number of seconds/);
});

test('horizon units: on-chain SECONDS become MINUTES, and a milliseconds mistake is refused', () => {
  assert.equal(horizonMinutes(600), 10);
  assert.equal(horizonMinutes(120), 2);
  assert.throws(() => horizonMinutes(600_000), /seconds expected \(not ms\)/);
  assert.equal(roundHorizonSeconds({ tradingEnd: 1000, evaluationEnd: 1600 }), 600);
  assert.throws(() => roundHorizonSeconds({ tradingEnd: 1600, evaluationEnd: 1000 }), /positive number of seconds/);
  // ten times the horizon, ten times the expected excess return
  const m = model({ drift: 3e-4 });
  const short = fairFor(m, { tEthBps: 10_000, horizonSeconds: 60, rMin: 0.99, rMax: 1.01 });
  const long = fairFor(m, { tEthBps: 10_000, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 });
  near((long.expectedReturn - 1) / (short.expectedReturn - 1), 10, 1e-2);
});

test('a candle gap is normalised by elapsed minutes, not by candle count', () => {
  const dense = makeCandles({ endT: NOW, drift: 2e-5, n: 60 });
  const gappy = dense.filter((_, i) => i % 2 === 0 || i === dense.length - 1); // every other minute is missing
  near(buildModel(gappy, { nowSec: NOW }).driftRaw, buildModel(dense, { nowSec: NOW }).driftRaw, 1e-9);
});
