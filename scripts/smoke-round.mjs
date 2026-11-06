// npm run smoke:round [-- --trading-seconds 150 --twap-seconds 45 --evaluation-seconds 45 --yes]
// End-to-end smoke test with the test wallets (TEST_WALLET_PKS, run npm run wallets:create first):
//   round 1: open, 3 agents propose, 2 users deposit and claim in every proposal, buy and sell LONG and SHORT,
//            collapse, vault trade, report + settle, redeem, reconcile to zero unaccounted.
//   round 2: an empty round (status quo wins, no vault trade, the seed returns).
// Wallets 0-2 are agents, 3-4 are users. The deployer tops them up with USDC.
import { parseUnits } from 'viem';
import {
  abis, accountFrom, chainNow, cliArgs, confirm, erc20Abi, loadBook, log, read, sendContract, sleep, testWallets, usdc,
} from './demo-round-common.mjs';
import { nextStep, openStatusQuoRound, preflight, printChecks, snapshot, STATUS } from './lib/round-actions.mjs';
import { printReconcile, reconcile } from './lib/reconcile.mjs';
import { main as recenterPool } from './pool-recenter.mjs';
import { oracleState, updateOracle } from './lib/oracle.mjs';
import { priceFromSqrt, readPool } from './lib/pool-math.mjs';

const args = cliArgs({
  'trading-seconds': { type: 'string', default: '150' },
  'twap-seconds': { type: 'string', default: '45' },
  'evaluation-seconds': { type: 'string', default: '45' },
});
const book = loadBook();
const A = abis();
const QR = book.c.QuantumRound;
const deployer = accountFrom('DEPLOYER_PK');
const wallets = testWallets();
if (wallets.length < 5) throw new Error('need 5 test wallets in TEST_WALLET_PKS. Run: npm run wallets:create');
const [agent0, agent1, agent2, user3, user4] = wallets;
const agents = [agent0, agent1, agent2];
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};
const timing = {
  tradingSeconds: Number(args['trading-seconds']),
  twapSeconds: Number(args['twap-seconds']),
  evaluationSeconds: Number(args['evaluation-seconds']),
};
const send = (account, address, abi, functionName, a, label) => sendContract({ account, address, abi, functionName, args: a, label });
const bal = (token, who) => read(token, erc20Abi, 'balanceOf', [who]);
async function waitUntil(ts, why) {
  for (;;) {
    const left = ts - (await chainNow());
    if (left <= 0) return;
    log(`${why}: ${left}s`);
    await sleep(Math.min(left, 5) * 1000);
  }
}
async function drive() {
  for (;;) {
    const r = await nextStep();
    if (r.action === 'idle') return;
    if (r.action === 'wait') await sleep(Math.min(Math.max(r.wait, 1), 3) * 1000);
    else log(`keeper step: ${r.action}`);
  }
}

console.log('Smoke test wallets:');
wallets.forEach((w, i) => console.log(`  ${i}: ${w.address}`));
await confirm('Runs two full rounds from the keeper, deployer and test wallets (moves a few USDC on the target chain).', { yes: args.yes, word: 'smoke' });

// ------------------------------------------------------------------ top up
console.log('\n[1] fund test wallets');
for (const [w, want] of [[agent0, '3'], [agent1, '3'], [agent2, '3'], [user3, '8'], [user4, '8']]) {
  const have = await bal(book.c.USDC, w.address);
  const need = parseUnits(want, 6);
  if (have < need) await send(deployer, book.c.USDC, erc20Abi, 'transfer', [w.address, need - have], `fund ${w.address.slice(0, 8)}`);
}

console.log('\n[2] register agents');
for (const [i, a] of agents.entries()) {
  const info = await read(book.c.ProposerRegistry, A.ProposerRegistry, 'agents', [a.address]);
  if (!info[0]) await send(a, book.c.ProposerRegistry, A.ProposerRegistry, 'registerAgent', [`Smoke Agent ${i + 1}`], `registerAgent ${i + 1}`);
  await send(a, book.c.USDC, erc20Abi, 'approve', [book.c.ProposerRegistry, parseUnits('3', 6)], `approve bond ${i + 1}`);
}

console.log('\n[3] preflight and open round 1');
const pre = await preflight();
printChecks(pre);
if (!pre.ready) throw new Error('preflight failed');
const reserve0 = await read(QR, A.QuantumRound, 'protocolLiquiditySeed');
const vaultBefore = { usdc: await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultUsdc'), teth: await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultTEth') };
const { snap: open } = await openStatusQuoRound({ timing, skipPreflight: true });
const r = open.id;

console.log('\n[4] three agents propose');
const allocations = [5000, 8000, 2000];
for (const [i, a] of agents.entries()) {
  await send(a, QR, A.QuantumRound, 'propose', [r, { tEthBps: allocations[i] }, `Smoke proposal ${i + 1}: ${allocations[i] / 100}% tETH`], `propose ${i + 1}`);
}
check('4 markets exist (status quo + 3 proposals)', (await snapshot(r)).proposalCount === 4);

console.log('\n[5] deposits and per-proposal credit claims');
const deposits = new Map([[user3, parseUnits('5', 6)], [user4, parseUnits('3', 6)]]);
for (const [u, amount] of deposits) {
  await send(u, book.c.USDC, erc20Abi, 'approve', [QR, amount], 'approve QuantumRound');
  await send(u, QR, A.QuantumRound, 'deposit', [r, amount], 'deposit');
  for (let p = 0n; p < 4n; p++) await send(u, QR, A.QuantumRound, 'claimCredits', [r, p, parseUnits('2', 6)], `claim 2 credits in #${p}`);
}
check('credits claimable in EVERY proposal from one deposit', (await read(QR, A.QuantumRound, 'creditsClaimed', [r, 3n, user3.address])) === parseUnits('2', 6));
let capped = false;
try {
  await sendContract({ account: user4, address: QR, abi: A.QuantumRound, functionName: 'claimCredits', args: [r, 3n, parseUnits('2', 6)], label: 'claim beyond the cap (must fail)', attempts: 1, quiet: true });
} catch (err) {
  capped = /ClaimExceedsDeposit/.test(err.decoded?.text ?? err.message);
}
check('claim beyond the deposit is rejected per proposal', capped);

console.log('\n[6] trading: buy and sell LONG and SHORT');
const tok = async (p, kind) => read(book.c.ProposalTokens, A.ProposalTokens, kind, [r, p]);
const one = parseUnits('1', 6);
await send(user3, QR, A.QuantumRound, 'buyLong', [r, 2n, one, 0n], 'user3 buyLong #2');
await send(user3, QR, A.QuantumRound, 'buyShort', [r, 3n, one, 0n], 'user3 buyShort #3');
await send(user4, QR, A.QuantumRound, 'buyShort', [r, 0n, one, 0n], 'user4 buyShort #0');
await send(user4, QR, A.QuantumRound, 'buyLong', [r, 2n, one / 2n, 0n], 'user4 buyLong #2');
const long2 = await bal(await tok(2n, 'longToken'), user3.address);
await send(user3, QR, A.QuantumRound, 'sellLong', [r, 2n, long2 / 2n, 0n], 'user3 sellLong #2 (half)');
const short3 = await bal(await tok(3n, 'shortToken'), user3.address);
await send(user3, QR, A.QuantumRound, 'sellShort', [r, 3n, short3, 0n], 'user3 sellShort #3 (all)');
check('LONG and SHORT bought and sold', (await bal(await tok(2n, 'longToken'), user3.address)) > 0n);

console.log('\n[7] strike proposal 1 inside the final TWAP window');
await waitUntil(open.tradingEnd - timing.twapSeconds + 3, 'waiting for the TWAP window');
await send(user3, QR, A.QuantumRound, 'buyLong', [r, 1n, parseUnits('2', 6), 0n], 'user3 buyLong #1 (strike)');
await waitUntil(open.tradingEnd, 'trading ends');

console.log('\n[8] collapse, vault trade, report and settle (keeper steps)');
await drive();
const done = await snapshot(r);
check('round settled', STATUS[done.status] === 'Settled', STATUS[done.status]);
check('proposal 1 won', done.winnerId === 1, `winner ${done.winnerId}`);
check('vault traded toward the winning allocation', (await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultTEth')) > vaultBefore.teth);
check('all bonds refunded', (await Promise.all(agents.map((a) => read(book.c.ProposerRegistry, A.ProposerRegistry, 'lockedBond', [a.address])))).every((b) => b === 0n));

console.log('\n[9] redeem');
for (const u of [user3, user4]) {
  const before = await bal(book.c.USDC, u.address);
  await send(u, QR, A.QuantumRound, 'redeem', [r], 'redeem');
  console.log(`  ${u.address.slice(0, 8)} received ${usdc((await bal(book.c.USDC, u.address)) - before)} USDC (deposit ${usdc(deposits.get(u))})`);
}
const after = await snapshot(r);
check('winning seed released after the last redeem', after.seedReleased);
check('every depositor redeemed', after.depositsOutstanding === 0n);

console.log('\n[10] reconcile');
const holders = [deployer, ...wallets].map((w) => w.address);
check('nothing unaccounted after round 1', printReconcile(await reconcile(holders)));

console.log('\n[10b] the vault trade moved the pool: recenter it before the next round');
await updateOracle({});
{
  const pool = await readPool(book);
  const drift = Math.abs(priceFromSqrt(pool.sqrtPriceX96, pool.key.usdcIs0) / (await oracleState()).usd - 1);
  console.log(`  pool is ${(drift * 100).toFixed(2)}% from the oracle`);
  if (drift > 0.004) await recenterPool(['--yes', '--max-new-usdc', '1']);
}

console.log('\n[11] empty round (status quo, no vault trade, seed returns)');
const reserveBefore2 = await read(QR, A.QuantumRound, 'protocolLiquiditySeed');
const vaultMid = { usdc: await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultUsdc'), teth: await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultTEth') };
const { snap: open2 } = await openStatusQuoRound({ timing, skipPreflight: false });
await waitUntil(open2.tradingEnd, 'empty round trading');
await drive();
const done2 = await snapshot(open2.id);
check('empty round settled', STATUS[done2.status] === 'Settled', STATUS[done2.status]);
check('status quo won', done2.winnerId === 0);
check('no vault trade', (await read(book.c.WavefundVault, A.WavefundVault, 'totalVaultTEth')) === vaultMid.teth);
check('seed returned to the reserve', (await read(QR, A.QuantumRound, 'protocolLiquiditySeed')) === reserveBefore2, `reserve ${usdc(await read(QR, A.QuantumRound, 'protocolLiquiditySeed'))}`);
check('nothing unaccounted after round 2', printReconcile(await reconcile(holders)));

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
void reserve0;
process.exit(failed.length ? 1 : 0);
