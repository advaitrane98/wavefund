// Reads forge broadcast files (contracts/broadcast/<Script>.s.sol/<chainId>/run-latest.json).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../demo-round-common.mjs';

export function readBroadcast(script, chainId = 5042002) {
  const file = path.join(ROOT, 'contracts', 'broadcast', `${script}.s.sol`, String(chainId), 'run-latest.json');
  if (!fs.existsSync(file)) return null;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const receipts = new Map((json.receipts ?? []).map((r) => [r.transactionHash.toLowerCase(), r]));
  return (json.transactions ?? []).map((t) => {
    const r = receipts.get(String(t.hash).toLowerCase());
    return {
      script,
      hash: t.hash,
      contractName: t.contractName ?? null,
      contractAddress: t.contractAddress ?? null,
      function: t.function ?? null,
      arguments: t.arguments ?? null,
      block: r ? Number(BigInt(r.blockNumber)) : null,
      gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
    };
  });
}

export function allBroadcasts() {
  return ['Deploy', 'DeployWaveHook', 'DeployPoolHelper', 'Wire'].flatMap((s) => readBroadcast(s) ?? []);
}
