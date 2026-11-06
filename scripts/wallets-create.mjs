// npm run wallets:create -- --count 5   Appends TEST_WALLET_PKS=<pk,pk,...> to .env (keys are never printed).
// Index convention used by the smoke test: 0-2 agents (propose), 3-4 users.
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ROOT, cliArgs } from './demo-round-common.mjs';

const args = cliArgs({ count: { type: 'string', default: '5' } });
const envFile = path.join(ROOT, '.env');
const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
if (/^TEST_WALLET_PKS=/m.test(text)) {
  console.log('TEST_WALLET_PKS already exists in .env; leaving it unchanged.');
  process.exit(0);
}
const keys = Array.from({ length: Number(args.count) }, () => generatePrivateKey());
fs.appendFileSync(envFile, `${text.endsWith('\n') || text === '' ? '' : '\n'}TEST_WALLET_PKS=${keys.join(',')}\n`);
console.log(`added ${keys.length} test wallets to .env. Addresses:`);
keys.forEach((k, i) => console.log(`  ${i}: ${privateKeyToAccount(k).address}`));
