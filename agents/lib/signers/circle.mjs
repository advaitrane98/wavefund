// Circle developer-controlled EOA wallets on ARC-TESTNET. Contract executions are submitted through Circle's Wallets
// API and polled until they reach a terminal state. Fee estimates are retried 4 times. Credentials are only read
// from the environment by the SDK client and never appear in errors or logs.
import { createHash, randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { abiFunction, functionSignature, toCircleParams, toWei } from './abi.mjs';

export const FEE_ATTEMPTS = 4;
export const TERMINAL = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Circle's HTTP status and error code, never credentials. */
export function circleErrorText(err) {
  const status = err?.response?.status ?? err?.status;
  const data = err?.response?.data ?? {};
  const code = data.code ?? err?.code;
  const message = data.message ?? err?.message ?? String(err);
  const safe = String(message).replace(/(?:TEST|LIVE)_API_KEY:[A-Za-z0-9:_-]+/g, '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return `Circle API error${status ? ` HTTP ${status}` : ''}${code != null ? ` code ${code}` : ''}: ${safe}`;
}

export class CircleError extends Error {
  constructor(err, context) {
    super(`${context}: ${circleErrorText(err)}`);
    this.name = 'CircleError';
    this.status = err?.response?.status ?? err?.status;
    this.code = err?.response?.data?.code ?? err?.code;
  }
}

/** Deterministic UUID (v4 layout) so a repeated request carries the same idempotency key. */
export function uuidFrom(text) {
  const h = createHash('sha256').update(text).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createCircleClient(env = process.env) {
  const apiKey = env.CIRCLE_API_KEY;
  const entitySecret = env.CIRCLE_ENTITY_SECRET;
  if (!apiKey) throw new Error('CIRCLE_API_KEY is not set in .env');
  if (!entitySecret) throw new Error('CIRCLE_ENTITY_SECRET is not set in .env');
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export function createCircleSigner({
  client, walletId, address, sleep = realSleep, pollMs = 2500, timeoutMs = 180_000, feeRetryMs = 1500, now = () => Date.now(),
}) {
  async function estimateFee({ to, abi, functionName, args }) {
    const item = abiFunction(abi, functionName, args);
    let last;
    for (let attempt = 1; attempt <= FEE_ATTEMPTS; attempt++) {
      try {
        const res = await client.estimateContractExecutionFee({
          source: { walletId },
          contractAddress: to,
          abiFunctionSignature: functionSignature(item),
          abiParameters: toCircleParams(args),
        });
        const tier = res?.data?.medium ?? res?.data?.high ?? res?.data?.low;
        return { attempts: attempt, gasLimit: tier?.gasLimit ? BigInt(tier.gasLimit) : null, networkFeeWei: toWei(tier?.networkFee) };
      } catch (err) {
        last = err;
        if (attempt < FEE_ATTEMPTS) await sleep(feeRetryMs * attempt);
      }
    }
    throw new CircleError(last, `fee estimate failed after ${FEE_ATTEMPTS} attempts`);
  }

  async function execute({ to, abi, functionName, args, label }) {
    const item = abiFunction(abi, functionName, args);
    const idempotencyKey = randomUUID();
    let created;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        created = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: to,
          abiFunctionSignature: functionSignature(item),
          abiParameters: toCircleParams(args),
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          idempotencyKey, // the same key on a retry returns the same transaction instead of a second one
          refId: label?.slice(0, 64),
        });
        break;
      } catch (err) {
        const status = err?.response?.status;
        if (status && status >= 400 && status < 500) throw new CircleError(err, `submit ${functionName} rejected`);
        if (attempt === 3) throw new CircleError(err, `submit ${functionName} failed`);
        await sleep(1500 * attempt);
      }
    }
    const id = created?.data?.id;
    if (!id) throw new Error(`Circle returned no transaction id for ${functionName}`);
    const startedAt = now();
    let lastState = 'INITIATED';
    while (now() - startedAt < timeoutMs) {
      await sleep(pollMs);
      let tx;
      try {
        tx = (await client.getTransaction({ id }))?.data?.transaction;
      } catch {
        continue; // transient polling failure: keep polling, never resubmit
      }
      if (!tx) continue;
      lastState = tx.state;
      if (TERMINAL.has(tx.state)) {
        if (tx.state !== 'COMPLETE') {
          const e = new Error(`Circle transaction ${id} ${tx.state}${tx.errorReason ? `: ${tx.errorReason}` : ''}`);
          e.txId = id;
          e.txHash = tx.txHash;
          e.terminal = tx.state;
          throw e;
        }
        return { id, hash: tx.txHash };
      }
    }
    const e = new Error(`Circle transaction ${id} not terminal after ${Math.round(timeoutMs / 1000)}s (last state ${lastState})`);
    e.txId = id;
    e.maybeBroadcast = true;
    throw e;
  }

  return { kind: 'circle', address, walletId, estimateFee, execute };
}
