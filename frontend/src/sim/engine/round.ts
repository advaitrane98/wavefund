import { twapOf } from "../amm";
import { r6 } from "../format";
import { makeRng } from "../rng";
import { makeRound, navOf, tethShareOf } from "../seed";
import type { Round, SimState } from "../types";
import { clone, fail, requireConnected } from "./util";
import { processQueue, rebalance } from "./vault";

/** Settlement return input is limited so the demo vault price stays positive. */
export const MAX_ENTERED_RETURN = 0.25;

/** Simulate the final window, pick the winner, and execute on the vault. */
export function collapseRound(prev: SimState): SimState {
  if (prev.round.status !== "open") fail("This round has already collapsed.");
  const s = clone(prev);
  const round = s.round;
  const rng = makeRng(round.seed + 7919);

  // Simulated final window: 12 samples around each market's current price.
  for (const p of round.proposals) {
    const last = p.samples[p.samples.length - 1];
    for (let i = 0; i < 12; i += 1) {
      const noise = (rng() - 0.5) * 0.006;
      p.samples.push(Math.min(0.99, Math.max(0.01, last + noise)));
    }
  }

  const twaps = round.proposals.map((p) => twapOf(p.samples, 12));
  const statusQuoTwap = twaps[0];
  let best = 0;
  for (let i = 1; i < twaps.length; i += 1) {
    if (twaps[i] > (best === 0 ? statusQuoTwap : twaps[best])) best = i;
  }
  // An agent wins only if it beats the status quo by more than the margin.
  const winner = best !== 0 && twaps[best] > statusQuoTwap + round.margin ? best : 0;
  const win = round.proposals[winner];

  // Vault: process queued flows at the current share price, then rebalance.
  processQueue(s);
  const prevShare = tethShareOf(s.vault);
  if (winner !== 0) rebalance(s, win.tethShare);

  round.winner = winner;
  round.status = "collapsed";
  round.collapse = {
    twaps,
    statusQuoTwap,
    winnerTwap: twaps[winner],
    executedAt: Date.now(),
  };
  s.vault.decisions.unshift({
    round: round.id,
    at: Date.now(),
    winnerName: win.name,
    winnerType: win.type,
    keptStatusQuo: winner === 0,
    prevTethShare: prevShare,
    newTethShare: tethShareOf(s.vault),
    statusQuoTwap,
    winnerTwap: twaps[winner],
    navAfter: navOf(s.vault),
    settledReturn: null,
    illustrative: false,
  });
  return s;
}

/**
 * Settle with an entered return. The payout return is clamped to [rMin, rMax];
 * LONG pays (r - rMin) / (rMax - rMin) credits and SHORT pays the rest.
 */
export function settleRound(prev: SimState, enteredReturn: number): SimState {
  if (prev.round.status !== "collapsed") fail("Collapse the round before settling it.");
  if (!Number.isFinite(enteredReturn) || Math.abs(enteredReturn) > MAX_ENTERED_RETURN) {
    fail(`Enter a return between -${MAX_ENTERED_RETURN * 100}% and ${MAX_ENTERED_RETURN * 100}%.`);
  }
  const s = clone(prev);
  const round = s.round;
  const payoutReturn = Math.min(round.rMax, Math.max(round.rMin, enteredReturn));
  const price = (payoutReturn - round.rMin) / (round.rMax - round.rMin);
  round.settlement = { enteredReturn, payoutReturn, price, settledAt: Date.now() };
  round.status = "settled";

  // Apply the entered return to the vault by repricing tETH.
  const v = s.vault;
  const nav = navOf(v);
  const tethValue = v.teth * v.oracle;
  const newTethValue = tethValue + enteredReturn * nav;
  if (v.teth > 0 && newTethValue > 0) {
    const gap = v.poolPrice / v.oracle;
    v.oracle = newTethValue / v.teth;
    v.poolPrice = v.oracle * gap;
  }
  const decision = v.decisions.find((d) => d.round === round.id && !d.illustrative);
  if (decision) {
    decision.settledReturn = enteredReturn;
    decision.navAfter = navOf(v);
  }
  return s;
}

/** Value of your position in the winning market, in credits, once settled. */
export function redeemValue(round: Round): number {
  if (round.winner === null || !round.settlement || round.userDeposit === null) return 0;
  const pos = round.positions[round.winner];
  const p = round.settlement.price;
  return r6(pos.credits + pos.long * p + pos.short * (1 - p));
}

/** USDC you get back: deposit − claimed in the winner + what the winner pays out. */
export function redeemableUsdc(round: Round): number {
  if (round.winner === null || !round.settlement || round.userDeposit === null) return 0;
  const pos = round.positions[round.winner];
  return r6(round.userDeposit - pos.claimed + redeemValue(round));
}

function applyRedeem(s: SimState): void {
  const round = s.round;
  if (round.userDeposit === null || round.redeemed !== null) return;
  const payout = redeemableUsdc(round);
  s.usdc = r6(s.usdc + payout);
  round.redeemed = payout;
}

export function redeem(prev: SimState): SimState {
  requireConnected(prev);
  if (prev.round.status !== "settled") fail("Settle the round before redeeming.");
  if (prev.round.userDeposit === null) fail("You have no deposit in this round.");
  if (prev.round.redeemed !== null) fail("You already redeemed this round.");
  const s = clone(prev);
  applyRedeem(s);
  return s;
}

/** Archive the settled round and open the next one. */
export function nextRound(prev: SimState): SimState {
  if (prev.round.status !== "settled") fail("Settle the current round first.");
  const s = clone(prev);
  applyRedeem(s); // never strand an unredeemed deposit
  s.pastRounds.unshift(s.round);
  s.pastRounds = s.pastRounds.slice(0, 10);
  const id = s.round.id + 1;
  s.round = makeRound(id, 20_260_000 + id, tethShareOf(s.vault));
  return s;
}
