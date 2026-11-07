import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runKeeper } from '../keeper-run.mjs';
import { runManipulate } from '../demo-manipulate.mjs';

test('keeper runs two complete fake cycles and stops before opening a third', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavefund-keeper-'));
  const events = [];
  let opened = 0;
  let phase = 'idle';
  let watcherStopped = false;
  let waits = 0;
  const code = await runKeeper(['--preset', 'judge', '--open-every', '1', '--max-rounds', '2'], {
    runDir,
    watch: () => async () => { watcherStopped = true; },
    pause: async () => { assert.ok(++waits <= 12, 'keeper must stop after the two completed cycles'); }, writeLog: () => {},
    reserve: async () => ({ ok: true }),
    readSnapshot: async () => null,
    openRound: async ({ timing }) => {
      assert.equal(timing.tradingSeconds, 480);
      assert.equal(timing.twapSeconds, 240);
      assert.equal(timing.evaluationSeconds, 120);
      assert.ok(opened < 2, 'must never open a third round');
      events.push(`open${++opened}`); phase = 'collapse';
    },
    next: async () => {
      if (phase === 'idle') return { action: 'idle', round: BigInt(opened), status: 'Settled' };
      const action = phase;
      events.push(`${action}${opened}`);
      phase = action === 'collapse' ? 'execute-trade' : action === 'execute-trade' ? 'report-and-settle' : 'idle';
      return { action, round: BigInt(opened) };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(events, ['open1', 'collapse1', 'execute-trade1', 'report-and-settle1', 'open2', 'collapse2', 'execute-trade2', 'report-and-settle2']);
  assert.equal(watcherStopped, true);
  assert.equal(fs.existsSync(path.join(runDir, 'keeper.lock')), false);
});

test('keeper refuses invalid cycle limits and a second active instance', async () => {
  for (const count of ['0', '-1', '1.5', 'Infinity', 'bad']) {
    await assert.rejects(runKeeper(['--open-every', '1', `--max-rounds=${count}`]), /max-rounds must be a positive integer/);
  }
  await assert.rejects(runKeeper(['--max-rounds', '2']), /requires --open-every/);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavefund-lock-'));
  fs.writeFileSync(path.join(runDir, 'keeper.lock'), String(process.pid));
  let watched = false;
  await assert.rejects(runKeeper([], { runDir, watch: () => { watched = true; } }), /another keeper is running/);
  assert.equal(watched, false);
  assert.equal(fs.readFileSync(path.join(runDir, 'keeper.lock'), 'utf8'), String(process.pid));
});

const address = '0x1111111111111111111111111111111111111111';
function strikeRig({ confirmError, quote = 3_000_000_000_000_000_000n } = {}) {
  const calls = [];
  let confirmation;
  const deps = {
    getBook: () => ({ c: { QuantumRound: address, USDC: address, ProposalTokens: address, WaveV4ProposalMarket: address } }),
    getAbis: () => ({ QuantumRound: [], ProposalTokens: [], WaveV4ProposalMarket: [] }),
    getDeployer: () => ({ address }),
    getWallets: () => { assert.fail('deployer mode must not access test-wallet keys'); },
    getSnapshot: async () => ({ id: 1n, status: 1, proposalCount: 2, tradingEnd: 100 }),
    getNow: async () => 55,
    pause: async () => { assert.fail('strike should already be due in this fixture'); },
    getBlock: async () => ({ timestamp: 55n }),
    confirmFn: async (message, options) => { confirmation = { message, options }; if (confirmError) throw confirmError; },
    readCall: async (_to, _abi, fn) => fn === 'creditToken' ? address : fn.startsWith('quoteBuy') ? quote : 0n,
    send: async args => { calls.push(args); return { ms: 100, receipt: { blockNumber: 5n } }; },
  };
  return { deps, calls, confirmation: () => confirmation };
}

test('deployer strike waits for confirmation and uses the adapter quote minus 0.5%', async () => {
  const t = strikeRig();
  await runManipulate(['--deployer', '--proposal', '1', '--credits', '1', '--at-seconds-before-end', '45'], t.deps);
  assert.equal(t.confirmation().options.word, 'strike');
  assert.deepEqual(t.calls.map(c => c.functionName), ['approve', 'deposit', 'claimCredits', 'buyLong']);
  assert.ok(t.calls.every(c => c.account.address === address));
  const buy = t.calls.at(-1);
  assert.equal(buy.args[2], 1_000_000n);
  assert.equal(buy.args[3], 2_985_000_000_000_000_000n);
  assert.notEqual(buy.args[3], 0n);
});

test('declining strike confirmation sends nothing; ambiguous signer flags are rejected', async () => {
  const t = strikeRig({ confirmError: new Error('Cancelled by operator.') });
  await assert.rejects(runManipulate(['--deployer', '--proposal', '1'], t.deps), /Cancelled by operator/);
  assert.equal(t.calls.length, 0);
  await assert.rejects(runManipulate(['--deployer', '--wallet', '0', '--proposal', '1'], t.deps), /Use --deployer or --wallet/);
});

test('a missing or zero adapter quote prevents the final strike transaction', async () => {
  const t = strikeRig({ quote: 0n });
  await assert.rejects(runManipulate(['--deployer', '--proposal', '1', '--at-seconds-before-end', '45'], t.deps), /positive adapter quote/);
  assert.equal(t.calls.filter(c => c.functionName === 'buyLong').length, 0);
});
