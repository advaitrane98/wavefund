// npm run agents:run -- [--dry-run | --execute] [--once] [--preset full|judge] [--only momentum,quant]
//                       [--simulate-round full|judge]   (dry-run only: pretend a round just opened)
// Default is --dry-run: decisions and transaction plans are logged, nothing is sent. --execute sends real
// transactions through each agent's own wallet, under the gas, trade and proposal caps.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { abis, chainNow, cliArgs, loadBook, publicClient, read } from '../scripts/demo-round-common.mjs';
import { PRESETS, resolveTiming } from '../scripts/lib/round-actions.mjs';
import { proposeSteps, tradeSteps } from './lib/actions.mjs';
import {
  agentState, creditBalance, creditsClaimed, marketPLong, proposalInfo, roundDeposit, snapshot,
} from './lib/chain.mjs';
import { gasCaps } from './lib/config.mjs';
import { StepFailed, createExecutor } from './lib/executor.mjs';
import { AGENTS_RUN_DIR, loadAgents } from './lib/files.mjs';
import { CapError, SpendLedger } from './lib/ledger.mjs';
import { acquireLock } from './lib/lock.mjs';
import { createLogger } from './lib/logger.mjs';
import { createMarketData, features as computeFeatures } from './lib/market-data.mjs';
import {
  dueTick, forecasterTicks, phaseOf, proposerWindow, secondsUntilNext, tradeCutoff,
} from './lib/scheduler.mjs';
import { createSigner, signerBackend } from './lib/signers/index.mjs';
import { forecasters } from './strategies/index.mjs';
import { decideProposal } from './proposer-strategies.mjs';
import { fetchHeadlines } from './lib/news.mjs';

const MAX_ATTEMPTS = 3;

function syntheticRound(preset, now) {
  const t = resolveTiming({ preset });
  const start = now - 60; // pretend the round opened a minute ago so proposal windows and the first ticks are due
  return {
    id: 0n, simulated: true, status: 1, now,
    tradingStart: start, tradingEnd: start + t.tradingSeconds, evaluationEnd: start + t.tradingSeconds + t.evaluationSeconds,
    twapWindow: t.twapSeconds, rMin: 990_000_000_000_000_000n, rMax: 1_010_000_000_000_000_000n, proposalCount: 1n,
  };
}

export async function runAgents(argv = process.argv.slice(2)) {
  const args = cliArgs({
    'dry-run': { type: 'boolean', default: false }, execute: { type: 'boolean', default: false }, once: { type: 'boolean', default: false },
    preset: { type: 'string', default: 'full' }, only: { type: 'string' }, 'simulate-round': { type: 'string' }, 'simulate-status-quo': { type: 'string' }, poll: { type: 'string', default: '5' },
  }, argv);
  if (args['dry-run'] && args.execute) throw new Error('Use either --dry-run (default) or --execute, not both.');
  const execute = args.execute;
  if (!PRESETS[args.preset]) throw new Error(`unknown --preset "${args.preset}" (use full or judge)`);
  if ((args['simulate-round'] || args['simulate-status-quo']) && execute) throw new Error('--simulate-round and --simulate-status-quo are dry-run only.');
  if (args['simulate-status-quo'] && !args['simulate-round']) throw new Error('--simulate-status-quo needs --simulate-round.');
  const pollMs = Math.max(1, Number(args.poll)) * 1000;

  const logger = createLogger({ dir: path.join(AGENTS_RUN_DIR, 'logs') });
  const lock = acquireLock(path.join(AGENTS_RUN_DIR, 'agents.lock'));
  const stop = new AbortController();
  const sleep = (ms) => new Promise((res) => {
    const t = setTimeout(res, ms);
    stop.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
  const onSignal = () => {
    if (stop.signal.aborted) return;
    logger.info('stop requested: finishing the current step, then exiting');
    stop.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const ledger = new SpendLedger({ file: path.join(AGENTS_RUN_DIR, 'ledger.json'), caps: gasCaps(args.preset) });
    const recovered = await ledger.recover(async (hash) => {
      const r = await publicClient.getTransactionReceipt({ hash });
      return r.gasUsed * r.effectiveGasPrice;
    });
    if (recovered.released || recovered.committed || recovered.stillPending) logger.info('recovered pending reservations', recovered);

    // Dry-run remembers what it "did" only in memory, so it can never stop a later --execute run from acting.
    const firedMemory = new Set();
    const fired = {
      has: (k) => firedMemory.has(k) || ledger.hasFired(k),
      mark: (k) => { firedMemory.add(k); if (execute) ledger.markFired(k); },
    };
    const market = createMarketData({ onRetry: (n, err) => logger.warn(`market data attempt ${n} failed: ${err.message}`) });
    const only = args.only ? args.only.split(',') : undefined;
    const agents = loadAgents({ only }).map(({ def, record }) => {
      let signer;
      try {
        signer = createSigner({ agentDef: def, agentRecord: record });
      } catch (err) {
        if (execute) throw err;
        logger.warn(`${def.key}: signer unavailable (${err.message}); dry-run continues with an address-only stub`);
        if (!record.address) throw new Error(`${def.key} has no address in agents/agents.json. Run: npm run agents:setup`);
        signer = { kind: 'stub', address: record.address, estimateFee: async () => ({ attempts: 0, gasLimit: null, networkFeeWei: null }), execute: async () => { throw new Error('dry-run'); } };
      }
      return { def, record, signer, executor: createExecutor({ agent: def, signer, ledger, logger, execute }), attempts: {} };
    });
    logger.info(`agents ${execute ? 'EXECUTE' : 'DRY-RUN'} started`, {
      backend: signerBackend(), preset: args.preset, caps: { perRound: '0.25 USDC', perDay: args.preset === 'judge' ? '3.0 USDC' : '1.0 USDC' },
      agents: agents.map((a) => `${a.def.key}:${a.signer.address}`),
    });

    let lastIdleLog = 0;
    const cycle = new Map(); // round -> allocations chosen so far this cycle (kept in memory, also in dry-run)
    let newsCache = null;
    async function headlinesNow() {
      if (!newsCache || Date.now() - newsCache.at > 300_000) newsCache = { at: Date.now(), ...(await fetchHeadlines()) };
      return newsCache;
    }
    const logWait = (agent, payload) => { if (args.once) logger.decision(agent, payload); };

    async function pass() {
      const snap = args['simulate-round'] ? syntheticRound(args['simulate-round'], await chainNow()) : await snapshot();
      if (!snap || snap.status !== 1) {
        if (args.once || Date.now() - lastIdleLog > 60_000) {
          lastIdleLog = Date.now();
          logger.info('no round is open for trading; nothing to do', { round: snap?.id?.toString(), status: snap?.status });
        }
        return { idle: true, wait: pollMs };
      }
      const timing = { tradingStart: snap.tradingStart, tradingEnd: snap.tradingEnd, twapWindow: snap.twapWindow, evaluationEnd: snap.evaluationEnd };
      const now = snap.simulated ? await chainNow() : snap.now;
      const roundKey = snap.id.toString();
      const book = loadBook();
      const statusQuoBps = snap.simulated
        ? (args['simulate-status-quo'] != null ? Number(args['simulate-status-quo']) : Number(await read(book.c.WavefundVault, abis().WavefundVault, 'currentTEthBps')))
        : (await proposalInfo(snap.id, 0)).tEthBps;
      const data = await market.candles();
      const f = computeFeatures(data.closes);
      const base = { round: roundKey, simulated: Boolean(snap.simulated), phase: phaseOf(timing, now), timing, now, statusQuoBps, mode: execute ? 'execute' : 'dry-run' };
      let nextWait = pollMs;

      for (const a of agents) {
        if (stop.signal.aborted) break;
        const { def } = a;
        const state = await agentState(a.signer.address);
        const spend = ledger.usage(def.key, roundKey);
        const inputs = { ...base, features: f, candleSource: { cached: data.cached, candles: f.candles }, agentUsdc: state.usdc.toString(), gasUsedRoundWei: spend.round.toString(), gasUsedDayWei: spend.day.toString() };

        if (def.type === 'proposer') {
          const firedKey = `${roundKey}|${def.key}|propose`;
          if (fired.has(firedKey)) continue;
          const win = proposerWindow(timing, def);
          if (now < win.opensAt) { nextWait = Math.min(nextWait, (win.opensAt - now) * 1000); logWait(def.key, { inputs, action: 'wait', reasoning: `proposal window opens in ${win.opensAt - now}s` }); continue; }
          if (now > win.closesAt || !win.valid) { fired.mark(firedKey); logger.decision(def.key, { inputs, action: 'skip', reasoning: 'proposal window already closed' }); continue; }
          const onChain = [];
          for (let p = 1; p < Number(snap.proposalCount); p++) onChain.push((await proposalInfo(snap.id, p)).tEthBps);
          const chosen = cycle.get(roundKey) ?? [];
          const news = def.key === 'news' ? await headlinesNow() : { headlines: [] };
          const d = await decideProposal({ def, candles: data.candles, statusQuoBps, others: [...onChain, ...chosen], headlines: news.headlines, env: process.env });
          const reasoning = d.action === 'propose'
            ? `${d.source}: raw ${d.rawBps} bps (z ${d.z?.toFixed(2)}), ${d.shifted ? `shifted to ${d.finalBps} bps (${d.shiftSide})` : 'no shift needed'}; ${d.why}`
            : `skip: ${d.skipReason}`;
          logger.decision(def.key, {
            inputs: { ...inputs, existingProposalsBps: onChain, chosenThisCycleBps: chosen, headlines: news.headlines?.map((h) => h.title), newsError: news.error },
            action: d.action, reasoning, source: d.source, rawBps: d.rawBps, finalBps: d.finalBps, shifted: d.shifted, shiftSide: d.shiftSide,
            tEthBps: d.finalBps, rationale: d.rationale, signal: d.signal,
          });
          if (d.action !== 'propose') { fired.mark(firedKey); continue; }
          try {
            const steps = proposeSteps({ agentDef: def, state, roundId: snap.id, tEthBps: d.finalBps, rationale: d.rationale });
            for (const s of steps) await a.executor.run(s, { roundId: roundKey });
            cycle.set(roundKey, [...chosen, d.finalBps]);
            fired.mark(firedKey);
          } catch (err) {
            handleFailure(a, firedKey, err);
          }
        } else {
          const ticks = forecasterTicks(timing, def);
          const cutoff = tradeCutoff(timing, def.key);
          const fk = (t) => `${roundKey}|${def.key}|t${t.index}`;
          const { tick, missed } = dueTick(ticks, (t) => fired.has(fk(t)), now, cutoff);
          for (const m of missed) { fired.mark(fk(m)); logger.info(`${def.key}: missed tick ${m.index} (${m.phase})`); }
          const upcoming = secondsUntilNext(ticks, (t) => fired.has(fk(t)), now);
          if (upcoming != null) nextWait = Math.min(nextWait, upcoming * 1000);
          if (!tick) { logWait(def.key, { inputs, action: 'wait', reasoning: now > cutoff ? `trading cutoff passed (${tradeCutoff(timing, def.key)}, ${now > timing.tradingEnd ? 'trading ended' : 'inside the guard window before tradingEnd'})` : `next tick in ${upcoming ?? 'n/a'}s`, ticks: ticks.length }); continue; }
          const proposals = [];
          for (let p = 1; p < Number(snap.proposalCount); p++) {
            const info = await proposalInfo(snap.id, p);
            proposals.push({ id: p, tEthBps: info.tEthBps, pLong: await marketPLong(snap.id, p) });
          }
          const d = forecasters.decide({ agent: def, features: f, round: snap, proposals, statusQuoBps });
          logger.decision(def.key, { inputs: { ...inputs, tick, proposals: d.view ?? proposals }, action: d.action, reasoning: d.reasoning });
          if (d.action !== 'trade') { fired.mark(fk(tick)); continue; }
          try {
            const credits = ledger.allowTrade(def.key, roundKey, d.proposalId, d.credits);
            const have = { deposit: await roundDeposit(snap.id, a.signer.address), claimed: await creditsClaimed(snap.id, d.proposalId, a.signer.address), credits: await creditBalance(snap.id, d.proposalId, a.signer.address).catch(() => 0n) };
            const steps = tradeSteps({ state, roundId: snap.id, proposalId: d.proposalId, credits, long: d.long, have });
            for (const s of steps) await a.executor.run(s, { roundId: roundKey });
            if (execute) ledger.recordTrade(def.key, roundKey, d.proposalId, credits);
            fired.mark(fk(tick));
          } catch (err) {
            handleFailure(a, fk(tick), err);
          }
        }
      }
      return { idle: false, wait: Math.max(1000, nextWait) };
    }

    function handleFailure(a, firedKey, err) {
      const n = (a.attempts[firedKey] = (a.attempts[firedKey] ?? 0) + 1);
      const capped = err instanceof CapError;
      logger.error(`${a.def.key}: ${err.message}`, { attempt: n, cap: capped, detail: err.detail && { ...err.detail, used: String(err.detail.used ?? ''), estimate: String(err.detail.estimate ?? ''), cap: String(err.detail.cap ?? '') } });
      if (capped || err instanceof StepFailed === false || n >= MAX_ATTEMPTS) {
        fired.mark(firedKey); // do not hammer: a cap or repeated failure ends this action for the round
      }
    }

    do {
      let wait = pollMs;
      try {
        ({ wait } = await pass());
      } catch (err) {
        logger.error(`pass failed: ${err.message}`);
      }
      if (args.once || stop.signal.aborted) break;
      await sleep(wait);
    } while (!stop.signal.aborted);
    logger.info('agents stopped cleanly');
  } finally {
    lock.release();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgents().then(() => process.exit(0)).catch((err) => {
    console.error(`agents:run failed: ${err.message}`);
    process.exit(1);
  });
}
