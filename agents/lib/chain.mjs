// Read-only chain access for the agents: round timings, proposals, market probabilities, balances, allowances.
import { abis, loadBook, publicClient, read, erc20Abi } from '../../scripts/demo-round-common.mjs';
import { snapshot } from '../../scripts/lib/round-actions.mjs';

export { snapshot, loadBook, abis, publicClient };

export async function proposalInfo(roundId, proposalId) {
  const book = loadBook();
  const p = await read(book.c.QuantumRound, abis().QuantumRound, 'proposals', [roundId, BigInt(proposalId)]);
  return { proposer: p[0], tEthBps: Number(p[1]), isStatusQuo: p[2], seedCredits: p[3], bond: p[4], rationale: p[6] };
}

/** Spot pLong (0..1) of a proposal market, or null if it is not seeded yet. */
export async function marketPLong(roundId, proposalId) {
  const book = loadBook();
  try {
    const [pLong] = await read(book.c.WaveV4ProposalMarket, abis().WaveV4ProposalMarket, 'probabilities', [roundId, BigInt(proposalId)]);
    return Number(pLong) / 1e18;
  } catch {
    return null;
  }
}

export async function agentState(address) {
  const book = loadBook();
  const A = abis();
  const [usdc, bondAllowance, roundAllowance, reg] = await Promise.all([
    read(book.c.USDC, erc20Abi, 'balanceOf', [address]),
    read(book.c.USDC, erc20Abi, 'allowance', [address, book.c.ProposerRegistry]),
    read(book.c.USDC, erc20Abi, 'allowance', [address, book.c.QuantumRound]),
    read(book.c.ProposerRegistry, A.ProposerRegistry, 'agents', [address]),
  ]);
  return { usdc, bondAllowance, roundAllowance, registered: reg[0] !== '' && reg[0] != null, registryName: reg[0] };
}

export async function roundDeposit(roundId, address) {
  const book = loadBook();
  return read(book.c.QuantumRound, abis().QuantumRound, 'deposits', [roundId, address]);
}

export async function creditsClaimed(roundId, proposalId, address) {
  const book = loadBook();
  return read(book.c.QuantumRound, abis().QuantumRound, 'creditsClaimed', [roundId, BigInt(proposalId), address]);
}

export async function creditBalance(roundId, proposalId, address) {
  const book = loadBook();
  const token = await read(book.c.ProposalTokens, abis().ProposalTokens, 'creditToken', [roundId, BigInt(proposalId)]);
  return read(token, erc20Abi, 'balanceOf', [address]);
}
