// Turns a decision into the ordered contract calls an agent has to make (approvals, registration, deposit, trade).
import { maxUint256 } from 'viem';
import { abis, loadBook } from './chain.mjs';
import { erc20Abi } from '../../scripts/demo-round-common.mjs';
import { FORECASTER_DEPOSIT } from './config.mjs';

/** Proposer: register once, approve the registry for the bond, then propose. */
export function proposeSteps({ agentDef, state, roundId, tEthBps, rationale }) {
  const book = loadBook();
  const A = abis();
  const steps = [];
  if (!state.registered) {
    steps.push({ label: 'register agent', to: book.c.ProposerRegistry, abi: A.ProposerRegistry, functionName: 'registerAgent', args: [agentDef.name] });
  }
  if (state.bondAllowance < 1_000_000n) {
    steps.push({ label: 'approve bond', to: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [book.c.ProposerRegistry, 1_000_000n] });
  }
  steps.push({
    label: `propose ${tEthBps} bps`, to: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'propose',
    args: [roundId, { tEthBps }, rationale.slice(0, 280)],
  });
  return steps;
}

export class PlanError extends Error {
  constructor(message, code = 'plan') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * Forecaster BUY. One deposit per round (FORECASTER_DEPOSIT, once), then credits are claimed INDEPENDENTLY in each proposal
 * that is traded (the contract caps claimed(r,p,user) <= deposit(r,user) per proposal), then the buy itself.
 *   have = { deposit, claimed, credits }  this agent's deposit in the round, credits already claimed in THIS proposal, and its
 *          credit-token balance in this proposal (credits left over from earlier claims or sells are reused, not claimed again).
 *   minOut  raw units of the bought token, ALWAYS derived from a fresh adapter quote by the caller (quote * 995 / 1000).
 * Returns { steps, deposit, claim } so callers can also update their own (dry-run) bookkeeping.
 */
export function tradeSteps({ state, roundId, proposalId, credits, long, have, minOut, depositAmount = FORECASTER_DEPOSIT }) {
  if (typeof minOut !== 'bigint' || minOut <= 0n) throw new PlanError('minOut must come from a fresh adapter quote (quote * 995 / 1000)', 'no-min-out');
  if (credits <= 0n) throw new PlanError('trade size must be positive', 'no-size');
  const book = loadBook();
  const A = abis();
  const steps = [];
  const deposit = have.deposit > 0n ? 0n : depositAmount; // never a second deposit in a round
  const depositAfter = have.deposit + deposit;
  const needClaim = have.credits < credits ? credits - have.credits : 0n;
  if (have.claimed + needClaim > depositAfter) {
    throw new PlanError(`claim of ${needClaim} would exceed the round deposit (${depositAfter}) in proposal ${proposalId}`, 'claim-exceeds-deposit');
  }
  if (deposit > 0n) {
    if (state.roundAllowance < deposit) {
      steps.push({ label: 'approve round deposit', to: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [book.c.QuantumRound, deposit] });
    }
    steps.push({ label: 'deposit', to: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'deposit', args: [roundId, deposit] });
  }
  if (needClaim > 0n) {
    steps.push({ label: `claim ${needClaim} credits in proposal ${proposalId}`, to: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'claimCredits', args: [roundId, BigInt(proposalId), needClaim] });
  }
  steps.push({
    label: `buy ${long ? 'LONG' : 'SHORT'} ${credits}`, to: book.c.QuantumRound, abi: A.QuantumRound,
    functionName: long ? 'buyLong' : 'buyShort', args: [roundId, BigInt(proposalId), credits, minOut],
  });
  return { steps, deposit, claim: needClaim };
}

/** Forecaster SELL of `amountIn` raw LONG/SHORT. `minCredits` (credits, 6 decimals) comes from the adapter's sell quote * 995 / 1000. */
export function sellSteps({ roundId, proposalId, amountIn, long, minCredits }) {
  if (typeof minCredits !== 'bigint' || minCredits < 0n) throw new PlanError('minCredits must come from a fresh adapter quote', 'no-min-out');
  if (amountIn <= 0n) throw new PlanError('sell amount must be positive', 'no-size');
  const book = loadBook();
  return [{
    label: `sell ${long ? 'LONG' : 'SHORT'} ${amountIn}`, to: book.c.QuantumRound, abi: abis().QuantumRound,
    functionName: long ? 'sellLong' : 'sellShort', args: [roundId, BigInt(proposalId), amountIn, minCredits],
  }];
}

/** Redeem a settled (or cancelled) round for the caller. */
export function redeemSteps({ roundId }) {
  const book = loadBook();
  return [{ label: `redeem round ${roundId}`, to: book.c.QuantumRound, abi: abis().QuantumRound, functionName: 'redeem', args: [BigInt(roundId)] }];
}

export { maxUint256 };
