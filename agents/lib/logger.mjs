// JSONL logging: one file per UTC day, one line per decision or transaction. Everything passes through redact().
import fs from 'node:fs';
import path from 'node:path';
import { redact, secretValuesFromEnv } from './redact.mjs';

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createLogger({ dir, now = () => Date.now(), echo = true, secrets, env = process.env } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const secretList = () => secrets ?? secretValuesFromEnv(env);
  function write(kind, fields = {}) {
    const ts = now();
    const line = { ts: new Date(ts).toISOString(), kind, ...fields };
    const clean = redact(line, secretList());
    fs.appendFileSync(path.join(dir, `${utcDay(ts)}.jsonl`), `${JSON.stringify(clean)}\n`);
    if (echo) {
      const brief = [clean.agent, clean.action ?? clean.status ?? clean.message].filter(Boolean).join(' ');
      console.log(`[${clean.ts.slice(11, 19)}] ${kind}${brief ? ` ${brief}` : ''}`);
    }
    return clean;
  }
  return {
    /** A decision: what the agent saw (inputs), why (reasoning) and what it chose (action). */
    decision: (agent, { inputs, reasoning, action, ...rest }) => write('decision', { agent, inputs, reasoning, action, ...rest }),
    /** A transaction lifecycle event: planned, simulated, broadcast, confirmed, failed, released. */
    tx: (agent, fields) => write('tx', { agent, ...fields }),
    info: (message, fields = {}) => write('info', { message, ...fields }),
    warn: (message, fields = {}) => write('warn', { message, ...fields }),
    error: (message, fields = {}) => write('error', { message, ...fields }),
    file: () => path.join(dir, `${utcDay(now())}.jsonl`),
  };
}
