// npm run check:contracts   Code at every address, ABI selectors present in the bytecode, wiring, roles, creditDecimals = 6.
import { keccak256, toFunctionSelector } from 'viem';
import { abis, accountFrom, addressUrl, loadBook, publicClient, read } from './demo-round-common.mjs';

const book = loadBook();
const c = book.c;
const A = abis();
let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

console.log('code and ABI selectors');
const abiByContract = {
  TestAsset: A.TestAsset, MockPriceOracle: A.MockPriceOracle, ProposerRegistry: A.ProposerRegistry, ProposalTokens: A.ProposalTokens,
  WaveV4ProposalMarket: A.WaveV4ProposalMarket, QuantumRound: A.QuantumRound, Resolver: A.Resolver, WavefundVault: A.WavefundVault,
  WaveHook: A.WaveHook, WavefundPoolHelper: A.WavefundPoolHelper,
};
for (const [name, abi] of Object.entries(abiByContract)) {
  if (!c[name]) { ok(false, `${name}: not in the address book`); continue; }
  const code = (await publicClient.getCode({ address: c[name] })) ?? '0x';
  if (code.length <= 2) { ok(false, `${name}: no code at ${c[name]}`); continue; }
  // WaveHook only dispatches the hook callbacks, not every function of BaseHook's ABI, so only require its own selectors.
  const missing = abi
    .filter((i) => i.type === 'function')
    .map((i) => toFunctionSelector(i))
    .filter((sel) => !code.toLowerCase().includes(sel.slice(2).toLowerCase()));
  ok(missing.length === 0, `${name} ${addressUrl(c[name])} has code${missing.length ? `, missing selectors ${missing.join(' ')}` : ', all ABI selectors present'}`);
}
ok((await publicClient.getCode({ address: c.PoolManager }))?.length > 2, 'PoolManager has code');
ok((await publicClient.getCode({ address: c.USDC }))?.length > 2, 'USDC has code');

console.log('configuration');
const keeper = (() => { try { return accountFrom('KEEPER_PK').address; } catch { return book.keeper; } })();
const has = async (addr, abi, roleFn, who) => read(addr, abi, 'hasRole', [await read(addr, abi, roleFn), who]);
ok((await read(c.ProposalTokens, A.ProposalTokens, 'creditDecimals')) === 6, 'ProposalTokens.creditDecimals == 6');
ok(await has(c.ProposalTokens, A.ProposalTokens, 'QUANTUM_ROUND_ROLE', c.QuantumRound), 'QuantumRound has QUANTUM_ROUND_ROLE on ProposalTokens');
ok(await has(c.ProposerRegistry, A.ProposerRegistry, 'QUANTUM_ROUND_ROLE', c.QuantumRound), 'QuantumRound has QUANTUM_ROUND_ROLE on ProposerRegistry');
ok(await has(c.QuantumRound, A.QuantumRound, 'KEEPER_ROLE', keeper), `keeper ${keeper} has KEEPER_ROLE on QuantumRound`);
ok(await has(c.WavefundVault, A.WavefundVault, 'KEEPER_ROLE', keeper), 'keeper has KEEPER_ROLE on WavefundVault');
ok(await has(c.MockPriceOracle, A.MockPriceOracle, 'KEEPER_ROLE', keeper), 'keeper has KEEPER_ROLE on MockPriceOracle');
ok(await has(c.QuantumRound, A.QuantumRound, 'VAULT_ROLE', c.WavefundVault), 'vault has VAULT_ROLE on QuantumRound');
ok(await has(c.Resolver, A.Resolver, 'RESOLVER_ROLE', c.WavefundVault), 'vault has RESOLVER_ROLE on Resolver');
ok(await has(c.QuantumRound, A.QuantumRound, 'RESOLVER_ROLE', c.Resolver), 'Resolver has RESOLVER_ROLE on QuantumRound');
const lc = (x) => String(x).toLowerCase();
ok(lc(await read(c.WaveV4ProposalMarket, A.WaveV4ProposalMarket, 'quantumRound')) === lc(c.QuantumRound), 'market.quantumRound == QuantumRound');
ok(lc(await read(c.WaveV4ProposalMarket, A.WaveV4ProposalMarket, 'waveHook')) === lc(c.WaveHook), 'market.waveHook == WaveHook');
ok(lc(await read(c.WaveV4ProposalMarket, A.WaveV4ProposalMarket, 'owner')) === lc(c.QuantumRound), 'market owner == QuantumRound');
ok(lc(await read(c.WavefundVault, A.WavefundVault, 'quantumRound')) === lc(c.QuantumRound), 'vault.quantumRound == QuantumRound');
ok(lc(await read(c.WavefundVault, A.WavefundVault, 'resolver')) === lc(c.Resolver), 'vault.resolver == Resolver');
ok(lc(await read(c.QuantumRound, A.QuantumRound, 'allocationSource')) === lc(c.WavefundVault), 'allocationSource == vault');
ok((await read(c.QuantumRound, A.QuantumRound, 'initialLiquidityPerProposal')) === 5_000_000n, 'initialLiquidityPerProposal == 5 USDC');
ok((BigInt(c.WaveHook) & 0x3fffn) === 2752n, 'WaveHook address flags == 2752');
ok(lc(await read(c.WaveHook, A.WaveHook, 'adapter')) === lc(c.WaveV4ProposalMarket), 'WaveHook.adapter == market');
ok(lc(await read(c.QuantumRound, A.QuantumRound, 'usdc')) === lc(c.USDC), 'QuantumRound uses the Arc USDC ERC-20');
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
