// Small file helpers: .env upserts (values are never printed) and agents.json read/write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../../scripts/demo-round-common.mjs';
import { AGENT_DEFS, publicFields } from './config.mjs';

export const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENTS_FILE = path.join(AGENTS_DIR, 'agents.json');
export const ENV_FILE = path.join(ROOT, '.env');
export const AGENTS_RUN_DIR = path.join(ROOT, '.run', 'agents');

/** Sets KEY=value in an env file: replaces an existing (even empty) line, otherwise appends. Returns what it did. */
export function upsertEnv(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) {
    const current = text.match(re)[0].slice(key.length + 1).trim();
    if (current === String(value)) return 'unchanged';
    fs.writeFileSync(file, text.replace(re, () => `${key}=${value}`));
    return 'updated';
  }
  fs.appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`);
  return 'added';
}

export function readAgentsFile(file = AGENTS_FILE) {
  if (!fs.existsSync(file)) return AGENT_DEFS.map((d) => ({ ...publicFields(d), address: null }));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeAgentsFile(records, file = AGENTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
}

/** Joins the static definitions with the addresses in agents.json. */
export function loadAgents({ file = AGENTS_FILE, only } = {}) {
  const records = readAgentsFile(file);
  return AGENT_DEFS.filter((d) => !only || only.includes(d.key)).map((def) => ({
    def,
    record: records.find((r) => r.key === def.key) ?? { ...publicFields(def), address: null },
  }));
}
