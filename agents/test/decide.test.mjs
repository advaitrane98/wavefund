import assert from 'node:assert/strict';
import test from 'node:test';
import { FORECAST } from '../lib/config.mjs';
import {
  EPSILON_X18, guardianCandidates, guardianThreshold, inFinalWindow, projectedLeader, signalFor, stageFor,
} from '../lib/decide.mjs';
import { x18 } from './forecast-fixtures.mjs';

const FAIR = x18(0.5);

test('Quant threshold is strict: a gap of exactly 0.005 does nothing, one unit more trades', () => {
  assert.equal(FORECAST.quantThreshold, 0.005);
  const at = signalFor({ pMarketX18: FAIR + x18(0.005), pFairX18: FAIR, threshold: 0.005 });
  assert.equal(at.direction, null);
  const over = signalFor({ pMarketX18: FAIR + x18(0.005) + 1n, pFairX18: FAIR, threshold: 0.005 });
  assert.equal(over.direction, 'lower');
  const atLow = signalFor({ pMarketX18: FAIR - x18(0.005), pFairX18: FAIR, threshold: 0.005 });
  assert.equal(atLow.direction, null);
  const under = signalFor({ pMarketX18: FAIR - x18(0.005) - 1n, pFairX18: FAIR, threshold: 0.005 });
  assert.equal(under.direction, 'raise');
});

test('direction: LONG when the market is low, SHORT when it is high', () => {
  const low = signalFor({ pMarketX18: x18(0.45), pFairX18: FAIR, threshold: 0.005 });
  assert.equal(low.direction, 'raise');
  assert.equal(low.gapX18, x18(0.45) - FAIR);
  assert.deepEqual(stageFor({ direction: low.direction, position: { long: 0n, short: 0n }, allowSell: true }), { kind: 'buy', side: 'long' });
  const high = signalFor({ pMarketX18: x18(0.55), pFairX18: FAIR, threshold: 0.005 });
  assert.equal(high.direction, 'lower');
  assert.deepEqual(stageFor({ direction: high.direction, position: { long: 0n, short: 0n }, allowSell: true }), { kind: 'buy', side: 'short' });
  assert.equal(stageFor({ direction: null, position: { long: 0n, short: 0n }, allowSell: true }), null);
});

test('positions moved past fair are SOLD, not doubled up on; the Guardian never sells', () => {
  const heldLong = { long: 2n * 10n ** 18n, short: 0n };
  const heldShort = { long: 0n, short: 2n * 10n ** 18n };
  assert.deepEqual(stageFor({ direction: 'lower', position: heldLong, allowSell: true }), { kind: 'sell', side: 'long' });
  assert.deepEqual(stageFor({ direction: 'raise', position: heldShort, allowSell: true }), { kind: 'sell', side: 'short' });
  // a LONG position with the market BELOW fair is still good: buy more LONG
  assert.deepEqual(stageFor({ direction: 'raise', position: heldLong, allowSell: true }), { kind: 'buy', side: 'long' });
  assert.deepEqual(stageFor({ direction: 'lower', position: heldLong, allowSell: false }), { kind: 'buy', side: 'short' });
  // dust is not worth a sale
  assert.deepEqual(stageFor({ direction: 'lower', position: { long: FORECAST.minSellRaw - 1n, short: 0n }, allowSell: true }), { kind: 'buy', side: 'short' });
});

test('projected winner follows QuantumRound.collapse: lowest id on ties, strict epsilon over the status quo', () => {
  const t = (...xs) => xs.map((x) => (x == null ? null : x18(x)));
  assert.equal(EPSILON_X18, 5n * 10n ** 15n);
  assert.deepEqual(projectedLeader(t(0.5, 0.505, 0.4)), { leader: 0, bestChallenger: 1, statusQuoWins: true }); // exactly epsilon: status quo keeps it
  assert.equal(projectedLeader([x18(0.5), x18(0.5) + EPSILON_X18 + 1n]).leader, 1);
  assert.equal(projectedLeader(t(0.5, 0.6, 0.6)).leader, 1, 'a tie goes to the lowest id');
  assert.equal(projectedLeader(t(0.5, 0.55, 0.62, 0.58)).leader, 2);
  assert.equal(projectedLeader(t(0.5, null, 0.62)).leader, 2, 'an unseeded market cannot lead');
  assert.equal(projectedLeader(t(0.5)).leader, 0);
  assert.equal(projectedLeader(t(0.7, 0.704, 0.702)).leader, 0, 'the challenger leads by less than epsilon over the status quo');
});

test('Guardian candidates: the projected leader plus proposals spot-priced at or above the status quo', () => {
  const t = (...xs) => xs.map((x) => (x == null ? null : x18(x)));
  const a = guardianCandidates({ spots: t(0.5, 0.56, 0.52, 0.45, 0.5), twaps: t(0.5, 0.56, 0.52, 0.45, 0.5) });
  assert.deepEqual(a, { leader: 1, ids: [1, 0, 2, 4] }); // Status quo qualifies too; 3 is below and excluded.
  const b = guardianCandidates({ spots: t(0.5, 0.45, 0.46), twaps: t(0.5, 0.45, 0.46) });
  assert.deepEqual(b, { leader: 0, ids: [0] }, 'the status quo leads and nothing is priced above it');
  const c = guardianCandidates({ spots: t(0.5, 0.49, 0.51), twaps: t(0.5, 0.9, 0.52) });
  assert.deepEqual(c, { leader: 1, ids: [1, 0, 2] }, 'the leader is evaluated even when its spot is below the status quo');
});

test('Guardian thresholds: 0.01 inside the final TWAP window, 0.03 outside', () => {
  assert.equal(guardianThreshold({ now: 899, tradingEnd: 1000, twapWindow: 100 }), 0.03);
  assert.equal(guardianThreshold({ now: 900, tradingEnd: 1000, twapWindow: 100 }), 0.01);
  assert.equal(guardianThreshold({ now: 999, tradingEnd: 1000, twapWindow: 100 }), 0.01);
  assert.equal(inFinalWindow({ now: 900, tradingEnd: 1000, twapWindow: 100 }), true);
  assert.equal(inFinalWindow({ now: 1000, tradingEnd: 1000, twapWindow: 100 }), false);
  assert.equal(FORECAST.guardianEverySec.inside, 5);
});
