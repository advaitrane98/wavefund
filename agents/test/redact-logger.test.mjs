import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createLogger } from '../lib/logger.mjs';
import { REDACTED, redact, secretValuesFromEnv } from '../lib/redact.mjs';
import { clock, readJsonl, tmpDir } from './helpers.mjs';

const KEY = 'TEST_API_KEY:abc123def456:0011223344556677';
const PK = `0x${'ab'.repeat(32)}`;
const env = { CIRCLE_API_KEY: KEY, CIRCLE_ENTITY_SECRET: 'e'.repeat(64), DEPLOYER_PK: PK, HARMLESS: 'hello-world-value' };

test('secretValuesFromEnv picks secret-looking variables only', () => {
  const v = secretValuesFromEnv(env);
  assert.ok(v.includes(KEY) && v.includes(PK) && v.includes('e'.repeat(64)));
  assert.ok(!v.includes('hello-world-value'));
});

test('redact blanks secret-named keys, known secret values and API-key shapes', () => {
  const out = redact({
    apiKey: 'x', entitySecret: 'y', privateKey: 'z', authorization: 'Bearer abc.def',
    note: `calling with ${KEY} and ${PK}`, nested: { ciphertext: 'q', ok: 'fine', pk: '1' },
    hash: `0x${'12'.repeat(32)}`, n: 5n,
  }, secretValuesFromEnv(env));
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.entitySecret, REDACTED);
  assert.equal(out.privateKey, REDACTED);
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.nested.ciphertext, REDACTED);
  assert.equal(out.nested.pk, REDACTED);
  assert.equal(out.nested.ok, 'fine');
  assert.ok(!out.note.includes(KEY) && !out.note.includes(PK));
  assert.equal(out.hash, `0x${'12'.repeat(32)}`, 'transaction hashes stay readable');
  assert.equal(out.n, '5');
});

test('redact scrubs Circle key shapes and bearer tokens even when not in the environment', () => {
  const out = redact({ msg: 'failed with LIVE_API_KEY:aaa:bbb and Bearer sk_live_123.abc' }, []);
  assert.ok(!out.msg.includes('LIVE_API_KEY:aaa:bbb') && !out.msg.includes('sk_live_123'));
});

test('logger writes one JSONL file per UTC day with redacted decisions and transactions', () => {
  const dir = tmpDir();
  const c = clock();
  const log = createLogger({ dir, now: c.now, echo: false, env });
  log.decision('momentum', { inputs: { price: 2000, apiKey: KEY, note: `key ${KEY}` }, reasoning: 'trend is up', action: 'propose' });
  log.tx('momentum', { status: 'broadcast', hash: `0x${'34'.repeat(32)}`, error: `boom ${PK}` });
  c.advance(24 * 3600);
  log.info('next day');
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['2026-11-06.jsonl', '2026-11-07.jsonl']);
  const day1 = readJsonl(`${dir}/2026-11-06.jsonl`);
  assert.equal(day1.length, 2);
  assert.equal(day1[0].kind, 'decision');
  assert.equal(day1[0].inputs.price, 2000);
  assert.equal(day1[0].reasoning, 'trend is up');
  assert.equal(day1[0].inputs.apiKey, REDACTED);
  const raw = fs.readFileSync(`${dir}/2026-11-06.jsonl`, 'utf8');
  assert.ok(!raw.includes(KEY) && !raw.includes(PK) && !raw.includes('e'.repeat(64)));
  assert.equal(day1[1].kind, 'tx');
  assert.match(day1[1].hash, /^0x3434/);
});
