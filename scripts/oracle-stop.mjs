// npm run oracle:stop
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DIR } from './demo-round-common.mjs';

const pidFile = path.join(RUN_DIR, 'oracle-watcher.pid');
if (!fs.existsSync(pidFile)) {
  console.log('oracle watcher is not running');
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidFile, 'utf8'));
try {
  process.kill(pid, 'SIGTERM');
  console.log(`stopped oracle watcher (pid ${pid})`);
} catch {
  console.log(`no process ${pid}; removing stale pid file`);
}
fs.rmSync(pidFile, { force: true });
