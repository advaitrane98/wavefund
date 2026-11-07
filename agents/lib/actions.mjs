// Turns a decision into the ordered contract calls an agent has to make (approvals, registration, deposit, trade).
import { maxUint256 } from 'viem';
import { abis, loadBook } from './chain.mjs';
import { erc20Abi } from '../../scripts/demo-round-common.mjs';

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

/**
 * Forecaster: make sure the round has enough deposit and CREDIT in the proposal, then buy LONG or SHORT.
 * `have` = { deposit, claimed, credits } for this agent on this proposal; `credits` is the trade size (6 decimals).
 */
export function tradeSteps({ state, roundId, proposalId, credits, long, have }) {
  const book = loadBook();
  const A = abis();
  const steps = [];
  const needDeposit = have.claimed + credits > have.deposit ? have.claimed + credits - have.deposit : 0n;
  const needClaim = have.credits < credits ? credits - have.credits : 0n;
  if (needDeposit > 0n) {
    if (state.roundAllowance < needDeposit) {
      steps.push({ label: 'approve round deposit', to: book.c.USDC, abi: erc20Abi, functionName: 'approve', args: [book.c.QuantumRound, needDeposit] });
    }
    steps.push({ label: 'deposit', to: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'deposit', args: [roundId, needDeposit] });
  }
  if (needClaim > 0n) {
    steps.push({ label: `claim ${needClaim} credits`, to: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'claimCredits', args: [roundId, BigInt(proposalId), needClaim] });
  }
  // Buying always returns at least the complete set (credits * 1e12 raw units), so that is a safe floor.
  steps.push({
    label: `buy ${long ? 'LONG' : 'SHORT'} ${credits}`, to: book.c.QuantumRound, abi: A.QuantumRound,
    functionName: long ? 'buyLong' : 'buyShort', args: [roundId, BigInt(proposalId), credits, credits * 10n ** 12n],
  });
  return steps;
}

export { maxUint256 };
