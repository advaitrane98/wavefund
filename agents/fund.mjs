// npm run agents:fund            (all agents)
// npm run agents:fund:proposers  (Momentum, Mean-reversion, News: 1 USDC bond + gas)
// npm run agents:fund:forecasters (Quant, Guardian: 2 USDC deposit + gas)
// Shows the exact plan, waits for you to type "fund", then sends ERC-20 USDC transfers. Tops each agent up to its
// target, so running it twice sends nothing the second time. USDC is also Arc's gas token: one balance covers both.
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  cliArgs, confirm, erc20Abi, loadBook, read, sendContract, txUrl, usdc as fmt,
} from '../scripts/demo-round-common.mjs';
import { DEFAULT_GAS_TOPUP, FORECASTER_DEPOSIT, PROPOSER_BOND } from './lib/config.mjs';
import { loadAgents } from './lib/files.mjs';
import { assertNotOperator } from './lib/signers/index.mjs';

export const purposeOf = (def) => (def.type === 'proposer' ? PROPOSER_BOND : FORECASTER_DEPOSIT);

/** Pure: what to send to each agent. `balances` maps agent key to its current USDC (raw 6 decimals). */
export function buildPlan({ agents, balances, gasTopUp = DEFAULT_GAS_TOPUP }) {
  return agents.map(({ def, record }) => {
    const purpose = purposeOf(def);
    const target = purpose + gasTopUp;
    const have = balances[def.key] ?? 0n;
    return {
      key: def.key, name: def.name, type: def.type, address: record.address,
      purpose, purposeLabel: def.type === 'proposer' ? 'bond' : 'round deposit', gasTopUp, target, have,
      send: have >= target ? 0n : target - have,
    };
  });
}

export function printPlan(plan, funder, funderBalance) {
  console.log('\nFunding plan (ERC-20 USDC on Arc Testnet, 6 decimals)');
  console.log(`  from: ${funder} (balance ${fmt(funderBalance)} USDC)`);
  for (const p of plan) {
    console.log(`  ${p.name.padEnd(15)} ${p.address}  target ${fmt(p.target)} (${fmt(p.purpose)} ${p.purposeLabel} + ${fmt(p.gasTopUp)} gas)  has ${fmt(p.have)}  SEND ${fmt(p.send)}`);
  }
  const total = plan.reduce((a, p) => a + p.send, 0n);
  console.log(`  total to send: ${fmt(total)} USDC`);
  return total;
}

export async function runFund(argv = process.argv.slice(2)) {
  const args = cliArgs({
    group: { type: 'string' }, only: { type: 'string' }, gas: { type: 'string' }, 'plan-only': { type: 'boolean', default: false },
  }, argv);
  const group = args.group;
  if (group && !['proposers', 'forecasters'].includes(group)) throw new Error('--group must be proposers or forecasters');
  const only = args.only ? args.only.split(',') : undefined;
  let agents = loadAgents({ only });
  if (group) agents = agents.filter(({ def }) => def.type === (group === 'proposers' ? 'proposer' : 'forecaster'));
  const missing = agents.filter(({ record }) => !record.address);
  if (missing.length) throw new Error(`No address for ${missing.map((m) => m.def.key).join(', ')}. Run: npm run agents:setup`);
  for (const { record } of agents) assertNotOperator(record.address);

  const pkName = process.env.AGENT_FUNDER_PK ? 'AGENT_FUNDER_PK' : 'DEPLOYER_PK';
  const pk = process.env[pkName];
  if (!pk) throw new Error('Set AGENT_FUNDER_PK (or DEPLOYER_PK) in .env: the wallet that pays for the funding.');
  const funder = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);

  const book = loadBook();
  const balances = {};
  for (const { def, record } of agents) balances[def.key] = await read(book.c.USDC, erc20Abi, 'balanceOf', [record.address]);
  const funderBalance = await read(book.c.USDC, erc20Abi, 'balanceOf', [funder.address]);
  const gasTopUp = args.gas ? parseUnits(args.gas, 6) : DEFAULT_GAS_TOPUP;
  const plan = buildPlan({ agents, balances, gasTopUp });
  const total = printPlan(plan, funder.address, funderBalance);

  if (total === 0n) return console.log('\nNothing to send: every selected agent is already funded.');
  if (funderBalance < total + 1_000_000n) throw new Error(`Funder has ${fmt(funderBalance)} USDC; needs ${fmt(total)} plus about 1 USDC left for its own gas.`);
  if (args['plan-only']) return console.log('\n--plan-only: nothing sent.');

  await confirm(`This will send ${fmt(total)} USDC from ${funder.address} to ${plan.filter((p) => p.send > 0n).length} agent wallet(s).`, { yes: args.yes, word: 'fund' });
  for (const p of plan.filter((x) => x.send > 0n)) {
    const res = await sendContract({
      account: funder, address: book.c.USDC, abi: erc20Abi, functionName: 'transfer', args: [p.address, p.send], label: `fund ${p.name} ${fmt(p.send)} USDC`,
    });
    if (res.hash) console.log(`    ${txUrl(res.hash)}`);
  }
  console.log('\nFunding complete.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFund().catch((err) => {
    console.error(`agents:fund failed: ${err.message}`);
    process.exit(1);
  });
}
