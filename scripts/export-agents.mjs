// node --env-file=.env scripts/export-agents.mjs
// Writes agents/agents.json with PUBLIC data only (address, name, type, description). No keys, no wallet IDs.
// Reads each agent's Circle developer-controlled wallet address with a read-only call (GET /v1/w3s/wallets/{id}).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress } from 'viem';

const key = process.env.CIRCLE_API_KEY;
if (!key) {
  console.error('CIRCLE_API_KEY is not set in .env');
  process.exit(1);
}

const AGENTS = [
  { id: 'momentum', env: 'AGENT_MOMENTUM_CIRCLE_WALLET_ID', name: 'Momentum', type: 'proposer', description: 'Proposes treasury allocations that follow the recent tETH price trend.' },
  { id: 'mean-reversion', env: 'AGENT_MEAN_REVERSION_CIRCLE_WALLET_ID', name: 'Mean Reversion', type: 'proposer', description: 'Proposes allocations that lean against stretched tETH moves.' },
  { id: 'news', env: 'AGENT_NEWS_CIRCLE_WALLET_ID', name: 'News', type: 'proposer', description: 'Proposes allocations based on a reading of current market news.' },
  { id: 'quant', env: 'AGENT_QUANT_CIRCLE_WALLET_ID', name: 'Quant', type: 'forecaster', description: 'Forecaster that trades LONG and SHORT using quantitative signals.' },
  { id: 'guardian', env: 'AGENT_GUARDIAN_CIRCLE_WALLET_ID', name: 'Guardian', type: 'forecaster', description: 'Forecaster that trades to guard the treasury against weak proposals.' },
];

const out = [];
for (const a of AGENTS) {
  const walletId = process.env[a.env];
  if (!walletId) {
    console.error(`${a.env} is not set in .env`);
    process.exit(1);
  }
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`${a.name}: Circle returned ${res.status}`);
    process.exit(1);
  }
  const wallet = (await res.json())?.data?.wallet;
  if (!wallet || !isAddress(wallet.address)) {
    console.error(`${a.name}: no wallet address in the response`);
    process.exit(1);
  }
  console.log(`${a.name}: ${wallet.blockchain} ${getAddress(wallet.address)}`);
  out.push({ id: a.id, name: a.name, type: a.type, description: a.description, address: getAddress(wallet.address), wallet: 'circle-developer-controlled' });
}

const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'agents.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify({ chainId: 5042002, agents: out }, null, 2)}\n`);
console.log(`wrote ${file}`);
