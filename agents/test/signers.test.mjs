import assert from 'node:assert/strict';
import test from 'node:test';
import { erc20Abi } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { abiFunction, functionSignature, toCircleParams, toWei } from '../lib/signers/abi.mjs';
import { CircleError, FEE_ATTEMPTS, circleErrorText, createCircleSigner, uuidFrom } from '../lib/signers/circle.mjs';
import { assertNotOperator, createSigner, signerBackend } from '../lib/signers/index.mjs';
import { createLocalSigner, localKeysEnabled } from '../lib/signers/local.mjs';
import { noSleep } from './helpers.mjs';

const ADDR = '0x1111111111111111111111111111111111111111';
const step = { to: ADDR, abi: erc20Abi, functionName: 'approve', args: [ADDR, 5n] };
const circleErr = (status, code, message = 'nope') => Object.assign(new Error(message), { response: { status, data: { code, message } } });

function fakeClient({ feeFailures = 0, states = ['SENT', 'COMPLETE'], createError } = {}) {
  const calls = { fee: 0, create: [], get: 0 };
  return {
    calls,
    async estimateContractExecutionFee() {
      calls.fee++;
      if (calls.fee <= feeFailures) throw circleErr(500, 9999, 'upstream');
      return { data: { medium: { gasLimit: '60000', networkFee: '0.0021' } } };
    },
    async createContractExecutionTransaction(input) {
      calls.create.push(input);
      if (createError) throw createError;
      return { data: { id: 'tx-1' } };
    },
    async getTransaction() {
      const state = states[Math.min(calls.get++, states.length - 1)];
      return { data: { transaction: { state, txHash: state === 'COMPLETE' ? `0x${'ab'.repeat(32)}` : undefined, errorReason: state === 'FAILED' ? 'EXECUTION_REVERTED' : undefined } } };
    },
  };
}
const signerWith = (client, extra = {}) => createCircleSigner({ client, walletId: 'w-1', address: ADDR, sleep: noSleep, ...extra });

test('abi helpers: signatures, tuple parameters and wei parsing', () => {
  assert.equal(functionSignature(abiFunction(erc20Abi, 'approve')), 'approve(address,uint256)');
  const propose = [{ type: 'function', name: 'propose', inputs: [{ name: 'r', type: 'uint256' }, { name: 'a', type: 'tuple', components: [{ name: 'bps', type: 'uint16' }] }, { name: 's', type: 'string' }], outputs: [], stateMutability: 'nonpayable' }];
  assert.equal(functionSignature(abiFunction(propose, 'propose')), 'propose(uint256,(uint16),string)');
  assert.deepEqual(toCircleParams([1n, { tEthBps: 2500 }, 'why']), ['1', [2500], 'why']);
  assert.equal(toWei('0.0021'), 2_100_000_000_000_000n);
  assert.equal(toWei('abc'), null);
});

test('circle signer: fee estimate is retried 4 times, succeeds on the last attempt', async () => {
  const client = fakeClient({ feeFailures: 3 });
  const fee = await signerWith(client).estimateFee(step);
  assert.equal(FEE_ATTEMPTS, 4);
  assert.equal(client.calls.fee, 4);
  assert.equal(fee.attempts, 4);
  assert.equal(fee.networkFeeWei, 2_100_000_000_000_000n);
});

test('circle signer: after 4 failed fee estimates the error carries HTTP status and code, never credentials', async () => {
  const client = fakeClient({ feeFailures: 99 });
  await assert.rejects(signerWith(client).estimateFee(step), (err) => {
    assert.ok(err instanceof CircleError);
    assert.match(err.message, /after 4 attempts/);
    assert.match(err.message, /HTTP 500/);
    assert.match(err.message, /code 9999/);
    assert.equal(err.status, 500);
    return true;
  });
  assert.equal(client.calls.fee, 4);
});

test('circleErrorText never leaks keys or bearer tokens', () => {
  const t = circleErrorText(circleErr(401, 156004, 'bad TEST_API_KEY:abc:def with Bearer sk.live.secret'));
  assert.match(t, /HTTP 401 code 156004/);
  assert.ok(!t.includes('TEST_API_KEY:abc:def') && !t.includes('sk.live.secret'));
});

test('circle signer: submits the call, polls to COMPLETE and returns the hash', async () => {
  const client = fakeClient({ states: ['INITIATED', 'SENT', 'COMPLETE'] });
  const res = await signerWith(client).execute({ ...step, label: 'x' });
  assert.equal(res.hash, `0x${'ab'.repeat(32)}`);
  assert.equal(client.calls.get, 3);
  const sent = client.calls.create[0];
  assert.equal(sent.walletId, 'w-1');
  assert.equal(sent.abiFunctionSignature, 'approve(address,uint256)');
  assert.deepEqual(sent.abiParameters, [ADDR, '5']);
  assert.match(sent.idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('circle signer: FAILED, DENIED and CANCELLED are terminal errors; a 4xx submit is not retried', async () => {
  await assert.rejects(signerWith(fakeClient({ states: ['SENT', 'FAILED'] })).execute(step), /FAILED: EXECUTION_REVERTED/);
  await assert.rejects(signerWith(fakeClient({ states: ['DENIED'] })).execute(step), /DENIED/);
  const client = fakeClient({ createError: circleErr(400, 155001, 'bad param') });
  await assert.rejects(signerWith(client).execute(step), /HTTP 400 code 155001/);
  assert.equal(client.calls.create.length, 1);
});

test('circle signer: a transaction that never becomes terminal is reported as possibly broadcast', async () => {
  let t = 0;
  const signer = signerWith(fakeClient({ states: ['SENT'] }), { timeoutMs: 1000, now: () => (t += 400) });
  await assert.rejects(signer.execute(step), (err) => err.maybeBroadcast === true && /not terminal/.test(err.message));
});

test('uuidFrom is deterministic and v4-shaped', () => {
  assert.equal(uuidFrom('a'), uuidFrom('a'));
  assert.notEqual(uuidFrom('a'), uuidFrom('b'));
  assert.match(uuidFrom('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('local keys are off unless explicitly enabled', () => {
  assert.equal(localKeysEnabled({}), false);
  assert.equal(localKeysEnabled({ AGENTS_SIGNER: 'local' }), false);
  assert.equal(localKeysEnabled({ AGENTS_SIGNER: 'local', AGENTS_ALLOW_LOCAL_KEYS: 'yes' }), true);
  assert.equal(signerBackend({}), 'circle');
  assert.equal(signerBackend({ AGENTS_SIGNER: 'local', AGENTS_ALLOW_LOCAL_KEYS: 'yes' }), 'local');
  assert.throws(() => createLocalSigner({ agent: { key: 'quant' }, env: { AGENT_QUANT_PK: `0x${'11'.repeat(32)}` } }), /Local-key signing is off/);
});

test('local signer refuses the deployer and keeper keys and needs its own key', () => {
  const deployer = `0x${'22'.repeat(32)}`;
  const env = { AGENTS_SIGNER: 'local', AGENTS_ALLOW_LOCAL_KEYS: 'yes', AGENT_QUANT_PK: deployer };
  assert.throws(() => createLocalSigner({ agent: { key: 'quant' }, env, forbidden: [privateKeyToAddress(deployer)] }), /never use those/);
  assert.throws(() => createLocalSigner({ agent: { key: 'quant' }, env: { ...env, AGENT_QUANT_PK: '' } }), /AGENT_QUANT_PK is not set/);
  const own = `0x${'33'.repeat(32)}`;
  const s = createLocalSigner({ agent: { key: 'quant' }, env: { ...env, AGENT_QUANT_PK: own }, forbidden: [privateKeyToAddress(deployer)] });
  assert.equal(s.kind, 'local');
  assert.equal(s.address, privateKeyToAddress(own));
});

test('agents never use the deployer or keeper: their addresses are rejected for Circle wallets too', () => {
  const dep = privateKeyToAddress(`0x${'44'.repeat(32)}`);
  const env = { DEPLOYER_PK: `0x${'44'.repeat(32)}`, KEEPER_ADDR: '0x9999999999999999999999999999999999999999', AGENT_QUANT_CIRCLE_WALLET_ID: 'w' };
  assert.throws(() => assertNotOperator(dep, env), /deployer or keeper/);
  assert.throws(() => assertNotOperator('0x9999999999999999999999999999999999999999', env), /deployer or keeper/);
  assertNotOperator(ADDR, env);
  const def = { key: 'quant', envId: 'AGENT_QUANT_CIRCLE_WALLET_ID' };
  assert.throws(() => createSigner({ agentDef: def, agentRecord: { address: dep }, env, client: {} }), /deployer or keeper/);
  assert.throws(() => createSigner({ agentDef: def, agentRecord: { address: null }, env, client: {} }), /agents:setup/);
  assert.throws(() => createSigner({ agentDef: def, agentRecord: { address: ADDR }, env: { ...env, AGENT_QUANT_CIRCLE_WALLET_ID: '' }, client: {} }), /AGENT_QUANT_CIRCLE_WALLET_ID is not set/);
  assert.equal(createSigner({ agentDef: def, agentRecord: { address: ADDR }, env, client: {} }).kind, 'circle');
});
