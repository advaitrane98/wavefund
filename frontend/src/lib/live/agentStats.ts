import { type Address, type Hex, getAbiItem, toEventSelector } from "viem";
import { proposerRegistryAbi, quantumRoundAbi } from "@/abis";
import { agentByAddress, forecasterAgents, proposerAgents } from "@/config/agents";
import { deployment } from "@/config/contracts";
import { type DecodedLog, decodeLogs, fetchLogs, newestFirst } from "./explorer";
import type { PublicClient } from "viem";

// ------------------------------------------------------------------ event shapes

type ProposalCreated = DecodedLog<{
  roundId: bigint;
  proposalId: bigint;
  proposer: Address;
  tEthBps: number;
  rationale: string;
}>;
type Collapsed = DecodedLog<{ roundId: bigint; winnerId: bigint }>;
type RoundSettled = DecodedLog<{ roundId: bigint; realisedReturn: bigint; pi: bigint; emergency: boolean }>;
type Deposited = DecodedLog<{ roundId: bigint; user: Address; amount: bigint }>;
type Redeemed = DecodedLog<{ roundId: bigint; user: Address; payout: bigint }>;
type Traded = DecodedLog<{ roundId: bigint; proposalId: bigint; user: Address }>;

export interface RoundEvents {
  proposals: ProposalCreated[];
  collapsed: Collapsed[];
  settled: RoundSettled[];
}

export interface ForecasterEvents {
  deposited: Deposited[];
  redeemed: Redeemed[];
  bought: Traded[];
  sold: Traded[];
}

// ------------------------------------------------------------------ results

export interface LatestRationale {
  text: string;
  roundId: bigint;
  proposalId: bigint;
  txHash: Hex;
}

export interface ProposerStats {
  address: Address;
  /** From ProposerRegistry.agents(). Null when the registry could not be read. */
  proposalsMade: number | null;
  roundsWon: number | null;
  /** Name registered on-chain, if the agent registered. */
  registeredName: string | null;
  /** Mean realised return (as a fraction, 0.01 = +1%) of this agent's winning proposals in settled rounds. */
  avgWinningReturn: number | null;
  /** Settled rounds this agent won, the sample behind avgWinningReturn. */
  settledWins: number;
  latestRationale: LatestRationale | null;
}

export interface ForecasterStats {
  address: Address;
  /** Redeemed minus deposited (USDC, 6 decimals) over settled rounds. */
  pnl: bigint;
  settledRounds: number;
  /** Settled rounds with a deposit that has not been redeemed yet. */
  unredeemedRounds: number;
  roundsParticipated: number;
  /** Bought plus Sold events. */
  trades: number;
}

export interface AgentStats {
  proposers: Record<string, ProposerStats>;
  forecasters: Record<string, ForecasterStats>;
  fetchedAt: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ------------------------------------------------------------------ pure computation

/** Realised returns (fractions) of the settled rounds this proposer won. */
export function winningReturns(address: Address, ev: RoundEvents): number[] {
  const out: number[] = [];
  for (const s of ev.settled) {
    const collapse = newestFirst(ev.collapsed.filter((c) => c.args.roundId === s.args.roundId))[0];
    if (!collapse) continue;
    const winner = ev.proposals.find(
      (p) => p.args.roundId === s.args.roundId && p.args.proposalId === collapse.args.winnerId,
    );
    if (winner && same(winner.args.proposer, address)) out.push(Number(s.args.realisedReturn) / 1e18 - 1);
  }
  return out;
}

export function latestRationaleOf(address: Address, ev: RoundEvents): LatestRationale | null {
  const latest = newestFirst(ev.proposals.filter((p) => same(p.args.proposer, address)))[0];
  if (!latest) return null;
  return {
    text: latest.args.rationale,
    roundId: latest.args.roundId,
    proposalId: latest.args.proposalId,
    txHash: latest.transactionHash,
  };
}

export function proposerStatsOf(
  address: Address,
  ev: RoundEvents,
  registry: { proposalsMade: number; roundsWon: number; name: string } | null,
): ProposerStats {
  const wins = winningReturns(address, ev);
  return {
    address,
    proposalsMade: registry ? registry.proposalsMade : null,
    roundsWon: registry ? registry.roundsWon : null,
    registeredName: registry?.name || null,
    avgWinningReturn: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
    settledWins: wins.length,
    latestRationale: latestRationaleOf(address, ev),
  };
}

/** P&L is redeemed minus deposited, counting only rounds that settled. */
export function forecasterStatsOf(
  address: Address,
  ev: ForecasterEvents,
  settledRounds: ReadonlySet<bigint>,
): ForecasterStats {
  const mine = <T extends { args: { user: Address } }>(l: T[]) => l.filter((x) => same(x.args.user, address));
  const deposited = mine(ev.deposited);
  const redeemed = mine(ev.redeemed);
  const bought = mine(ev.bought);
  const sold = mine(ev.sold);

  const rounds = new Set<bigint>();
  for (const l of [...deposited, ...bought, ...sold]) rounds.add(l.args.roundId);

  let dep = 0n;
  let red = 0n;
  const depositedSettled = new Set<bigint>();
  const redeemedSettled = new Set<bigint>();
  for (const d of deposited) {
    if (!settledRounds.has(d.args.roundId)) continue;
    dep += d.args.amount;
    depositedSettled.add(d.args.roundId);
  }
  for (const r of redeemed) {
    if (!settledRounds.has(r.args.roundId)) continue;
    red += r.args.payout;
    redeemedSettled.add(r.args.roundId);
  }
  let unredeemed = 0;
  for (const id of depositedSettled) if (!redeemedSettled.has(id)) unredeemed++;

  return {
    address,
    pnl: red - dep,
    settledRounds: depositedSettled.size,
    unredeemedRounds: unredeemed,
    roundsParticipated: rounds.size,
    trades: bought.length + sold.length,
  };
}

// ------------------------------------------------------------------ fetching

const selector = (name: string) => toEventSelector(getAbiItem({ abi: quantumRoundAbi, name } as never) as never);

async function inBatches<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += size) {
    out.push(...(await Promise.all(tasks.slice(i, i + size).map((t) => t()))));
  }
  return out;
}

/**
 * Agent stats from the explorer API (events) and ProposerRegistry (counters).
 * Throws when the explorer API cannot be reached, so the caller can keep the last good data.
 */
export async function fetchAgentStats(client: PublicClient): Promise<AgentStats> {
  const qr = deployment.addresses.quantumRound;
  const registry = deployment.addresses.registry;
  if (!qr) throw new Error("QuantumRound is not in the address book");
  const fromBlock = deployment.deployBlock ?? 0n;

  const logs = (name: string, user?: Address, pos?: 2 | 3) =>
    fetchLogs({
      address: qr,
      topic0: selector(name),
      topics: user && pos ? { [pos]: user } : undefined,
      fromBlock,
    });

  // Round-wide events first.
  const [proposalLogs, collapsedLogs, settledLogs] = await inBatches(
    [() => logs("ProposalCreated"), () => logs("Collapsed"), () => logs("RoundSettled")],
    3,
  );
  const roundEvents: RoundEvents = {
    proposals: decodeLogs(quantumRoundAbi, "ProposalCreated", proposalLogs),
    collapsed: decodeLogs(quantumRoundAbi, "Collapsed", collapsedLogs),
    settled: decodeLogs(quantumRoundAbi, "RoundSettled", settledLogs),
  };
  const settledRounds = new Set(roundEvents.settled.map((s) => s.args.roundId));

  // Registry counters for every proposer in agents.json.
  const registryRows: ({ proposalsMade: number; roundsWon: number; name: string } | null)[] =
    registry && proposerAgents.length
      ? (
          (await client.multicall({
            contracts: proposerAgents.map((a) => ({
              address: registry,
              abi: proposerRegistryAbi,
              functionName: "agents",
              args: [a.address],
            })) as never,
            allowFailure: true,
          })) as { status: string; result?: readonly unknown[] }[]
        ).map((r) =>
          r.status === "success" && r.result
            ? { name: String(r.result[0]), proposalsMade: Number(r.result[3]), roundsWon: Number(r.result[4]) }
            : null,
        )
      : proposerAgents.map(() => null);

  const proposers: Record<string, ProposerStats> = {};
  proposerAgents.forEach((a, i) => {
    proposers[a.address.toLowerCase()] = proposerStatsOf(a.address, roundEvents, registryRows[i] ?? null);
  });

  // Forecaster events, a few requests at a time to stay under the explorer's rate limit.
  const forecasters: Record<string, ForecasterStats> = {};
  for (const a of forecasterAgents) {
    const [dep, red, buy, sell] = await inBatches(
      [
        () => logs("Deposited", a.address, 2),
        () => logs("Redeemed", a.address, 2),
        () => logs("Bought", a.address, 3),
        () => logs("Sold", a.address, 3),
      ],
      2,
    );
    forecasters[a.address.toLowerCase()] = forecasterStatsOf(
      a.address,
      {
        deposited: decodeLogs(quantumRoundAbi, "Deposited", dep),
        redeemed: decodeLogs(quantumRoundAbi, "Redeemed", red),
        bought: decodeLogs(quantumRoundAbi, "Bought", buy),
        sold: decodeLogs(quantumRoundAbi, "Sold", sell),
      },
      settledRounds,
    );
  }

  return { proposers, forecasters, fetchedAt: Date.now() };
}

/** Registered agents.json name for an address, if any. Used by cards that only know the proposer address. */
export const agentName = (address: string | null | undefined) => agentByAddress(address)?.name ?? null;
