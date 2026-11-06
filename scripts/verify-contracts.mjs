// npm run verify:contracts [-- --only QuantumRound | --dry-run]
// forge verify-contract --verifier blockscout for every contract in the address book, then checks the explorer API
// reports verified source. Needs BLOCKSCOUT_API_KEY if the explorer requires one. Compiles src/ only.
// --dry-run prints each command (with encoded constructor arguments) and sends nothing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { EXPLORER, ROOT, addressUrl, cliArgs, loadBook, sleep } from './demo-round-common.mjs';
import { allBroadcasts } from './lib/broadcast.mjs';

const SPEC = {
  TestAsset: ['src/TestAsset.sol:TestAsset', 'address'],
  MockPriceOracle: ['src/MockPriceOracle.sol:MockPriceOracle', 'address,address,int256'],
  ProposerRegistry: ['src/ProposerRegistry.sol:ProposerRegistry', 'address,address'],
  ProposalTokens: ['src/ProposalTokens.sol:ProposalTokens', 'address'],
  WaveV4ProposalMarket: ['src/WaveV4ProposalMarket.sol:WaveV4ProposalMarket', 'address,address,address'],
  QuantumRound: ['src/QuantumRound.sol:QuantumRound', 'address,address,address,address,address'],
  Resolver: ['src/Resolver.sol:Resolver', 'address,address'],
  WavefundVault: ['src/WavefundVault.sol:WavefundVault', 'address,address,address,address,address'],
  WaveHook: ['src/WaveHook.sol:WaveHook', 'address,address'],
  WavefundPoolHelper: ['src/WavefundPoolHelper.sol:WavefundPoolHelper', 'address,address,address,address'],
};

export async function verificationStatus(address) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`);
    if (!res.ok) return { verified: false, detail: `explorer HTTP ${res.status}` };
    const j = await res.json();
    const verified = Boolean(j.is_verified || j.is_fully_verified || j.is_partially_verified) && Boolean(j.source_code || j.file_path);
    return { verified, name: j.name, detail: verified ? 'verified source' : 'not verified' };
  } catch (err) {
    return { verified: false, detail: `explorer unreachable: ${err.message}` };
  }
}

function constructorArgs(book, name, broadcast) {
  const c = book.c;
  const recorded = broadcast.find((t) => t.contractName === name && t.contractAddress?.toLowerCase() === c[name].toLowerCase())?.arguments;
  let values;
  if (recorded) values = recorded.map((a) => a.replace(/ \[.*\]$/, ''));
  else if (name === 'WaveHook') values = [c.PoolManager, c.WaveV4ProposalMarket];
  else throw new Error(`no constructor arguments recorded for ${name}; run the forge scripts first`);
  const types = SPEC[name][1].split(',');
  return encodeAbiParameters(parseAbiParameters(SPEC[name][1]), values.map((v, i) => (types[i] === 'int256' ? BigInt(v) : v)));
}

async function main() {
  const args = cliArgs({ only: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } });
  const book = loadBook();
  const broadcast = allBroadcasts();
  let failures = 0;
  for (const [name, [target]] of Object.entries(SPEC)) {
    if (args.only && args.only !== name) continue;
    if (!book.c[name]) { console.log(`${name}: not in the address book`); failures++; continue; }
    const hex = constructorArgs(book, name, broadcast);
    if (args['dry-run']) {
      console.log(`${name}: forge verify-contract ${book.c[name]} ${target} --chain-id 5042002 --verifier blockscout --verifier-url ${EXPLORER}/api/ --constructor-args ${hex.slice(0, 18)}... (${(hex.length - 2) / 64} words)`);
      continue;
    }
    const before = await verificationStatus(book.c[name]);
    if (before.verified) { console.log(`${name}: already verified  ${addressUrl(book.c[name])}?tab=contract`); continue; }
    const cmd = ['verify-contract', book.c[name], target, '--chain-id', '5042002', '--verifier', 'blockscout', '--verifier-url', `${EXPLORER}/api/`, '--constructor-args', hex, '--watch'];
    if (process.env.BLOCKSCOUT_API_KEY) cmd.push('--etherscan-api-key', process.env.BLOCKSCOUT_API_KEY);
    console.log(`\n${name}: forge ${cmd.slice(0, 4).join(' ')} ...`);
    const r = spawnSync('forge', cmd, {
      cwd: path.join(ROOT, 'contracts'),
      stdio: 'inherit',
      // compile only src/ (the test and script folders are heavy with via_ir)
      env: { ...process.env, FOUNDRY_TEST: 'no_tests_here', FOUNDRY_SCRIPT: 'no_scripts_here' },
    });
    let after = { verified: false, detail: 'pending' };
    for (let i = 0; i < 6 && !after.verified; i++) {
      after = await verificationStatus(book.c[name]);
      if (!after.verified) await sleep(5000);
    }
    console.log(`${name}: ${after.verified ? 'VERIFIED' : 'NOT VERIFIED'} (${after.detail}, forge exit ${r.status})  ${addressUrl(book.c[name])}?tab=contract`);
    if (!after.verified) failures++;
  }
  console.log(failures === 0 ? '\nall done' : `\n${failures} contract(s) not verified`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
