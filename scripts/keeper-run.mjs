// npm run keeper:run [-- --open-every <minutes> --max-rounds 2 --preset judge|full --poll 2]
// Single-instance keeper: collapses at tradingEnd, runs the vault trade IMMEDIATELY after (fresh oracle first),
// reports and settles at evaluationEnd, treats "already done" reverts as success. Stops only on a confirmed
// on-chain revert or 5 identical failures. With --open-every it opens the next round after settlement (only if the
// reserve covers 4 markets). The oracle watcher runs while a round is open. Ctrl+C stops cleanly.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_DIR, cliArgs, log, sleep } from './demo-round-common.mjs';
import { startOracleWatcher } from './lib/oracle.mjs';
import { STATUS, nextStep, openStatusQuoRound, reserveCoversMarkets, resolveTiming, snapshot, usdc } from './lib/round-actions.mjs';

export async function runKeeper(argv = process.argv.slice(2), deps = {}) {
  const { next = nextStep, readSnapshot = snapshot, openRound = openStatusQuoRound, reserve = reserveCoversMarkets, watch = startOracleWatcher, pause = sleep, writeLog = log, runDir = RUN_DIR } = deps;
  const args = cliArgs({
    'open-every': { type: 'string' },
    'max-rounds': { type: 'string' },
    preset: { type: 'string', default: 'full' },
    'trading-minutes': { type: 'string' },
    'evaluation-seconds': { type: 'string' },
    'twap-seconds': { type: 'string' },
    poll: { type: 'string', default: '2' },
  }, argv);
  const pollMs = Math.max(1, Number(args.poll)) * 1000;
  const openEveryMin = args['open-every'] ? Number(args['open-every']) : null;
  if (args['open-every'] && (!Number.isFinite(openEveryMin) || openEveryMin <= 0)) throw new Error('--open-every must be positive minutes');
  const maxRounds = args['max-rounds'] == null ? Infinity : Number(args['max-rounds']);
  if (args['max-rounds'] != null && (!(maxRounds > 0) || !Number.isSafeInteger(maxRounds))) throw new Error('--max-rounds must be a positive integer');
  if (args['max-rounds'] && !openEveryMin) throw new Error('--max-rounds requires --open-every');
  let roundsOpened = 0;
  const timing = openEveryMin
    ? resolveTiming({ preset: args.preset, trading: args['trading-minutes'], evaluation: args['evaluation-seconds'], twap: args['twap-seconds'] })
    : null;

  const lock = path.join(runDir, 'keeper.lock');
  fs.mkdirSync(runDir, { recursive: true });
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (err) { if (err.code === 'EPERM') alive = true; }
    if (alive) throw new Error(`another keeper is running (pid ${pid}). Stop it first.`);
    fs.rmSync(lock); // stale lock
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });

  let stopping = false;
  let stopWatcher;
  try { stopWatcher = watch(); } catch (err) { fs.rmSync(lock); throw err; }
  const cleanup = async () => {
    stopping = true;
    await stopWatcher();
    if (fs.existsSync(lock) && Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock);
  };
  const requestStop = () => { stopping = true; };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  writeLog(`keeper started${openEveryMin ? `, opening a new round every ${openEveryMin} min after settlement` : ''}`);
  let lastFailure = '';
  let failureCount = 0;
  let lastKey = '';
  let exitCode = 0;

  try {
    while (!stopping) {
      try {
        const r = await next();
        failureCount = 0;
        lastFailure = '';
        const key = `${r.action}:${r.round}:${r.status ?? ''}`;
        if (key !== lastKey) {
          lastKey = key;
          writeLog(r.action === 'wait' ? r.why : r.action === 'idle' ? `idle (round ${r.round ?? '-'} ${r.status})` : `done: ${r.action} (round ${r.round})`);
        }
        if (r.action === 'idle' && roundsOpened >= maxRounds) {
          writeLog(`completed ${roundsOpened} opened rounds; stopping before another opens`);
          break;
        }
        if (r.action === 'idle' && openEveryMin && !stopping) {
          const s = await readSnapshot();
          const due = !s || s.now >= s.tradingStart + openEveryMin * 60;
          if (due) {
            const cover = await reserve();
            if (!cover.ok) {
              writeLog(`reserve ${usdc(cover.reserve)} USDC cannot fund 4 markets (${usdc(cover.need)}), not opening`);
            } else {
              writeLog('opening the next round');
              try {
                await openRound({ timing, skipPreflight: false });
                roundsOpened++;
              } catch (err) {
                if (!/^preflight failed/.test(err.message)) throw err;
                writeLog('NOT READY to open (see the failed checks above). Fix it, for example npm run pool:recenter. Retrying in 30 s.');
                await pause(30_000);
              }
            }
          }
        }
        await pause(r.action === 'wait' ? Math.min(Math.max(r.wait, 1) * 1000, pollMs) : r.action === 'idle' ? Math.max(pollMs, 5000) : 500);
      } catch (err) {
        if (err.confirmed) {
          writeLog(`STOP: confirmed on-chain revert: ${err.message}`);
          exitCode = 2;
          break;
        }
        const msg = err.decoded?.text || err.message;
        failureCount = msg === lastFailure ? failureCount + 1 : 1;
        lastFailure = msg;
        writeLog(`step failed (${failureCount}/5): ${msg}`);
        if (failureCount >= 5) {
          writeLog('STOP: 5 identical failures in a row');
          exitCode = 3;
          break;
        }
        await pause(pollMs);
      }
    }
  } finally {
    await cleanup();
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    writeLog('keeper stopped');
  }
  return exitCode;

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKeeper().then(code => { process.exitCode = code; }).catch(err => { console.error(`keeper:run failed: ${err.message}`); process.exitCode = 1; });
}
