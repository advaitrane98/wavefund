// Forecaster orchestrator: Quant and Guardian run as two INDEPENDENT loops inside one process (one lock, one ledger).
//  - Quant: scheduler ticks, trades every proposal (including the status quo) whose price is more than 0.5 point from fair.
//  - Guardian: its own 5s/15s loop; one Multicall3 call per pass; acts only against overpriced proposals; never awaits Quant,
//    the proposers, news, or any transaction receipt inside the timed evaluation pass.
// Everything chain-facing is injected (reads, model, executors), so the production wiring is what the tests exercise.
import { FORECAST } from './config.mjs';
import { fairFor, fromX18, roundHorizonSeconds, boundsFromRound, ModelError } from './fair.mjs';
import { guardianCandidates, guardianThreshold, inFinalWindow, signalFor, stageFor } from './decide.mjs';
import { createMutex, createTrader } from './trader.mjs';
import { createRedeemer } from './redeemer.mjs';
import { dueTick, forecasterTicks, secondsUntilNext, tradeCutoff } from './scheduler.mjs';

const SWEEP_EVERY_MS = 20_000;
const COOLDOWN_MS = 10_000;

export function createForecasterRuntime({
  agents, ledger, logger, execute, fired, model, reads, roundSource, sleep, stop = new AbortController(),
  nowMs = () => Date.now(), perfMs = () => performance.now(), flags = {}, cfg = FORECAST, pollMs = 5000,
}) {
  const ctxs = new Map();
  for (const a of agents) {
    const mutex = createMutex();
    const trader = createTrader({ agent: a.def, signer: a.signer, executor: a.executor, ledger, logger, execute, reads, mutex, cfg });
    const redeemer = createRedeemer({ agent: a.def, address: a.signer.address, reads, executor: a.executor, ledger, logger, execute, mutex, cfg });
    ctxs.set(a.def.key, { ...a, mutex, trader, redeemer, attempts: new Map(), closed: new Set(), cooldown: new Map(), sweepP: null, sweptAt: 0, inflight: null });
  }
  const aborted = () => stop.signal.aborted;
  const pct = (x) => (x == null ? null : fromX18(x));
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const exhausted = (a, roundId, p) => (a.attempts.get(`${roundId}|${p}`) ?? 0) >= cfg.maxActionAttempts;

  /** Redeem sweep: single-flight, throttled, never awaited by a hot loop. */
  function sweepInBackground(a, currentRoundId) {
    if (a.sweepP || nowMs() - a.sweptAt < SWEEP_EVERY_MS) return a.sweepP;
    a.sweptAt = nowMs();
    a.sweepP = a.redeemer.sweep(currentRoundId).catch((err) => logger.error(`${a.def.key}: redeem sweep failed: ${err.message}`)).finally(() => { a.sweepP = null; });
    return a.sweepP;
  }

  let lastIdle = 0;
  function idleNote(name, ctx) {
    if (flags.once || nowMs() - lastIdle > 60_000) {
      lastIdle = nowMs();
      logger.info(`${name}: no round is open for trading; nothing to do`, { round: ctx?.id?.toString(), status: ctx?.status });
    }
  }

  function note(a, r, p, result) {
    if (result.status === 'failed') bump(a.attempts, `${r}|${p}`);
    if (result.status === 'closed') a.closed.add(String(r));
  }

  // ------------------------------------------------------------------------------------------------ Quant
  const firedKey = (round, key, t) => `${round}|${key}|t${t.index}`;

  async function quantTick() {
    const a = ctxs.get('quant');
    if (!a) return { wait: pollMs };
    const ctx = await roundSource();
    if (!ctx || ctx.status !== 1) {
      if (ctx) sweepInBackground(a, ctx.id);
      idleNote('quant', ctx);
      return { idle: true, wait: pollMs };
    }
    sweepInBackground(a, ctx.id);
    const roundKey = ctx.id.toString();
    const timing = { tradingStart: ctx.tradingStart, tradingEnd: ctx.tradingEnd, twapWindow: ctx.twapWindow, evaluationEnd: ctx.evaluationEnd };
    const now = ctx.now;
    const ticks = forecasterTicks(timing, a.def);
    const cutoff = tradeCutoff(timing, a.def.key);
    const isFired = (t) => fired.has(firedKey(roundKey, a.def.key, t));
    const { tick: due, missed } = dueTick(ticks, isFired, now, cutoff);
    for (const m of missed) { fired.mark(firedKey(roundKey, a.def.key, m)); logger.info(`quant: missed tick ${m.index} (${m.phase})`); }
    const upcoming = secondsUntilNext(ticks, isFired, now);
    const wait = Math.max(1000, Math.min(pollMs, (upcoming ?? pollMs / 1000) * 1000));
    const forced = flags.evaluateNow && !execute;
    const tick = due ?? (forced ? { index: -1, phase: 'forced (--evaluate-now)', at: now } : null);
    if (!tick) {
      if (flags.once) logger.decision('quant', { inputs: { round: roundKey, now }, action: 'wait', reasoning: now > cutoff ? 'trading cutoff passed' : `next tick in ${upcoming ?? 'n/a'}s` });
      return { wait };
    }
    const tickKey = tick.index >= 0 ? firedKey(roundKey, a.def.key, tick) : null;

    let m;
    try {
      m = await model.get();
    } catch (err) {
      bump(a.attempts, `${roundKey}|tick${tick.index}`);
      logger.error(`quant: no market model (${err.message}); skipping this tick`);
      if (tickKey && (a.attempts.get(`${roundKey}|tick${tick.index}`) ?? 0) >= cfg.maxActionAttempts) fired.mark(tickKey);
      return { wait };
    }
    const view = await reads.quantView(ctx, a.signer.address);
    const horizonSeconds = roundHorizonSeconds(ctx);
    const { rMin, rMax } = boundsFromRound(ctx);
    const rows = [];
    for (const p of view.proposals) {
      if (p.pLongX18 == null || p.tEthBps == null) { rows.push({ proposalId: p.id, action: 'skip', reasoning: 'market not seeded or unreadable' }); continue; }
      try {
        const fair = fairFor(m.model, { tEthBps: p.tEthBps, horizonSeconds, rMin, rMax, cfg });
        const sig = signalFor({ pMarketX18: p.pLongX18, pFairX18: fair.pFairX18, threshold: cfg.quantThreshold });
        const stage = stageFor({ direction: sig.direction, position: p.position, allowSell: true });
        rows.push({
          proposalId: p.id, tEthBps: p.tEthBps, pMarket: pct(p.pLongX18), pFair: fair.pFair, gap: pct(sig.gapX18), threshold: cfg.quantThreshold,
          expectedReturn: fair.expectedReturn, clamped: fair.clamped, direction: sig.direction, pFairX18: fair.pFairX18, pMarketX18: p.pLongX18, gapX18: sig.gapX18,
          action: stage ? `${stage.kind} ${stage.side.toUpperCase()}` : 'hold', reasoning: sig.note, position: { long: p.position.long, short: p.position.short },
        });
      } catch (err) {
        rows.push({ proposalId: p.id, action: 'skip', reasoning: err instanceof ModelError ? err.message : `fair value failed: ${err.message}` });
      }
    }
    logger.decision('quant', {
      inputs: {
        round: roundKey, now, tick, mode: execute ? 'execute' : 'dry-run', model: { price: m.model.price, drift: m.model.drift, driftRaw: m.model.driftRaw, driftCapped: m.model.driftCapped, sigma: m.model.sigma, candles: m.model.candles, cacheAgeMs: m.ageMs },
        horizonSeconds, rMin, rMax, proposals: rows.map(({ pFairX18, pMarketX18, gapX18, position, ...r }) => r),
      },
      action: rows.some((r) => r.direction) ? 'trade' : 'hold', reasoning: `${rows.filter((r) => r.direction).length} of ${rows.length} proposals are more than ${cfg.quantThreshold} from fair`,
    });

    const abs = (x) => (x < 0n ? -x : x);
    const todo = rows.filter((r) => r.direction).sort((x, y) => (abs(y.gapX18) > abs(x.gapX18) ? 1 : abs(y.gapX18) < abs(x.gapX18) ? -1 : 0));
    const results = [];
    for (const r of todo) {
      if (aborted()) break;
      if (a.closed.has(roundKey)) break;
      if (exhausted(a, roundKey, r.proposalId)) { logger.info(`quant: giving up on proposal ${r.proposalId} for round ${roundKey} after ${cfg.maxActionAttempts} failed attempts`); continue; }
      const result = await a.trader.act({
        roundId: ctx.id, proposalId: r.proposalId, direction: r.direction, targetX18: r.pFairX18, allowSell: true,
        referenceValid: () => model.peek ? model.peek()?.fetchedAt === m.fetchedAt && model.peek().ageMs < cfg.modelTtlMs : true,
        stillValid: (pLong) => { const s = signalFor({ pMarketX18: pLong, pFairX18: r.pFairX18, threshold: cfg.quantThreshold }); return s.direction === r.direction; },
      });
      note(a, roundKey, r.proposalId, result);
      results.push(result);
      logger.decision('quant', { inputs: { round: roundKey, proposalId: r.proposalId, pMarket: r.pMarket, pFair: r.pFair, gap: r.gap, threshold: cfg.quantThreshold, sizing: result.sizing }, action: `${r.action}: ${result.status}`, reasoning: result.reason ?? result.steps?.join(' -> '), txs: result.txs, credits: result.credits, minOut: result.minOut });
    }
    if (tickKey && !results.some((x) => x.status === 'failed' && (a.attempts.get(`${roundKey}|${x.proposalId}`) ?? 0) < cfg.maxActionAttempts)) fired.mark(tickKey);
    return { wait, rows, results };
  }

  // ------------------------------------------------------------------------------------------------ Guardian
  const g = { ctx: null, reruns: 0, passes: 0 };

  async function guardianContext(force = false) {
    if (!g.ctx || force) g.ctx = await roundSource();
    return g.ctx;
  }

  async function evaluateGuardian() {
    const a = ctxs.get('guardian');
    if (!a) return { wait: pollMs };
    const t0 = perfMs();
    let ctx = await guardianContext();
    if (!ctx || ctx.status !== 1) {
      if (ctx) sweepInBackground(a, ctx.id);
      idleNote('guardian', ctx);
      g.ctx = null;
      return { idle: true, wait: pollMs };
    }
    let batch = await reads.guardianBatch(ctx);
    let multicalls = 1;
    if (!batch.round && !ctx.simulated) throw new Error('round header unreadable in the prices batch; not acting');
    const transition = !ctx.simulated && (batch.currentRoundId !== ctx.id || batch.round.proposalCount > ctx.proposalCount || batch.round.status !== 1);
    if (transition) {
      ctx = await guardianContext(true);
      if (!ctx || ctx.status !== 1) return { idle: true, wait: pollMs, reason: 'round transition' };
      // Re-evaluate on the next pass rather than fetching prices twice in this one.
      return { wait: 250, reason: 'round transition', multicalls };
    }
    const now = batch.now;
    if (now >= ctx.tradingEnd) { g.ctx = null; sweepInBackground(a, ctx.id); return { idle: true, wait: pollMs, reason: 'trading ended' }; }
    const roundKey = ctx.id.toString();
    const win = { now, tradingEnd: ctx.tradingEnd, twapWindow: ctx.twapWindow };
    const finalWindow = inFinalWindow(win);
    const threshold = guardianThreshold(win, cfg);
    const spots = batch.proposals.map((p) => p.pLongX18);
    const twaps = batch.proposals.map((p) => p.twapX18);
    const { leader, ids } = guardianCandidates({ spots, twaps, epsilon: ctx.epsilon });

    let m = null;
    let modelNote;
    try {
      m = await model.getBounded();
    } catch (err) {
      modelNote = err.message;
    }
    const horizonSeconds = roundHorizonSeconds(ctx);
    const { rMin, rMax } = boundsFromRound(ctx);
    const rows = [];
    for (const id of ids) {
      const p = batch.proposals[id];
      if (!p || p.pLongX18 == null || p.tEthBps == null) { rows.push({ proposalId: id, leader: id === leader, action: 'skip', reasoning: 'market unreadable' }); continue; }
      if (!m) { rows.push({ proposalId: id, leader: id === leader, pMarket: pct(p.pLongX18), action: 'skip', reasoning: `no market model: ${modelNote}` }); continue; }
      const fair = fairFor(m.model, { tEthBps: p.tEthBps, horizonSeconds, rMin, rMax, cfg });
      const sig = signalFor({ pMarketX18: p.pLongX18, pFairX18: fair.pFairX18, threshold });
      const intervene = sig.direction === 'lower'; // the Guardian only defends against OVERPRICED proposals
      rows.push({
        proposalId: id, leader: id === leader, tEthBps: p.tEthBps, pMarket: pct(p.pLongX18), pFair: fair.pFair, gap: pct(sig.gapX18), threshold,
        action: intervene ? 'buy SHORT' : 'hold', reasoning: intervene ? 'overpriced beyond threshold' : sig.direction === 'raise' ? 'underpriced: the Guardian does not buy LONG' : 'inside threshold',
        intervene, pFairX18: fair.pFairX18, thresholdX18: sig.thresholdX18, gapX18: sig.gapX18, stale: m.stale, modelFetchedAt: m.fetchedAt,
      });
    }
    const todo = rows.filter((r) => r.intervene).sort((x, y) => (Number(y.leader) - Number(x.leader)) || (y.gapX18 > x.gapX18 ? 1 : y.gapX18 < x.gapX18 ? -1 : 0));
    const passMs = Math.round(perfMs() - t0);
    g.passes++;
    logger.decision('guardian', {
      inputs: {
        round: roundKey, now, finalWindow, threshold, leader, candidates: ids, multicalls, passMs, withinBudget: passMs < cfg.guardianPassBudgetMs, budgetMs: cfg.guardianPassBudgetMs,
        modelAgeMs: m?.ageMs, modelStale: m?.stale, projectedTwaps: twaps.map(pct), spots: spots.map(pct), mode: execute ? 'execute' : 'dry-run',
        proposals: rows.map(({ pFairX18, thresholdX18, gapX18, ...r }) => r),
      },
      action: todo.length ? `intervene on ${todo.map((r) => r.proposalId).join(',')}` : 'watch', reasoning: `leader ${leader}; ${todo.length} candidate(s) beyond ${threshold}`,
    });

    if (todo.length && !a.inflight && !a.closed.has(roundKey) && !aborted()) {
      const jobs = todo.filter((r) => !exhausted(a, roundKey, r.proposalId) && nowMs() >= (a.cooldown.get(`${roundKey}|${r.proposalId}`) ?? 0));
      if (jobs.length) {
        // Started, NOT awaited: receipts and sizing never count against the evaluation pass.
        a.inflight = intervene(a, ctx, jobs, threshold).finally(() => { a.inflight = null; });
        a.inflight.catch(() => {});
      }
    } else if (todo.length && a.inflight) {
      logger.info('guardian: an intervention is still in flight; evaluating only');
    }
    sweepInBackground(a, ctx.id);
    const every = (finalWindow ? cfg.guardianEverySec.inside : cfg.guardianEverySec.outside) * 1000;
    return { wait: Math.max(250, every - passMs), passMs, rows, leader, ids, multicalls, inflight: a.inflight };
  }

  async function guardianPass() {
    const start = perfMs();
    const record = (action, reason) => {
      const passMs = Math.round(perfMs() - start);
      logger.decision('guardian', {
        inputs: { passMs, withinBudget: passMs < cfg.guardianPassBudgetMs, budgetMs: cfg.guardianPassBudgetMs, mode: execute ? 'execute' : 'dry-run' },
        action, reasoning: reason,
      });
      return passMs;
    };
    try {
      const result = await evaluateGuardian();
      if (ctxs.has('guardian') && result.passMs == null) result.passMs = record(result.idle ? 'idle' : 'resync', result.reason ?? 'no trading round');
      return result;
    } catch (err) {
      if (ctxs.has('guardian')) record('failed', err.message);
      throw err;
    }
  }

  async function intervene(a, ctx, jobs, threshold) {
    const roundKey = ctx.id.toString();
    for (const r of jobs) {
      if (aborted() || a.closed.has(roundKey)) break;
      const result = await a.trader.act({
        roundId: ctx.id, proposalId: r.proposalId, direction: 'lower', targetX18: r.pFairX18, allowSell: false,
        referenceValid: () => model.peek ? model.peek()?.fetchedAt === r.modelFetchedAt && model.peek().ageMs < cfg.modelTtlMs : true,
        stillValid: (pLong) => pLong - r.pFairX18 > r.thresholdX18,
      });
      note(a, roundKey, r.proposalId, result);
      if (result.status === 'failed') a.cooldown.set(`${roundKey}|${r.proposalId}`, nowMs() + COOLDOWN_MS);
      logger.decision('guardian', {
        inputs: { round: roundKey, proposal: r.proposalId, leader: r.leader, deviation: r.gap, threshold, pMarket: r.pMarket, pFair: r.pFair, sizing: result.sizing },
        action: `intervention ${result.status}${result.status === 'closed' ? ' (late TradingClosed, not an error)' : ''}`,
        reasoning: result.reason ?? result.steps?.join(' -> '), transaction: result.txs?.map((t) => t.hash ?? 'dry-run'), credits: result.credits, minOut: result.minOut,
      });
    }
  }

  // ------------------------------------------------------------------------------------------------ loops
  async function loop(name, fn, once) {
    do {
      let wait = pollMs;
      try {
        ({ wait } = await fn());
      } catch (err) {
        logger.error(`${name} pass failed: ${err.message}`);
      }
      if (once || aborted()) break;
      await sleep(wait);
    } while (!aborted());
  }

  return {
    quantTick, guardianPass, ctxs,
    has: (key) => ctxs.has(key),
    /** Runs the independent loops concurrently. With once=true each does a single pass, then in-flight work is awaited. */
    async run({ once = false } = {}) {
      const jobs = [];
      if (ctxs.has('quant') || ctxs.has('guardian')) await Promise.race([model.warm?.(), sleep(6000)]); // one bounded fetch up front; never repeated inside a pass
      if (ctxs.has('quant')) jobs.push(loop('quant', quantTick, once));
      if (ctxs.has('guardian')) jobs.push(loop('guardian', guardianPass, once));
      if (!once && model.warm) jobs.push((async () => { while (!aborted()) { await model.warm(); await sleep(15_000); } })());
      await Promise.all(jobs);
      // Finish what is already in flight (a stop request ends the loops, never a transaction half way).
      await Promise.all([...ctxs.values()].flatMap((c) => [c.inflight, c.sweepP]).filter(Boolean));
    },
  };
}
