import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBook, publicClient, read } from '../demo-round-common.mjs';
import { EventReadError, readEvents } from '../lib/read-events.mjs';
import { reconcile, printReconcile } from '../lib/reconcile.mjs';
import { snapshot } from '../lib/round-actions.mjs';

test('event scans shrink rejected ranges without skipping or duplicating blocks', async () => {
  const ranges = [];
  const client = { getContractEvents: async ({ fromBlock, toBlock }) => {
    ranges.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1n > 3n) throw new Error('provider range limit');
    return Array.from({ length: Number(toBlock - fromBlock + 1n) }, (_, i) => ({ blockNumber: fromBlock + BigInt(i) }));
  } };
  const logs = await readEvents({ client, address: '0x0', abi: [], fromBlock: 0n, toBlock: 10n, initialStep: 8n, minStep: 2n });
  assert.ok(ranges.length > 1, 'fixture must exercise provider rejection and range shrinking');
  assert.deepEqual(logs.map(l => l.blockNumber), Array.from({ length: 11 }, (_, i) => BigInt(i)));
});

test('permanent event RPC failure stops at the minimum range with a named error', async () => {
  let calls = 0;
  const client = { getContractEvents: async () => { calls++; throw new Error('RPC unavailable'); } };
  await assert.rejects(readEvents({ client, address: '0x0', abi: [], fromBlock: 0n, toBlock: 10n, initialStep: 8n, minStep: 2n }),
    e => e instanceof EventReadError && /blocks 0..1: RPC unavailable/.test(e.message));
  assert.equal(calls, 2, 'no unbounded retry or silent incomplete event history');
});

test('round snapshot pins its header, vault state and timestamp to the report block', async () => {
  const seen = [];
  const r = [100n, 200n, 300n, 50n, 990000000000000000n, 1010000000000000000n, 3, 2, 0, false, 1000000000000000000n, 500000000000000000n, 0n, 0n, 0n, 0n];
  const out = await snapshot(undefined, {
    blockNumber: 77n,
    reader: async (_address, _abi, fn, _args, options) => { seen.push(options.blockNumber); return fn === 'currentRoundId' ? 1n : fn === 'rounds' ? r : [0n, 0n, 0n, 0n, 0n, true, true, false]; },
    getBlock: async options => { assert.equal(options.blockNumber, 77n); return { timestamp: 301n }; },
  });
  assert.equal(out.now, 301);
  assert.equal(out.status, 3);
  assert.deepEqual(seen, [77n, 77n, 77n]);
});

test('reconciliation includes pending holders, stays on one block and detects a one-USDC discrepancy', async () => {
  const { c } = loadBook();
  const holders = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
  const seen = [];
  let extra = 0n;
  const reader = async (address, _abi, fn, args, options) => {
    seen.push({ fn, args, block: options.blockNumber });
    const values = { protocolLiquiditySeed: 10000000n, currentRoundId: 1n, totalVaultUsdc: 5000000n, queuedDepositsUsdc: 1000000n, claimableUsdcTotal: 2000000n, totalVaultTEth: 3n * 10n ** 18n };
    if (fn in values) return values[fn];
    if (fn === 'rounds') { const r = Array(16).fill(0n); r[6] = 3; r[9] = false; r[14] = 6000000n; r[15] = 2000000n; return r; }
    if (fn === 'pendingPayout') return args[0] === holders[0] ? 1000000n : 2000000n;
    if (fn === 'balanceOf') return address === c.TestAsset ? 3n * 10n ** 18n : args[0] === c.QuantumRound ? 17000000n + extra : 8000000n;
    assert.fail(`unexpected read ${fn}`);
  };
  const good = await reconcile(holders, { blockNumber: 77n, reader });
  assert.equal(printReconcile(good), true);
  assert.equal(good.quantumRound.expected, 17000000n);
  assert.ok(seen.every(r => r.block === 77n));
  assert.deepEqual(seen.filter(r => r.fn === 'pendingPayout').map(r => r.args[0]), holders);
  extra = 1000000n;
  const bad = await reconcile(holders, { blockNumber: 77n, reader });
  assert.equal(bad.quantumRound.unaccounted, 1000000n);
  assert.equal(printReconcile(bad), false);
});

test('common read forwards an explicit block and preserves latest-block behavior otherwise', async () => {
  const original = publicClient.readContract;
  const seen = [];
  publicClient.readContract = async request => { seen.push(request); return 0n; };
  try {
    await read('0x0', [], 'value', [], { blockNumber: 77n });
    await read('0x0', [], 'value');
    assert.equal(seen[0].blockNumber, 77n);
    assert.equal('blockNumber' in seen[1], false);
  } finally { publicClient.readContract = original; }
});
