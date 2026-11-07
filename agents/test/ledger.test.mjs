import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseUnits } from 'viem';
import { MAX_PROPOSAL_CREDITS, MAX_TRADE_CREDITS, gasCaps } from '../lib/config.mjs';
import { CapError, SpendLedger } from '../lib/ledger.mjs';
import { clock, tmpDir } from './helpers.mjs';

const usdc18 = (s) => parseUnits(s, 18);
const make = (preset = 'full', c = clock(), dir = tmpDir()) => ({ c, dir, file: `${dir}/ledger.json`, ledger: new SpendLedger({ file: `${dir}/ledger.json`, caps: gasCaps(preset), now: c.now }) });

test('caps: 0.25 USDC per round, 1.0 per UTC day, 3.0 per day with the judge preset', () => {
  assert.equal(gasCaps('full').perRoundWei, usdc18('0.25'));
  assert.equal(gasCaps('full').perDayWei, usdc18('1.0'));
  assert.equal(gasCaps('judge').perDayWei, usdc18('3.0'));
});

test('a reservation counts while pending; the round cap blocks the next one', () => {
  const { ledger } = make();
  ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.2') });
  assert.throws(() => ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.1') }), CapError);
  ledger.reserve({ agent: 'quant', roundId: 2, estimateWei: usdc18('0.2') }); // different round, still within the day
  ledger.reserve({ agent: 'guardian', roundId: 1, estimateWei: usdc18('0.2') }); // caps are per agent
});

test('confirmation replaces the estimate with actual gas', () => {
  const { ledger } = make();
  const id = ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.2') });
  ledger.commit(id, usdc18('0.01'));
  assert.equal(ledger.usage('quant', 1).round, usdc18('0.01'));
  ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.2') }); // freed room is usable again
});

test('release frees a reservation that never reached the chain', () => {
  const { ledger } = make();
  const id = ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.25') });
  assert.throws(() => ledger.assertFits('quant', 1, 1n), CapError);
  ledger.release(id, 'never broadcast');
  assert.equal(ledger.usage('quant', 1).round, 0n);
  ledger.assertFits('quant', 1, usdc18('0.25'));
});

test('daily cap: 1.0 USDC across rounds, resets at the next UTC day', () => {
  const { ledger, c } = make();
  for (let round = 1; round <= 4; round++) ledger.commit(ledger.reserve({ agent: 'news', roundId: round, estimateWei: usdc18('0.25') }), usdc18('0.25'));
  assert.throws(() => ledger.reserve({ agent: 'news', roundId: 5, estimateWei: usdc18('0.01') }), /per UTC day/);
  c.advance(13 * 3600); // 12:00 UTC -> 01:00 next day
  ledger.reserve({ agent: 'news', roundId: 5, estimateWei: usdc18('0.01') });
});

test('judge preset allows 3.0 USDC per day', () => {
  const { ledger } = make('judge');
  for (let round = 1; round <= 12; round++) ledger.commit(ledger.reserve({ agent: 'news', roundId: round, estimateWei: usdc18('0.25') }), usdc18('0.25'));
  assert.throws(() => ledger.reserve({ agent: 'news', roundId: 13, estimateWei: usdc18('0.01') }), /per UTC day/);
});

test('state survives a restart; recover() releases never-broadcast reservations and settles broadcast ones', async () => {
  const { ledger, file, c } = make();
  const lost = ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.1') });
  const sent = ledger.reserve({ agent: 'quant', roundId: 1, estimateWei: usdc18('0.1') });
  ledger.broadcast(sent, '0xabc');
  const again = new SpendLedger({ file, caps: gasCaps('full'), now: c.now });
  const out = await again.recover(async (hash) => (hash === '0xabc' ? usdc18('0.004') : null));
  assert.deepEqual(out, { released: 1, committed: 1, stillPending: 0 });
  assert.equal(again.state.entries[lost].state, 'released');
  assert.equal(again.usage('quant', 1).round, usdc18('0.004'));
});

test('a corrupt ledger refuses to load instead of resetting the caps', () => {
  const { dir, file } = make();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new SpendLedger({ file, caps: gasCaps('full') }), /unreadable/);
  assert.ok(dir);
});

test('trade caps: per trade and per proposal', () => {
  const { ledger } = make();
  assert.equal(ledger.allowTrade('quant', 1, 1, 5_000_000n), MAX_TRADE_CREDITS);
  ledger.recordTrade('quant', 1, 1, MAX_TRADE_CREDITS);
  assert.equal(ledger.allowTrade('quant', 1, 1, 100_000n), 100_000n);
  ledger.recordTrade('quant', 1, 1, MAX_TRADE_CREDITS);
  assert.equal(ledger.spentOnProposal('quant', 1, 1), MAX_PROPOSAL_CREDITS);
  assert.throws(() => ledger.allowTrade('quant', 1, 1, 1n), /per-proposal cap/);
  assert.equal(ledger.allowTrade('quant', 1, 2, 1n), 1n); // another proposal has its own room
  assert.equal(ledger.allowTrade('guardian', 1, 1, 1n), 1n); // another agent too
});

test('fired marks persist so a restart does not repeat an action', () => {
  const { ledger, file, c } = make();
  ledger.markFired('1|momentum|propose');
  const again = new SpendLedger({ file, caps: gasCaps('full'), now: c.now });
  assert.ok(again.hasFired('1|momentum|propose'));
  assert.ok(!again.hasFired('1|news|propose'));
});
