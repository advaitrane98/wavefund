import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_DEFS, FORECAST, gasCaps } from '../lib/config.mjs';
import { createExecutor, StepFailed } from '../lib/executor.mjs';
import { buildModel, fairFor } from '../lib/fair.mjs';
import { buildForecasterRuntime } from '../lib/forecaster-setup.mjs';
import { createForecasterRuntime } from '../lib/forecasters.mjs';
import { createModelProvider } from '../lib/model-provider.mjs';
import { readJsonl } from './helpers.mjs';
import { ADDR, makeCandles, makeLogPool, makeWorld, makeWorldExecutor, rig, x18 } from './forecast-fixtures.mjs';

const NOW = 1_800_000_000;
const def = (k) => AGENT_DEFS.find((d) => d.key === k);
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (cond, n = 200) => { for (let i = 0; i < n && !cond(); i++) await tick(); return cond(); };
const FAIR = { 0: 0.5125, 1: 0.5175, 2: 0.5075 }; // drift capped at 5e-5/min, 10 min horizon, tETH 50/70/30%, bounds 0.99..1.01

function build({
  execute = true, pools, tEthBps = [5000, 7000, 3000], now = NOW, tradingEnd = NOW + 400, only, gateQuant, gateGuardian, failGuardian, flags = {}, nowMs,
  makeExecutors, perfMs,
} = {}) {
  const r = rig({ execute });
  const w = makeWorld({ pools: pools ?? [makeLogPool({ pLong: 0.5 }), makeLogPool({ pLong: 0.56 }), makeLogPool({ pLong: 0.52 })], tEthBps, now, tradingEnd });
  const fetches = { n: 0 };
  const market = { candles: async () => { fetches.n++; return { candles: makeCandles({ endT: w.now, drift: 3e-4, noise: 0 }), cached: false }; } };
  const clockMs = { v: w.now * 1000 };
  const model = createModelProvider({ market, now: () => clockMs.v });
  const calls = { quant: [], guardian: [] };
  const executors = makeExecutors?.(w, calls, r) ?? {
    quant: makeWorldExecutor(w, ADDR.quant, { calls: calls.quant, gate: gateQuant, apply: execute }),
    guardian: makeWorldExecutor(w, ADDR.guardian, { calls: calls.guardian, gate: gateGuardian, apply: execute, failOn: failGuardian }),
  };
  const all = [
    { def: def('quant'), signer: { address: ADDR.quant }, executor: executors.quant },
    { def: def('guardian'), signer: { address: ADDR.guardian }, executor: executors.guardian },
  ].filter((a) => !only || only.includes(a.def.key));
  const stop = new AbortController();
  const runtime = createForecasterRuntime({
    agents: all, ledger: r.ledger, logger: r.logger, execute, fired: r.fired, model, reads: w.reads, roundSource: () => w.reads.roundContext(),
    sleep: async () => {}, stop, flags: { once: true, ...flags }, nowMs: nowMs ?? (() => clockMs.v), ...(perfMs ? { perfMs } : {}),
  });
  const logs = () => readJsonl(r.logger.file());
  return { ...r, w, market, fetches, model, runtime, calls, clockMs, stop, logs, all };
}
const decisions = (t, agent) => t.logs().filter((l) => l.kind === 'decision' && l.agent === agent);

// -------------------------------------------------------------------------------------------------- Quant
test('Quant: evaluates EVERY proposal including the status quo and moves traded markets all the way to fair', async () => {
  const t = build({ pools: [makeLogPool({ pLong: 0.52 }), makeLogPool({ pLong: 0.5 }), makeLogPool({ pLong: 0.51 })] });
  await t.runtime.quantTick();
  const rows = decisions(t, 'quant')[0].inputs.proposals;
  assert.deepEqual(rows.map((r) => r.proposalId), [0, 1, 2], 'proposal 0 is in the table');
  for (const r of rows) {
    assert.ok(Math.abs(r.pFair - FAIR[r.proposalId]) < 1e-4, `pFair ${r.pFair} for ${r.proposalId}`);
    assert.ok(Math.abs(r.gap - (r.pMarket - r.pFair)) < 1e-12);
    assert.equal(r.threshold, 0.005);
  }
  assert.deepEqual(rows.map((r) => r.action), ['buy SHORT', 'buy LONG', 'hold']);
  const [p0, p1, p2] = t.w.pools.map((p) => p.pLong);
  assert.ok(Math.abs(p0 - FAIR[0]) < 2e-3 && p0 >= FAIR[0] - 3e-3, `status quo traded to ${p0}`);
  assert.ok(Math.abs(p1 - FAIR[1]) < 2e-3, `proposal 1 traded to ${p1}`);
  assert.ok(Math.abs(p2 - 0.51) < 1e-9, 'inside the threshold: untouched');
  const fns = t.calls.quant.map((c) => c.fn);
  assert.equal(fns.filter((f) => f === 'deposit').length, 1, 'a single deposit for the whole round');
  assert.equal(fns.filter((f) => f === 'claimCredits').length, 2, 'independent claims in each traded proposal');
  assert.ok(t.calls.quant.filter((c) => c.fn === 'claimCredits').every((c) => c.args[2] === 2_000_000n), 'claim full entitlement independently; actual trades stay capped at one');
});

test('Quant: the 0.005 threshold is strict', async () => {
  const model = buildModel(makeCandles({ endT: NOW, drift: 3e-4, noise: 0 }), { nowSec: NOW });
  const fair2 = fairFor(model, { tEthBps: 3000, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 }).pFairX18;
  for (const [delta, expected] of [[0n, 'hold'], [1n, 'buy SHORT']]) {
    const edge = Object.assign(makeLogPool({ pLong: 0.52 }), { pLongX18: () => fair2 + x18(0.005) + delta });
    const t = build({ execute: false, pools: [makeLogPool({ pLong: 0.5125 }), makeLogPool({ pLong: 0.5175 }), edge] });
    await t.runtime.quantTick();
    const row = decisions(t, 'quant')[0].inputs.proposals.find((r) => r.proposalId === 2);
    assert.equal(row.action, expected, `gap = 0.005 + ${delta} unit`);
  }
});

test('Quant waits for its tick and does nothing outside the schedule', async () => {
  const t = build({ now: NOW, tradingEnd: NOW + 400 });
  t.w.now = NOW - 200; // before the round has run for 30 s
  t.w.tradingStart = NOW - 100;
  await t.runtime.quantTick();
  assert.equal(t.calls.quant.length, 0);
  assert.equal(decisions(t, 'quant')[0].action, 'wait');
});

// -------------------------------------------------------------------------------------------------- shared model and cache
test('one cached model serves Quant and Guardian: identical pFair, and the cache expires at 60 s', async () => {
  const t = build({ execute: false });
  await t.runtime.quantTick();
  const g = await t.runtime.guardianPass();
  await g.inflight;
  assert.equal(t.fetches.n, 1, 'one fetch for both agents');
  const q = decisions(t, 'quant')[0].inputs.proposals;
  const gr = decisions(t, 'guardian')[0].inputs.proposals;
  for (const row of gr.filter((r) => r.pFair != null)) assert.equal(row.pFair, q.find((x) => x.proposalId === row.proposalId).pFair, 'exactly the Quant pFair');
  t.clockMs.v += 59_999;
  await t.model.get();
  assert.equal(t.fetches.n, 1, 'still cached at 59.999 s');
  t.clockMs.v += 1;
  await t.model.get();
  assert.equal(t.fetches.n, 2, 'refetched at 60 s');
  assert.equal(FORECAST.modelTtlMs, 60_000);
});

test('the Guardian never stalls on a slow or failing market-data fetch', async () => {
  const clockMs = { v: NOW * 1000 };
  let hang = false;
  const market = { candles: async () => (hang ? new Promise(() => {}) : { candles: makeCandles({ endT: NOW, drift: 3e-4, noise: 0 }) }) };
  const model = createModelProvider({ market, now: () => clockMs.v });
  assert.equal((await model.getBounded({ waitMs: 20 })).stale, false);
  hang = true;
  clockMs.v += 61_000;
  await assert.rejects(model.getBounded({ waitMs: 20 }), /no usable market model/, 'expired model cannot authorize an intervention');
  clockMs.v += 130_000;
  await assert.rejects(model.getBounded({ waitMs: 20 }), /no usable market model/);
  const failing = createModelProvider({ market: { candles: async () => { throw new Error('HTTP 503'); } }, now: () => clockMs.v });
  await assert.rejects(failing.getBounded({ waitMs: 20 }), /no usable market model/);
});

// -------------------------------------------------------------------------------------------------- Guardian
test('Guardian outside the final window needs 0.03: only the overpriced leader acts, and only with SHORT', async () => {
  const t = build({}); // twap window starts 160 s from now: outside
  const g = await t.runtime.guardianPass();
  await g.inflight;
  const d = decisions(t, 'guardian')[0].inputs;
  assert.equal(d.finalWindow, false);
  assert.equal(d.threshold, 0.03);
  assert.equal(d.leader, 1);
  assert.deepEqual(d.candidates, [1, 0, 2], 'leader first, then every eligible proposal including status quo');
  const buys = t.calls.guardian.filter((c) => /^buy/.test(c.fn));
  assert.deepEqual(buys.map((c) => [c.fn, Number(c.args[1])]), [['buyShort', 1]], 'proposal 2 is only 0.0125 above fair: below 0.03');
  assert.ok(t.w.pools[1].pLong < 0.56 && t.w.pools[1].pLong > FAIR[1] - 3e-3, `leader pushed down to ${t.w.pools[1].pLong}`);
});

test('Guardian inside the final window needs only 0.01 and serves the leader first', async () => {
  const t = build({ now: NOW, tradingEnd: NOW + 100 });
  t.w.tradingStart = NOW - 300;
  const g = await t.runtime.guardianPass();
  await g.inflight;
  const d = decisions(t, 'guardian')[0].inputs;
  assert.equal(d.finalWindow, true);
  assert.equal(d.threshold, 0.01);
  const buys = t.calls.guardian.filter((c) => c.fn === 'buyShort').map((c) => Number(c.args[1]));
  assert.deepEqual(buys, [1, 2], 'leader (1) before the other overpriced proposal (2)');
});

test('Guardian threshold is strict (0.01 exactly does nothing) and it ignores underpriced markets', async () => {
  const model = buildModel(makeCandles({ endT: NOW, drift: 3e-4, noise: 0 }), { nowSec: NOW });
  const fair2 = fairFor(model, { tEthBps: 3000, horizonSeconds: 600, rMin: 0.99, rMax: 1.01 }).pFairX18;
  for (const [delta, expected] of [[0n, 'hold'], [1n, 'buy SHORT']]) {
    const edge = Object.assign(makeLogPool({ pLong: 0.52 }), { pLongX18: () => fair2 + x18(0.01) + delta });
    const t = build({ execute: false, now: NOW, tradingEnd: NOW + 100, pools: [makeLogPool({ pLong: 0.5 }), makeLogPool({ pLong: 0.5 }), edge] });
    t.w.tradingStart = NOW - 300;
    const g = await t.runtime.guardianPass();
    await g.inflight;
    const row = decisions(t, 'guardian')[0].inputs.proposals.find((r) => r.proposalId === 2);
    assert.equal(row.action, expected, `gap = 0.01 + ${delta} unit`);
  }
  const under = build({ execute: false, now: NOW, tradingEnd: NOW + 100, pools: [makeLogPool({ pLong: 0.5 }), makeLogPool({ pLong: 0.51 }), makeLogPool({ pLong: 0.51 })] });
  under.w.tradingStart = NOW - 300;
  const u = await under.runtime.guardianPass();
  assert.deepEqual(u.rows.map((r) => r.intervene), Array(u.rows.length).fill(false));
  assert.equal(under.calls.guardian.length, 0);
});

test('Guardian leader follows projected TWAP with epsilon: a spot-cheap proposal with a high projected TWAP is still evaluated', async () => {
  const pools = [makeLogPool({ pLong: 0.5 }), makeLogPool({ pLong: 0.49 }), makeLogPool({ pLong: 0.53 })];
  const t = build({ execute: false, pools, now: NOW, tradingEnd: NOW + 100 });
  t.w.tradingStart = NOW - 300;
  t.w.twaps = [x18(0.5), x18(0.58), x18(0.53)]; // proposal 1 is the projected winner although its spot is below the status quo
  const g = await t.runtime.guardianPass();
  assert.equal(g.leader, 1);
  assert.deepEqual(g.ids, [1, 0, 2]);
  t.w.twaps = [x18(0.5), x18(0.505), x18(0.4)]; // exactly epsilon: the status quo keeps winning
  const g2 = await t.runtime.guardianPass();
  assert.equal(g2.leader, 0);
  assert.deepEqual(g2.ids, [0, 2]);
});

test('exactly ONE prices multicall per steady-state pass, and the pass duration is logged', async () => {
  const t = build({ execute: false });
  await t.runtime.guardianPass();
  assert.equal(t.w.calls.guardianBatch, 1);
  assert.equal(t.w.calls.roundContext, 1);
  const g = await t.runtime.guardianPass();
  assert.equal(t.w.calls.guardianBatch, 2, 'one more call for the second pass, not two');
  assert.equal(t.w.calls.roundContext, 1, 'the round header is cached between passes');
  assert.equal(g.multicalls, 1);
  const d = decisions(t, 'guardian').at(-1).inputs;
  assert.equal(d.multicalls, 1);
  assert.equal(typeof d.passMs, 'number');
  assert.equal(d.withinBudget, true);
  assert.equal(d.budgetMs, 3000);
});

test('Guardian records failed pass duration and includes slow failures in the budget metric', async () => {
  let clock = 0;
  const t = build({ execute: false, perfMs: () => { clock += 2000; return clock; } });
  t.logger.info('start failed-pass fixture'); // Missing decisions must fail the assertion, not file opening.
  t.w.reads.guardianBatch = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(t.runtime.guardianPass(), /RPC unavailable/);
  const failed = decisions(t, 'guardian').find(d => d.action === 'failed');
  assert.ok(failed, 'failed evaluations must remain visible to latency reports');
  assert.equal(failed.inputs.passMs, 4000);
  assert.equal(failed.inputs.withinBudget, false);
  assert.equal(t.calls.guardian.length, 0);
});

test('Guardian records idle pass duration without sending a transaction', async () => {
  let clock = 0;
  const t = build({ execute: false, perfMs: () => ++clock });
  t.w.status = 3;
  const result = await t.runtime.guardianPass();
  assert.equal(result.idle, true);
  const idle = decisions(t, 'guardian').find(d => d.action === 'idle');
  assert.ok(idle, 'idle evaluations must be counted as passes');
  assert.ok(idle.inputs.passMs > 0);
  assert.equal(t.calls.guardian.length, 0);
});

test('a round change refreshes the header and defers prices to the next pass', async () => {
  const t = build({ execute: false });
  await t.runtime.guardianPass();
  t.w.id = 2n;
  const g = await t.runtime.guardianPass();
  assert.equal(g.multicalls, 1);
  assert.equal(t.w.calls.guardianBatch, 2);
  assert.equal(g.reason, 'round transition');
  const next = await t.runtime.guardianPass();
  assert.equal(next.multicalls, 1);
  assert.equal(t.w.calls.guardianBatch, 3);
});

test('Guardian cadence: 5 s inside the final window, 15 s outside', async () => {
  const outside = build({ execute: false });
  const o = await outside.runtime.guardianPass();
  assert.ok(o.wait > 5000 && o.wait <= 15_000, `outside: ${o.wait}`);
  const inside = build({ execute: false, now: NOW, tradingEnd: NOW + 100 });
  inside.w.tradingStart = NOW - 300;
  const i = await inside.runtime.guardianPass();
  assert.ok(i.wait >= 250 && i.wait <= 5000, `inside: ${i.wait}`);
});

// -------------------------------------------------------------------------------------------------- independence
test('the Guardian ACTS while a Quant transaction is still pending (production orchestrator)', async () => {
  let release;
  const gateQuant = new Promise((res) => { release = res; });
  const t = build({ gateQuant });
  let quantFinished = false;
  const done = t.runtime.run({ once: true }).then(() => { quantFinished = true; });
  assert.equal(await waitFor(() => t.calls.quant.length > 0), true, 'Quant has started its transaction chain');
  assert.equal(await waitFor(() => t.calls.guardian.some((c) => c.fn === 'buyShort')), true, 'the Guardian intervened');
  assert.equal(quantFinished, false, 'while the Quant transaction is STILL pending');
  assert.ok(!t.calls.quant.some((c) => /^buy/.test(c.fn)), 'Quant has not got past its gated first step');
  assert.ok(t.w.pools[1].pLong < 0.56, 'the Guardian trade landed on the shared market');
  release();
  await done;
  assert.equal(quantFinished, true);
});

test('the evaluation pass never awaits a transaction; a second pass does not stack another one', async () => {
  let release;
  const gateGuardian = new Promise((res) => { release = res; });
  const t = build({ gateGuardian });
  let timer;
  const g = await Promise.race([
    t.runtime.guardianPass(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: 'Guardian evaluation waited for its transaction' })), 500); }),
  ]).finally(() => clearTimeout(timer));
  assert.ok(g.inflight, 'the intervention runs in the background');
  assert.equal(await waitFor(() => t.calls.guardian.length > 0), true);
  const before = t.calls.guardian.length;
  const g2 = await t.runtime.guardianPass();
  assert.equal(g2.inflight, g.inflight, 'still the same in-flight chain');
  assert.equal(t.calls.guardian.length, before, 'no concurrent transactions for one wallet');
  assert.ok(t.logs().some((l) => l.kind === 'info' && /still in flight/.test(l.message)));
  release();
  await g.inflight;
});

test('late TradingClosed is logged and nonfatal, and stops further attempts in that round', async () => {
  const t = build({ failGuardian: (s) => (s.functionName === 'buyShort' ? Object.assign(new Error('TradingClosed(1,2,3)'), { errorName: 'TradingClosed' }) : null) });
  const g = await t.runtime.guardianPass();
  await g.inflight;
  const logs = t.logs();
  assert.ok(logs.some((l) => l.agent === 'guardian' && /late TradingClosed, not an error/.test(l.action ?? '')));
  assert.ok(!logs.some((l) => l.kind === 'error'));
  const n = t.calls.guardian.length;
  const g2 = await t.runtime.guardianPass();
  await g2.inflight;
  assert.equal(t.calls.guardian.length, n, 'no retry once trading is closed');
  assert.ok(t.ledger.spentOnProposal('guardian', 1n, 1) === 0n, 'the budget was released');
});

test('stale snapshot: if the round moved on before the transaction, nothing is sent', async () => {
  const t = build({});
  const original = t.w.reads.roundFresh;
  t.w.reads.roundFresh = async (r) => ({ ...(await original(r)), ok: false, reason: 'round changed (now 2)' });
  const g = await t.runtime.guardianPass();
  await g.inflight;
  assert.equal(t.calls.guardian.length, 0);
  assert.ok(decisions(t, 'guardian').some((d) => /intervention stale/.test(d.action ?? '')));
});

test('failed interventions are bounded: three attempts, then the Guardian gives up on that proposal for the round', async () => {
  let ms = NOW * 1000;
  const t = build({ nowMs: () => ms, failGuardian: (s) => (s.functionName === 'buyShort' ? new StepFailed('rejected', { ambiguous: false }) : null) });
  for (let i = 0; i < 8; i++) {
    const g = await t.runtime.guardianPass();
    await g.inflight;
    ms += 11_000;
  }
  assert.equal(t.calls.guardian.filter((c) => c.fn === 'buyShort').length, 3);
  assert.equal(t.ledger.spentOnProposal('guardian', 1n, 1), 0n);
});

// -------------------------------------------------------------------------------------------------- run.mjs wiring
test('--only proposers: no forecast runtime, no market-data fetch, no chain reads', () => {
  let fetched = 0;
  const reads = new Proxy({}, { get() { throw new Error('forecaster reads must not be touched'); } });
  const proposer = { def: AGENT_DEFS.find((d) => d.type === 'proposer'), signer: { address: ADDR.quant }, executor: {} };
  const rt = buildForecasterRuntime({ agents: [proposer], ledger: {}, logger: {}, execute: false, fired: {}, stop: new AbortController(), sleep: async () => {}, deps: { reads, market: { candles: async () => { fetched++; } } } });
  assert.equal(rt, null);
  assert.equal(fetched, 0);
});

test('--only guardian: a fresh Quant-equivalent model is fetched, but no Quant trade is ever launched', async () => {
  const t = build({ only: ['guardian'] });
  const rt = buildForecasterRuntime({
    agents: t.all, ledger: t.ledger, logger: t.logger, execute: true, fired: t.fired, stop: t.stop, sleep: async () => {}, flags: { once: true },
    deps: { reads: t.w.reads, market: t.market, runtime: { nowMs: () => t.clockMs.v } },
  });
  assert.equal(rt.has('quant'), false);
  assert.equal(rt.has('guardian'), true);
  await rt.run({ once: true });
  assert.equal(t.fetches.n, 1, 'the model was fetched for the Guardian');
  assert.equal(t.w.calls.quantView, 0);
  assert.equal(t.calls.quant.length, 0);
  assert.ok(t.calls.guardian.some((c) => c.fn === 'buyShort'));
});

test('dry-run end to end: zero transactions through the real executor and no durable marks', async () => {
  let sent = 0;
  const makeExecutors = (w, calls, r) => {
    const mk = (address) => {
      const signer = { address, estimateFee: async () => ({ attempts: 1, networkFeeWei: null }), execute: async () => { sent++; throw new Error('must not send'); } };
      return createExecutor({
        agent: { key: address === ADDR.quant ? 'quant' : 'guardian' }, signer, ledger: r.ledger, logger: r.logger, execute: false,
        estimator: { estimateContractGas: async () => 120_000n }, gasFees: async () => ({ maxFeePerGas: 41n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
      });
    };
    return { quant: mk(ADDR.quant), guardian: mk(ADDR.guardian) };
  };
  const t = build({ execute: false, makeExecutors, pools: [makeLogPool({ pLong: 0.52 }), makeLogPool({ pLong: 0.56 }), makeLogPool({ pLong: 0.505 })] });
  await t.runtime.run({ once: true });
  assert.equal(sent, 0);
  const tx = t.logs().filter((l) => l.kind === 'tx');
  assert.ok(tx.length > 0 && tx.every((l) => /dry-run, nothing sent/.test(l.status)));
  assert.equal(t.ledger.hasFired(`1|quant|t0`), false);
  assert.deepEqual(t.ledger.state.trades, {});
  assert.deepEqual(t.ledger.state.tradeReservations, {});
  assert.deepEqual(t.ledger.state.fired, {});
  assert.deepEqual(t.ledger.state.entries, {});
  assert.ok(FORECAST.maxActionAttempts === 3 && gasCaps('full').perRoundWei > 0n);
});
