/**
 * Types for the simulated (mock) workspace.
 * Amounts are plain numbers in human units (USDC 6 dp, credits 6 dp).
 * One credit = one complete set = 1 LONG + 1 SHORT.
 */

export type Side = "LONG" | "SHORT";
export type TradeAction = "buy" | "sell";
export type ProposalType = "Protocol" | "Agent";
export type RoundStatus = "open" | "collapsed" | "settled";

export interface Reserves {
  long: number;
  short: number;
}

export interface Proposal {
  index: number;
  name: string;
  /** Short descriptor, for example "Momentum agent". */
  kind: string;
  type: ProposalType;
  agentId: string | null;
  /** Target allocation: fraction held in tETH, the rest in USDC. */
  tethShare: number;
  reserves: Reserves;
  /** pLong samples, newest last. The final-window TWAP uses the last 12. */
  samples: number[];
}

/** Your position in one proposal's market. */
export interface Position {
  /** Unspent credits in this market. */
  credits: number;
  /** Cumulative credits claimed in this market. */
  claimed: number;
  long: number;
  short: number;
}

export interface CollapseResult {
  twaps: number[];
  statusQuoTwap: number;
  winnerTwap: number;
  executedAt: number;
}

export interface Settlement {
  enteredReturn: number;
  payoutReturn: number;
  /** LONG pays this many credits, SHORT pays 1 minus this. */
  price: number;
  settledAt: number;
}

export interface Round {
  id: number;
  status: RoundStatus;
  rMin: number;
  rMax: number;
  /** Margin a proposal's TWAP must beat the status quo by. */
  margin: number;
  seed: number;
  proposals: Proposal[];
  winner: number | null;
  /** Credits deposited into the round, or null before you deposit. */
  userDeposit: number | null;
  positions: Position[];
  collapse: CollapseResult | null;
  settlement: Settlement | null;
  /** USDC returned when you redeemed, or null. */
  redeemed: number | null;
}

export interface QueuedDeposit {
  id: number;
  usdc: number;
  at: number;
}

export interface QueuedWithdrawal {
  id: number;
  shares: number;
  at: number;
}

export interface Decision {
  round: number;
  at: number;
  winnerName: string;
  winnerType: ProposalType;
  /** True when the status quo (proposal 0) was kept. */
  keptStatusQuo: boolean;
  prevTethShare: number;
  newTethShare: number;
  statusQuoTwap: number;
  winnerTwap: number;
  navAfter: number;
  settledReturn: number | null;
  illustrative: boolean;
}

export interface Vault {
  usdc: number;
  teth: number;
  /** Oracle price of 1 tETH in USDC. */
  oracle: number;
  /** Uniswap v4 pool price of 1 tETH in USDC. */
  poolPrice: number;
  totalShares: number;
  userShares: number;
  queuedDeposits: QueuedDeposit[];
  queuedWithdrawals: QueuedWithdrawal[];
  decisions: Decision[];
}

export interface SimState {
  version: 1;
  connected: boolean;
  /** Demo USDC wallet balance (ERC-20 view). */
  usdc: number;
  round: Round;
  pastRounds: Round[];
  vault: Vault;
  nextId: number;
}

export type SimResult = { ok: true } | { ok: false; error: string };
