import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { forecasterStatsOf, latestRationaleOf, proposerStatsOf, winningReturns, type ForecasterEvents, type RoundEvents } from "./agentStats";

const A = "0x927751387951B69390151f34f3dD756A624Abc0D" as Address;
const B = "0x2901AB7721217a1733B744009847DFE3d9f70E25" as Address;
const Q = "0x66617018c7d91e1345eA9F51b44a062aad2D439e" as Address;

let n = 0n;
const base = (blockNumber: bigint) => ({
  address: A,
  blockNumber,
  logIndex: n++,
  timeStamp: 0n,
  topics: [] as Hex[],
  data: "0x" as Hex,
  transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
});
const e18 = (x: number) => BigInt(Math.round(x * 1e18));

const rounds: RoundEvents = {
  proposals: [
    { ...base(1n), args: { roundId: 1n, proposalId: 1n, proposer: A, tEthBps: 5000, rationale: "round one" } },
    { ...base(1n), args: { roundId: 1n, proposalId: 2n, proposer: B, tEthBps: 2000, rationale: "b one" } },
    { ...base(5n), args: { roundId: 2n, proposalId: 1n, proposer: A, tEthBps: 6000, rationale: "round two" } },
    { ...base(5n), args: { roundId: 2n, proposalId: 2n, proposer: B, tEthBps: 1000, rationale: "b two" } },
  ],
  collapsed: [
    { ...base(3n), args: { roundId: 1n, winnerId: 1n } },
    { ...base(7n), args: { roundId: 2n, winnerId: 2n } },
  ],
  settled: [{ ...base(4n), args: { roundId: 1n, realisedReturn: e18(1.02), pi: 0n, emergency: false } }],
};

describe("proposer stats", () => {
  test("average winning return counts only settled rounds the agent won", () => {
    expect(winningReturns(A, rounds)).toHaveLength(1);
    expect(winningReturns(A, rounds)[0]).toBeCloseTo(0.02, 10);
    expect(winningReturns(B, rounds)).toHaveLength(0);
  });

  test("latest rationale is the newest proposal", () => {
    expect(latestRationaleOf(A, rounds)?.text).toBe("round two");
    expect(latestRationaleOf(A, rounds)?.roundId).toBe(2n);
    expect(latestRationaleOf(Q, rounds)).toBeNull();
  });

  test("combines registry counters with event-derived values", () => {
    const s = proposerStatsOf(A, rounds, { proposalsMade: 2, roundsWon: 1, name: "Momentum" });
    expect(s.proposalsMade).toBe(2);
    expect(s.registeredName).toBe("Momentum");
    expect(s.avgWinningReturn).toBeCloseTo(0.02, 10);
    expect(proposerStatsOf(B, rounds, null).avgWinningReturn).toBeNull();
  });
});

describe("forecaster stats", () => {
  const ev: ForecasterEvents = {
    deposited: [
      { ...base(2n), args: { roundId: 1n, user: Q, amount: 10_000_000n } },
      { ...base(6n), args: { roundId: 2n, user: Q, amount: 5_000_000n } },
      { ...base(2n), args: { roundId: 1n, user: B, amount: 99_000_000n } },
    ],
    redeemed: [{ ...base(4n), args: { roundId: 1n, user: Q, payout: 10_500_000n } }],
    bought: [
      { ...base(3n), args: { roundId: 1n, proposalId: 1n, user: Q } },
      { ...base(6n), args: { roundId: 2n, proposalId: 1n, user: Q } },
    ],
    sold: [{ ...base(3n), args: { roundId: 1n, proposalId: 1n, user: Q } }],
  };

  test("P&L is redeemed minus deposited over settled rounds only", () => {
    const s = forecasterStatsOf(Q, ev, new Set([1n]));
    expect(s.pnl).toBe(500_000n);
    expect(s.settledRounds).toBe(1);
    expect(s.unredeemedRounds).toBe(0);
  });

  test("counts rounds participated and trades across all rounds", () => {
    const s = forecasterStatsOf(Q, ev, new Set([1n]));
    expect(s.roundsParticipated).toBe(2);
    expect(s.trades).toBe(3);
  });

  test("a settled round with a deposit and no redeem is flagged as unredeemed", () => {
    const s = forecasterStatsOf(Q, { ...ev, redeemed: [] }, new Set([1n]));
    expect(s.pnl).toBe(-10_000_000n);
    expect(s.unredeemedRounds).toBe(1);
  });

  test("ignores other users' events", () => {
    expect(forecasterStatsOf(A, ev, new Set([1n])).trades).toBe(0);
  });
});

import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { quantumRoundAbi } from "@/abis";
import { buildAgentStats } from "./agentStats";
import type { ExplorerLog } from "./explorer";

const MOMENTUM = "0x927751387951B69390151f34f3dD756A624Abc0D" as Address;
const QUANT = "0x66617018c7d91e1345eA9F51b44a062aad2D439e" as Address;

function rawLog(name: string, args: Record<string, unknown>, block: bigint): ExplorerLog {
  const item = getAbiItem({ abi: quantumRoundAbi, name } as never) as unknown as {
    inputs: { name: string; type: string; indexed: boolean }[];
  };
  const topics = encodeEventTopics({ abi: quantumRoundAbi, eventName: name, args } as never);
  const data = item.inputs.filter((i) => !i.indexed);
  return {
    address: A,
    blockNumber: block,
    logIndex: n++,
    timeStamp: 0n,
    topics: topics as Hex[],
    data: data.length
      ? encodeAbiParameters(
          data as never,
          data.map((i) => args[i.name]) as never,
        )
      : "0x",
    transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
  };
}

describe("buildAgentStats from encoded logs", () => {
  test("decodes real event encodings end to end", () => {
    const logs = [
      rawLog("ProposalCreated", { roundId: 1n, proposalId: 1n, proposer: MOMENTUM, tEthBps: 6000, rationale: "Trend is up." }, 10n),
      rawLog("Deposited", { roundId: 1n, user: QUANT, amount: 8_000_000n }, 11n),
      rawLog("Bought", { roundId: 1n, proposalId: 1n, user: QUANT, isLong: true, credits: 1_000_000n, tokensOut: 2n }, 12n),
      rawLog("Collapsed", { roundId: 1n, winnerId: 1n, probabilities: [500000000000000000n, 600000000000000000n] }, 13n),
      rawLog("RoundSettled", { roundId: 1n, realisedReturn: e18(1.05), pi: e18(0.7), emergency: false }, 14n),
      rawLog("Redeemed", { roundId: 1n, user: QUANT, payout: 9_000_000n }, 15n),
    ];
    const s = buildAgentStats(logs, [{ proposalsMade: 1, roundsWon: 1, name: "Momentum" }, null, null]);
    const m = s.proposers[MOMENTUM.toLowerCase()];
    expect(m.latestRationale?.text).toBe("Trend is up.");
    expect(m.avgWinningReturn).toBeCloseTo(0.05, 10);
    expect(m.roundsWon).toBe(1);
    const q = s.forecasters[QUANT.toLowerCase()];
    expect(q.pnl).toBe(1_000_000n);
    expect(q.trades).toBe(1);
    expect(q.roundsParticipated).toBe(1);
  });
});
