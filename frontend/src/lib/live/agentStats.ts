import { type Address, type Hex, getAbiItem, toEventSelector } from "viem";
import { proposerRegistryAbi, quantumRoundAbi } from "@/abis";
import { agentByAddress, forecasterAgents, proposerAgents } from "@/config/agents";
import { deployment } from "@/config/contracts";
import { type DecodedLog, type ExplorerLog, decodeLogs, fetchLogs, newestFirst } from "./explorer";
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

export interface LogSource {
  logs: ExplorerLog[];
  /** "explorer" normally. "rpc" when the explorer API was rate limited or down. */
  source: "explorer" | "rpc";
}

/**
 * Every QuantumRound event in one explorer request (the explorer's free tier allows few requests,
 * so per-event and per-agent queries would exhaust it). Falls back to the chain RPC if the explorer fails.
 */
export async function loadQuantumRoundLogs(client: PublicClient): Promise<LogSource> {
  const address = deployment.addresses.quantumRound;
  if (!address) throw new Error("QuantumRound is not in the address book");
  const fromBlock = deployment.deployBlock ?? 0n;
  try {
    return { logs: await fetchLogs({ address, fromBlock }), source: "explorer" };
  } catch {
    const raw = await client.getLogs({ address, fromBlock, toBlock: "latest" });
    return {
      source: "rpc",
      logs: raw.map((l) => ({
        address: l.address,
        blockNumber: l.blockNumber ?? 0n,
        logIndex: BigInt(l.logIndex ?? 0),
        timeStamp: 0n,
        topics: l.topics as Hex[],
        data: l.data,
        transactionHash: (l.transactionHash ?? "0x") as Hex,
      })),
    };
  }
}

const ofEvent = (logs: readonly ExplorerLog[], name: string) => {
  const sel = selector(name).toLowerCase();
  return logs.filter((l) => l.topics[0]?.toLowerCase() === sel);
};

/** Pure: turn raw QuantumRound logs and registry rows into the agent stats. */
export function buildAgentStats(
  logs: readonly ExplorerLog[],
  registryRows: ({ proposalsMade: number; roundsWon: number; name: string } | null)[],
): Omit<AgentStats, "fetchedAt"> {
  const roundEvents: RoundEvents = {
    proposals: decodeLogs(quantumRoundAbi, "ProposalCreated", ofEvent(logs, "ProposalCreated")),
    collapsed: decodeLogs(quantumRoundAbi, "Collapsed", ofEvent(logs, "Collapsed")),
    settled: decodeLogs(quantumRoundAbi, "RoundSettled", ofEvent(logs, "RoundSettled")),
  };
  const settledRounds = new Set(roundEvents.settled.map((s) => s.args.roundId));
  const forecasterEvents: ForecasterEvents = {
    deposited: decodeLogs(quantumRoundAbi, "Deposited", ofEvent(logs, "Deposited")),
    redeemed: decodeLogs(quantumRoundAbi, "Redeemed", ofEvent(logs, "Redeemed")),
    bought: decodeLogs(quantumRoundAbi, "Bought", ofEvent(logs, "Bought")),
    sold: decodeLogs(quantumRoundAbi, "Sold", ofEvent(logs, "Sold")),
  };

  const proposers: Record<string, ProposerStats> = {};
  proposerAgents.forEach((a, i) => {
    proposers[a.address.toLowerCase()] = proposerStatsOf(a.address, roundEvents, registryRows[i] ?? null);
  });
  const forecasters: Record<string, ForecasterStats> = {};
  for (const a of forecasterAgents) {
    forecasters[a.address.toLowerCase()] = forecasterStatsOf(a.address, forecasterEvents, settledRounds);
  }
  return { proposers, forecasters };
}

/**
 * Agent stats from QuantumRound events (explorer API) and ProposerRegistry counters (RPC).
 * Throws when neither the explorer nor the RPC can serve the logs, so the caller keeps the last good data.
 */
export async function fetchAgentStats(client: PublicClient): Promise<AgentStats & { source: LogSource["source"] }> {
  const registry = deployment.addresses.registry;
  const [{ logs, source }, rows] = await Promise.all([
    loadQuantumRoundLogs(client),
    registry && proposerAgents.length
      ? (client.multicall({
          contracts: proposerAgents.map((a) => ({
            address: registry,
            abi: proposerRegistryAbi,
            functionName: "agents",
            args: [a.address],
          })) as never,
          allowFailure: true,
        }) as Promise<{ status: string; result?: readonly unknown[] }[]>)
      : Promise.resolve([] as { status: string; result?: readonly unknown[] }[]),
  ]);
  const registryRows = proposerAgents.map((_, i) => {
    const r = rows[i];
    return r?.status === "success" && r.result
      ? { name: String(r.result[0]), proposalsMade: Number(r.result[3]), roundsWon: Number(r.result[4]) }
      : null;
  });
  return { ...buildAgentStats(logs, registryRows), fetchedAt: Date.now(), source };
}

/** Registered agents.json name for an address, if any. Used by cards that only know the proposer address. */
export const agentName = (address: string | null | undefined) => agentByAddress(address)?.name ?? null;
