import assert from 'node:assert/strict';
import test from 'node:test';
import { MULTICALL3 } from '../lib/config.mjs';
import { QUOTE_FN, createForecastClients, createForecastReads, isTradingClosed } from '../lib/forecast-chain.mjs';
import { StepFailed } from '../lib/executor.mjs';

const BOOK = { c: {
  QuantumRound: '0x00000000000000000000000000000000000000a1', WaveV4ProposalMarket: '0x00000000000000000000000000000000000000a2',
  ProposalTokens: '0x00000000000000000000000000000000000000a3', USDC: '0x3600000000000000000000000000000000000000',
} };
const ME = '0x66617018c7d91e1345eA9F51b44a062aad2D439e';
const ABIS = {
  QuantumRound: [], WaveV4ProposalMarket: [], ProposalTokens: [],
};
const abiFor = (names) => names.map((name) => ({ type: 'function', name, inputs: [], outputs: [], stateMutability: 'view' }));
ABIS.QuantumRound = abiFor(['rounds', 'EPSILON', 'currentRoundId', 'proposals', 'deposits', 'creditsClaimed', 'roundStatus', 'redeemed', 'previewRedeem']);
ABIS.WaveV4ProposalMarket = abiFor(['probabilities', 'probabilityTwap', ...Object.values(QUOTE_FN)]);
ABIS.ProposalTokens = abiFor(['creditToken', 'longToken', 'shortToken']);

function fakeClient({ respond } = {}) {
  const calls = [];
  const client = {
    calls,
    async getBlockNumber() { return 123n; },
    async multicall(params) {
      calls.push(params);
      return params.contracts.map((c) => {
        const r = respond?.(c);
        if (r !== undefined) return r;
        return { status: 'success', result: defaults(c) };
      });
    },
    async readContract({ functionName }) { return functionName === 'currentRoundId' ? 7n : 0n; },
  };
  return client;
}
const defaults = (c) => {
  const p = Number(c.args?.[1] ?? 0);
  switch (c.functionName) {
    case 'getCurrentBlockTimestamp': return 1_800_000_000n;
    case 'currentRoundId': return 7n;
    case 'rounds': return [1_799_999_900n, 1_800_000_400n, 1_800_001_000n, 240n, 990_000_000_000_000_000n, 1_010_000_000_000_000_000n, 1, 3, 0, false];
    case 'EPSILON': return 5n * 10n ** 15n;
    case 'probabilities': return [BigInt(500 + p * 10) * 10n ** 15n, BigInt(500 - p * 10) * 10n ** 15n];
    case 'probabilityTwap': return BigInt(510 + p * 10) * 10n ** 15n;
    case 'proposals': return [ME, 3000 + p * 1000, p === 0, 5_000_000n, 0n, 0n, ''];
    case 'creditToken': return `0x${'c'.repeat(39)}${p}`;
    case 'longToken': return `0x${'1'.repeat(39)}${p}`;
    case 'shortToken': return `0x${'2'.repeat(39)}${p}`;
    case 'balanceOf': return BigInt(c.address.slice(-2).replace(/\D/g, '') || 0) + 7n;
    case 'quoteBuyLong': return 10n ** 18n + 5n;
    case 'quoteSellShort': return [3n, 1n, 2n];
    default: return 0n;
  }
};
const reads = (client) => createForecastReads({ client, fastClient: client, book: BOOK, A: ABIS });
const CTX = { id: 7n, proposalCount: 3 };

test('the prices call is ONE Multicall3 call at the fixed address with batchSize 0', async () => {
  assert.equal(MULTICALL3, '0xcA11bde05977b3631167028862bE2a173976CA11');
  const client = fakeClient();
  const out = await reads(client).guardianBatch(CTX);
  assert.equal(client.calls.length, 1, 'exactly one multicall');
  const [params] = client.calls;
  assert.equal(params.batchSize, 0, 'viem must not split it');
  assert.equal(params.multicallAddress, MULTICALL3);
  assert.equal(params.allowFailure, true);
  const names = params.contracts.map((c) => c.functionName);
  assert.equal(names[0], 'getCurrentBlockTimestamp');
  assert.equal(params.contracts[0].address, MULTICALL3, 'the chain clock comes from Multicall3 itself');
  assert.deepEqual(names.slice(1, 3), ['currentRoundId', 'rounds']);
  assert.equal(names.filter((n) => n === 'probabilities').length, 3);
  assert.equal(names.filter((n) => n === 'probabilityTwap').length, 3, 'the projected-TWAP ranking inputs are in the same batch');
  assert.equal(names.filter((n) => n === 'proposals').length, 3);
  assert.equal(out.now, 1_800_000_000);
  assert.equal(out.currentRoundId, 7n);
  assert.equal(out.round.status, 1);
  assert.equal(out.round.twapWindow, 240);
  assert.deepEqual(out.proposals.map((p) => [p.id, p.pLongX18, p.twapX18, p.tEthBps]), [
    [0, 500n * 10n ** 15n, 510n * 10n ** 15n, 3000], [1, 510n * 10n ** 15n, 520n * 10n ** 15n, 4000], [2, 520n * 10n ** 15n, 530n * 10n ** 15n, 5000],
  ]);
});

test('a failed read inside the batch becomes null for that proposal instead of failing the pass', async () => {
  const client = fakeClient({ respond: (c) => (c.functionName === 'probabilityTwap' && c.args[1] === 1n ? { status: 'failure', error: new Error('MarketNotSeeded') } : undefined) });
  const out = await reads(client).guardianBatch(CTX);
  assert.equal(out.proposals[1].twapX18, null);
  assert.notEqual(out.proposals[0].twapX18, null);
});

test('quote batches: one multicall, spot first, the right quote view per kind and side', async () => {
  const client = fakeClient();
  const batch = reads(client).batchFor(7n, 2);
  const out = await batch({ requests: [{ kind: 'buy', side: 'long', x: 5n }, { kind: 'sell', side: 'short', x: 10n ** 18n }] });
  assert.equal(client.calls.length, 1);
  const names = client.calls[0].contracts.map((c) => c.functionName);
  assert.deepEqual(names, ['probabilities', 'quoteBuyLong', 'quoteSellShort']);
  assert.deepEqual(client.calls[0].contracts[1].args, [7n, 2n, 5n]);
  assert.equal(client.calls[0].batchSize, 0);
  assert.equal(out.pLongX18, 520n * 10n ** 15n);
  assert.equal(out.results[0].ok, true);
  assert.deepEqual(out.results[1].value, { credits: 3n, longDust: 1n, shortDust: 2n });
  assert.deepEqual(Object.values(QUOTE_FN).sort(), ['quoteBuyLong', 'quoteBuyShort', 'quoteSellLong', 'quoteSellShort']);
  const failing = fakeClient({ respond: (c) => (c.functionName === 'quoteBuyLong' ? { status: 'failure', error: new Error('InsufficientDepth') } : undefined) });
  const bad = await reads(failing).batchFor(7n, 0)({ requests: [{ kind: 'buy', side: 'long', x: 1n }] });
  assert.equal(bad.results[0].ok, false);
});

test('round freshness gate: same round, still Trading, chain clock before tradingEnd', async () => {
  const r = reads(fakeClient());
  assert.equal((await r.roundFresh(7n)).ok, true);
  assert.match((await r.roundFresh(6n)).reason, /round changed/);
  const ended = reads(fakeClient({ respond: (c) => (c.functionName === 'getCurrentBlockTimestamp' ? { status: 'success', result: 1_800_000_400n } : undefined) }));
  const e = await ended.roundFresh(7n);
  assert.equal(e.ok, false);
  assert.equal(e.closed, true);
});

test('Quant view: spot, allocation and balances for every proposal in one multicall (plus a one-off token lookup)', async () => {
  const client = fakeClient();
  const r = reads(client);
  const v = await r.quantView(CTX, ME);
  assert.equal(v.proposals.length, 3);
  assert.equal(v.proposals[0].tEthBps, 3000);
  assert.ok(typeof v.proposals[1].position.long === 'bigint');
  const before = client.calls.length;
  await r.quantView(CTX, ME);
  assert.equal(client.calls.length - before, 1, 'token addresses are cached; the second view is one call');
});

test('TradingClosed detection', () => {
  assert.equal(isTradingClosed(Object.assign(new Error('x'), { errorName: 'TradingClosed' })), true);
  assert.equal(isTradingClosed(new Error('execution reverted: TradingNotOpen')), true);
  assert.equal(isTradingClosed({ message: 'TradingClosed(1,2,3)' }), true);
  assert.equal(isTradingClosed(new Error('Slippage(1,0)')), false);
  assert.equal(isTradingClosed(null), false);
  assert.equal(isTradingClosed({ errorName: 'InsufficientDepth' }), false);
  assert.ok(new StepFailed('x', {}));
});

test('forecaster RPC clients are bounded: tight timeouts and no endless retries', () => {
  const c = createForecastClients({ rpcUrl: 'http://127.0.0.1:9' });
  assert.equal(c.fast.transport.timeout, 2500);
  assert.equal(c.fast.transport.retryCount, 0);
  assert.ok(c.standard.transport.timeout <= 6000 && c.standard.transport.retryCount <= 1);
});
