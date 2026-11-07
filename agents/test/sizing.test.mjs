import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCALE, SizingError, calibratePhi, inputLeg, minOutFromQuote, raisesPLong, sizeMove, swapPoint, terminalFromMarginal,
} from '../lib/sizing.mjs';
import { makeLogPool, poolBatch, shallow, x18 } from './forecast-fixtures.mjs';

const CAP = 1_000_000n; // 1 credit in micro-credits
const buy = (pool, side, target, xMax = CAP) => sizeMove({ kind: 'buy', side, targetX18: x18(target), xMax, batch: poolBatch(pool) });

test('decimals: a buy quote holds the retained complete-set leg PLUS the swap output (credits 6 / tokens 18)', () => {
  const c = 5n; // 5 micro-credits = 5e12 raw
  const p = swapPoint('buy', 'long', c, c * SCALE + 123_456n);
  assert.deepEqual([p.inRaw, p.outRaw], [5_000_000_000_000n, 123_456n]);
  assert.equal(swapPoint('buy', 'long', c, c * SCALE), null, 'a quote that is only the retained leg has no swap output');
  assert.equal(swapPoint('buy', 'long', c, 7n), null);
});

test('sell quotes: swapped input and output are recovered from credits + dust', () => {
  const pool = makeLogPool({ pLong: 0.6 });
  for (const side of ['long', 'short']) {
    const amountIn = 750_000_000_000_000_000n; // 0.75 token
    const detail = pool.sellDetail(side, amountIn);
    const point = swapPoint('sell', side, amountIn, pool.quoteSell(side, amountIn));
    assert.equal(point.inRaw, detail.swapInput, `${side}: s = amountIn - credits*1e12 - soldDust`);
    assert.equal(point.outRaw, detail.swapOutput, `${side}: out = credits*1e12 + otherDust`);
  }
});

test('inputLeg and direction', () => {
  assert.equal(inputLeg('buy', 'long'), 'short');
  assert.equal(inputLeg('buy', 'short'), 'long');
  assert.equal(inputLeg('sell', 'long'), 'long');
  assert.equal(inputLeg('sell', 'short'), 'short');
  assert.deepEqual([raisesPLong('buy', 'long'), raisesPLong('sell', 'short'), raisesPLong('buy', 'short'), raisesPLong('sell', 'long')], [true, true, false, false]);
});

test('target reachable: a buy moves the price ALL THE WAY to fair (non-constant-product curve)', async () => {
  const pool = makeLogPool({ pLong: 0.45, kappa: 0.5 });
  const target = 0.52;
  const exact = pool.exactCreditsFor('long', target);
  const s = await buy(pool, 'long', target);
  assert.equal(s.reachable, true);
  assert.equal(s.capBound, false);
  assert.ok(s.size > 0n && s.size < CAP);
  assert.ok(Math.abs(Number(s.size) - exact) <= 600, `size ${s.size} vs exact ${exact}`);
  // the estimate of the terminal price is close to the exact closed form ...
  assert.ok(Math.abs(Number(s.estX18) / 1e18 - pool.exactAfterBuy('long', s.size)) < 2e-4);
  // ... and executing the trade really lands on fair without crossing it
  const after = pool.exactAfterBuy('long', s.size);
  assert.ok(after <= target + 2e-4 && after > target - 1.5e-3, `lands at ${after}`);
  pool.applyBuy('long', s.size);
  assert.ok(Math.abs(pool.pLong - target) < 1.5e-3);
  assert.ok(s.rounds <= 5, `at most 5 round trips, used ${s.rounds}`);
});

test('works for SHORT buys, other pool depths and other fee factors', async () => {
  for (const { kappa, phi } of [{ kappa: 0.5, phi: 0.997 }, { kappa: 0.08, phi: 0.99 }, { kappa: 1.5, phi: 1 }, { kappa: 0.5, phi: 0.95 }]) {
    const pool = makeLogPool({ pLong: 0.62, kappa, phi });
    const target = 0.58;
    const exact = pool.exactCreditsFor('short', target);
    const xMax = BigInt(Math.ceil(exact * 2));
    const s = await buy(pool, 'short', target, xMax);
    assert.equal(s.reachable, true, `kappa ${kappa} phi ${phi}`);
    assert.ok(Math.abs(Number(s.phi) / 1e18 - phi) < 5e-6, `calibrated phi ${Number(s.phi) / 1e18} vs ${phi}`);
    const after = pool.exactAfterBuy('short', s.size);
    assert.ok(after >= target - 2e-4 && after < target + 1.5e-3, `kappa ${kappa}: lands at ${after}`);
  }
});

test('average execution probability is NOT the terminal price (and is not what the sizer uses)', async () => {
  const pool = makeLogPool({ pLong: 0.45, kappa: 0.5 });
  const s = await buy(pool, 'long', 0.6);
  const input = s.size * SCALE;
  const out = pool.quoteBuy('long', s.size) - input;
  const avgP = Number(input) / Number(out); // SHORT paid per LONG received
  const avgProb = avgP / (1 + avgP);
  const terminal = pool.exactAfterBuy('long', s.size);
  assert.ok(Math.abs(avgProb - terminal) > 0.02, 'the average price lags the terminal price by a lot');
  assert.ok(Math.abs(Number(s.estX18) / 1e18 - terminal) < 2e-4, 'the finite-difference estimate does not');
});

test('cap-bound: the target is out of reach within 1 credit, so the whole cap is used and it says so', async () => {
  const pool = makeLogPool({ pLong: 0.45, kappa: 0.5 });
  const s = await buy(pool, 'long', 0.8);
  assert.equal(s.size, CAP);
  assert.equal(s.capBound, true);
  assert.equal(s.reachable, false);
  assert.match(s.reason, /cap-bound/);
  assert.ok(pool.exactAfterBuy('long', s.size) < 0.8);
});

test('depth-bound: InsufficientDepth beyond some size limits the trade instead of failing it', async () => {
  const pool = shallow(makeLogPool({ pLong: 0.45, kappa: 0.5 }), 300_000n);
  const s = await buy(pool, 'long', 0.7);
  assert.equal(s.depthBound, true);
  assert.equal(s.reachable, false);
  assert.ok(s.size > 280_000n && s.size <= 300_000n, `size ${s.size}`);
  assert.match(s.reason, /depth-bound/);
});

test('zero size: spot already at or past fair, a target one unit away, and no quotable size', async () => {
  const pool = makeLogPool({ pLong: 0.5 });
  const past = await buy(pool, 'long', 0.5);
  assert.equal(past.size, 0n);
  assert.equal(past.reason, 'spot-at-or-past-target');
  const wrongWay = await buy(pool, 'long', 0.4);
  assert.equal(wrongWay.size, 0n);
  const tiny = await sizeMove({ kind: 'buy', side: 'long', targetX18: pool.pLongX18() + 10n ** 9n, xMax: CAP, batch: poolBatch(pool) });
  assert.equal(tiny.size, 0n);
  assert.equal(tiny.reason, 'target-within-one-unit');
  const none = await sizeMove({ kind: 'buy', side: 'long', targetX18: x18(0.6), xMax: 0n, batch: poolBatch(pool) });
  assert.equal(none.size, 0n);
  assert.equal(none.reason, 'no-room');
  const dry = shallow(makeLogPool({ pLong: 0.5 }), 0n);
  await assert.rejects(buy(dry, 'long', 0.6), (e) => e instanceof SizingError && e.code === 'calibration');
});

test('a broken quote source cannot be sized (no formula fallback)', async () => {
  const dead = async ({ requests }) => ({ pLongX18: x18(0.5), results: requests.map(() => ({ ok: false, error: new Error('TradingClosed') })) });
  await assert.rejects(sizeMove({ kind: 'buy', side: 'long', targetX18: x18(0.6), xMax: CAP, batch: dead }), SizingError);
  assert.throws(() => calibratePhi(1n, x18(0.5), 'long'), SizingError);
  assert.throws(() => calibratePhi(5n * 10n ** 18n, x18(0.5), 'long'), /implausible/);
});

test('sell sizing: a held position is sold down to fair using the sell quote views', async () => {
  const pool = makeLogPool({ pLong: 0.6, kappa: 0.5 });
  const target = 0.56;
  const position = 3n * 10n ** 18n;
  const xMax = position < 10n ** 18n ? position : 10n ** 18n; // 1 credit-equivalent per trade
  const s = await sizeMove({ kind: 'sell', side: 'long', targetX18: x18(target), xMax, batch: poolBatch(pool) });
  assert.equal(s.reachable, true, s.reason);
  assert.ok(s.size > 0n && s.size < xMax);
  pool.applySell('long', s.size);
  assert.ok(pool.pLong >= target - 3e-4 && pool.pLong < target + 1.5e-3, `sold down to ${pool.pLong}`);
  const raise = makeLogPool({ pLong: 0.4, kappa: 0.5 });
  const r = await sizeMove({ kind: 'sell', side: 'short', targetX18: x18(0.44), xMax, batch: poolBatch(raise) });
  assert.equal(r.reachable, true);
  raise.applySell('short', r.size);
  assert.ok(raise.pLong <= 0.44 + 3e-4 && raise.pLong > 0.44 - 1.5e-3, `sold SHORT up to ${raise.pLong}`);
});

test('sell sizing: limited by the position (cap-bound) and by depth', async () => {
  const pool = makeLogPool({ pLong: 0.6, kappa: 0.5 });
  const small = 20_000_000_000_000_000n; // 0.02 token held
  const s = await sizeMove({ kind: 'sell', side: 'long', targetX18: x18(0.5), xMax: small, batch: poolBatch(pool) });
  assert.equal(s.size, small);
  assert.equal(s.capBound, true);
  assert.equal(s.reachable, false);
});

test('minOut is the adapter quote minus 0.5% and nothing else', () => {
  assert.equal(minOutFromQuote(1000n), 995n);
  assert.equal(minOutFromQuote(1_000_000_000_000_000_000n), 995_000_000_000_000_000n);
  assert.equal(minOutFromQuote(199n), 198n); // floor
  assert.throws(() => minOutFromQuote(0n), SizingError);
  assert.throws(() => minOutFromQuote(undefined), SizingError);
  const pool = makeLogPool({ pLong: 0.45 });
  const q = pool.quoteBuy('long', 500_000n);
  assert.equal(minOutFromQuote(q), (q * 995n) / 1000n);
  assert.notEqual(minOutFromQuote(q), 500_000n * SCALE, 'not the old "complete set only" floor');
});

test('terminalFromMarginal is symmetric between the legs', () => {
  const phi = 997n * 10n ** 15n;
  const one = 10n ** 18n;
  assert.equal(terminalFromMarginal(phi, phi, 'long'), one / 2n); // P = 1
  assert.equal(terminalFromMarginal(phi, phi, 'short'), one / 2n);
  assert.equal(terminalFromMarginal(0n, phi, 'long'), null);
});
