// npm run round-report -- --round N   Read-only report from on-chain state and events.
import { abis, cliArgs, loadBook, publicClient, read, txUrl, usdc } from './demo-round-common.mjs';
import { STATUS, snapshot } from './lib/round-actions.mjs';
import { printReconcile, reconcile } from './lib/reconcile.mjs';
import { testWallets } from './demo-round-common.mjs';

const args = cliArgs({ round: { type: 'string' } });
const book = loadBook();
const A = abis();
const s = await snapshot(args.round ? BigInt(args.round) : undefined);
if (!s) throw new Error('no such round');
const QR = book.c.QuantumRound;
const e18 = (x) => (Number(x) / 1e18).toFixed(4);

console.log(`\nRound ${s.id}: ${STATUS[s.status]}`);
console.log(`  trading ${new Date(s.tradingStart * 1000).toISOString()} -> ${new Date(s.tradingEnd * 1000).toISOString()}, TWAP window ${s.twapWindow}s`);
console.log(`  evaluation ends ${new Date(s.evaluationEnd * 1000).toISOString()}, return bounds ${e18(s.rMin)} .. ${e18(s.rMax)}`);
console.log(`  deposits ${usdc(s.totalDeposits)} USDC (outstanding ${usdc(s.depositsOutstanding)}), escrow ${usdc(s.escrow)}, paid ${usdc(s.totalPaid)}, seed released: ${s.seedReleased}`);
if (s.status >= 2) console.log(`  winner: proposal ${s.winnerId}`);
if (s.status === 3) console.log(`  realised return ${e18(s.realisedReturn)}  ->  LONG pays ${e18(s.pi)}`);

console.log('\nProposals');
for (let p = 0n; p < BigInt(s.proposalCount); p++) {
  const x = await read(QR, A.QuantumRound, 'proposals', [s.id, p]);
  const twap = x[5] ? `TWAP ${e18(x[5])}` : '';
  console.log(`  #${p} ${x[2] ? 'status quo' : x[0]}  tETH ${x[1] / 100}%  seed ${usdc(x[3])}  ${twap}${p === BigInt(s.winnerId) && s.status >= 2 ? '  <- winner' : ''}  ${x[6] ? `"${x[6]}"` : ''}`);
}
console.log(`\nVault: executed ${s.vault.executed}, reported ${s.vault.reported}, cancelled ${s.vault.cancelled}, start value ${usdc(s.vault.startValue)} USDC`);

console.log('\nEvents');
const start = BigInt((loadBook().startBlock ?? 0));
const latest = await publicClient.getBlockNumber();
const logs = [];
for (const [name, address, abi] of [['QuantumRound', QR, A.QuantumRound], ['WavefundVault', book.c.WavefundVault, A.WavefundVault]]) {
  let from = start;
  let step = 50_000n;
  while (from <= latest) {
    const to = from + step > latest ? latest : from + step;
    try {
      const got = await publicClient.getContractEvents({ address, abi, fromBlock: from, toBlock: to });
      logs.push(...got.map((l) => ({ name, l })));
      from = to + 1n;
    } catch {
      step = step > 1000n ? step / 4n : step;
      if (step <= 1000n && from + step > latest) break;
    }
  }
}
const mine = logs.filter(({ l }) => l.args?.roundId === s.id || l.args?.roundId === undefined && ['FlowsProcessed'].includes(l.eventName));
mine.sort((a, b) => Number(a.l.blockNumber - b.l.blockNumber) || a.l.logIndex - b.l.logIndex);
for (const { name, l } of mine) {
  const a = Object.entries(l.args ?? {}).filter(([k]) => k !== 'roundId').map(([k, v]) => `${k}=${typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? `[${v.join(',')}]` : v}`).join(' ');
  console.log(`  ${name}.${l.eventName} ${a}  ${txUrl(l.transactionHash)}`);
}
console.log('\nReconciliation');
printReconcile(await reconcile(testWallets().map((w) => w.address)));
