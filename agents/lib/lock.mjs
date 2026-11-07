// Single-instance lock: a pid file. A lock whose process is gone is taken over.
import fs from 'node:fs';
import path from 'node:path';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

export function acquireLock(file, { pid = process.pid, isAlive = alive } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const other = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(other) && other > 0 && other !== pid && isAlive(other)) {
      throw new Error(`Another agents process is running (pid ${other}). Stop it first, or delete ${file} if you are sure it is gone.`);
    }
  }
  fs.writeFileSync(file, String(pid));
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}
