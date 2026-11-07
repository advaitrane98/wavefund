import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { erc20Abi } from 'viem';
import { PlanError, sellSteps, tradeSteps } from '../lib/actions.mjs';
import { FORECASTER_DEPOSIT, MAX_PROPOSAL_CREDITS, MAX_TRADE_CREDITS } from '../lib/config.mjs';
import { StepFailed, createExecutor } from '../lib/executor.mjs';
import { SpendLedger } from '../lib/ledger.mjs';
import { createRedeemer } from '../lib/redeemer.mjs';
import { createMutex, createTrader } from '../lib/trader.mjs';
import { readJsonl } from './helpers.mjs';
import { ADDR, makeLogPool, makeWorld, makeWorldExecutor, rig, x18 } from './forecast-fixtures.mjs';
import { gasCaps } from '../lib/config.mjs';

const AGENT = { key: 'quant' };
const state0 = { roundAllowance: 0n };

function setup({ execute = true, pools = [makeLogPool({ pLong: 0.45 }), makeLogPool({ pLong: 0.45 }), makeLogPool({ pLong: 0.45 })], executorOpts = {}, world } = {}) {
  const r = rig({ execute });
  const w = world ?? makeWorld({ pools });
  const calls = [];
  const executor = makeWorldExecutor(w, ADDR.quant, { calls, apply: execute, ...executorOpts });
  const trader = createTrader({ agent: AGENT, signer: { address: ADDR.quant }, executor, ledger: r.ledger, logger: r.logger, execute, reads: w.reads });
  const intent = (proposalId, target, extra = {}) => ({ roundId: w.id, proposalId, direction: 'raise', targetX18: x18(target), allowSell: true, ...extra });
  return { ...r, w, calls, trader, intent, executor };
}
const labels = (calls) => calls.map((c) => c.fn);

// ---------------------------------------------------------------------------------------------- tradeSteps (pure)
test('tradeSteps: ONE deposit per round, credits claimed independently per proposal', () => {
  const first = tradeSteps({ state: state0, roundId: 1n, proposalId: 1, credits: 800_000n, long: true, have: { deposit: 0n, claimed: 0n, credits: 0n }, minOut: 5n });
  assert.deepEqual(first.steps.map((s) => s.functionName), ['approve', 'deposit', 'claimCredits', 'buyLong']);
  assert.equal(first.steps[1].args[1], FORECASTER_DEPOSIT, 'a single 2 USDC deposit');
  assert.equal(first.steps[2].args[2], 800_000n);
  // proposal 2 in the same round: the deposit exists, so only a claim in THAT proposal and a buy
  const second = tradeSteps({ state: { roundAllowance: 0n }, roundId: 1n, proposalId: 2, credits: 900_000n, long: false, have: { deposit: FORECASTER_DEPOSIT, claimed: 0n, credits: 0n }, minOut: 5n });
  assert.deepEqual(second.steps.map((s) => s.functionName), ['claimCredits', 'buyShort']);
  assert.equal(second.steps[0].args[1], 2n);
  // both proposals can claim up to the whole deposit, independently
  const full = tradeSteps({ state: state0, roundId: 1n, proposalId: 3, credits: 1_000_000n, long: true, have: { deposit: FORECASTER_DEPOSIT, claimed: 1_000_000n, credits: 0n }, minOut: 5n });
  assert.equal(full.steps[0].args[2], 1_000_000n);
});

test('tradeSteps: leftover credits are reused, an allowance is not re-approved, claims cannot exceed the deposit', () => {
  const reuse = tradeSteps({ state: { roundAllowance: 10n ** 9n }, roundId: 1n, proposalId: 1, credits: 600_000n, long: true, have: { deposit: 0n, claimed: 0n, credits: 250_000n }, minOut: 5n });
  assert.deepEqual(reuse.steps.map((s) => s.functionName), ['deposit', 'claimCredits', 'buyLong']);
  assert.equal(reuse.steps[1].args[2], 350_000n);
  assert.throws(() => tradeSteps({ state: state0, roundId: 1n, proposalId: 1, credits: 1_000_000n, long: true, have: { deposit: FORECASTER_DEPOSIT, claimed: 1_500_000n, credits: 0n }, minOut: 5n }), (e) => e instanceof PlanError && e.code === 'claim-exceeds-deposit');
});

test('tradeSteps and sellSteps refuse to build a trade without a quote-derived minimum', () => {
  const have = { deposit: FORECASTER_DEPOSIT, claimed: 0n, credits: 1_000_000n };
  for (const minOut of [undefined, 0n, -1n, 5]) assert.throws(() => tradeSteps({ state: state0, roundId: 1n, proposalId: 1, credits: 1n, long: true, have, minOut }), PlanError);
  const [s] = sellSteps({ roundId: 1n, proposalId: 1, amountIn: 10n ** 18n, long: true, minCredits: 990_000n });
  assert.deepEqual([s.functionName, s.args[3]], ['sellLong', 990_000n]);
  assert.throws(() => sellSteps({ roundId: 1n, proposalId: 1, amountIn: 1n, long: true }), PlanError);
});

// ---------------------------------------------------------------------------------------------- the trader
test('one deposit across two proposals, independent claims, and each market is moved to its fair value', async () => {
  const t = setup();
  const a = await t.trader.act(t.intent(1, 0.5));
  const b = await t.trader.act(t.intent(2, 0.49));
  assert.equal(a.status, 'done', a.reason);
  assert.equal(b.status, 'done', b.reason);
  assert.equal(labels(t.calls).filter((f) => f === 'deposit').length, 1, 'ONE deposit for the whole round');
  assert.equal(labels(t.calls).filter((f) => f === 'claimCredits').length, 2, 'a claim in EACH traded proposal');
  assert.equal(t.calls.filter((c) => c.fn === 'claimCredits').map((c) => Number(c.args[1])).join(), '1,2');
  assert.ok(Math.abs(t.w.pools[1].pLong - 0.5) < 2e-3 && Math.abs(t.w.pools[2].pLong - 0.49) < 2e-3);
  assert.ok(t.w.pools[1].pLong <= 0.5 + 3e-4, 'no overshoot');
  assert.ok(Math.abs(t.w.pools[0].pLong - 0.45) < 1e-12, 'an untraded proposal is untouched');
  assert.deepEqual(t.ledger.trackedRounds('quant'), ['1'], 'the round is tracked so it can be redeemed later');
});

test('minOut for buys and sells is the fresh adapter quote times 995/1000', async () => {
  const pool = makeLogPool({ pLong: 0.45 });
  const seen = [];
  const t = setup({ pools: [pool], executorOpts: { onStep: (step) => {
    if (step.functionName === 'buyLong') seen.push({ fn: 'buyLong', min: step.args[3], quote: pool.quoteBuy('long', step.args[2]) });
    if (step.functionName === 'sellLong') seen.push({ fn: 'sellLong', min: step.args[3], quote: pool.quoteSell('long', step.args[2]).credits });
  } } });
  await t.trader.act(t.intent(0, 0.52));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].min, (seen[0].quote * 995n) / 1000n);
  assert.notEqual(seen[0].min, seen[0].quote, '0.5% below the quote');
  // now sell part of the LONG it holds after the market overshoots
  pool.setP(0.62);
  const sell = await t.trader.act({ ...t.intent(0, 0.58), direction: 'lower' });
  assert.equal(sell.status, 'done', sell.reason);
  const sold = seen.find((s) => s.fn === 'sellLong');
  assert.ok(sold, 'a LONG position is sold, not hedged with a SHORT buy');
  assert.equal(sold.min, (sold.quote * 995n) / 1000n);
});

test('per-trade cap (1 credit) and per-proposal cap (2 credits) hold across repeated trades', async () => {
  const pool = makeLogPool({ pLong: 0.2, kappa: 0.05 }); // very deep: wants far more than the caps allow
  const t = setup({ pools: [pool] });
  const results = [];
  for (let i = 0; i < 4; i++) { pool.setP(0.2); results.push(await t.trader.act(t.intent(0, 0.9))); }
  const bought = t.calls.filter((c) => c.fn === 'buyLong').map((c) => c.args[2]);
  assert.ok(bought.every((c) => c <= MAX_TRADE_CREDITS), 'never more than 1 credit in a trade');
  assert.equal(bought.reduce((a, b) => a + b, 0n), MAX_PROPOSAL_CREDITS, 'exactly the 2 credit proposal cap in total');
  assert.deepEqual(results.map((r) => r.status), ['done', 'done', 'capped', 'capped']);
  assert.equal(t.ledger.spentOnProposal('quant', 1n, 0), MAX_PROPOSAL_CREDITS);
});

test('dry-run: ZERO transactions through the real executor, cumulative planning, no durable marks', async () => {
  const r = rig({ execute: false });
  const w = makeWorld({ pools: [makeLogPool({ pLong: 0.2, kappa: 0.05 })] });
  let sent = 0;
  const signer = { address: ADDR.quant, estimateFee: async () => ({ attempts: 1, networkFeeWei: null }), execute: async () => { sent++; throw new Error('must not send'); } };
  const executor = createExecutor({
    agent: AGENT, signer, ledger: r.ledger, logger: r.logger, execute: false,
    estimator: { estimateContractGas: async () => 120_000n }, gasFees: async () => ({ maxFeePerGas: 41n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }),
  });
  const trader = createTrader({ agent: AGENT, signer, executor, ledger: r.ledger, logger: r.logger, execute: false, reads: w.reads });
  const out = [];
  for (let i = 0; i < 3; i++) out.push(await trader.act({ roundId: w.id, proposalId: 0, direction: 'raise', targetX18: x18(0.9), allowSell: true }));
  assert.equal(sent, 0, 'dry-run sends nothing');
  assert.deepEqual(out.map((o) => o.status), ['planned', 'planned', 'capped'], 'caps are cumulative inside the dry-run');
  const tx = readJsonl(r.logger.file()).filter((l) => l.kind === 'tx');
  assert.equal(tx.filter((l) => l.step === 'deposit').length, 1, 'the dry-run plans the deposit once');
  assert.ok(tx.every((l) => /dry-run, nothing sent/.test(l.status)));
  const durable = JSON.parse(fs.existsSync(r.ledger.file) ? fs.readFileSync(r.ledger.file, 'utf8') : '{}');
  assert.deepEqual(durable.trades ?? {}, {});
  assert.deepEqual(durable.tradeReservations ?? {}, {});
  assert.deepEqual(durable.tracked ?? {}, {});
  assert.deepEqual(durable.entries ?? {}, {});
  assert.equal(new SpendLedger({ file: r.ledger.file, caps: gasCaps('full') }).spentOnProposal('quant', 1n, 0), 0n);
});

test('ambiguous broadcast keeps the budget counted, also after a restart; a clean failure gives it back', async () => {
  const ambiguous = setup({ pools: [makeLogPool({ pLong: 0.2, kappa: 0.05 })], executorOpts: { failOn: (s) => (s.functionName === 'buyLong' ? new StepFailed('timeout', { ambiguous: true, hash: '0xabc' }) : null) } });
  const res = await ambiguous.trader.act(ambiguous.intent(0, 0.9));
  assert.equal(res.status, 'failed');
  assert.equal(res.ambiguous, true);
  const spent = ambiguous.ledger.spentOnProposal('quant', 1n, 0);
  assert.ok(spent > 0n);
  const again = new SpendLedger({ file: ambiguous.ledger.file, caps: gasCaps('full') });
  assert.equal(again.spentOnProposal('quant', 1n, 0), spent, 'no duplicate spend after a restart');
  assert.equal(again.unresolvedTradeReservations()[0].state, 'ambiguous');

  const clean = setup({ pools: [makeLogPool({ pLong: 0.2, kappa: 0.05 })], executorOpts: { failOn: (s) => (s.functionName === 'buyLong' ? new StepFailed('rejected', { ambiguous: false }) : null) } });
  const res2 = await clean.trader.act(clean.intent(0, 0.9));
  assert.equal(res2.status, 'failed');
  assert.equal(clean.ledger.spentOnProposal('quant', 1n, 0), 0n, 'never broadcast: the budget is free again');
});

test('dry-run claims remain independent across proposals and are reused on later trades', async () => {
  const t = setup({ execute: false });
  for (const id of [1, 2, 1]) {
    const result = await t.trader.act(t.intent(id, 0.5));
    assert.equal(result.status, 'planned', result.reason);
  }
  const claims = t.calls.filter(c => c.fn === 'claimCredits');
  assert.deepEqual(claims.map(c => Number(c.args[1])), [1, 2], 'no re-claim in proposal 1 after trading proposal 2');
  assert.equal(t.calls.filter(c => c.fn === 'deposit').length, 1);
});

test('a signal that vanished before the trade lands is not traded, and the budget is released', async () => {
  const t = setup({ pools: [makeLogPool({ pLong: 0.45 })] });
  const res = await t.trader.act(t.intent(0, 0.52, { stillValid: () => false }));
  assert.equal(res.status, 'stale');
  assert.equal(labels(t.calls).includes('buyLong'), false);
  assert.equal(t.ledger.spentOnProposal('quant', 1n, 0), 0n);
});

test('TradingClosed is logged and nonfatal; a round that moved on is stale', async () => {
  const closing = setup({ pools: [makeLogPool({ pLong: 0.45 })], executorOpts: { failOn: (s) => (s.functionName === 'buyLong' ? Object.assign(new Error('TradingNotOpen'), { errorName: 'TradingNotOpen' }) : null) } });
  const res = await closing.trader.act(closing.intent(0, 0.52));
  assert.equal(res.status, 'closed');
  assert.equal(closing.ledger.spentOnProposal('quant', 1n, 0), 0n);
  const logs = readJsonl(closing.logger.file());
  assert.ok(logs.some((l) => l.kind === 'info' && /trading closed/.test(l.message)));
  assert.ok(!logs.some((l) => l.kind === 'error'));

  const ended = setup({ pools: [makeLogPool({ pLong: 0.45 })] });
  ended.w.now = ended.w.tradingEnd + 1;
  assert.equal((await ended.trader.act(ended.intent(0, 0.52))).status, 'closed');
  const moved = setup({ pools: [makeLogPool({ pLong: 0.45 })] });
  assert.equal((await moved.trader.act({ ...moved.intent(0, 0.52), roundId: 99n })).status, 'stale');
  assert.equal(moved.calls.length, 0);
});

test('the Guardian-style trader (allowSell false) buys SHORT even while holding LONG; Quant sells it', async () => {
  const pool = makeLogPool({ pLong: 0.45 });
  const q = setup({ pools: [pool] });
  await q.trader.act(q.intent(0, 0.5));
  pool.setP(0.6);
  const g = await q.trader.act({ ...q.intent(0, 0.55), direction: 'lower', allowSell: false });
  assert.equal(g.stage.kind, 'buy');
  assert.equal(g.stage.side, 'short');
  pool.setP(0.6);
  const s = await q.trader.act({ ...q.intent(0, 0.55), direction: 'lower', allowSell: true });
  assert.equal(s.stage.kind, 'sell');
});

test('unfunded wallets are not asked to deposit (execute); one wallet runs one chain at a time', async () => {
  const t = setup({ pools: [makeLogPool({ pLong: 0.45 })] });
  t.w.wallet(ADDR.quant).usdc = 1_000_000n;
  assert.equal((await t.trader.act(t.intent(0, 0.52))).status, 'unfunded');
  assert.equal(t.calls.length, 0);
  const m = createMutex();
  const order = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = m.run(async () => { order.push('a-start'); await gate; order.push('a-end'); });
  const second = m.run(async () => { order.push('b'); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['a-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

// ---------------------------------------------------------------------------------------------- settle / redeem
function redeemRig({ execute = true, world, failFirst = 0 } = {}) {
  const r = rig({ execute });
  const w = world ?? makeWorld({ pools: [makeLogPool()] });
  const calls = [];
  let failures = failFirst;
  const executor = makeWorldExecutor(w, ADDR.quant, { calls, apply: execute, failOn: (s) => (s.functionName === 'redeem' && failures-- > 0 ? new StepFailed('rpc down', {}) : null) });
  const redeemer = createRedeemer({ agent: AGENT, address: ADDR.quant, reads: w.reads, executor, ledger: r.ledger, logger: r.logger, execute, mutex: createMutex() });
  return { ...r, w, calls, redeemer };
}

test('redeem: an older tracked round is redeemed after a newer round has opened', async () => {
  const t = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 12n, status: 1 }) });
  t.w.settled.set(1, 3);
  t.w.wallet(ADDR.quant).deposit.set('1', 2_000_000n);
  t.ledger.trackRound('quant', 1);
  const out = await t.redeemer.sweep(12n); // Round 1 is outside the five-round startup lookback.
  assert.deepEqual(out.map((o) => [o.round, o.status]), [[1, 'redeemed']]);
  assert.deepEqual(t.calls.map((c) => [c.fn, c.args[0]]), [['redeem', 1n]]);
  assert.deepEqual(t.ledger.trackedRounds('quant'), []);
  assert.deepEqual(await t.redeemer.sweep(12n), [], 'nothing left to redeem');
});

test('redeem: an already-settled latest round is found at startup without any tracking', async () => {
  const t = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 3n, status: 3 }) });
  t.w.wallet(ADDR.quant).deposit.set('3', 2_000_000n);
  const out = await t.redeemer.sweep(3n);
  assert.equal(out.length, 1, 'startup discovers the settled round without tracking');
  assert.equal(out[0].round, 3);
  assert.equal(out[0].status, 'redeemed');
  const cancelled = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 3n, status: 4 }) });
  cancelled.w.wallet(ADDR.quant).deposit.set('3', 2_000_000n);
  assert.equal((await cancelled.redeemer.sweep(3n))[0].status, 'redeemed');
});

test('redeem: a running round is left alone, an empty one is dropped, dry-run plans once and marks nothing durable', async () => {
  const running = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 2n, status: 1 }) });
  running.w.wallet(ADDR.quant).deposit.set('2', 2_000_000n);
  running.ledger.trackRound('quant', 2);
  assert.deepEqual(await running.redeemer.sweep(2n), []);
  assert.deepEqual(running.ledger.trackedRounds('quant'), ['2'], 'still tracked while the round runs');

  const empty = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 2n, status: 3 }) });
  empty.ledger.trackRound('quant', 2);
  assert.deepEqual(await empty.redeemer.sweep(2n), []);
  assert.deepEqual(empty.ledger.trackedRounds('quant'), []);

  const dry = redeemRig({ execute: false, world: makeWorld({ pools: [makeLogPool()], id: 3n, status: 3 }) });
  dry.w.wallet(ADDR.quant).deposit.set('3', 2_000_000n);
  const plans = await dry.redeemer.sweep(3n);
  assert.equal(plans.length, 1, 'startup must plan redemption');
  assert.equal(plans[0].status, 'planned');
  assert.deepEqual(await dry.redeemer.sweep(3n), [], 'planned once only');
  assert.equal(dry.w.wallet(ADDR.quant).redeemed.size, 0, 'nothing was redeemed');
  assert.equal(fs.existsSync(dry.ledger.file), false, 'no durable marks: the ledger file was never written');
});

test('redeem: failures are bounded to 3 attempts per round', async () => {
  const t = redeemRig({ world: makeWorld({ pools: [makeLogPool()], id: 3n, status: 3 }), failFirst: 99 });
  t.w.wallet(ADDR.quant).deposit.set('3', 2_000_000n);
  t.ledger.trackRound('quant', 3);
  for (let i = 0; i < 6; i++) await t.redeemer.sweep(3n);
  assert.equal(t.calls.length, 3);
  assert.ok(erc20Abi.length > 0);
});
