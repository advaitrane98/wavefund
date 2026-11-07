// Redeems settled (or cancelled) rounds for one forecaster wallet.
//  - Rounds the wallet deposited into are TRACKED (durably in execute mode, in memory in dry-run), so an older round is still
//    redeemed after a newer round has opened.
//  - The first sweep after startup also looks at the most recent rounds, which covers a latest round that is already settled.
//  - Each round gets a bounded number of attempts; a dry-run plans a redeem once and leaves no durable mark.
import { FORECAST } from './config.mjs';
import { redeemSteps } from './actions.mjs';

const SETTLED = 3;
const CANCELLED = 4;
export const STARTUP_LOOKBACK = 5;

export function createRedeemer({ agent, address, reads, executor, ledger, logger, execute, mutex, cfg = FORECAST }) {
  const attempts = new Map();
  const planned = new Set(); // dry-run: already planned this process
  let first = true;

  async function sweep(currentRoundId) {
    const cur = currentRoundId == null ? 0 : Number(currentRoundId);
    const candidates = new Set(ledger.trackedRounds(agent.key).map(Number));
    if (first && cur > 0) for (let r = Math.max(1, cur - STARTUP_LOOKBACK + 1); r <= cur; r++) candidates.add(r);
    first = false;
    const out = [];
    for (const r of [...candidates].sort((a, b) => a - b)) {
      if (planned.has(r) || (attempts.get(r) ?? 0) >= cfg.maxActionAttempts) continue;
      const info = await reads.redeemInfo(BigInt(r), address);
      if (info.status !== SETTLED && info.status !== CANCELLED) continue; // still running: keep it tracked
      const owed = info.preview > 0n || (info.deposit > 0n && !info.redeemed);
      if (!owed) { ledger.untrackRound(agent.key, r, { persist: execute }); continue; }
      const result = await mutex.run(async () => {
        try {
          const [step] = redeemSteps({ roundId: r });
          const tx = await executor.run(step, { roundId: r });
          if (execute) ledger.untrackRound(agent.key, r);
          else planned.add(r);
          logger.decision(agent.key, {
            inputs: { round: String(r), status: info.status === SETTLED ? 'Settled' : 'Cancelled', previewUsdc: info.preview.toString(), deposit: info.deposit.toString() },
            action: execute ? 'redeem' : 'redeem (planned, dry-run)', reasoning: `round ${r} is finished and this wallet is owed ${info.preview} raw USDC`, hash: tx.hash,
          });
          return { round: r, status: execute ? 'redeemed' : 'planned', hash: tx.hash };
        } catch (err) {
          const n = attempts.get(r) ?? 0;
          attempts.set(r, n + 1);
          logger.error(`${agent.key}: redeem round ${r} failed (attempt ${n + 1}/${cfg.maxActionAttempts}): ${err.message}`);
          return { round: r, status: 'failed', error: err.message };
        }
      });
      out.push(result);
    }
    return out;
  }

  return { sweep };
}
