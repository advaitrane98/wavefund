import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { erc20Abi, parseUnits } from 'viem';
import { gasCaps } from '../lib/config.mjs';
import { StepFailed, createExecutor } from '../lib/executor.mjs';
import { CapError, SpendLedger } from '../lib/ledger.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { createLogger } from '../lib/logger.mjs';
import { createMarketData, features } from '../lib/market-data.mjs';
import { buildPlan, purposeOf } from '../fund.mjs';
import { AGENT_DEFS } from '../lib/config.mjs';
import { proposers, forecasters, fairPLong } from '../strategies/index.mjs';
import { clock, noSleep, readJsonl, tmpDir } from './helpers.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const step = { label: 'approve', to: ADDR, abi: erc20Abi, functionName: 'approve', args: [ADDR, 1n] };
const agent = { key: 'quant' };
const GWEI = 10n ** 9n;
const fees = async () => ({ maxFeePerGas: 41n * GWEI, maxPriorityFeePerGas: GWEI });

function rig({ execute = false, estimate, signer, preset = 'full', receipt } = {}) {
  const dir = tmpDir();
  const c = clock();
  const ledger = new SpendLedger({ file: `${dir}/l.json`, caps: gasCaps(preset), now: c.now });
  const logger = createLogger({ dir: `${dir}/logs`, now: c.now, echo: false, env: {} });
  const estimator = { estimateContractGas: estimate ?? (async () => 100_000n) };
  const s = signer ?? { kind: 'fake', address: ADDR, estimateFee: async () => ({ attempts: 1, networkFeeWei: null }), execute: async () => ({ hash: `0x${'cd'.repeat(32)}` }) };
  const getReceipt = receipt ?? (async () => ({ status: 'success', gasUsed: 90_000n, effectiveGasPrice: 20n * GWEI }));
  const executor = createExecutor({ agent, signer: s, ledger, logger, execute, estimator, gasFees: fees, getReceipt });
  return { dir, ledger, logger, executor, c };
}

test('dry-run sends nothing, reserves nothing, and logs the plan', async () => {
  let sent = 0;
  const signer = { address: ADDR, estimateFee: async () => ({ attempts: 1 }), execute: async () => { sent++; } };
  const { executor, ledger, logger } = rig({ signer });
  const r = await executor.run(step, { roundId: 1 });
  assert.equal(r.dryRun, true);
  assert.equal(sent, 0);
  assert.equal(ledger.usage('quant', 1).round, 0n);
  const [line] = readJsonl(logger.file());
  assert.match(line.status, /dry-run, nothing sent/);
});

test('dry-run applies the caps cumulatively across the steps of one plan', async () => {
  const { executor } = rig({ estimate: async () => 2_500_000n }); // 2.5M gas * 41 gwei * 1.2 = ~0.123 USDC per step
  await executor.run(step, { roundId: 1 });
  await executor.run(step, { roundId: 1 });
  await assert.rejects(executor.run(step, { roundId: 1 }), CapError);
});

test('execute: reserves the estimate, then replaces it with actual gas on confirmation', async () => {
  const { executor, ledger, logger } = rig({ execute: true });
  const r = await executor.run(step, { roundId: 1 });
  assert.equal(r.wei, 90_000n * 20n * GWEI);
  assert.equal(ledger.usage('quant', 1).round, 90_000n * 20n * GWEI);
  const entry = Object.values(ledger.state.entries)[0];
  assert.equal(entry.state, 'confirmed');
  assert.ok(BigInt(entry.estimateWei) > BigInt(entry.amountWei), 'estimate was larger than the actual');
  assert.deepEqual(readJsonl(logger.file()).map((l) => l.status), ['reserved', 'broadcast', 'confirmed']);
});

test('execute: the reservation is held while pending and released if the transaction never broadcasts', async () => {
  let seenPending;
  const signer = {
    address: ADDR, estimateFee: async () => ({ attempts: 1 }),
    execute: async () => { seenPending = true; throw new Error('Circle rejected the request'); },
  };
  const { executor, ledger } = rig({ execute: true, signer });
  await assert.rejects(executor.run(step, { roundId: 1 }), StepFailed);
  assert.ok(seenPending);
  const entry = Object.values(ledger.state.entries)[0];
  assert.equal(entry.state, 'released');
  assert.equal(ledger.usage('quant', 1).round, 0n);
});

test('execute: while pending the estimate counts against the cap', async () => {
  let duringCap;
  const { ledger } = rig({ execute: true });
  const signer = { address: ADDR, estimateFee: async () => ({ attempts: 1 }), execute: async () => { duringCap = ledger.usage('quant', 1).round; return { hash: `0x${'ef'.repeat(32)}` }; } };
  const dir = tmpDir();
  const executor = createExecutor({
    agent, signer, ledger, logger: createLogger({ dir, echo: false, env: {} }), execute: true,
    estimator: { estimateContractGas: async () => 100_000n }, gasFees: fees, getReceipt: async () => ({ status: 'success', gasUsed: 1n, effectiveGasPrice: 1n }),
  });
  await executor.run(step, { roundId: 1 });
  assert.ok(duringCap > 0n);
});

test('execute: a call that would revert is never sent; a transaction that may have been sent stays reserved', async () => {
  const bad = rig({ execute: true, estimate: async () => { throw new Error('execution reverted'); } });
  await assert.rejects(bad.executor.run(step, { roundId: 1 }), /would revert/);
  assert.equal(Object.keys(bad.ledger.state.entries).length, 0);

  const unknown = { address: ADDR, estimateFee: async () => ({ attempts: 1 }), execute: async () => { throw Object.assign(new Error('not terminal'), { maybeBroadcast: true }); } };
  const r = rig({ execute: true, signer: unknown });
  await assert.rejects(r.executor.run(step, { roundId: 1 }), StepFailed);
  assert.equal(Object.values(r.ledger.state.entries)[0].state, 'pending');
});

test('execute: the daily gas cap stops a step before anything is reserved or sent', async () => {
  let sent = 0;
  const signer = { address: ADDR, estimateFee: async () => ({ attempts: 1 }), execute: async () => { sent++; return { hash: '0x1' }; } };
  const { executor } = rig({ execute: true, signer, estimate: async () => 9_000_000n }); // ~0.44 USDC estimate > 0.25 round cap
  await assert.rejects(executor.run(step, { roundId: 1 }), CapError);
  assert.equal(sent, 0);
});

test('single-instance lock: a second process is refused, a dead pid is taken over, release frees it', () => {
  const file = `${tmpDir()}/agents.lock`;
  const a = acquireLock(file, { pid: 111, isAlive: () => true });
  assert.throws(() => acquireLock(file, { pid: 222, isAlive: () => true }), /Another agents process is running \(pid 111\)/);
  a.release();
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, '333');
  const b = acquireLock(file, { pid: 444, isAlive: () => false });
  assert.equal(fs.readFileSync(file, 'utf8'), '444');
  b.release();
});

// ---- market data
const candleRows = (n = 40) => Array.from({ length: n }, (_, i) => [1_700_000_000 + (n - i) * 60, 1999, 2001, 2000, 2000 + (n - i) * 0.1, 10]);
const okResponse = (rows = candleRows()) => ({ ok: true, json: async () => rows });

test('market data: 3 attempts spread over about 20 s, then succeeds', async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => (++n < 3 ? { ok: false, status: 503 } : okResponse());
  const md = createMarketData({ fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  const out = await md.candles();
  assert.equal(n, 3);
  assert.equal(out.attempts, 3);
  assert.equal(waits.reduce((a, b) => a + b, 0), 20_000);
  assert.equal(out.candles.length, 40);
});

test('market data: gives up after 3 attempts with a clear error', async () => {
  let n = 0;
  const md = createMarketData({ fetchImpl: async () => { n++; return { ok: false, status: 429 }; }, sleep: noSleep });
  await assert.rejects(md.candles(), /after 3 attempts.*HTTP 429/);
  assert.equal(n, 3);
});

test('market data: short cache avoids refetching, expires after the TTL, fresh bypasses it', async () => {
  const c = clock();
  let n = 0;
  const md = createMarketData({ fetchImpl: async () => { n++; return okResponse(); }, sleep: noSleep, now: c.now, ttlMs: 20_000 });
  await md.candles();
  const second = await md.candles();
  assert.equal(n, 1);
  assert.equal(second.cached, true);
  c.advance(21);
  await md.candles();
  assert.equal(n, 2);
  await md.candles({ fresh: true });
  assert.equal(n, 3);
});

test('features are computed from oldest-first closes', async () => {
  const md = createMarketData({ fetchImpl: async () => okResponse(), sleep: noSleep });
  const { closes } = await md.candles();
  const f = features(closes);
  assert.ok(f.ret15 > 0 && f.last === closes.at(-1) && f.candles === 40);
  assert.throws(() => features(closes.slice(0, 5)), /at least 20 candles/);
});

// ---- funding plan
test('funding plan: proposers 1 USDC bond + gas, forecasters 2 USDC deposit + gas, tops up only the shortfall', () => {
  const agents = AGENT_DEFS.map((def) => ({ def, record: { address: ADDR } }));
  const plan = buildPlan({ agents, balances: { quant: 1_000_000n, guardian: 9_000_000n }, gasTopUp: 500_000n });
  const by = Object.fromEntries(plan.map((p) => [p.key, p]));
  assert.equal(by.momentum.send, 1_500_000n);
  assert.equal(by.news.send, 1_500_000n);
  assert.equal(by.quant.target, 2_500_000n);
  assert.equal(by.quant.send, 1_500_000n);
  assert.equal(by.guardian.send, 0n);
  assert.equal(purposeOf(AGENT_DEFS[0]), 1_000_000n);
  assert.equal(purposeOf(AGENT_DEFS[3]), 2_000_000n);
});

// ---- strategies
const f0 = { last: 2000, ret5: 0, ret15: 0, ret30: 0, sigma: 0.0005, z: 0, shock: 0 };
test('proposers explain themselves and skip when there is no signal', () => {
  assert.equal(proposers.momentum({ features: f0, statusQuoBps: 5000 }).action, 'skip');
  const up = proposers.momentum({ features: { ...f0, ret15: 0.002 }, statusQuoBps: 5000 });
  assert.equal(up.action, 'propose');
  assert.equal(up.tEthBps, 7000);
  assert.match(up.reasoning, /trend up/);
  assert.equal(proposers.mean_reversion({ features: { ...f0, z: 2 }, statusQuoBps: 5000 }).tEthBps, 3000);
  assert.equal(proposers.news({ features: f0, statusQuoBps: 5000 }).action, 'skip');
  assert.equal(proposers.momentum({ features: { ...f0, ret15: 0.002 }, statusQuoBps: 9900 }).action, 'skip', 'no point proposing a near-identical allocation');
});

test('forecasters trade only on a real edge, and sizes respect the per-trade cap', () => {
  const round = { rMin: 990_000_000_000_000_000n, rMax: 1_010_000_000_000_000_000n, tradingEnd: 1000, evaluationEnd: 1600 };
  const none = forecasters.decide({ agent: { key: 'quant' }, features: f0, round, proposals: [{ id: 1, tEthBps: 7000, pLong: 0.5 }], statusQuoBps: 5000 });
  assert.equal(none.action, 'skip');
  const buyLong = forecasters.decide({ agent: { key: 'quant' }, features: { ...f0, ret30: 0.01 }, round, proposals: [{ id: 1, tEthBps: 9000, pLong: 0.3 }], statusQuoBps: 5000 });
  assert.equal(buyLong.action, 'trade');
  assert.equal(buyLong.long, true);
  assert.ok(buyLong.credits <= 500_000n && buyLong.credits > 0n);
  assert.equal(forecasters.decide({ agent: { key: 'quant' }, features: f0, round, proposals: [{ id: 1, tEthBps: 7000, pLong: null }], statusQuoBps: 5000 }).action, 'skip');
  assert.ok(Math.abs(fairPLong({ w: 0.5, mu: 0, rMin: 0.99, rMax: 1.01 }) - 0.5) < 1e-9);
  assert.ok(parseUnits('1', 6) > 0n);
});
