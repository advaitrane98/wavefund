import type { Address, Hash } from "viem";
import type { RoundPhase } from "./logic";

export interface ProposalView {
  id: number;
  isStatusQuo: boolean;
  proposer: Address | null;
  proposerName: string | null;
  tEthBps: number;
  /** Credits (6 decimals) the market was seeded with. */
  seedCredits: bigint;
  rationale: string;
  /** 1e18 fixed point. */
  pLong: bigint;
  pShort: bigint;
  /** Final-window TWAP of pLong, 1e18. */
  twap: bigint;
  /** Fraction change, e.g. 0.034 = +3.4%. */
  impliedReturn: number;
  tokens: { credit: Address; long: Address; short: Address };
  /** The connected user's balances in this market. */
  user: { credits: bigint; long: bigint; short: bigint; claimed: bigint };
}

export interface RoundView {
  id: number;
  status: number;
  phase: RoundPhase;
  tradingStart: number;
  tradingEnd: number;
  evaluationEnd: number;
  twapWindow: number;
  rMin: bigint;
  rMax: bigint;
  proposalCount: number;
  winnerId: number;
  realisedReturn: bigint;
  /** LONG pays pi credits, SHORT pays 1 - pi (1e18). */
  pi: bigint;
  totalDeposits: bigint;
  proposals: ProposalView[];
  user: { deposit: bigint; redeemed: boolean; previewRedeem: bigint };
}

export interface VaultView {
  navUsdc: bigint;
  totalVaultUsdc: bigint;
  totalVaultTEth: bigint;
  queuedDepositsUsdc: bigint;
  queuedWithdrawShares: bigint;
  /** Raw USDC per 1e18 shares. */
  sharePriceUsdc: bigint;
  totalSupply: bigint;
  /** Raw USDC (6 decimals) per 1 tETH. */
  oraclePriceUsdc: bigint;
  poolPriceUsdc: bigint;
  tEthBps: number;
  oracleUpdatedAt: number | null;
  unreportedRound: number;
  user: {
    wave: bigint;
    depositRequest: bigint;
    withdrawRequest: bigint;
    claimableShares: bigint;
    claimableUsdcFromEpochs: bigint;
    claimableUsdc: bigint;
  };
}

export interface UserView {
  usdc: bigint;
  usdcAllowanceRound: bigint;
  usdcAllowanceVault: bigint;
  pendingPayout: bigint;
}

export interface Snapshot {
  blockNumber: bigint;
  blockTimestamp: number;
  fetchedAtMs: number;
  /** Seconds to add to Date.now()/1000 to get chain time. */
  clockSkew: number;
  currentRoundId: number;
  round: RoundView | null;
  vault: VaultView;
  user: UserView | null;
}

export interface HistoryRow {
  roundId: number;
  status: number;
  phase: RoundPhase;
  winnerId: number;
  winnerName: string;
  winnerTEthBps: number;
  statusQuoTEthBps: number;
  startValueUsdc: bigint;
  executed: boolean;
  reported: boolean;
  cancelled: boolean;
  realisedReturn: bigint;
  /** Transaction that executed the vault trade, when found. */
  tradeTx: Hash | null;
}
