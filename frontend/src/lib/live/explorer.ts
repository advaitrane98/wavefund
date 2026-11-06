import { type Abi, type Address, type Hex, decodeEventLog, getAddress, pad } from "viem";
import { arcTestnet } from "../chain";

/**
 * Event history from the chain explorer's API (Blockscout, Etherscan-compatible `getLogs`).
 * The browser calls it directly, so no API key is used here. Never reads local log files.
 */
const BASE = (process.env.NEXT_PUBLIC_ARC_EXPLORER_URL || arcTestnet.blockExplorers.default.url).replace(/\/$/, "");

export interface ExplorerLog {
  address: Address;
  blockNumber: bigint;
  logIndex: bigint;
  timeStamp: bigint;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
}

interface RawLog {
  address: string;
  blockNumber: string;
  logIndex: string;
  timeStamp: string;
  topics: (string | null)[];
  data: string;
  transactionHash: string;
}

export interface LogQuery {
  address: Address;
  topic0: Hex;
  /** Indexed address filters, by topic position (1 to 3). */
  topics?: Partial<Record<1 | 2 | 3, Address>>;
  fromBlock: bigint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 4;

/** Raw logs for one event. Retries 429s and network errors with exponential backoff. */
export async function fetchLogs(q: LogQuery): Promise<ExplorerLog[]> {
  const params = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: q.fromBlock.toString(),
    toBlock: "latest",
    address: q.address,
    topic0: q.topic0,
  });
  for (const [pos, addr] of Object.entries(q.topics ?? {})) {
    if (!addr) continue;
    params.set(`topic${pos}`, pad(addr, { size: 32 }).toLowerCase());
    params.set(`topic0_${pos}_opr`, "and");
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}/api?${params.toString()}`);
      if (res.status === 429 || res.status >= 500) throw new Error(`Explorer API ${res.status}`);
      if (!res.ok) throw new Error(`Explorer API ${res.status}`);
      const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
      if (!Array.isArray(body.result)) {
        // "No logs found" / "No records found" come back as an empty, non-array result.
        if (/no (logs|records)/i.test(body.message ?? "")) return [];
        throw new Error(body.message || "Explorer API returned an unexpected response");
      }
      return (body.result as RawLog[]).map((l) => ({
        address: getAddress(l.address),
        blockNumber: BigInt(l.blockNumber),
        logIndex: BigInt(l.logIndex === "0x" ? "0x0" : l.logIndex),
        timeStamp: BigInt(l.timeStamp === "0x" ? "0x0" : l.timeStamp),
        topics: l.topics.filter((t): t is string => t !== null) as Hex[],
        data: l.data as Hex,
        transactionHash: l.transactionHash as Hex,
      }));
    } catch (e) {
      lastError = e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Explorer API unreachable");
}

export interface DecodedLog<Args> extends ExplorerLog {
  args: Args;
}

/** Decode logs of one event with the contract ABI. Logs that do not match are dropped. */
export function decodeLogs<Args>(abi: Abi, eventName: string, logs: readonly ExplorerLog[]): DecodedLog<Args>[] {
  const out: DecodedLog<Args>[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        eventName,
      } as never) as unknown as { args: Args };
      out.push({ ...log, args: decoded.args });
    } catch {
      // Not this event, or malformed: skip.
    }
  }
  return out;
}

/** Newest first: by block, then log index. */
export function newestFirst<T extends ExplorerLog>(logs: readonly T[]): T[] {
  return [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? Number(b.logIndex - a.logIndex) : Number(b.blockNumber - a.blockNumber),
  );
}
