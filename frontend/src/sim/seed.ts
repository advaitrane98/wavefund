import { AGENTS } from "./agents";
import { makeRng } from "./rng";
import type { Decision, Proposal, Round, SimState, Vault } from "./types";

export const START_USDC = 10_000;
export const FAUCET_USDC = 1_000;
export const POOL_DEPTH = 5_000;
export const MARGIN = 0.005;
export const R_MIN = -0.1;
export const R_MAX = 0.1;
export const FIRST_ROUND = 11;

const SAMPLE_COUNT = 12;

function makeProposal(
  index: number,
  base: Omit<Proposal, "index" | "reserves" | "samples">,
  prior: number,
): Proposal {
  // pLong = short / (long + short); reserves sum to 2 * depth.
  const short = 2 * POOL_DEPTH * prior;
  const long = 2 * POOL_DEPTH * (1 - prior);
  return {
    ...base,
    index,
    reserves: { long, short },
    samples: Array.from({ length: SAMPLE_COUNT }, () => prior),
  };
}

/** Build a fresh round. Proposal 0 is always the protocol status quo. */
export function makeRound(id: number, seed: number, currentTethShare: number): Round {
  const rng = makeRng(seed);
  const pool = [...AGENTS];
  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }

  const proposals: Proposal[] = [
    makeProposal(
      0,
      {
        name: "Keep current allocation (Protocol)",
        kind: "Status quo",
        type: "Protocol",
        agentId: null,
        tethShare: currentTethShare,
      },
      0.5,
    ),
    ...picked.map((agent, i) => {
      const jitter = Math.round((rng() - 0.5) * 10) / 100; // -0.05..0.05
      const share = Math.min(0.8, Math.max(0.3, agent.baseTethShare + jitter));
      const prior = 0.46 + rng() * 0.14; // 0.46..0.60
      return makeProposal(
        i + 1,
        {
          name: agent.name,
          kind: agent.kind,
          type: "Agent",
          agentId: agent.id,
          tethShare: Math.round(share * 100) / 100,
        },
        Math.round(prior * 1000) / 1000,
      );
    }),
  ];

  return {
    id,
    status: "open",
    rMin: R_MIN,
    rMax: R_MAX,
    margin: MARGIN,
    seed,
    proposals,
    winner: null,
    userDeposit: null,
    positions: proposals.map(() => ({ credits: 0, claimed: 0, long: 0, short: 0 })),
    collapse: null,
    settlement: null,
    redeemed: null,
  };
}

const ILLUSTRATIVE_HISTORY: Decision[] = [
  {
    round: 10,
    at: Date.UTC(2026, 9, 29, 12, 0),
    winnerName: "Macro Lens",
    winnerType: "Agent",
    keptStatusQuo: false,
    prevTethShare: 0.55,
    newTethShare: 0.38,
    statusQuoTwap: 0.5,
    winnerTwap: 0.534,
    navAfter: 243_880,
    settledReturn: 0.012,
    illustrative: true,
  },
  {
    round: 9,
    at: Date.UTC(2026, 9, 22, 12, 0),
    winnerName: "Keep current allocation (Protocol)",
    winnerType: "Protocol",
    keptStatusQuo: true,
    prevTethShare: 0.55,
    newTethShare: 0.55,
    statusQuoTwap: 0.51,
    winnerTwap: 0.511,
    navAfter: 241_020,
    settledReturn: -0.004,
    illustrative: true,
  },
  {
    round: 8,
    at: Date.UTC(2026, 9, 15, 12, 0),
    winnerName: "Momentum-7",
    winnerType: "Agent",
    keptStatusQuo: false,
    prevTethShare: 0.42,
    newTethShare: 0.55,
    statusQuoTwap: 0.5,
    winnerTwap: 0.562,
    navAfter: 242_000,
    settledReturn: 0.027,
    illustrative: true,
  },
];

export function makeVault(): Vault {
  return {
    usdc: 100_000,
    teth: 60,
    oracle: 2_500,
    poolPrice: 2_498,
    totalShares: 250_000,
    userShares: 0,
    queuedDeposits: [],
    queuedWithdrawals: [],
    decisions: ILLUSTRATIVE_HISTORY.map((d) => ({ ...d })),
  };
}

export const navOf = (v: Vault): number => v.usdc + v.teth * v.oracle;
export const tethShareOf = (v: Vault): number => (v.teth * v.oracle) / navOf(v);

export function initialState(): SimState {
  const vault = makeVault();
  return {
    version: 1,
    connected: false,
    usdc: 0,
    round: makeRound(FIRST_ROUND, 20_260_011, tethShareOf(vault)),
    pastRounds: [],
    vault,
    nextId: 1,
  };
}
