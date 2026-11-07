// npm run agents:setup
// Idempotent. Creates (only if missing) one Circle wallet set and five unfunded EOA wallets on ARC-TESTNET, writes the
// public addresses to agents/agents.json and the wallet IDs to .env. Existing IDs are re-used, never duplicated.
// Errors name Circle's HTTP status and error code but never credentials.
import { pathToFileURL } from 'node:url';
import { AGENT_DEFS, CHAIN_NAME, WALLET_SET_ENV, WALLET_SET_NAME, publicFields } from './lib/config.mjs';
import { AGENTS_FILE, ENV_FILE, readAgentsFile, upsertEnv, writeAgentsFile } from './lib/files.mjs';
import { CircleError, createCircleClient, uuidFrom } from './lib/signers/circle.mjs';
import { assertNotOperator } from './lib/signers/index.mjs';

const refIdOf = (key) => `wavefund-agent-${key}`;

export async function runSetup({ client, env = process.env, envFile = ENV_FILE, agentsFile = AGENTS_FILE, say = console.log } = {}) {
  const summary = { createdWalletSet: false, created: [], reused: [], addresses: {} };
  const wrap = async (context, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw new CircleError(err, context);
    }
  };

  // 1. wallet set
  let walletSetId = env[WALLET_SET_ENV];
  if (!walletSetId) {
    const res = await wrap('create wallet set', () => client.createWalletSet({ name: WALLET_SET_NAME, idempotencyKey: uuidFrom('wavefund-agents-wallet-set') }));
    walletSetId = res?.data?.walletSet?.id;
    if (!walletSetId) throw new Error('Circle returned no wallet set id');
    upsertEnv(envFile, WALLET_SET_ENV, walletSetId);
    env[WALLET_SET_ENV] = walletSetId;
    summary.createdWalletSet = true;
    say(`created wallet set (id saved to .env as ${WALLET_SET_ENV})`);
  } else {
    say(`using existing wallet set (${WALLET_SET_ENV})`);
  }

  // 2. one EOA per agent
  let existing; // wallets already in the set, for recovery when .env lost an ID
  const records = readAgentsFile(agentsFile);
  for (const def of AGENT_DEFS) {
    let wallet;
    const knownId = env[def.envId];
    if (knownId) {
      const res = await wrap(`get wallet for ${def.key}`, () => client.getWallet({ id: knownId }));
      wallet = res?.data?.wallet;
      if (!wallet) throw new Error(`${def.envId} points to a wallet Circle cannot find`);
      summary.reused.push(def.key);
    } else {
      existing ??= (await wrap('list wallets', () => client.listWallets({ walletSetId, blockchain: CHAIN_NAME, pageSize: 50 })))?.data?.wallets ?? [];
      wallet = existing.find((w) => w.refId === refIdOf(def.key));
      if (wallet) {
        summary.reused.push(def.key);
      } else {
        const res = await wrap(`create wallet for ${def.key}`, () => client.createWallets({
          accountType: 'EOA', blockchains: [CHAIN_NAME], count: 1, walletSetId,
          metadata: [{ name: `Wavefund ${def.name}`, refId: refIdOf(def.key) }],
          idempotencyKey: uuidFrom(`wavefund-agent-wallet-${def.key}`),
        }));
        wallet = res?.data?.wallets?.[0];
        if (!wallet) throw new Error(`Circle returned no wallet for ${def.key}`);
        summary.created.push(def.key);
      }
      upsertEnv(envFile, def.envId, wallet.id); // persist immediately so a later failure cannot cause a duplicate
      env[def.envId] = wallet.id;
    }
    if (wallet.blockchain && wallet.blockchain !== CHAIN_NAME) throw new Error(`${def.key} wallet is on ${wallet.blockchain}, expected ${CHAIN_NAME}`);
    if (wallet.accountType && wallet.accountType !== 'EOA') throw new Error(`${def.key} wallet is ${wallet.accountType}, expected EOA`);
    assertNotOperator(wallet.address, env);
    summary.addresses[def.key] = wallet.address;
    const i = records.findIndex((r) => r.key === def.key);
    const next = { ...publicFields(def), address: wallet.address };
    if (i >= 0) records[i] = next;
    else records.push(next);
  }
  writeAgentsFile(AGENT_DEFS.map((d) => records.find((r) => r.key === d.key)), agentsFile);
  say(`wrote ${AGENT_DEFS.length} addresses to agents/agents.json`);
  say(`created: ${summary.created.join(', ') || 'none'}; reused: ${summary.reused.join(', ') || 'none'}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await runSetup({ client: createCircleClient() });
    for (const [k, a] of Object.entries(summary.addresses)) console.log(`  ${k}: ${a}`);
    console.log('\nWallets are unfunded. Fund them with: npm run agents:fund (shows the plan and asks first).');
  } catch (err) {
    console.error(`agents:setup failed: ${err.message}`);
    process.exit(1);
  }
}
