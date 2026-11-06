// node scripts/forge-run.mjs <Deploy|DeployWaveHook|DeployPoolHelper|Wire> [--broadcast] [-- extra forge flags]
// Runs a forge script with the gas policy (priority fee 1 gwei, max fee 2x the current base fee + tip).
// WITHOUT --broadcast it only simulates against the RPC and prints forge's gas estimate: nothing is sent.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, RPC_URL, PRIORITY_FEE, publicClient } from './demo-round-common.mjs';

const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.error('usage: forge-run.mjs <ScriptName> [--broadcast] [forge flags]');
  process.exit(1);
}
const broadcast = rest.includes('--broadcast');
const extra = rest.filter((a) => a !== '--broadcast');
const block = await publicClient.getBlock();
const base = block.baseFeePerGas ?? (await publicClient.getGasPrice());
const maxFee = base * 2n + PRIORITY_FEE;
console.log(`base fee ${Number(base) / 1e9} gwei -> max fee ${Number(maxFee) / 1e9} gwei, priority ${Number(PRIORITY_FEE) / 1e9} gwei`);
const cmd = ['script', `script/${name}.s.sol`, '--rpc-url', RPC_URL, '--with-gas-price', maxFee.toString(), '--priority-gas-price', PRIORITY_FEE.toString(), ...(broadcast ? ['--broadcast'] : []), ...extra];
console.log(`forge ${cmd.join(' ').replace(RPC_URL, '<rpc>')}${broadcast ? '' : '   (simulation only)'}`);
const r = spawnSync('forge', cmd, { cwd: path.join(ROOT, 'contracts'), stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
