// Exports the ABIs the operator scripts need from forge artifacts (contracts/out) to
// contracts/deployments/abis.json, so the scripts work without a local forge build.
// Run: npm run abi:export   (after `forge build` in contracts/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.FORGE_OUT || path.join(root, 'contracts', 'out');
const names = [
  ['QuantumRound', 'QuantumRound.sol'],
  ['WavefundVault', 'WavefundVault.sol'],
  ['Resolver', 'Resolver.sol'],
  ['MockPriceOracle', 'MockPriceOracle.sol'],
  ['ProposerRegistry', 'ProposerRegistry.sol'],
  ['ProposalTokens', 'ProposalTokens.sol'],
  ['ProposalToken', 'ProposalToken.sol'],
  ['WaveV4ProposalMarket', 'WaveV4ProposalMarket.sol'],
  ['WaveHook', 'WaveHook.sol'],
  ['TestAsset', 'TestAsset.sol'],
  ['WavefundPoolHelper', 'WavefundPoolHelper.sol'],
  ['PoolManager', 'PoolManager.sol'],
  ['ERC20', 'ERC20.sol'],
];
const abis = {};
for (const [name, file] of names) {
  const p = path.join(out, file, `${name}.json`);
  if (!fs.existsSync(p)) {
    console.warn(`skip ${name}: ${p} not found`);
    continue;
  }
  abis[name] = JSON.parse(fs.readFileSync(p, 'utf8')).abi;
}
const dest = path.join(root, 'contracts', 'deployments', 'abis.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(abis));
console.log(`wrote ${path.relative(root, dest)} with ${Object.keys(abis).length} ABIs`);
