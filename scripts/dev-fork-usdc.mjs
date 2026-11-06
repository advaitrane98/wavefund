// DRY-RUN HELPER, local anvil forks only. Anvil cannot execute Arc's USDC ERC-20 transfers (blocklist precompile),
// so this swaps the code at the USDC address for a plain 6-decimal ERC-20 (MockUSDC) and mints to the given
// addresses. It refuses to run against anything but a local RPC.
//   FORGE_OUT=/path/to/out node scripts/dev-fork-usdc.mjs <amount USDC> <address> [<address> ...]
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, RPC_URL } from './demo-round-common.mjs';

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(RPC_URL)) {
  console.error(`refusing to run: RPC ${RPC_URL} is not a local fork`);
  process.exit(1);
}
const [amount, ...addrs] = process.argv.slice(2);
const out = process.env.FORGE_OUT || path.join(ROOT, 'contracts', 'out');
const artifact = JSON.parse(fs.readFileSync(path.join(out, 'MockUSDC.sol', 'MockUSDC.json'), 'utf8'));
const USDC = '0x3600000000000000000000000000000000000000';
const rpc = async (method, params) => {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
await rpc('anvil_setCode', [USDC, artifact.deployedBytecode.object]);
const pk = process.env.DEPLOYER_PK;
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, transport: http(RPC_URL) });
const pub = createPublicClient({ transport: http(RPC_URL) });
const abi = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
for (const a of addrs) {
  await rpc('anvil_setBalance', [a, '0x56BC75E2D63100000']); // 100 native units for gas on the fork
  const h = await wallet.writeContract({ address: USDC, abi, functionName: 'mint', args: [a, parseUnits(amount, 6)], chain: null });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`minted ${amount} USDC to ${a}`);
}
