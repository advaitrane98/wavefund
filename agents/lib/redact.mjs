// Secret redaction for everything the agents log or print.
const SECRET_KEY = /(secret|api[_-]?key|private|mnemonic|password|passphrase|authorization|ciphertext|bearer|(^|[_-])pk$|^pk($|[_-])|token$)/i;
const CIRCLE_KEY = /\b(?:TEST|LIVE)_API_KEY:[A-Za-z0-9:_-]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
export const REDACTED = '[REDACTED]';

/** Environment variables whose VALUES must never appear in logs (matched as substrings). */
export function secretValuesFromEnv(env = process.env) {
  const names = Object.keys(env).filter((k) => /(_PK$|^PK$|SECRET|API_KEY|PRIVATE|PASSWORD|TOKEN|TEST_WALLET_PKS)/i.test(k));
  const out = new Set();
  for (const n of names) {
    const v = env[n];
    if (!v) continue;
    for (const part of String(v).split(',')) {
      const p = part.trim();
      if (p.length >= 8) out.add(p);
    }
  }
  return [...out];
}

export function redactString(s, secrets = []) {
  let out = String(s);
  for (const v of secrets) if (v && out.includes(v)) out = out.split(v).join(REDACTED);
  return out.replace(CIRCLE_KEY, REDACTED).replace(BEARER, `Bearer ${REDACTED}`);
}

/** Deep copy with secret-named keys blanked, known secret values and API-key shapes replaced, bigints as strings. */
export function redact(value, secrets = secretValuesFromEnv(), depth = 0) {
  if (depth > 12) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return redactString(value.message, secrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, secrets, depth + 1);
  return out;
}
