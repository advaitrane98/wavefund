import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AGENT_DEFS } from '../lib/config.mjs';
import { upsertEnv } from '../lib/files.mjs';
import { runSetup } from '../setup.mjs';
import { tmpDir } from './helpers.mjs';

const circleErr = (status, code, message) => Object.assign(new Error(message), { response: { status, data: { code, message } } });

function fakeCircle({ wallets = [], walletSetFails } = {}) {
  const state = { sets: 0, createCalls: 0, wallets: [...wallets], getCalls: 0 };
  return {
    state,
    async createWalletSet() {
      if (walletSetFails) throw walletSetFails;
      state.sets++;
      return { data: { walletSet: { id: 'ws-1' } } };
    },
    async createWallets({ metadata, walletSetId, accountType, blockchains }) {
      state.createCalls++;
      assert.equal(accountType, 'EOA');
      assert.deepEqual(blockchains, ['ARC-TESTNET']);
      assert.equal(walletSetId, 'ws-1');
      const w = { id: `w-${state.wallets.length + 1}`, address: `0x${String(state.wallets.length + 1).padStart(40, '0')}`, blockchain: 'ARC-TESTNET', accountType: 'EOA', refId: metadata[0].refId };
      state.wallets.push(w);
      return { data: { wallets: [w] } };
    },
    async listWallets() { return { data: { wallets: state.wallets } }; },
    async getWallet({ id }) {
      state.getCalls++;
      const w = state.wallets.find((x) => x.id === id);
      if (!w) throw circleErr(404, 156000, 'wallet not found');
      return { data: { wallet: w } };
    },
  };
}

const fresh = () => {
  const dir = tmpDir();
  return { dir, envFile: `${dir}/.env`, agentsFile: `${dir}/agents.json`, env: { CIRCLE_API_KEY: 'TEST_API_KEY:a:b', DEPLOYER_ADDR: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' }, say: () => {} };
};

test('first run creates one wallet set and five EOAs, writes addresses to agents.json and IDs to .env', async () => {
  const ctx = fresh();
  const client = fakeCircle();
  const out = await runSetup({ client, ...ctx });
  assert.equal(client.state.sets, 1);
  assert.equal(client.state.createCalls, 5);
  assert.equal(out.created.length, 5);
  const file = JSON.parse(fs.readFileSync(ctx.agentsFile, 'utf8'));
  assert.equal(file.chainId, 5042002);
  const agents = file.agents;
  assert.deepEqual(agents.map((a) => a.id), AGENT_DEFS.map((d) => d.key.replace(/_/g, '-')));
  for (const a of agents) {
    assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(a.wallet, 'circle-developer-controlled');
    assert.ok(a.name && a.type && a.description);
    assert.equal(a.walletId, undefined, 'wallet IDs stay out of agents.json');
  }
  assert.deepEqual(agents.map((a) => a.type), ['proposer', 'proposer', 'proposer', 'forecaster', 'forecaster']);
  const env = fs.readFileSync(ctx.envFile, 'utf8');
  assert.match(env, /^AGENT_CIRCLE_WALLET_SET_ID=ws-1$/m);
  for (const d of AGENT_DEFS) assert.match(env, new RegExp(`^${d.envId}=w-\\d+$`, 'm'));
  assert.ok(!env.includes('CIRCLE_API_KEY'), 'credentials are never written');
});

test('running setup again never creates duplicates', async () => {
  const ctx = fresh();
  const client = fakeCircle();
  await runSetup({ client, ...ctx });
  const envAfterFirst = fs.readFileSync(ctx.envFile, 'utf8');
  const env2 = { ...ctx.env, ...Object.fromEntries(envAfterFirst.trim().split('\n').map((l) => l.split('='))) };
  const second = await runSetup({ client, ...ctx, env: env2 });
  assert.equal(client.state.sets, 1);
  assert.equal(client.state.createCalls, 5);
  assert.deepEqual(second.created, []);
  assert.equal(second.reused.length, 5);
  assert.equal(fs.readFileSync(ctx.envFile, 'utf8'), envAfterFirst);
});

test('if .env lost the IDs, wallets already in the set are found by refId and re-used', async () => {
  const ctx = fresh();
  const client = fakeCircle();
  await runSetup({ client, ...ctx });
  const fresh2 = fresh();
  fresh2.env.AGENT_CIRCLE_WALLET_SET_ID = 'ws-1';
  const again = await runSetup({ client, ...fresh2 });
  assert.equal(client.state.createCalls, 5, 'no new wallet was created');
  assert.equal(again.reused.length, 5);
});

test('with all IDs in .env setup only reads wallets', async () => {
  const ctx = fresh();
  const client = fakeCircle();
  await runSetup({ client, ...ctx });
  const env = { ...ctx.env, AGENT_CIRCLE_WALLET_SET_ID: 'ws-1', ...Object.fromEntries(AGENT_DEFS.map((d, i) => [d.envId, `w-${i + 1}`])) };
  client.state.createCalls = 0;
  await runSetup({ client, ...fresh(), env });
  assert.equal(client.state.createCalls, 0);
  assert.equal(client.state.getCalls, 5);
});

test('Circle errors include HTTP status and error code but no credentials', async () => {
  const ctx = fresh();
  const client = fakeCircle({ walletSetFails: circleErr(401, 156004, 'Unauthorized for TEST_API_KEY:a:b') });
  await assert.rejects(runSetup({ client, ...ctx }), (err) => {
    assert.match(err.message, /HTTP 401/);
    assert.match(err.message, /code 156004/);
    assert.ok(!err.message.includes('TEST_API_KEY:a:b'));
    return true;
  });
});

test('setup refuses a wallet whose address is the deployer or keeper', async () => {
  const ctx = fresh();
  ctx.env.KEEPER_ADDR = '0x0000000000000000000000000000000000000001';
  await assert.rejects(runSetup({ client: fakeCircle(), ...ctx }), /deployer or keeper/);
});

test('upsertEnv adds, replaces an empty value and leaves equal values alone', () => {
  const dir = tmpDir();
  const f = `${dir}/.env`;
  fs.writeFileSync(f, 'A=1\nB=\n');
  assert.equal(upsertEnv(f, 'C', '3'), 'added');
  assert.equal(upsertEnv(f, 'B', '2'), 'updated');
  assert.equal(upsertEnv(f, 'B', '2'), 'unchanged');
  assert.equal(fs.readFileSync(f, 'utf8'), 'A=1\nB=2\nC=3\n');
});

test('setup keeps names and descriptions already published in agents.json and only sets the address', async () => {
  const ctx = fresh();
  fs.writeFileSync(ctx.agentsFile, JSON.stringify({ chainId: 5042002, agents: [{ id: 'mean-reversion', name: 'Mean Reversion', type: 'proposer', description: 'Published text.', address: null, wallet: 'circle-developer-controlled' }] }));
  await runSetup({ client: fakeCircle(), ...ctx });
  const mr = JSON.parse(fs.readFileSync(ctx.agentsFile, 'utf8')).agents.find((a) => a.id === 'mean-reversion');
  assert.equal(mr.name, 'Mean Reversion');
  assert.equal(mr.description, 'Published text.');
  assert.match(mr.address, /^0x/);
});
