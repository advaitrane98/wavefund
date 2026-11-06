// npm run fund:vault [-- --amount 5 --teth 0 --yes]   Bootstraps the vault: fundVault mints WAVE to the deployer.
import { parseUnits } from 'viem';
import { abis, accountFrom, cliArgs, confirm, erc20Abi, loadBook, read, sendContract, usdc } from './demo-round-common.mjs';
import { oracleState } from './lib/oracle.mjs';

const args = cliArgs({ amount: { type: 'string', default: '5' }, teth: { type: 'string', default: '0' } });
const book = loadBook();
const admin = accountFrom('DEPLOYER_PK');
const amount = parseUnits(args.amount, 6);
const teth = parseUnits(args.teth, 18);
const o = await oracleState();
if (o.age > 240) throw new Error(`oracle is ${o.age}s old (fundVault needs <= 300s). Run: npm run oracle:update`);
await confirm(`Fund the vault ${book.c.WavefundVault} with ${usdc(amount)} USDC and ${args.teth} tETH (shares go to ${admin.address}).`, { yes: args.yes, word: 'fund' });
if ((await read(book.c.USDC, erc20Abi, 'allowance', [admin.address, book.c.WavefundVault])) < amount) {
  await sendContract({ account: admin, address: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [book.c.WavefundVault, amount], label: 'approve vault' });
}
if (teth > 0n) {
  await sendContract({ account: admin, address: book.c.TestAsset, abi: abis().TestAsset, functionName: 'mint', args: [admin.address, teth], label: 'mint tETH' });
  await sendContract({ account: admin, address: book.c.TestAsset, abi: erc20Abi, functionName: 'approve', args: [book.c.WavefundVault, teth], label: 'approve vault tETH' });
}
await sendContract({ account: admin, address: book.c.WavefundVault, abi: abis().WavefundVault, functionName: 'fundVault', args: [amount, teth, admin.address], label: 'fundVault' });
const V = book.c.WavefundVault;
console.log(`vault NAV ${usdc(await read(V, abis().WavefundVault, 'navUsdc'))} USDC, shares ${await read(V, abis().WavefundVault, 'totalSupply')}`);
