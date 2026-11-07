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

// agents/agents.json is shared with the frontend: { chainId, agents: [{ id, name, type, description, address, wallet }] }.
// Internally the runtime uses `key` (underscores) where the file uses `id` (hyphens), e.g. mean_reversion / mean-reversion.
export const idOf = (key) => key.replace(/_/g, '-');
export const keyOf = (id) => String(id).replace(/-/g, '_');
export const WALLET_KIND = 'circle-developer-controlled';

export function readAgentsFile(file = AGENTS_FILE) {
  if (!fs.existsSync(file)) return AGENT_DEFS.map((d) => ({ ...publicFields(d), address: null }));
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(json) ? json : json.agents ?? [];
  return list.map((a) => ({ key: a.key ?? keyOf(a.id), name: a.name, type: a.type, description: a.description, address: a.address ?? null }));
}

export function writeAgentsFile(records, file = AGENTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const agents = records.map((r) => ({ id: idOf(r.key), name: r.name, type: r.type, description: r.description, address: r.address, wallet: WALLET_KIND }));
  fs.writeFileSync(file, `${JSON.stringify({ chainId: 5042002, agents }, null, 2)}\n`);
}

/** Joins the static definitions with the addresses in agents.json. */
export function loadAgents({ file = AGENTS_FILE, only } = {}) {
  const records = readAgentsFile(file);
  return AGENT_DEFS.filter((d) => !only || only.includes(d.key)).map((def) => ({
    def,
    record: records.find((r) => r.key === def.key) ?? { ...publicFields(def), address: null },
  }));
}
