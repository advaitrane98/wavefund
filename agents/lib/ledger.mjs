// Spending ledger: gas caps (per agent per round and per UTC day) and trade caps (per trade, per proposal).
// Gas is RESERVED (estimate) while a transaction is pending, REPLACED with the actual gas on confirmation, and
// RELEASED if it never reaches the chain. Persisted to a JSON file with atomic writes. Single-instance lock
// guarantees only one process writes it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_PROPOSAL_CREDITS, MAX_TRADE_CREDITS } from './config.mjs';
import { utcDay } from './logger.mjs';

export class CapError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CapError';
    this.detail = detail;
  }
}

const empty = () => ({ version: 1, entries: {}, trades: {}, fired: {} });

export class SpendLedger {
  constructor({ file, caps, now = () => Date.now() }) {
    this.file = file;
    this.caps = caps;
    this.now = now;
    this.state = empty();
    if (fs.existsSync(file)) {
      try {
        this.state = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        // A corrupt ledger must never silently reset the caps.
        throw new Error(`Spend ledger ${file} is unreadable. Fix or move it before running (caps would reset).`);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  day() {
    return utcDay(this.now());
  }

  /** Gas counted against the caps: pending reservations plus confirmed actuals. Released entries cost nothing. */
  usage(agent, roundId) {
    const today = this.day();
    let round = 0n;
    let day = 0n;
    for (const e of Object.values(this.state.entries)) {
      if (e.agent !== agent || e.state === 'released') continue;
      const wei = BigInt(e.amountWei);
      if (e.day === today) day += wei;
      if (roundId != null && String(e.roundId) === String(roundId)) round += wei;
    }
    return { round, day };
  }

  /** Throws CapError if `estimateWei` would break a cap. Does not write anything. */
  assertFits(agent, roundId, estimateWei) {
    const u = this.usage(agent, roundId);
    if (u.round + estimateWei > this.caps.perRoundWei) {
      throw new CapError(`gas cap per round reached for ${agent}`, { used: u.round, estimate: estimateWei, cap: this.caps.perRoundWei });
    }
    if (u.day + estimateWei > this.caps.perDayWei) {
      throw new CapError(`gas cap per UTC day reached for ${agent}`, { used: u.day, estimate: estimateWei, cap: this.caps.perDayWei });
    }
    return u;
  }

  reserve({ agent, roundId, estimateWei, label }) {
    this.assertFits(agent, roundId, estimateWei);
    const id = randomUUID();
    this.state.entries[id] = {
      id, agent, roundId: String(roundId ?? ''), day: this.day(), state: 'pending',
      amountWei: estimateWei.toString(), estimateWei: estimateWei.toString(), label, createdAt: this.now(),
    };
    this.save();
    return id;
  }

  broadcast(id, txHash) {
    const e = this.state.entries[id];
    if (!e) return;
    e.txHash = txHash;
    this.save();
  }

  commit(id, actualWei) {
    const e = this.state.entries[id];
    if (!e) return;
    e.state = 'confirmed';
    e.amountWei = actualWei.toString();
    this.save();
  }

  release(id, reason) {
    const e = this.state.entries[id];
    if (!e || e.state !== 'pending') return;
    e.state = 'released';
    e.releasedReason = reason;
    this.save();
  }

  /**
   * Startup recovery after a crash. Pending entries that never got a hash are released; ones with a hash are
   * settled from their receipt (`lookup(hash)` returns the actual wei, or null if not mined yet).
   */
  async recover(lookup) {
    const out = { released: 0, committed: 0, stillPending: 0 };
    for (const e of Object.values(this.state.entries)) {
      if (e.state !== 'pending') continue;
      if (!e.txHash) {
        this.release(e.id, 'never broadcast (process stopped)');
        out.released++;
        continue;
      }
      const actual = await lookup(e.txHash).catch(() => null);
      if (actual != null) {
        this.commit(e.id, actual);
        out.committed++;
      } else out.stillPending++;
    }
    return out;
  }

  // ---- trade caps (credits, 6 decimals)
  tradeKey(agent, roundId, proposalId) {
    return `${agent}|${roundId}|${proposalId}`;
  }

  spentOnProposal(agent, roundId, proposalId) {
    return BigInt(this.state.trades[this.tradeKey(agent, roundId, proposalId)] ?? '0');
  }

  /** Returns the credits that may be spent (<= wanted), or throws if nothing may be. */
  allowTrade(agent, roundId, proposalId, wanted) {
    if (wanted <= 0n) throw new CapError('trade size must be positive');
    const perTrade = wanted > MAX_TRADE_CREDITS ? MAX_TRADE_CREDITS : wanted;
    const room = MAX_PROPOSAL_CREDITS - this.spentOnProposal(agent, roundId, proposalId);
    if (room <= 0n) throw new CapError(`per-proposal cap reached for ${agent} on proposal ${proposalId}`);
    return perTrade > room ? room : perTrade;
  }

  recordTrade(agent, roundId, proposalId, credits) {
    const k = this.tradeKey(agent, roundId, proposalId);
    this.state.trades[k] = (this.spentOnProposal(agent, roundId, proposalId) + credits).toString();
    this.save();
  }

  // ---- idempotent scheduling marks (survive restarts)
  hasFired(key) {
    return Boolean(this.state.fired[key]);
  }

  markFired(key) {
    this.state.fired[key] = this.now();
    this.save();
  }
}
