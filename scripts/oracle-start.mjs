// npm run oracle:start   Starts the background watcher (updates every 60 s while a round is open).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUN_DIR } from './demo-round-common.mjs';

const pidFile = path.join(RUN_DIR, 'oracle-watcher.pid');
fs.mkdirSync(RUN_DIR, { recursive: true });
if (fs.existsSync(pidFile)) {
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    console.log(`oracle watcher already running (pid ${pid})`);
    process.exit(0);
  } catch {
    fs.rmSync(pidFile);
  }
}
const log = fs.openSync(path.join(RUN_DIR, 'oracle-watcher.log'), 'a');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', path.join(path.dirname(fileURLToPath(import.meta.url)), 'oracle-watch.mjs')], {
  detached: true,
  stdio: ['ignore', log, log],
});
child.unref();
fs.writeFileSync(pidFile, String(child.pid));
console.log(`oracle watcher started (pid ${child.pid}), log: .run/oracle-watcher.log`);
