import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmpDir = (prefix = 'agents-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const noSleep = async () => {};
export const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A fake clock the tests can move. */
export function clock(startMs = Date.UTC(2026, 10, 6, 12, 0, 0)) {
  const c = { ms: startMs, now: () => c.ms, advance: (s) => { c.ms += s * 1000; } };
  return c;
}

export const timing = (start = 1_000, trading = 1_200, twap = 300, evaluation = 600) => ({
  tradingStart: start, tradingEnd: start + trading, twapWindow: twap, evaluationEnd: start + trading + evaluation,
});
