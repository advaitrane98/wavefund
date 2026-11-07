// Local-key backend. Only for tests and offline rehearsal: it is enabled solely by explicit config and refuses the
// deployer and keeper keys.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc, publicClient, RPC_URL, gasPolicy } from '../../../scripts/demo-round-common.mjs';

export function localKeysEnabled(env = process.env) {
  return env.AGENTS_SIGNER === 'local' && env.AGENTS_ALLOW_LOCAL_KEYS === 'yes';
}

export function createLocalSigner({ agent, env = process.env, forbidden = [] }) {
  if (!localKeysEnabled(env)) {
    throw new Error('Local-key signing is off. Set AGENTS_SIGNER=local and AGENTS_ALLOW_LOCAL_KEYS=yes to enable it explicitly.');
  }
  const varName = `AGENT_${agent.key.toUpperCase()}_PK`;
  const pk = env[varName];
  if (!pk) throw new Error(`${varName} is not set (needed for the local-key backend)`);
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  if (forbidden.map((a) => a.toLowerCase()).includes(account.address.toLowerCase())) {
    throw new Error(`${varName} is the deployer or keeper key. Agents must never use those.`);
  }
  const wallet = createWalletClient({ account, chain: arc, transport: http(RPC_URL) });
  return {
    kind: 'local',
    address: account.address,
    async estimateFee() {
      return { attempts: 1, gasLimit: null, networkFeeWei: null };
    },
    async execute({ to, abi, functionName, args }) {
      const fees = await gasPolicy();
      const { request } = await publicClient.simulateContract({ account, address: to, abi, functionName, args, ...fees });
      const hash = await wallet.writeContract(request);
      return { id: hash, hash };
    },
  };
}
