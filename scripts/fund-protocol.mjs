// npm run fund:protocol [-- --amount 30 --yes]   Approves QuantumRound and adds USDC to the protocol reserve.
import { parseUnits } from 'viem';
import { abis, accountFrom, cliArgs, confirm, erc20Abi, loadBook, read, sendContract, usdc } from './demo-round-common.mjs';

const args = cliArgs({ amount: { type: 'string', default: '30' } });
const book = loadBook();
const admin = accountFrom('DEPLOYER_PK');
const amount = parseUnits(args.amount, 6);
const balance = await read(book.c.USDC, erc20Abi, 'balanceOf', [admin.address]);
if (balance < amount) throw new Error(`deployer holds ${usdc(balance)} USDC, needs ${usdc(amount)}`);
await confirm(`Add ${usdc(amount)} USDC to the protocol reserve of QuantumRound ${book.c.QuantumRound}.`, { yes: args.yes, word: 'fund' });
const allowance = await read(book.c.USDC, erc20Abi, 'allowance', [admin.address, book.c.QuantumRound]);
if (allowance < amount) {
  await sendContract({ account: admin, address: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [book.c.QuantumRound, amount], label: 'approve QuantumRound' });
}
await sendContract({ account: admin, address: book.c.QuantumRound, abi: abis().QuantumRound, functionName: 'addProtocolLiquiditySeed', args: [amount], label: 'addProtocolLiquiditySeed' });
console.log(`reserve now ${usdc(await read(book.c.QuantumRound, abis().QuantumRound, 'protocolLiquiditySeed'))} USDC`);
