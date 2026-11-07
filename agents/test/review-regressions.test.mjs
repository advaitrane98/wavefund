import assert from 'node:assert/strict';
import test from 'node:test';
import { guardianCandidates } from '../lib/decide.mjs';
import { createModelProvider } from '../lib/model-provider.mjs';
import { createForecastReads } from '../lib/forecast-chain.mjs';
import { createTrader } from '../lib/trader.mjs';
import { StepFailed } from '../lib/executor.mjs';
import { ADDR, makeLogPool, makeWorld, makeWorldExecutor, rig, x18 } from './forecast-fixtures.mjs';

test('review: status quo is eligible even when a challenger is projected to win', () => {
  const { leader, ids } = guardianCandidates({ spots: [700000000000000000n, 800000000000000000n], twaps: [500000000000000000n, 600000000000000000n] });
  assert.equal(leader, 1);
  assert.deepEqual(ids, [1, 0]);
});

test('review: Guardian cannot use a reference that has reached its 60-second expiry', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const market = { candles: async () => {
    if (++calls > 1) return new Promise(() => {});
    return { candles: Array.from({ length: 30 }, (_, i) => ({ t: now / 1000 - (29 - i) * 60, close: 2000 + i })) };
  } };
  const provider = createModelProvider({ market, now: () => now });
  const fresh = await provider.getBounded({ waitMs: 1 });
  assert.equal(fresh.stale, false);
  now += 60000;
  await assert.rejects(provider.getBounded({ waitMs: 1 }), /model|expired|stale|forecast/i);
});

test('review: failed deposit read cannot turn into a zero deposit', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const client = { multicall: async ({ contracts }) => contracts.map(c => {
    if (c.functionName === 'deposits') return { status: 'failure', error: new Error('deposit unavailable') };
    if (['creditToken', 'longToken', 'shortToken'].includes(c.functionName)) return { status: 'success', result: address };
    return { status: 'success', result: 0n };
  }) };
  const reads = createForecastReads({ client });
  await assert.rejects(reads.haveState(1n, 0, address), /deposit|read|unavailable/i);
});

test('review: missing chain timestamp cannot pass the trading freshness gate', async () => {
  const round = [100, 500, 600, 100, 990000000000000000n, 1010000000000000000n, 1, 2, 0];
  const client = { multicall: async ({ contracts }) => contracts.map(c => c.functionName === 'getCurrentBlockTimestamp'
    ? { status: 'failure', error: new Error('clock unavailable') }
    : { status: 'success', result: c.functionName === 'currentRoundId' ? 1n : round }) };
  const reads = createForecastReads({ client });
  const result = await reads.roundFresh(1n).catch(e => ({ ok: false, reason: e.message }));
  assert.equal(result.ok, false);
});

test('review: all refinement quotes use one block; a fresh search gets a new block', async () => {
  let blocks = 0;
  const seen = [];
  const client = {
    getBlockNumber: async () => BigInt(40 + ++blocks),
    multicall: async ({ contracts, blockNumber }) => {
      seen.push(blockNumber);
      return contracts.map(c => ({ status: 'success', result: c.functionName === 'probabilities' ? [500000000000000000n, 500000000000000000n] : 2000000000000000000n }));
    },
  };
  const reads = createForecastReads({ client });
  const batch = reads.batchFor(1n, 0);
  const requests = [{ kind: 'buy', side: 'long', x: 100000n }];
  await batch({ requests });
  await batch({ requests });
  await reads.batchFor(1n, 0)({ requests });
  assert.deepEqual(seen, [41n, 41n, 42n]);
  assert.equal(blocks, 2);
});

function traderRig({ onStep, failOn } = {}) {
  const r = rig({ execute: true });
  const pool = makeLogPool({ pLong: 0.45 });
  const world = makeWorld({ pools: [pool] });
  const calls = [];
  const executor = makeWorldExecutor(world, ADDR.quant, { calls, onStep: step => onStep?.(step, pool), failOn });
  const makeTrader = () => createTrader({ agent: { key: 'quant' }, signer: { address: ADDR.quant }, executor, ledger: r.ledger, logger: r.logger, execute: true, reads: world.reads });
  return { ...r, pool, world, calls, makeTrader, intent: { roundId: 1n, proposalId: 0, direction: 'raise', targetX18: x18(0.55), allowSell: true } };
}

test('review: target size is recalculated after a delayed deposit moves the market toward fair', async () => {
  const t = traderRig({ onStep: (step, pool) => { if (step.functionName === 'deposit') pool.setP(0.54); } });
  const result = await t.makeTrader().act(t.intent);
  assert.equal(result.status, 'done', result.reason);
  assert.ok(t.pool.pLong > 0.549 && t.pool.pLong <= 0.5503, `terminal price ${t.pool.pLong}`);
  assert.equal(t.calls.filter(c => c.fn === 'deposit').length, 1);
});

test('review: a reference that expires during deposit cannot authorize a trade', async () => {
  let valid = true;
  const t = traderRig({ onStep: step => { if (step.functionName === 'deposit') valid = false; } });
  const result = await t.makeTrader().act({ ...t.intent, referenceValid: () => valid });
  assert.equal(result.status, 'stale');
  assert.match(result.reason, /reference expired/);
  assert.equal(t.calls.filter(c => /^buy|^sell/.test(c.fn)).length, 0);
});

test('review: an ambiguous deposit blocks all further operations for that agent after recreation', async () => {
  const t = traderRig({ failOn: step => step.functionName === 'deposit' ? new StepFailed('deposit receipt unknown', { ambiguous: true }) : null });
  const first = await t.makeTrader().act(t.intent);
  assert.equal(first.ambiguous, true);
  const count = t.calls.length;
  const again = await t.makeTrader().act(t.intent);
  assert.equal(again.status, 'pending');
  assert.equal(t.calls.length, count, 'no second deposit or claim while the first may be pending');
});

test('review: ambiguous gas without a hash stays reserved during crash recovery', async () => {
  const { ledger } = rig({ execute: true });
  const id = ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: 100n, label: 'deposit' });
  ledger.markGasAmbiguous(id);
  const recovered = await ledger.recover(async () => { throw new Error('no receipt'); });
  assert.deepEqual(recovered, { released: 0, committed: 0, stillPending: 1 });
  assert.equal(ledger.pendingGas('quant').length, 1);
  assert.equal(ledger.usage('quant', 1).round, 100n);
});
