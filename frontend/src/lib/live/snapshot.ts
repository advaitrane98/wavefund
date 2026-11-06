import { erc20Abi, type Abi, type Address, type Hash, type PublicClient } from "viem";
import { USDC_ADDRESS } from "@/lib/chain";
import {
  marketAbi,
  oracleAbi,
  proposalTokensAbi,
  quantumRoundAbi,
  registryAbi,
  vaultAbi,
} from "@/generated/abis";
import { deployment } from "@/lib/contracts";
import { computePhase, impliedReturn } from "./logic";
import type { HistoryRow, ProposalView, RoundView, Snapshot, UserView, VaultView } from "./types";

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

export interface LiveAddresses {
  quantumRound: Address;
  market: Address;
  vault: Address;
  registry: Address;
  tokens: Address;
}

export function liveAddresses(): LiveAddresses | null {
  const a = deployment.addresses;
  if (!a.quantumRound || !a.market || !a.vault || !a.registry || !a.tokens) return null;
  return {
    quantumRound: a.quantumRound,
    market: a.market,
    vault: a.vault,
    registry: a.registry,
    tokens: a.tokens,
  };
}

/** One Multicall3 request. A failed call throws when `strict`, otherwise yields undefined. */
async function batch(client: PublicClient, calls: Call[], strict = true): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const results = (await client.multicall({
    contracts: calls as never,
    allowFailure: true,
  })) as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
  return results.map((r) => {
    if (r.status === "success") return r.result;
    if (strict) throw r.error;
    return undefined;
  });
}

// Token addresses and proposer names never change once set, so they are cached.
const tokenCache = new Map<string, { credit: Address; long: Address; short: Address }>();
const nameCache = new Map<string, string>();

const big = (x: unknown): bigint => (typeof x === "bigint" ? x : BigInt((x as number | undefined) ?? 0));

export async function fetchSnapshot(client: PublicClient, account: Address | null): Promise<Snapshot> {
  const addr = liveAddresses();
  if (!addr) throw new Error("No deployment");
  const { quantumRound: qr, market, vault, registry, tokens } = addr;

  // Wave 1: block, round counter, vault and user globals.
  const wave1: Call[] = [
    { address: qr, abi: quantumRoundAbi as Abi, functionName: "currentRoundId" },
    { address: vault, abi: vaultAbi as Abi, functionName: "navUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "totalVaultUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "totalVaultTEth" },
    { address: vault, abi: vaultAbi as Abi, functionName: "queuedDepositsUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "queuedWithdrawShares" },
    { address: vault, abi: vaultAbi as Abi, functionName: "sharePriceUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "totalSupply" },
    { address: vault, abi: vaultAbi as Abi, functionName: "oraclePriceTEthInUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "spotPriceTEthInUsdc" },
    { address: vault, abi: vaultAbi as Abi, functionName: "currentTEthBps" },
    { address: vault, abi: vaultAbi as Abi, functionName: "unreportedRound" },
    { address: vault, abi: vaultAbi as Abi, functionName: "oracle" },
  ];
  const userCalls: Call[] = account
    ? [
        { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account, qr] },
        { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [account, vault] },
        { address: qr, abi: quantumRoundAbi as Abi, functionName: "pendingPayout", args: [account] },
        { address: vault, abi: vaultAbi as Abi, functionName: "balanceOf", args: [account] },
        { address: vault, abi: vaultAbi as Abi, functionName: "depositRequest", args: [account] },
        { address: vault, abi: vaultAbi as Abi, functionName: "withdrawRequest", args: [account] },
        { address: vault, abi: vaultAbi as Abi, functionName: "claimable", args: [account] },
        { address: vault, abi: vaultAbi as Abi, functionName: "claimableUsdc", args: [account] },
      ]
    : [];

  const [block, w1] = await Promise.all([
    client.getBlock(),
    batch(client, [...wave1, ...userCalls]),
  ]);
  const fetchedAtMs = Date.now();
  const blockTimestamp = Number(block.timestamp);
  const clockSkew = blockTimestamp - Math.floor(fetchedAtMs / 1000);

  const currentRoundId = Number(w1[0]);
  const oracleAddress = w1[12] as Address;
  const u = w1.slice(13);

  // Wave 2: round data and the oracle timestamp.
  const wave2: Call[] = [{ address: oracleAddress, abi: oracleAbi as Abi, functionName: "latestPrice" }];
  if (currentRoundId > 0) {
    wave2.push({ address: qr, abi: quantumRoundAbi as Abi, functionName: "rounds", args: [BigInt(currentRoundId)] });
    if (account) {
      wave2.push(
        { address: qr, abi: quantumRoundAbi as Abi, functionName: "deposits", args: [BigInt(currentRoundId), account] },
        { address: qr, abi: quantumRoundAbi as Abi, functionName: "redeemed", args: [BigInt(currentRoundId), account] },
        { address: qr, abi: quantumRoundAbi as Abi, functionName: "previewRedeem", args: [BigInt(currentRoundId), account] },
      );
    }
  }
  const w2 = await batch(client, wave2, false);
  const oracleLatest = w2[0] as readonly [bigint, bigint] | undefined;

  const claimable = (u[7] as readonly [bigint, bigint] | undefined) ?? [0n, 0n];
  const vaultView: VaultView = {
    navUsdc: big(w1[1]),
    totalVaultUsdc: big(w1[2]),
    totalVaultTEth: big(w1[3]),
    queuedDepositsUsdc: big(w1[4]),
    queuedWithdrawShares: big(w1[5]),
    sharePriceUsdc: big(w1[6]),
    totalSupply: big(w1[7]),
    oraclePriceUsdc: big(w1[8]),
    poolPriceUsdc: big(w1[9]),
    tEthBps: Number(w1[10]),
    unreportedRound: Number(w1[11]),
    oracleUpdatedAt: oracleLatest ? Number(oracleLatest[1]) : null,
    user: {
      wave: big(u[4]),
      depositRequest: big(u[5]),
      withdrawRequest: big(u[6]),
      claimableShares: claimable[0],
      claimableUsdcFromEpochs: claimable[1],
      claimableUsdc: big(u[8]),
    },
  };
  const userView: UserView | null = account
    ? {
        usdc: big(u[0]),
        usdcAllowanceRound: big(u[1]),
        usdcAllowanceVault: big(u[2]),
        pendingPayout: big(u[3]),
      }
    : null;

  let round: RoundView | null = null;
  if (currentRoundId > 0 && w2[1]) {
    const rd = w2[1] as readonly unknown[];
    const proposalCount = Number(rd[7]);
    const roundId = BigInt(currentRoundId);

    // Wave 3: proposals, probabilities, TWAPs, and token addresses not yet cached.
    const wave3: Call[] = [];
    const slots: { kind: string; p: number }[] = [];
    for (let p = 0; p < proposalCount; p += 1) {
      const pid = BigInt(p);
      wave3.push({ address: qr, abi: quantumRoundAbi as Abi, functionName: "proposals", args: [roundId, pid] });
      slots.push({ kind: "proposal", p });
      wave3.push({ address: market, abi: marketAbi as Abi, functionName: "probabilities", args: [roundId, pid] });
      slots.push({ kind: "probs", p });
      wave3.push({ address: market, abi: marketAbi as Abi, functionName: "probabilityTwap", args: [roundId, pid] });
      slots.push({ kind: "twap", p });
      if (!tokenCache.has(`${currentRoundId}:${p}`)) {
        for (const kind of ["creditToken", "longToken", "shortToken"] as const) {
          wave3.push({ address: tokens, abi: proposalTokensAbi as Abi, functionName: kind, args: [roundId, pid] });
          slots.push({ kind, p });
        }
      }
      if (account) {
        wave3.push({
          address: qr,
          abi: quantumRoundAbi as Abi,
          functionName: "creditsClaimed",
          args: [roundId, pid, account],
        });
        slots.push({ kind: "claimed", p });
      }
    }
    const w3 = await batch(client, wave3, false);
    const bySlot = new Map<string, unknown>();
    slots.forEach((s, i) => bySlot.set(`${s.kind}:${s.p}`, w3[i]));

    for (let p = 0; p < proposalCount; p += 1) {
      const c = bySlot.get(`creditToken:${p}`) as Address | undefined;
      const l = bySlot.get(`longToken:${p}`) as Address | undefined;
      const s = bySlot.get(`shortToken:${p}`) as Address | undefined;
      if (c && l && s) tokenCache.set(`${currentRoundId}:${p}`, { credit: c, long: l, short: s });
    }

    // Wave 4: proposer names (cached) and the user's token balances.
    const wave4: Call[] = [];
    const slots4: { kind: string; key: string }[] = [];
    const proposers = new Set<Address>();
    for (let p = 0; p < proposalCount; p += 1) {
      const pr = bySlot.get(`proposal:${p}`) as readonly unknown[] | undefined;
      const proposer = pr?.[0] as Address | undefined;
      if (proposer && proposer !== "0x0000000000000000000000000000000000000000") proposers.add(proposer);
    }
    for (const proposer of proposers) {
      if (!nameCache.has(proposer)) {
        wave4.push({ address: registry, abi: registryAbi as Abi, functionName: "agents", args: [proposer] });
        slots4.push({ kind: "name", key: proposer });
      }
    }
    if (account) {
      for (let p = 0; p < proposalCount; p += 1) {
        const t = tokenCache.get(`${currentRoundId}:${p}`);
        if (!t) continue;
        for (const k of ["credit", "long", "short"] as const) {
          wave4.push({ address: t[k], abi: erc20Abi, functionName: "balanceOf", args: [account] });
          slots4.push({ kind: k, key: String(p) });
        }
      }
    }
    const w4 = await batch(client, wave4, false);
    const bal = new Map<string, bigint>();
    slots4.forEach((s, i) => {
      if (s.kind === "name") {
        const agent = w4[i] as readonly unknown[] | undefined;
        if (agent && typeof agent[0] === "string") nameCache.set(s.key, agent[0]);
      } else {
        bal.set(`${s.kind}:${s.key}`, big(w4[i]));
      }
    });

    const rMin = big(rd[4]);
    const rMax = big(rd[5]);
    const proposals: ProposalView[] = [];
    for (let p = 0; p < proposalCount; p += 1) {
      const pr = bySlot.get(`proposal:${p}`) as readonly unknown[] | undefined;
      const probs = bySlot.get(`probs:${p}`) as readonly [bigint, bigint] | undefined;
      const twap = bySlot.get(`twap:${p}`) as bigint | undefined;
      const t = tokenCache.get(`${currentRoundId}:${p}`);
      if (!pr || !probs || !t) continue;
      const proposer = pr[0] as Address;
      const isStatusQuo = Boolean(pr[2]);
      proposals.push({
        id: p,
        isStatusQuo,
        proposer: isStatusQuo ? null : proposer,
        proposerName: isStatusQuo ? null : (nameCache.get(proposer) ?? null),
        tEthBps: Number(pr[1]),
        seedCredits: big(pr[3]),
        rationale: String(pr[6] ?? ""),
        pLong: probs[0],
        pShort: probs[1],
        twap: twap ?? probs[0],
        impliedReturn: impliedReturn(probs[0], rMin, rMax),
        tokens: t,
        user: {
          credits: bal.get(`credit:${p}`) ?? 0n,
          long: bal.get(`long:${p}`) ?? 0n,
          short: bal.get(`short:${p}`) ?? 0n,
          claimed: big(bySlot.get(`claimed:${p}`)),
        },
      });
    }

    const nowSec = Math.floor(fetchedAtMs / 1000) + clockSkew;
    const tradingEnd = Number(rd[1]);
    const evaluationEnd = Number(rd[2]);
    round = {
      id: currentRoundId,
      status: Number(rd[6]),
      phase: computePhase(Number(rd[6]), nowSec, tradingEnd, evaluationEnd),
      tradingStart: Number(rd[0]),
      tradingEnd,
      evaluationEnd,
      twapWindow: Number(rd[3]),
      rMin,
      rMax,
      proposalCount,
      winnerId: Number(rd[8]),
      realisedReturn: big(rd[10]),
      pi: big(rd[11]),
      totalDeposits: big(rd[12]),
      proposals,
      user: account
        ? { deposit: big(w2[2]), redeemed: Boolean(w2[3]), previewRedeem: big(w2[4]) }
        : { deposit: 0n, redeemed: false, previewRedeem: 0n },
    };
  }

  return {
    blockNumber: block.number,
    blockTimestamp,
    fetchedAtMs,
    clockSkew,
    currentRoundId,
    round,
    vault: vaultView,
    user: userView,
  };
}

const HISTORY_ROUNDS = 10;
const LOG_LOOKBACK = 200_000n;
const tradeTxCache = new Map<number, Hash>();

/** Past decisions, newest first. Called only when the round count or phase changes. */
export async function fetchHistory(client: PublicClient, currentRoundId: number): Promise<HistoryRow[]> {
  const addr = liveAddresses();
  if (!addr || currentRoundId < 1) return [];
  const { quantumRound: qr, vault } = addr;
  const ids: number[] = [];
  for (let r = currentRoundId; r >= 1 && ids.length < HISTORY_ROUNDS; r -= 1) ids.push(r);

  const waveA: Call[] = ids.flatMap((r) => [
    { address: qr, abi: quantumRoundAbi as Abi, functionName: "rounds", args: [BigInt(r)] },
    { address: vault, abi: vaultAbi as Abi, functionName: "roundState", args: [BigInt(r)] },
    { address: qr, abi: quantumRoundAbi as Abi, functionName: "proposals", args: [BigInt(r), 0n] },
  ]);
  const a = await batch(client, waveA);

  const winners = ids.map((r, i) => ({ r, rd: a[i * 3] as readonly unknown[] }));
  const waveB: Call[] = winners
    .filter(({ rd }) => Number(rd[6]) >= 2)
    .map(({ r, rd }) => ({
      address: qr,
      abi: quantumRoundAbi as Abi,
      functionName: "proposals",
      args: [BigInt(r), BigInt(Number(rd[8]))],
    }));
  const b = await batch(client, waveB, false);
  let bi = 0;

  const head = await client.getBlockNumber();
  const rows: HistoryRow[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const roundId = ids[i];
    const rd = a[i * 3] as readonly unknown[];
    const rs = a[i * 3 + 1] as readonly unknown[];
    const p0 = a[i * 3 + 2] as readonly unknown[];
    const status = Number(rd[6]);
    const decided = status >= 2;
    const winnerId = Number(rd[8]);
    const winnerProposal = decided ? (b[bi++] as readonly unknown[] | undefined) : undefined;
    const executed = Boolean(rs[5]);

    let tradeTx: Hash | null = tradeTxCache.get(roundId) ?? null;
    if (executed && !tradeTx) {
      try {
        const from = deployment.deployBlock ?? (head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n);
        const logs = await client.getContractEvents({
          address: vault,
          abi: vaultAbi as Abi,
          eventName: "TradeExecuted",
          args: { roundId: BigInt(roundId) },
          fromBlock: from,
          toBlock: head,
        });
        const hash = logs[0]?.transactionHash;
        if (hash) {
          tradeTxCache.set(roundId, hash);
          tradeTx = hash;
        }
      } catch {
        // The log lookup is a convenience; the history stays usable without the link.
      }
    }

    rows.push({
      roundId,
      status,
      phase: computePhase(status, 0, 1, 2),
      winnerId,
      winnerName: !decided
        ? "Undecided"
        : winnerId === 0
          ? "Status quo"
          : (nameCache.get(String(winnerProposal?.[0])) ?? `Proposal ${winnerId}`),
      winnerTEthBps: Number(winnerProposal?.[1] ?? 0),
      statusQuoTEthBps: Number(p0[1]),
      startValueUsdc: big(rs[0]),
      executed,
      reported: Boolean(rs[6]),
      cancelled: Boolean(rs[7]),
      realisedReturn: big(rd[10]),
      tradeTx,
    });
  }
  return rows;
}

export interface UserRoundRow {
  roundId: number;
  deposit: bigint;
  redeemed: boolean;
  /** What `redeem` would pay right now (0 until the round is settled or cancelled). */
  previewRedeem: bigint;
}

/** The user's deposit and redeemable amount for each recent round. */
export async function fetchUserRounds(
  client: PublicClient,
  currentRoundId: number,
  account: Address,
): Promise<UserRoundRow[]> {
  const addr = liveAddresses();
  if (!addr || currentRoundId < 1) return [];
  const ids: number[] = [];
  for (let r = currentRoundId; r >= 1 && ids.length < HISTORY_ROUNDS; r -= 1) ids.push(r);
  const calls: Call[] = ids.flatMap((r) => [
    { address: addr.quantumRound, abi: quantumRoundAbi as Abi, functionName: "deposits", args: [BigInt(r), account] },
    { address: addr.quantumRound, abi: quantumRoundAbi as Abi, functionName: "redeemed", args: [BigInt(r), account] },
    { address: addr.quantumRound, abi: quantumRoundAbi as Abi, functionName: "previewRedeem", args: [BigInt(r), account] },
  ]);
  const res = await batch(client, calls);
  return ids.map((roundId, i) => ({
    roundId,
    deposit: big(res[i * 3]),
    redeemed: Boolean(res[i * 3 + 1]),
    previewRedeem: big(res[i * 3 + 2]),
  }));
}
