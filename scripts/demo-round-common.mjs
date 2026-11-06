// Shared helper for every operator script: chain + clients, address book, ABIs, resilient sends with decoded
// custom errors, typed confirmations, explorer links. Node ESM + viem. Reads keys from the environment (.env).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseGwei,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.io';
export const EXPLORER = (process.env.EXPLORER_URL || 'https://explorer.testnet.arc.io').replace(/\/$/, '');
export const DEPLOYMENTS_DIR = path.join(ROOT, 'contracts', 'deployments');
export const BOOK_FILE = process.env.DEPLOYMENTS_FILE || path.join(DEPLOYMENTS_DIR, 'current.json');
export const POSITION_FILE = process.env.POSITION_FILE || path.join(DEPLOYMENTS_DIR, 'pool-position.json');
export const RUN_DIR = path.join(ROOT, '.run');

export const ATTEMPTS = 5;
export const RETRY_PAUSE_MS = 6000;
export const PRIORITY_FEE = parseGwei('1');

export const arc = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Arcscan', url: EXPLORER } },
});

export const publicClient = createPublicClient({ chain: arc, transport: http(RPC_URL) });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const usdc = (x) => formatUnits(BigInt(x), 6);
export const tokens18 = (x) => formatUnits(BigInt(x), 18);
export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${EXPLORER}/address/${addr}`;

// ---------------------------------------------------------------- address book and ABIs

export function loadBook() {
  if (!fs.existsSync(BOOK_FILE)) {
    throw new Error(`No address book at ${BOOK_FILE}. Deploy first (forge scripts) or set DEPLOYMENTS_FILE.`);
  }
  const book = JSON.parse(fs.readFileSync(BOOK_FILE, 'utf8'));
  return { ...book, c: book.contracts };
}

let abiCache;
export function abis() {
  if (!abiCache) {
    const file = path.join(DEPLOYMENTS_DIR, 'abis.json');
    if (!fs.existsSync(file)) throw new Error('contracts/deployments/abis.json missing. Run: npm run abi:export');
    abiCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return abiCache;
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
]);

// ---------------------------------------------------------------- accounts

export function accountFrom(envName) {
  const pk = process.env[envName];
  if (!pk) throw new Error(`${envName} is not set. Add it to .env (never paste keys in chat).`);
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

export function walletFor(account) {
  return createWalletClient({ account, chain: arc, transport: http(RPC_URL) });
}

export function testWallets() {
  const raw = process.env.TEST_WALLET_PKS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pk) => privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`));
}

// ---------------------------------------------------------------- args

export function cliArgs(options, argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { yes: { type: 'boolean', short: 'y', default: false }, ...options },
    allowPositionals: true,
    strict: true,
  });
  return { ...values, _: positionals };
}

// ---------------------------------------------------------------- confirmation

/** Asks the operator to type `word`. `--yes` skips the prompt. */
export async function confirm(message, { yes = false, word = 'yes' } = {}) {
  console.log(`\n${message}`);
  if (yes) {
    console.log('(--yes given, continuing)');
    return true;
  }
  if (!process.stdin.isTTY) throw new Error('Not a terminal. Re-run with --yes to confirm non-interactively.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type "${word}" to continue: `)).trim();
  rl.close();
  if (answer !== word) throw new Error('Cancelled by operator.');
  return true;
}

// ---------------------------------------------------------------- errors

function allErrorAbi() {
  const merged = [];
  const seen = new Set();
  for (const abi of Object.values(abis())) {
    for (const item of abi) {
      if (item.type !== 'error') continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }
  return merged;
}

function revertData(err) {
  let e = err;
  const seen = new Set();
  while (e && !seen.has(e)) {
    seen.add(e);
    for (const k of ['raw', 'data']) {
      if (typeof e[k] === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(e[k])) return e[k];
      if (e[k] && typeof e[k].data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(e[k].data)) return e[k].data;
    }
    e = e.cause;
  }
  return undefined;
}

/** Returns { name, args, text } for a revert, decoding custom errors from every Wavefund ABI. */
export function decodeError(err) {
  const data = revertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: allErrorAbi(), data });
      const args = (d.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : String(a)));
      return { name: d.errorName, args, data, text: `${d.errorName}(${args.join(', ')})` };
    } catch {
      return { name: undefined, args: [], data, text: `unrecognised revert data ${data.slice(0, 74)}` };
    }
  }
  const short = err?.shortMessage || err?.message || String(err);
  return { name: undefined, args: [], data: undefined, text: short.split('\n')[0] };
}

export class ChainRevertError extends Error {
  constructor(message, { hash, decoded } = {}) {
    super(message);
    this.name = 'ChainRevertError';
    this.confirmed = true;
    this.hash = hash;
    this.decoded = decoded;
  }
}

// ---------------------------------------------------------------- gas policy and sending

/** Priority fee 1 gwei, max fee about 2x the current base fee (plus the tip). */
export async function gasPolicy() {
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? (await publicClient.getGasPrice());
  return { maxPriorityFeePerGas: PRIORITY_FEE, maxFeePerGas: base * 2n + PRIORITY_FEE };
}

/**
 * Simulates, then broadcasts a contract write. Failures BEFORE a hash exists (RPC errors, simulation reverts) are
 * retried up to 5 times with a 6 s pause. Once a hash exists the transaction is never re-sent. A mined revert throws
 * ChainRevertError with the decoded custom error. `okErrors` lists custom errors that mean "already done": they
 * return { skipped: true, reason } immediately instead of retrying or failing.
 */
export async function sendContract({
  account,
  address,
  abi,
  functionName,
  args = [],
  label,
  okErrors = [],
  attempts = ATTEMPTS,
  pauseMs = RETRY_PAUSE_MS,
  quiet = false,
}) {
  const name = label || functionName;
  const wallet = walletFor(account);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let hash;
    let sentAt = 0;
    try {
      const fees = await gasPolicy();
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi,
        functionName,
        args,
        ...fees,
      });
      sentAt = Date.now();
      hash = await wallet.writeContract(request);
    } catch (err) {
      last = err;
      const d = decodeError(err);
      if (d.name && okErrors.includes(d.name)) {
        if (!quiet) console.log(`  ${name}: already done (${d.text})`);
        return { skipped: true, reason: d.text };
      }
      if (!quiet) console.log(`  ${name}: attempt ${attempt}/${attempts} failed before broadcast: ${d.text}`);
      if (attempt < attempts) await sleep(pauseMs);
      continue;
    }
    if (!quiet) console.log(`  ${name}: sent ${txUrl(hash)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const ms = Date.now() - sentAt;
    if (receipt.status === 'reverted') {
      let decoded = { text: 'reverted (reason unavailable)' };
      try {
        await publicClient.simulateContract({
          account,
          address,
          abi,
          functionName,
          args,
          blockNumber: receipt.blockNumber - 1n,
        });
      } catch (err) {
        decoded = decodeError(err);
      }
      if (decoded.name && okErrors.includes(decoded.name)) return { skipped: true, reason: decoded.text, hash };
      throw new ChainRevertError(`${name} reverted on chain: ${decoded.text} (${txUrl(hash)})`, { hash, decoded });
    }
    return { hash, receipt, skipped: false, ms };
  }
  const d = decodeError(last);
  const e = new Error(`${name} failed after ${attempts} attempts: ${d.text}`);
  e.decoded = d;
  throw e;
}

/** Reads one view function. */
export function read(address, abi, functionName, args = []) {
  return publicClient.readContract({ address, abi, functionName, args });
}

export async function nativeBalance(addr) {
  return publicClient.getBalance({ address: addr });
}

export async function chainNow() {
  return Number((await publicClient.getBlock()).timestamp);
}

export function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}
