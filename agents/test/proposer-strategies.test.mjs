import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_DEFS } from '../lib/config.mjs';
import {
  BOUNDS, DataError, RATIONALE_LIMIT, decideProposal, directionOf, diversify, finalizeRationale, latestCloses,
  meanReversionSignal, momentumSignal, sigmaPerMinute, toSlot,
} from '../proposer-strategies.mjs';

const def = (k) => AGENT_DEFS.find((d) => d.key === k);
const T0 = 1_700_000_000;
const series = (closes, t0 = T0) => closes.map((close, i) => ({ t: t0 + i * 60, close, open: close, high: close, low: close, volume: 1 }));
const wiggle = (i) => (i % 2 ? 0.3 : -0.3);

// ---- fixed candle fixtures (30 contiguous 1-minute closes)
const FLAT = series(Array.from({ length: 30 }, () => 2000));
const CHOPPY = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i))); // noise only: no trend, no deviation to speak of
const RISING = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i) + (i >= 20 ? (i - 19) * 1.5 : 0))); // last 10 minutes climb
const FALLING = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i) - (i >= 20 ? (i - 19) * 1.5 : 0)));
const SPIKE = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i) + (i === 29 ? 12 : 0))); // last close far above its 30m average
const DIP = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i) - (i === 29 ? 12 : 0)));

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------------------------------------------------------------- data rules

test('latestCloses needs 30 contiguous one-minute closes', () => {
  assert.equal(latestCloses(FLAT).length, 30);
  assert.throws(() => latestCloses(FLAT.slice(5)), DataError);
  const gap = FLAT.map((c, i) => (i >= 15 ? { ...c, t: c.t + 60 } : c));
  assert.throws(() => latestCloses(gap), /not contiguous/);
  const longer = series(Array.from({ length: 60 }, (_, i) => 1000 + i));
  assert.equal(latestCloses(longer)[0], 1030, 'uses the most recent 30');
});

test('toSlot rounds to 100 bps and respects 1000-9000', () => {
  assert.equal(toSlot(4949), 4900);
  assert.equal(toSlot(4951), 5000);
  assert.equal(toSlot(-50), 1000);
  assert.equal(toSlot(12_345), 9000);
});

// ---------------------------------------------------------------- momentum

test('momentum: z = ln(p_now / p_10m_ago) / (sigma * sqrt(10)), allocation = 5000 + clamp(z, -2, 2) * 1750', () => {
  const closes = RISING.map((c) => c.close);
  const trend = Math.log(closes[29] / closes[19]);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const m = mean(rets);
  const sigma = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  const s = momentumSignal(RISING);
  approx(sigmaPerMinute(closes), sigma);
  approx(s.trend, trend);
  approx(s.z, trend / (sigma * Math.sqrt(10)));
  assert.equal(s.rawBps, toSlot(5000 + Math.max(-2, Math.min(2, s.z)) * 1750));
});

test('momentum: flat prices give a neutral 5000; strong trends saturate at +-2 (8500 / 1500)', () => {
  assert.equal(momentumSignal(FLAT).z, 0);
  assert.equal(momentumSignal(FLAT).rawBps, 5000);
  assert.equal(momentumSignal(RISING).rawBps, 8500);
  assert.equal(momentumSignal(FALLING).rawBps, 1500);
  assert.ok(momentumSignal(RISING).z > 2 && momentumSignal(FALLING).z < -2);
});

test('momentum: a mild trend lands between the extremes on a 100 bps slot', () => {
  const mild = series(Array.from({ length: 30 }, (_, i) => 2000 + wiggle(i) + i * 0.05));
  const s = momentumSignal(mild);
  assert.ok(s.rawBps > 5000 && s.rawBps <= 8500);
  assert.equal(s.rawBps % 100, 0);
});

// ---------------------------------------------------------------- mean reversion

test('mean-reversion: z = ln(price / 30m average) / (sigma * sqrt(30)), allocation = 5000 - clamp(z, -2, 2) * 1750', () => {
  const closes = SPIKE.map((c) => c.close);
  const dev = Math.log(closes[29] / mean(closes));
  const s = meanReversionSignal(SPIKE);
  approx(s.deviation, dev);
  approx(s.z, dev / (sigmaPerMinute(closes) * Math.sqrt(30)));
  assert.equal(s.rawBps, toSlot(5000 - Math.max(-2, Math.min(2, s.z)) * 1750));
});

test('mean-reversion: a spike above the average lowers the allocation, a dip raises it, flat is neutral', () => {
  assert.ok(meanReversionSignal(SPIKE).rawBps < 5000);
  assert.ok(meanReversionSignal(DIP).rawBps > 5000);
  assert.equal(meanReversionSignal(FLAT).rawBps, 5000);
  assert.equal(meanReversionSignal(RISING).rawBps <= 5000, true, 'a rising series ends above its average');
});

// ---------------------------------------------------------------- decideProposal (momentum, mean-reversion)

test('decideProposal: momentum and mean-reversion return a rationale under 280 chars on one line', async () => {
  for (const [key, candles] of [['momentum', RISING], ['mean_reversion', SPIKE]]) {
    const d = await decideProposal({ def: def(key), candles, statusQuoBps: 5000, others: [] });
    assert.equal(d.action, 'propose');
    assert.ok(d.rationale.length < RATIONALE_LIMIT && !/[\r\n]/.test(d.rationale));
    assert.ok(Number.isInteger(d.finalBps) && d.finalBps % 100 === 0);
    assert.equal(d.source, key);
  }
  const m = await decideProposal({ def: def('momentum'), candles: RISING, statusQuoBps: 5000 });
  assert.match(m.rationale, /^Momentum: 10m trend \+/);
  assert.equal(m.rawBps, 8500);
  assert.equal(m.finalBps, 8500);
  assert.equal(m.shifted, false);
});

test('decideProposal: insufficient or gappy data skips with a reason instead of guessing', async () => {
  const d = await decideProposal({ def: def('momentum'), candles: FLAT.slice(10), statusQuoBps: 5000 });
  assert.equal(d.action, 'skip');
  assert.match(d.skipReason, /market data: need 30 one-minute closes/);
});

test('shift direction follows the signal and the rationale states the shift', async () => {
  // bullish signal 8500 with an existing proposal at 8300 -> shifts UP to the nearest 500-bps slot, 8800
  const up = await decideProposal({ def: def('momentum'), candles: RISING, statusQuoBps: 5000, others: [8300] });
  assert.equal(up.rawBps, 8500);
  assert.equal(up.finalBps, 8800);
  assert.equal(up.shifted, true);
  assert.ok(up.finalBps > up.rawBps);
  assert.match(up.rationale, /signal suggests 85%; shifted to 88% to stay distinct/);
  // bearish signal 1500 with an existing proposal at 1700 -> shifts DOWN to the nearest slot, 1200
  const down = await decideProposal({ def: def('momentum'), candles: FALLING, statusQuoBps: 5000, others: [1700] });
  assert.equal(down.rawBps, 1500);
  assert.equal(down.finalBps, 1200);
  assert.ok(down.finalBps < down.rawBps);
  assert.match(down.rationale, /signal suggests 15%; shifted to 12% to stay distinct/);
});

test('mean-reversion near the status quo shifts in its own (bearish) direction', async () => {
  const d = await decideProposal({ def: def('mean_reversion'), candles: SPIKE, statusQuoBps: 4600 });
  assert.ok(d.rawBps < 5000);
  if (d.shifted) assert.ok(d.finalBps < d.rawBps, 'moved down, the way the signal points');
  assert.ok(Math.abs(d.finalBps - 4600) >= 500);
});

// ---------------------------------------------------------------- diversify

test('diversify: untouched when already 500+ bps from everything', () => {
  assert.deepEqual(diversify({ signalBps: 7000, direction: 1, others: [5000, 6500] }), { bps: 7000, shifted: false });
});

test('diversify: walks to the nearest valid slot in the signal direction', () => {
  assert.equal(diversify({ signalBps: 6800, direction: 1, others: [5000, 6800] }).bps, 7300);
  assert.equal(diversify({ signalBps: 3200, direction: -1, others: [5000, 3200] }).bps, 2700);
  assert.equal(diversify({ signalBps: 5000, direction: 1, others: [5000] }).bps, 5500);
  assert.equal(diversify({ signalBps: 5000, direction: -1, others: [5000] }).bps, 4500);
});

test('diversify: tries the opposite side once when the signal side is full, else skips with a reason', () => {
  const opp = diversify({ signalBps: 8800, direction: 1, others: [5000, 8800] });
  assert.equal(opp.bps, 8300);
  assert.equal(opp.side, 'opposite direction');
  const full = Array.from({ length: 17 }, (_, i) => 1000 + i * 500);
  const skip = diversify({ signalBps: 5000, direction: 1, others: full });
  assert.equal(skip.skip, true);
  assert.match(skip.reason, /no slot at least 500 bps/);
});

test('directionOf follows the signal side of 5000, then the status quo, then up', () => {
  assert.equal(directionOf(6000, 5000), 1);
  assert.equal(directionOf(4000, 5000), -1);
  assert.equal(directionOf(5000, 7000), -1);
  assert.equal(directionOf(5000, 3000), 1);
  assert.equal(directionOf(5000, 5000), 1);
});

test('bounds hold: raw signals and diversified results stay inside 1000-9000 on 100 bps slots', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let n = 0; n < 150; n++) {
    const drift = (rnd() - 0.5) * 6;
    const noise = rnd() * 1.5;
    const candles = series(Array.from({ length: 30 }, (_, i) => 2000 + i * drift + (rnd() - 0.5) * noise));
    const sq = 1000 + Math.round(rnd() * 80) * 100;
    for (const key of ['momentum', 'mean_reversion']) {
      const d = await decideProposal({ def: def(key), candles, statusQuoBps: sq, others: [] });
      assert.ok(d.rawBps >= BOUNDS.min && d.rawBps <= BOUNDS.max && d.rawBps % 100 === 0);
      if (d.action === 'propose') {
        assert.ok(d.finalBps >= BOUNDS.min && d.finalBps <= BOUNDS.max && d.finalBps % 100 === 0);
        assert.ok(Math.abs(d.finalBps - sq) >= 500);
      }
    }
  }
});

test('finalizeRationale collapses whitespace and stays under 280 chars', () => {
  assert.equal(finalizeRationale('a\n b\t c'), 'a b c');
  const long = finalizeRationale('x'.repeat(600));
  assert.ok(long.length < RATIONALE_LIMIT && long.endsWith('...'));
});

// ---------------------------------------------------------------- three agents, near-identical signals

async function cycleOf({ candles, statusQuoBps, existing = [], llm, headlines = [] }) {
  const chosen = [];
  const out = [];
  for (const key of ['momentum', 'mean_reversion', 'news']) {
    const d = await decideProposal({ def: def(key), candles, statusQuoBps, others: [...existing, ...chosen], headlines, llm, env: {} });
    out.push(d);
    if (d.action === 'propose') chosen.push(d.finalBps);
  }
  return out;
}

function assertDistinct(results, statusQuoBps, existing = []) {
  const bps = results.filter((r) => r.action === 'propose').map((r) => r.finalBps);
  const all = [statusQuoBps, ...existing, ...bps];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) assert.ok(Math.abs(all[i] - all[j]) >= 500, `${all[i]} and ${all[j]} are closer than 500 bps (${all.join(', ')})`);
  }
  for (const b of bps) assert.ok(b >= 1000 && b <= 9000 && b % 100 === 0);
  return bps;
}

test('three agents with identical neutral signals always yield three distinct proposals, 500+ bps apart and from the status quo', async () => {
  for (const sq of [1000, 2500, 4500, 5000, 5500, 7000, 9000]) {
    const results = await cycleOf({ candles: FLAT, statusQuoBps: sq });
    const bps = assertDistinct(results, sq);
    assert.equal(bps.length, 3, `all three propose at status quo ${sq}`);
  }
});

test('three agents all bullish at the same level still end up distinct (including with other proposals on chain)', async () => {
  const bullish = { llm: async () => ({ ok: true, tEthBps: 8500, rationale: 'Headlines are constructive and the trend is up, so lean long.', model: 'm' }) };
  const headlines = [{ title: 'ETH rallies', publishedAt: new Date().toISOString() }];
  for (const [sq, existing] of [[5000, []], [5000, [6500]], [3000, [8000]], [8500, []]]) {
    const results = await cycleOf({ candles: RISING, statusQuoBps: sq, existing, headlines, ...bullish });
    assertDistinct(results, sq, existing);
  }
});

test('when no slot is free the agent skips with a logged reason instead of proposing a duplicate', async () => {
  const crowded = Array.from({ length: 17 }, (_, i) => 1000 + i * 500);
  const d = await decideProposal({ def: def('momentum'), candles: FLAT, statusQuoBps: 5000, others: crowded });
  assert.equal(d.action, 'skip');
  assert.match(d.skipReason, /no slot/);
});
