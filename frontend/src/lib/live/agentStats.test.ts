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
