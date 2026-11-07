import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_DEFS } from '../lib/config.mjs';
import { dueTick, forecasterTicks, guardFor, phaseOf, proposerWindow, secondsUntilNext, tradeCutoff, twapStart } from '../lib/scheduler.mjs';
import { timing } from './helpers.mjs';

const def = (k) => AGENT_DEFS.find((d) => d.key === k);
const T = timing(); // trading 1000..2200, TWAP window 300 (starts 1900), evaluation ends 2800

test('guards: 15 s before tradingEnd for everyone, 5 s for Guardian', () => {
  assert.equal(guardFor('quant'), 15);
  assert.equal(guardFor('guardian'), 5);
  assert.equal(tradeCutoff(T, 'quant'), 2185);
  assert.equal(tradeCutoff(T, 'guardian'), 2195);
  assert.equal(twapStart(T), 1900);
});

test('phases follow the on-chain timings', () => {
  assert.equal(phaseOf(T, 999), 'before');
  assert.equal(phaseOf(T, 1000), 'trading');
  assert.equal(phaseOf(T, 1899), 'trading');
  assert.equal(phaseOf(T, 1900), 'twap');
  assert.equal(phaseOf(T, 2200), 'evaluation');
  assert.equal(phaseOf(T, 2800), 'ended');
});

test('proposers act early: staggered start, window closes within the first quarter', () => {
  const m = proposerWindow(T, def('momentum'));
  const mr = proposerWindow(T, def('mean_reversion'));
  const n = proposerWindow(T, def('news'));
  assert.deepEqual([m.opensAt, mr.opensAt, n.opensAt], [1005, 1020, 1035]);
  for (const w of [m, mr, n]) {
    assert.equal(w.closesAt, 1300); // 25% of 1200 s
    assert.ok(w.valid);
  }
});

test('proposer stagger is capped on a short (judge) round and the window never passes the cutoff', () => {
  const judge = timing(1_000, 480, 240, 120);
  const w = proposerWindow(judge, def('news'));
  assert.ok(w.opensAt - judge.tradingStart <= 48);
  assert.ok(w.closesAt < tradeCutoff(judge, 'news'));
  const tiny = timing(1_000, 10, 5, 5);
  assert.equal(proposerWindow(tiny, def('news')).valid, false);
});

test('forecasters: periodic ticks, one before the TWAP window, regular ones inside it, a final one at the cutoff', () => {
  const ticks = forecasterTicks(T, def('quant'));
  const phases = new Set(ticks.map((t) => t.phase));
  assert.deepEqual([...phases].sort(), ['final', 'periodic', 'pre-twap', 'twap']);
  assert.ok(ticks.some((t) => t.phase === 'pre-twap' && t.at === 1880));
  const inside = ticks.filter((t) => t.at >= 1900);
  assert.ok(inside.length >= 9, 'about every 30 s inside the final window');
  assert.deepEqual(ticks.map((t) => t.at), [...ticks.map((t) => t.at)].sort((a, b) => a - b));
  assert.deepEqual(ticks.map((t) => t.index), ticks.map((_, i) => i));
});

test('no forecaster tick falls within 15 s of tradingEnd (Guardian: 5 s)', () => {
  for (const key of ['quant', 'guardian']) {
    const ticks = forecasterTicks(T, def(key));
    const last = Math.max(...ticks.map((t) => t.at));
    assert.ok(last <= T.tradingEnd - guardFor(key), `${key} last tick ${last}`);
    assert.ok(ticks.every((t) => t.at >= T.tradingStart));
  }
  const q = Math.max(...forecasterTicks(T, def('quant')).map((t) => t.at));
  const g = Math.max(...forecasterTicks(T, def('guardian')).map((t) => t.at));
  assert.ok(g > q, 'Guardian is allowed to trade later than Quant');
  assert.ok(T.tradingEnd - g >= 5 && T.tradingEnd - q >= 15);
});

test('dueTick runs the latest due tick once, reports older ones as missed, and stops at the cutoff', () => {
  const ticks = forecasterTicks(T, def('quant'));
  const fired = new Set();
  const isFired = (t) => fired.has(t.index);
  const cutoff = tradeCutoff(T, 'quant');
  assert.equal(dueTick(ticks, isFired, 1000, cutoff).tick, null);
  const first = dueTick(ticks, isFired, ticks[2].at + 1, cutoff);
  assert.equal(first.tick.index, 2);
  assert.deepEqual(first.missed.map((t) => t.index), [0, 1]);
  fired.add(2);
  assert.equal(dueTick(ticks, isFired, ticks[2].at + 1, cutoff).tick, null);
  assert.equal(dueTick(ticks, isFired, cutoff + 1, cutoff).tick, null);
  assert.equal(dueTick(ticks, () => false, 2199, cutoff).tick, null, 'inside the guard window nothing may run');
});

test('secondsUntilNext points at the next unfired tick', () => {
  const ticks = forecasterTicks(T, def('quant'));
  assert.equal(secondsUntilNext(ticks, () => false, ticks[0].at - 7), 7);
  assert.equal(secondsUntilNext(ticks, () => false, 99_999), null);
});
