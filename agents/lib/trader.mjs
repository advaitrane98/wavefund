// One forecaster's trade executor, shared by Quant and Guardian: size the move with adapter quotes, reserve the credit
// budget write-ahead, run deposit/claim/trade through the executor, and keep dry-run bookkeeping in memory only.
//
// One wallet = one transaction chain at a time (mutex). Dry-run sends ZERO transactions, writes no durable spend,
// deposit or trade mark, but remembers what it "did" so deposits, claims and caps stay cumulative within the run.
import { FORECAST, FORECASTER_DEPOSIT, MAX_TRADE_CREDITS } from './config.mjs';
import { CapError } from './ledger.mjs';
import { PlanError, sellSteps, tradeSteps } from './actions.mjs';
import { stageFor } from './decide.mjs';
import { isTradingClosed } from './forecast-chain.mjs';
import { SCALE, SizingError, minOutFromQuote, sizeMove } from './sizing.mjs';
import { StepFailed } from './executor.mjs';

export function createMutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const next = tail.then(fn, fn);
      tail = next.then(() => {}, () => {});
      return next;
    },
    get busy() { return false; },
  };
}

const GAS_RESERVE_USDC = 250_000n; // keep the per-round gas allowance (0.25 USDC) outside the 2 USDC deposit

export function createTrader({ agent, signer, executor, ledger, logger, execute, reads, mutex = createMutex(), cfg = FORECAST }) {
  const virtual = { deposit: new Map(), claimed: new Map(), credits: new Map(), long: new Map(), short: new Map(), usdc: 0n };
  const key = (r, p) => `${r}:${p}`;
  const get = (m, k) => m.get(k) ?? 0n;
  const bump = (m, k, d) => m.set(k, get(m, k) + d);

  /** On-chain state plus (dry-run only) what earlier planned steps would already have done. */
  async function haveNow(roundId, proposalId) {
    const h = await reads.haveState(roundId, proposalId, signer.address);
    if (execute) return h;
    const k = key(roundId, proposalId);
    const dep = get(virtual.deposit, String(roundId));
    return {
      ...h,
      deposit: h.deposit + dep,
      claimed: h.claimed + get(virtual.claimed, k),
      credits: h.credits + get(virtual.credits, k),
      usdc: h.usdc - virtual.usdc,
      roundAllowance: dep > 0n ? 2n ** 255n : h.roundAllowance,
      position: { long: h.position.long + get(virtual.long, k), short: h.position.short + get(virtual.short, k) },
    };
  }

  const summary = (s) => s && ({
    size: s.size, reason: s.reason, reachable: s.reachable, capBound: s.capBound, depthBound: s.depthBound, rounds: s.rounds, quotes: s.quotes,
    spotX18: s.spotX18, targetX18: s.targetX18, estX18: s.estX18, residualX18: s.residualX18, phi: s.phi, bracket: s.bracket,
  });

  /**
   * intent = { roundId, proposalId, direction: 'raise'|'lower', targetX18, allowSell, stillValid(pLongX18) -> bool, why }
   * Resolves to { status, ... } and never throws for expected conditions (closed, stale, capped, no size).
   */
  async function act(intent) {
    return mutex.run(() => actLocked(intent));
  }

  async function actLocked(intent) {
    const { roundId, proposalId } = intent;
    const base = { agent: agent.key, roundId: String(roundId), proposalId, mode: execute ? 'execute' : 'dry-run' };
    const done = (status, extra = {}) => ({ ...base, status, ...extra });
    let reservation;
    try {
      if (execute && ledger.unresolvedTradeReservations().some((r) => r.key.startsWith(`${agent.key}|`))) {
        return done('pending', { reason: 'an earlier wallet operation has no verdict; reconcile it before retrying' });
      }
      if (intent.referenceValid && !intent.referenceValid()) return done('stale', { reason: 'fair-value reference expired or changed' });
      const fresh = await reads.roundFresh(roundId);
      if (!fresh.ok) return done(fresh.closed ? 'closed' : 'stale', { reason: fresh.reason });

      const have = await haveNow(roundId, proposalId);
      const stage = stageFor({ direction: intent.direction, position: have.position, allowSell: intent.allowSell });
      if (!stage) return done('skipped', { reason: 'no direction' });
      const { kind, side } = stage;
      const batch = reads.batchFor(roundId, proposalId);

      // ---- cap / room before sizing: the search never looks beyond what may actually be traded
      let xMax;
      if (kind === 'buy') {
        const depositAfter = have.deposit > 0n ? have.deposit : FORECASTER_DEPOSIT;
        const claimRoom = depositAfter > have.claimed ? depositAfter - have.claimed : 0n;
        const room = ledger.tradeRoom(agent.key, roundId, proposalId);
        xMax = [room, have.credits + claimRoom, MAX_TRADE_CREDITS].reduce((a, b) => (b < a ? b : a));
        if (xMax <= 0n) return done('capped', { reason: room <= 0n ? 'per-proposal credit cap reached' : 'no credits left to claim in this proposal', stage });
        if (have.deposit === 0n && have.usdc < FORECASTER_DEPOSIT + GAS_RESERVE_USDC && execute) {
          return done('unfunded', { reason: `needs ${FORECASTER_DEPOSIT + GAS_RESERVE_USDC} raw USDC (deposit + gas), has ${have.usdc}`, stage });
        }
      } else {
        const bal = side === 'long' ? have.position.long : have.position.short;
        const perTrade = MAX_TRADE_CREDITS * SCALE;
        xMax = bal < perTrade ? bal : perTrade;
      }

      let sized = await sizeMove({ kind, side, targetX18: intent.targetX18, xMax, batch });
      if (sized.size <= 0n) return done('no-size', { reason: sized.reason, stage, sizing: summary(sized) });

      // ---- plan
      let prerequisite = [];
      let finalStep;
      let credits = 0n;
      let deposit = 0n;
      let claim = 0n;
      if (kind === 'buy') {
        reservation = ledger.reserveTrade(agent.key, roundId, proposalId, sized.size, { persist: execute });
        credits = reservation.credits;
        const quote0 = credits === sized.size ? sized.quote : (await batch({ requests: [{ kind, side, x: credits }] })).results[0].value;
        // Claim the remaining round entitlement once in this market. This leaves enough credits for a fresh
        // target-size calculation after slow approval/deposit/claim transactions, without another claim cycle.
        const depositAfter = have.deposit > 0n ? have.deposit : FORECASTER_DEPOSIT;
        const claimRoom = depositAfter > have.claimed ? depositAfter - have.claimed : 0n;
        const plan = tradeSteps({ state: have, roundId, proposalId, credits: have.credits + claimRoom, long: side === 'long', have, minOut: minOutFromQuote(quote0, cfg.minOutNum, cfg.minOutDen) });
        ({ deposit, claim } = plan);
        prerequisite = plan.steps.slice(0, -1);
        finalStep = plan.steps.at(-1);
        if (deposit > 0n) ledger.trackRound(agent.key, roundId, { persist: execute });
      } else {
        finalStep = null;
      }

      const txs = [];
      for (const s of prerequisite) {
        if (intent.referenceValid && !intent.referenceValid()) throw Object.assign(new Error('fair-value reference expired or changed'), { stale: true });
        txs.push(await executor.run(s, { roundId }));
        if (!execute) {
          const k = key(roundId, proposalId);
          if (s.functionName === 'deposit') { bump(virtual.deposit, String(roundId), deposit); virtual.usdc += deposit; }
          if (s.functionName === 'claimCredits') { bump(virtual.claimed, k, claim); bump(virtual.credits, k, claim); }
        }
      }

      if (prerequisite.length) {
        const current = await haveNow(roundId, proposalId);
        const available = kind === 'buy' ? current.credits : current.position[side];
        sized = await sizeMove({ kind, side, targetX18: intent.targetX18, xMax: available < xMax ? available : xMax, batch: reads.batchFor(roundId, proposalId) });
        if (reservation) ledger.releaseTrade(reservation, 're-sizing after prerequisites');
        reservation = undefined;
        if (sized.size <= 0n) return done('no-size', { reason: sized.reason, stage, sizing: summary(sized), txs });
        if (kind === 'buy') {
          reservation = ledger.reserveTrade(agent.key, roundId, proposalId, sized.size, { persist: execute });
          credits = reservation.credits;
        }
      }

      // ---- fresh quote + spot immediately before the trade; minOut is ALWAYS the adapter quote minus 0.5%
      const again = await reads.roundFresh(roundId);
      if (!again.ok) throw Object.assign(new Error(again.reason), { tradingClosed: again.closed, stale: true });
      const q = await reads.batchFor(roundId, proposalId)({ requests: [{ kind, side, x: kind === 'buy' ? credits : sized.size }] });
      const r0 = q.results[0];
      if (!r0.ok) throw r0.error instanceof Error ? r0.error : Object.assign(new Error('quote failed'), { cause: r0.error });
      const moved = q.pLongX18 > sized.spotX18 ? q.pLongX18 - sized.spotX18 : sized.spotX18 - q.pLongX18;
      if (moved > 100_000_000_000_000n) throw Object.assign(new Error('market moved since target sizing; replan next pass'), { stale: true });
      if (intent.referenceValid && !intent.referenceValid()) throw Object.assign(new Error('fair-value reference expired or changed'), { stale: true });
      if (intent.stillValid && !intent.stillValid(q.pLongX18)) {
        if (reservation) ledger.releaseTrade(reservation, 'market moved back inside the threshold');
        return done('stale', { reason: 'market moved: signal no longer holds', stage, sizing: summary(sized), txs });
      }
      let step;
      let expectedOut;
      if (kind === 'buy') {
        expectedOut = r0.value;
        step = { ...finalStep, args: [roundId, BigInt(proposalId), credits, minOutFromQuote(r0.value, cfg.minOutNum, cfg.minOutDen)] };
      } else {
        const credited = r0.value.credits;
        if (credited <= 0n) return done('no-size', { reason: 'sell would return zero credits', stage, sizing: summary(sized) });
        expectedOut = credited;
        [step] = sellSteps({ roundId, proposalId, amountIn: sized.size, long: side === 'long', minCredits: minOutFromQuote(credited, cfg.minOutNum, cfg.minOutDen) });
      }
      txs.push(await executor.run(step, { roundId }));
      if (reservation) ledger.confirmTrade(reservation);

      // ---- dry-run memory: later planned trades see these effects
      if (!execute) {
        const k = key(roundId, proposalId);
        if (kind === 'buy') {
          bump(virtual.credits, k, -credits);
          bump(side === 'long' ? virtual.long : virtual.short, k, expectedOut);
        } else {
          bump(side === 'long' ? virtual.long : virtual.short, k, -sized.size);
          bump(virtual.credits, k, expectedOut);
        }
      }
      return done(execute ? 'done' : 'planned', {
        stage, sizing: summary(sized), credits, expectedOut, minOut: step.args[3], txs: txs.map((t) => ({ hash: t.hash, dryRun: t.dryRun })), steps: [...prerequisite, step].map((s) => s.label),
      });
    } catch (err) {
      const detail = err instanceof StepFailed ? err.detail : {};
      if (reservation) {
        if (detail.ambiguous) ledger.markTradeAmbiguous(reservation, err.message);
        else ledger.releaseTrade(reservation, err.message); // never broadcast, or it reverted on chain: the budget is free again
      }
      if (err.tradingClosed || isTradingClosed(err) || isTradingClosed({ errorName: detail.errorName, message: detail.simulationError })) {
        logger.info(`${agent.key}: trading closed before the trade could land (late, not an error)`, { round: String(roundId), proposalId });
        return done('closed', { reason: 'trading closed' });
      }
      if (err.stale) return done('stale', { reason: err.message });
      if (err instanceof CapError) return done('capped', { reason: err.message });
      if (err instanceof SizingError || err instanceof PlanError) return done('no-size', { reason: err.message, code: err.code });
      return done('failed', { reason: err.message, ambiguous: Boolean(detail.ambiguous), reverted: Boolean(detail.reverted) });
    }
  }

  return { act, mutex, haveNow, get dryRunState() { return virtual; } };
}
