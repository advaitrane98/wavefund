import { quoteBuy, quoteSell, pLongOf } from "../amm";
import { r6 } from "../format";
import type { Side, SimState, TradeAction } from "../types";
import { clone, fail, requireAmount, requireConnected, requireOpen } from "./util";

/** Deposit USDC once into the round. 1 USDC = 1 credit of claim capacity. */
export function depositOnce(prev: SimState, amount: number): SimState {
  requireConnected(prev);
  requireOpen(prev);
  requireAmount(amount);
  if (prev.round.userDeposit !== null) fail("You already deposited in this round. Deposit is once per round.");
  if (amount > prev.usdc) fail("Not enough demo USDC.");
  const s = clone(prev);
  s.usdc = r6(s.usdc - amount);
  s.round.userDeposit = r6(amount);
  return s;
}

/** Claim credits in one proposal. Each proposal can claim up to the full deposit. */
export function claim(prev: SimState, index: number, amount: number): SimState {
  requireConnected(prev);
  requireOpen(prev);
  requireAmount(amount);
  const deposit = prev.round.userDeposit;
  if (deposit === null) fail("Deposit first, then claim credits in each proposal.");
  const pos = prev.round.positions[index];
  if (!pos) fail("Unknown proposal.");
  const room = r6(deposit - pos.claimed);
  if (amount > room + 1e-9) fail(`You can claim up to ${room} more credits in this proposal.`);
  const s = clone(prev);
  const p = s.round.positions[index];
  p.credits = r6(p.credits + amount);
  p.claimed = r6(p.claimed + amount);
  return s;
}

/** Claim the remaining capacity in every proposal. */
export function claimAll(prev: SimState): SimState {
  requireConnected(prev);
  requireOpen(prev);
  const deposit = prev.round.userDeposit;
  if (deposit === null) fail("Deposit first, then claim credits in each proposal.");
  const s = clone(prev);
  for (const p of s.round.positions) {
    const room = r6(deposit - p.claimed);
    if (room > 0) {
      p.credits = r6(p.credits + room);
      p.claimed = r6(p.claimed + room);
    }
  }
  return s;
}

/** Buy or sell LONG/SHORT in one proposal's market. */
export function trade(
  prev: SimState,
  index: number,
  action: TradeAction,
  side: Side,
  amount: number,
): SimState {
  requireConnected(prev);
  requireOpen(prev);
  requireAmount(amount);
  const proposal = prev.round.proposals[index];
  const pos = prev.round.positions[index];
  if (!proposal || !pos) fail("Unknown proposal.");

  const quote =
    action === "buy"
      ? quoteBuy(proposal.reserves, side, amount)
      : quoteSell(proposal.reserves, side, amount);
  if (!quote) fail("Enter an amount greater than zero.");

  if (action === "buy" && amount > pos.credits + 1e-9) {
    fail("Not enough credits in this market. Claim more credits first.");
  }
  if (action === "sell") {
    const held = side === "LONG" ? pos.long : pos.short;
    if (amount > held + 1e-9) fail(`You only hold ${held.toFixed(4)} ${side} here.`);
  }
  if (quote.out < quote.minOut) fail("Price moved beyond 0.5% slippage.");

  const s = clone(prev);
  const p = s.round.proposals[index];
  const q = s.round.positions[index];
  p.reserves = quote.reservesAfter;
  p.samples.push(pLongOf(p.reserves));
  if (action === "buy") {
    q.credits = r6(q.credits - amount);
    if (side === "LONG") q.long = r6(q.long + quote.out);
    else q.short = r6(q.short + quote.out);
  } else {
    q.credits = r6(q.credits + quote.out);
    if (side === "LONG") q.long = r6(q.long - amount);
    else q.short = r6(q.short - amount);
  }
  return s;
}
