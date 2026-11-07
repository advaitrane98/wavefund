import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MAX_PROPOSAL_CREDITS, MAX_TRADE_CREDITS, gasCaps } from '../lib/config.mjs';
import { CapError, SpendLedger } from '../lib/ledger.mjs';
import { clock, tmpDir } from './helpers.mjs';

const make = () => {
  const dir = tmpDir();
  const file = `${dir}/l.json`;
  const c = clock();
  return { file, c, ledger: new SpendLedger({ file, caps: gasCaps('full'), now: c.now }), reopen: () => new SpendLedger({ file, caps: gasCaps('full'), now: c.now }) };
};

test('A3 caps: 1 credit per trade and 2 credits per proposal per round', () => {
  assert.equal(MAX_TRADE_CREDITS, 1_000_000n);
  assert.equal(MAX_PROPOSAL_CREDITS, 2_000_000n);
  const { ledger } = make();
  assert.equal(ledger.tradeRoom('quant', 1, 1), 1_000_000n);
  const a = ledger.reserveTrade('quant', 1, 1, 5_000_000n);
  assert.equal(a.credits, 1_000_000n, 'clipped to the per-trade cap');
  const b = ledger.reserveTrade('quant', 1, 1, 5_000_000n);
  assert.equal(b.credits, 1_000_000n);
  assert.equal(ledger.tradeRoom('quant', 1, 1), 0n);
  assert.throws(() => ledger.reserveTrade('quant', 1, 1, 1n), CapError);
  assert.equal(ledger.tradeRoom('quant', 1, 2), 1_000_000n, 'another proposal has its own room');
  assert.equal(ledger.tradeRoom('guardian', 1, 1), 1_000_000n, 'and so does another agent');
  assert.equal(ledger.tradeRoom('quant', 2, 1), 1_000_000n, 'and another round');
});

test('the budget is written ahead: a restart still counts a reservation that never got a verdict', () => {
  const { ledger, reopen, file } = make();
  const r = ledger.reserveTrade('quant', 1, 1, 700_000n);
  assert.ok(fs.readFileSync(file, 'utf8').includes('700000'));
  const again = reopen();
  assert.equal(again.spentOnProposal('quant', 1, 1), 700_000n);
  assert.equal(again.unresolvedTradeReservations().length, 1);
  assert.equal(again.tradeRoom('quant', 1, 1), 1_000_000n);
  again.reserveTrade('quant', 1, 1, 1_000_000n);
  assert.equal(again.tradeRoom('quant', 1, 1), 300_000n, 'duplicate spend after a restart is impossible');
  assert.ok(r.id);
});

test('release gives the budget back; ambiguous and confirmed reservations stay counted', () => {
  const { ledger, reopen } = make();
  const never = ledger.reserveTrade('quant', 1, 1, 400_000n);
  ledger.releaseTrade(never, 'never broadcast');
  assert.equal(ledger.spentOnProposal('quant', 1, 1), 0n);
  const unknown = ledger.reserveTrade('quant', 1, 1, 300_000n);
  ledger.markTradeAmbiguous(unknown, 'maybe broadcast');
  ledger.releaseTrade(unknown, 'ignored: only a pending reservation can be released');
  const ok = ledger.reserveTrade('quant', 1, 1, 200_000n);
  ledger.confirmTrade(ok);
  ledger.releaseTrade(ok, 'ignored');
  assert.equal(ledger.spentOnProposal('quant', 1, 1), 500_000n);
  assert.equal(reopen().spentOnProposal('quant', 1, 1), 500_000n);
});

test('dry-run reservations make the caps cumulative in memory and write nothing durable', () => {
  const { ledger, reopen, file } = make();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const a = ledger.reserveTrade('quant', 1, 1, 900_000n, { persist: false });
  const b = ledger.reserveTrade('quant', 1, 1, 900_000n, { persist: false });
  assert.equal(ledger.tradeRoom('quant', 1, 1), 200_000n, 'cumulative within the dry-run');
  ledger.trackRound('quant', 1, { persist: false });
  assert.deepEqual(ledger.trackedRounds('quant'), ['1']);
  ledger.releaseTrade(b, 'plan failed');
  assert.equal(ledger.tradeRoom('quant', 1, 1), 1_000_000n);
  assert.ok(a.id);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'nothing was written');
  const fresh = reopen();
  assert.equal(fresh.spentOnProposal('quant', 1, 1), 0n);
  assert.deepEqual(fresh.trackedRounds('quant'), []);
});

test('tracked rounds persist (execute) so redemption finds older rounds', () => {
  const { ledger, reopen } = make();
  ledger.trackRound('quant', 3);
  ledger.trackRound('quant', 3);
  ledger.trackRound('quant', 4);
  assert.deepEqual(reopen().trackedRounds('quant'), ['3', '4']);
  ledger.untrackRound('quant', 3);
  assert.deepEqual(reopen().trackedRounds('quant'), ['4']);
});
