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

const empty = () => ({ version: 1, entries: {}, trades: {}, fired: {}, tradeReservations: {}, tracked: {} });

export class SpendLedger {
  constructor({ file, caps, now = () => Date.now() }) {
    this.file = file;
    this.caps = caps;
    this.now = now;
    this.state = empty();
    // Dry-run bookkeeping lives only here: it makes caps cumulative inside one dry-run and is NEVER written to disk.
    this.dry = new Map(); // trade key -> credits "spent" in a dry-run
    this.dryReservations = new Map(); // id -> { key, credits }
    this.dryTracked = new Map(); // agent -> Set(roundId)
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

  markGasAmbiguous(id) {
    const e = this.state.entries[id];
    if (e) { e.ambiguous = true; this.save(); }
  }

  pendingGas(agent) {
    return Object.values(this.state.entries).filter((e) => e.agent === agent && e.state === 'pending');
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
        if (e.ambiguous) { out.stillPending++; continue; }
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

  /** Credits counted against the per-proposal cap: confirmed + pending + ambiguous (durable) plus this dry-run's plans. */
  spentOnProposal(agent, roundId, proposalId) {
    const k = this.tradeKey(agent, roundId, proposalId);
    return BigInt(this.state.trades[k] ?? '0') + (this.dry.get(k) ?? 0n);
  }

  /** Credits that may still be spent in ONE trade right now: min(per-trade cap, room left on the proposal). Never negative. */
  tradeRoom(agent, roundId, proposalId) {
    const room = MAX_PROPOSAL_CREDITS - this.spentOnProposal(agent, roundId, proposalId);
    if (room <= 0n) return 0n;
    return room > MAX_TRADE_CREDITS ? MAX_TRADE_CREDITS : room;
  }

  /** Returns the credits that may be spent (<= wanted), or throws if nothing may be. */
  allowTrade(agent, roundId, proposalId, wanted) {
    if (wanted <= 0n) throw new CapError('trade size must be positive');
    const room = this.tradeRoom(agent, roundId, proposalId);
    if (room <= 0n) throw new CapError(`per-proposal cap reached for ${agent} on proposal ${proposalId}`);
    return wanted > room ? room : wanted;
  }

  recordTrade(agent, roundId, proposalId, credits) {
    const k = this.tradeKey(agent, roundId, proposalId);
    this.state.trades[k] = (BigInt(this.state.trades[k] ?? '0') + credits).toString();
    this.save();
  }

  /**
   * Write-ahead trade budget. The credits are counted as spent BEFORE anything is broadcast, so a crash or an ambiguous
   * broadcast can never allow the same budget to be spent twice after a restart. `persist: false` (dry-run) keeps the
   * reservation in memory only: it makes the caps cumulative inside the dry-run and leaves no durable mark.
   * Returns { id, credits } with credits clipped to the room left, or throws CapError.
   */
  reserveTrade(agent, roundId, proposalId, wanted, { persist = true } = {}) {
    const credits = this.allowTrade(agent, roundId, proposalId, wanted);
    const k = this.tradeKey(agent, roundId, proposalId);
    const id = randomUUID();
    if (persist) {
      this.state.trades[k] = (BigInt(this.state.trades[k] ?? '0') + credits).toString();
      this.state.tradeReservations[id] = { id, key: k, credits: credits.toString(), state: 'pending', at: this.now() };
      this.save();
    } else {
      this.dry.set(k, (this.dry.get(k) ?? 0n) + credits);
      this.dryReservations.set(id, { key: k, credits });
    }
    return { id, credits, persist };
  }

  /** The trade is on chain: the reservation stays counted. */
  confirmTrade(res) {
    if (!res.persist) return;
    const r = this.state.tradeReservations[res.id];
    if (r && r.state === 'pending') { r.state = 'confirmed'; this.save(); }
  }

  /** The trade may or may not have been broadcast: the reservation stays counted for good (no duplicate spend). */
  markTradeAmbiguous(res, reason) {
    if (!res.persist) return;
    const r = this.state.tradeReservations[res.id];
    if (r && r.state === 'pending') { r.state = 'ambiguous'; r.reason = reason; this.save(); }
  }

  /** The trade was certainly never broadcast (or reverted on chain): give the budget back. */
  releaseTrade(res, reason) {
    if (!res.persist) {
      const d = this.dryReservations.get(res.id);
      if (d) { this.dry.set(d.key, (this.dry.get(d.key) ?? 0n) - d.credits); this.dryReservations.delete(res.id); }
      return;
    }
    const r = this.state.tradeReservations[res.id];
    if (!r || r.state !== 'pending') return;
    r.state = 'released';
    r.reason = reason;
    this.state.trades[r.key] = (BigInt(this.state.trades[r.key]) - BigInt(r.credits)).toString();
    this.save();
  }

  /** Reservations that survived a restart without a verdict. They stay counted; this is for logging. */
  unresolvedTradeReservations() {
    return Object.values(this.state.tradeReservations).filter((r) => r.state === 'pending' || r.state === 'ambiguous');
  }

  // ---- rounds an agent deposited into (so redemption still finds them after newer rounds open)
  trackRound(agent, roundId, { persist = true } = {}) {
    if (!persist) {
      if (!this.dryTracked.has(agent)) this.dryTracked.set(agent, new Set());
      this.dryTracked.get(agent).add(String(roundId));
      return;
    }
    const list = new Set(this.state.tracked[agent] ?? []);
    list.add(String(roundId));
    this.state.tracked[agent] = [...list];
    this.save();
  }

  untrackRound(agent, roundId, { persist = true } = {}) {
    if (!persist) { this.dryTracked.get(agent)?.delete(String(roundId)); return; }
    this.state.tracked[agent] = (this.state.tracked[agent] ?? []).filter((r) => r !== String(roundId));
    this.save();
  }

  trackedRounds(agent) {
    return [...new Set([...(this.state.tracked[agent] ?? []), ...(this.dryTracked.get(agent) ?? [])])];
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
