// Picks the signer backend. Circle developer-controlled wallets are the default; local keys need explicit config.
// Agents never sign with the deployer or keeper keys: their addresses are rejected.
import { privateKeyToAddress } from 'viem/accounts';
import { createCircleClient, createCircleSigner } from './circle.mjs';
import { createLocalSigner, localKeysEnabled } from './local.mjs';

export function operatorAddresses(env = process.env) {
  const out = [];
  for (const name of ['DEPLOYER_PK', 'KEEPER_PK']) {
    const pk = env[name];
    if (pk) out.push(privateKeyToAddress(pk.startsWith('0x') ? pk : `0x${pk}`));
  }
  for (const name of ['DEPLOYER_ADDR', 'KEEPER_ADDR']) if (env[name]) out.push(env[name]);
  return out;
}

export function assertNotOperator(address, env = process.env) {
  if (operatorAddresses(env).some((a) => a.toLowerCase() === address.toLowerCase())) {
    throw new Error(`Agent address ${address} is the deployer or keeper address. Agents must use their own wallets.`);
  }
}

export function signerBackend(env = process.env) {
  return localKeysEnabled(env) ? 'local' : 'circle';
}

/** `agentRecord` is the agents.json entry (public address); the wallet ID comes from the environment. */
export function createSigner({ agentDef, agentRecord, env = process.env, client }) {
  const forbidden = operatorAddresses(env);
  if (signerBackend(env) === 'local') return createLocalSigner({ agent: agentDef, env, forbidden });
  const walletId = env[agentDef.envId];
  if (!walletId) throw new Error(`${agentDef.envId} is not set. Run: npm run agents:setup`);
  if (!agentRecord?.address) throw new Error(`No address for ${agentDef.key} in agents/agents.json. Run: npm run agents:setup`);
  assertNotOperator(agentRecord.address, env);
  return createCircleSigner({ client: client ?? createCircleClient(env), walletId, address: agentRecord.address });
}
