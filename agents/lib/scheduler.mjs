// Pure scheduling: given a round's on-chain timings, when may each agent act? All times are unix seconds.
// timing = { tradingStart, tradingEnd, twapWindow, evaluationEnd }
import { GUARD_SECONDS, PRE_TWAP_LEAD } from './config.mjs';

export const guardFor = (agentKey) => (agentKey === 'guardian' ? GUARD_SECONDS.guardian : GUARD_SECONDS.default);

/** The last second at which an agent may still trade: no forecaster trades within `guard` seconds of tradingEnd. */
export const tradeCutoff = (timing, agentKey) => timing.tradingEnd - guardFor(agentKey);

export const twapStart = (timing) => timing.tradingEnd - timing.twapWindow;

export function phaseOf(timing, now) {
  if (now < timing.tradingStart) return 'before';
  if (now < twapStart(timing)) return 'trading';
  if (now < timing.tradingEnd) return 'twap';
  if (now < timing.evaluationEnd) return 'evaluation';
  return 'ended';
}

/** Proposers act early: after a small per-agent stagger, within the first quarter of the trading window. */
export function proposerWindow(timing, agent) {
  const duration = timing.tradingEnd - timing.tradingStart;
  const stagger = Math.min(agent.stagger ?? 0, Math.floor(duration * 0.1));
  const opensAt = timing.tradingStart + stagger;
  const closesAt = Math.min(timing.tradingStart + Math.floor(duration * 0.25), tradeCutoff(timing, agent.key) - 1);
  return { opensAt, closesAt, valid: closesAt > opensAt };
}

/**
 * Forecaster ticks, sorted: periodic during trading, one just before the final TWAP window, regular ones inside it,
 * and a last one right before the cutoff. Nothing is scheduled after `tradeCutoff`.
 */
export function forecasterTicks(timing, agent) {
  const cutoff = tradeCutoff(timing, agent.key);
  const tw = twapStart(timing);
  const duration = timing.tradingEnd - timing.tradingStart;
  const first = timing.tradingStart + Math.min(30, Math.floor(duration * 0.1));
  const ticks = new Map();
  const add = (at, phase) => {
    if (at >= timing.tradingStart && at <= cutoff && !ticks.has(at)) ticks.set(at, { at, phase });
  };
  const preTwap = tw - PRE_TWAP_LEAD;
  for (let t = first; t < preTwap - 1; t += agent.interval) add(t, 'periodic');
  add(preTwap, 'pre-twap');
  for (let t = tw; t <= cutoff; t += agent.twapInterval) add(t, 'twap');
  add(cutoff - 1, 'final');
  return [...ticks.values()].sort((a, b) => a.at - b.at).map((t, i) => ({ ...t, index: i }));
}

/**
 * Picks the tick to run now: the most recent tick that is due, not yet fired and not past the cutoff.
 * Older unfired ticks are reported as `missed` (the agent was busy or the process was down).
 */
export function dueTick(ticks, isFired, now, cutoff) {
  if (now > cutoff) return { tick: null, missed: ticks.filter((t) => !isFired(t)) };
  const lastFired = Math.max(-1, ...ticks.filter((t) => isFired(t)).map((t) => t.index));
  const due = ticks.filter((t) => t.index > lastFired && t.at <= now && !isFired(t));
  if (!due.length) return { tick: null, missed: [] };
  return { tick: due[due.length - 1], missed: due.slice(0, -1) };
}

/** Seconds until the next thing happens for a forecaster (for sleeping in the run loop). */
export function secondsUntilNext(ticks, isFired, now) {
  const next = ticks.find((t) => t.at > now && !isFired(t));
  return next ? next.at - now : null;
}
