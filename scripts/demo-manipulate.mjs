// npm run demo:manipulate -- --proposal 1 --side long|short --credits 2 --at-seconds-before-end 20 [--wallet 0] [--round N]
// Strikes one proposal's market shortly before trading ends so its final-window TWAP moves. Deposit, approval and
// credit claim happen first; the buy is sent early by the measured submission latency so it lands at the requested
// moment. Uses one of the TEST_WALLET_PKS wallets.
import { parseUnits } from 'viem';
import { abis, chainNow, cliArgs, confirm, erc20Abi, loadBook, log, read, sendContract, sleep, testWallets, usdc } from './demo-round-common.mjs';
import { snapshot } from './lib/round-actions.mjs';

const args = cliArgs({
  round: { type: 'string' },
  proposal: { type: 'string' },
  side: { type: 'string', default: 'long' },
  credits: { type: 'string', default: '1' },
  'at-seconds-before-end': { type: 'string', default: '20' },
  wallet: { type: 'string', default: '0' },
});
if (args.proposal == null) throw new Error('--proposal is required');
if (!['long', 'short'].includes(args.side)) throw new Error('--side must be long or short');
const book = loadBook();
const A = abis();
const wallets = testWallets();
const account = wallets[Number(args.wallet)];
if (!account) throw new Error(`no test wallet at index ${args.wallet} (TEST_WALLET_PKS has ${wallets.length}). Run npm run wallets:create`);
const snap = await snapshot(args.round ? BigInt(args.round) : undefined);
if (!snap || snap.status !== 1) throw new Error('the round is not in its trading phase');
const proposal = BigInt(args.proposal);
if (proposal >= BigInt(snap.proposalCount)) throw new Error(`proposal ${proposal} does not exist (round has ${snap.proposalCount})`);
const credits = parseUnits(args.credits, 6);
const strikeAt = snap.tradingEnd - Number(args['at-seconds-before-end']);
const QR = book.c.QuantumRound;

await confirm(`Wallet ${account.address} will buy ${args.side.toUpperCase()} in round ${snap.id} proposal ${proposal} with ${usdc(credits)} credits at T-${args['at-seconds-before-end']}s.`, { yes: args.yes, word: 'strike' });

// preparation: deposit, approval, credits
const deposited = await read(QR, A.QuantumRound, 'deposits', [snap.id, account.address]);
const observed = [];
if (deposited < credits) {
  if ((await read(book.c.USDC, erc20Abi, 'allowance', [account.address, QR])) < credits) {
    const a = await sendContract({ account, address: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [QR, credits], label: 'approve QuantumRound' });
    observed.push(a.ms);
  }
  const d = await sendContract({ account, address: QR, abi: A.QuantumRound, functionName: 'deposit', args: [snap.id, credits - deposited], label: 'deposit' });
  observed.push(d.ms);
}
const credit = await read(book.c.ProposalTokens, A.ProposalTokens, 'creditToken', [snap.id, proposal]);
const held = await read(credit, erc20Abi, 'balanceOf', [account.address]);
if (held < credits) {
  const r = await sendContract({ account, address: QR, abi: A.QuantumRound, functionName: 'claimCredits', args: [snap.id, proposal, credits - held], label: 'claimCredits' });
  observed.push(r.ms);
}
// the fastest observed send-to-confirmation time is the best estimate of the best-case landing delay
const latencyMs = Math.min(6000, Math.max(500, Math.min(...observed.filter(Boolean), 1500)));
log(`measured submission latency ~${latencyMs} ms`);

// wait until (strike time - latency)
for (;;) {
  const now = await chainNow();
  const remainingMs = (strikeAt - now) * 1000 - latencyMs;
  if (remainingMs <= 0) break;
  log(`striking in ~${Math.round(remainingMs / 1000)}s`);
  await sleep(Math.min(remainingMs, 2000));
}
const fn = args.side === 'long' ? 'buyLong' : 'buyShort';
const sent = await sendContract({ account, address: QR, abi: A.QuantumRound, functionName: fn, args: [snap.id, proposal, credits, 0n], label: `${fn} proposal ${proposal}`, attempts: 1 });
const block = await (await import('./demo-round-common.mjs')).publicClient.getBlock({ blockNumber: sent.receipt.blockNumber });
console.log(`strike landed ${snap.tradingEnd - Number(block.timestamp)}s before trading end (target ${args['at-seconds-before-end']}s)`);
