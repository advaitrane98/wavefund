// npm run keeper:run [-- --open-every <minutes> --preset judge|full --poll 2]
// Single-instance keeper: collapses at tradingEnd, runs the vault trade IMMEDIATELY after (fresh oracle first),
// reports and settles at evaluationEnd, treats "already done" reverts as success. Stops only on a confirmed
// on-chain revert or 5 identical failures. With --open-every it opens the next round after settlement (only if the
// reserve covers 4 markets). The oracle watcher runs while a round is open. Ctrl+C stops cleanly.
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR, cliArgs, log, sleep } from './demo-round-common.mjs';
import { startOracleWatcher } from './lib/oracle.mjs';
import { STATUS, nextStep, openStatusQuoRound, reserveCoversMarkets, resolveTiming, snapshot, usdc } from './lib/round-actions.mjs';

const args = cliArgs({
  'open-every': { type: 'string' },
  preset: { type: 'string', default: 'full' },
  'trading-minutes': { type: 'string' },
  'evaluation-seconds': { type: 'string' },
  'twap-seconds': { type: 'string' },
  poll: { type: 'string', default: '2' },
});
const pollMs = Math.max(1, Number(args.poll)) * 1000;
const openEveryMin = args['open-every'] ? Number(args['open-every']) : null;
const timing = openEveryMin
  ? resolveTiming({ preset: args.preset, trading: args['trading-minutes'], evaluation: args['evaluation-seconds'], twap: args['twap-seconds'] })
  : null;

const lock = path.join(RUN_DIR, 'keeper.lock');
fs.mkdirSync(RUN_DIR, { recursive: true });
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  try {
    process.kill(pid, 0);
    console.error(`another keeper is running (pid ${pid}). Stop it first.`);
    process.exit(1);
  } catch {
    fs.rmSync(lock); // stale lock
  }
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });

let stopping = false;
const stopWatcher = startOracleWatcher();
const cleanup = async () => {
  stopping = true;
  await stopWatcher();
  if (fs.existsSync(lock) && Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock);
};
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

log(`keeper started${openEveryMin ? `, opening a new round every ${openEveryMin} min after settlement` : ''}`);
let lastFailure = '';
let failureCount = 0;
let lastKey = '';
let exitCode = 0;

try {
  while (!stopping) {
    try {
      const r = await nextStep();
      failureCount = 0;
      lastFailure = '';
      const key = `${r.action}:${r.round}:${r.status ?? ''}`;
      if (key !== lastKey) {
        lastKey = key;
        log(r.action === 'wait' ? r.why : r.action === 'idle' ? `idle (round ${r.round ?? '-'} ${r.status})` : `done: ${r.action} (round ${r.round})`);
      }
      if (r.action === 'idle' && openEveryMin && !stopping) {
        const s = await snapshot();
        const due = !s || s.now >= s.tradingStart + openEveryMin * 60;
        if (due) {
          const cover = await reserveCoversMarkets();
          if (!cover.ok) {
            log(`reserve ${usdc(cover.reserve)} USDC cannot fund 4 markets (${usdc(cover.need)}), not opening`);
          } else {
            log('opening the next round');
            try {
              await openStatusQuoRound({ timing, skipPreflight: false });
            } catch (err) {
              if (!/^preflight failed/.test(err.message)) throw err;
              log('NOT READY to open (see the failed checks above). Fix it, for example npm run pool:recenter. Retrying in 30 s.');
              await sleep(30_000);
            }
          }
        }
      }
      await sleep(r.action === 'wait' ? Math.min(Math.max(r.wait, 1) * 1000, pollMs) : r.action === 'idle' ? Math.max(pollMs, 5000) : 500);
    } catch (err) {
      if (err.confirmed) {
        log(`STOP: confirmed on-chain revert: ${err.message}`);
        exitCode = 2;
        break;
      }
      const msg = err.decoded?.text || err.message;
      failureCount = msg === lastFailure ? failureCount + 1 : 1;
      lastFailure = msg;
      log(`step failed (${failureCount}/5): ${msg}`);
      if (failureCount >= 5) {
        log('STOP: 5 identical failures in a row');
        exitCode = 3;
        break;
      }
      await sleep(pollMs);
    }
  }
} finally {
  await cleanup();
  log('keeper stopped');
}
process.exit(exitCode);
