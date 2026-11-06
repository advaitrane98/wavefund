// Foreground watcher process spawned by oracle:start (also usable directly). Ctrl+C / SIGTERM stops it cleanly.
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR, log } from './demo-round-common.mjs';
import { startOracleWatcher } from './lib/oracle.mjs';

const pidFile = path.join(RUN_DIR, 'oracle-watcher.pid');
const stop = startOracleWatcher();
log('oracle watcher running (60 s while a round is open)');
const shutdown = async () => {
  await stop();
  if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.rmSync(pidFile);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
