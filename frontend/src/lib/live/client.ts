import {
  createPublicClient,
  custom,
  fallback,
  http,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { PUBLIC_RPC_URL, arcTestnet } from "@/lib/chain";

/**
 * Read client: Multicall3 batching, and a fallback transport that tries the wallet
 * provider first (only while the wallet is on Arc) and then the public RPC.
 * The http transport retries 429s and other transient errors with exponential backoff.
 */
let walletProvider: EIP1193Provider | null = null;
let cached: PublicClient | null = null;

/** Called by the wallet layer: pass the provider while it is on Arc, otherwise null. */
export function setWalletTransport(provider: EIP1193Provider | null): void {
  if (provider === walletProvider) return;
  walletProvider = provider;
  cached = null;
}

export function getPublicClient(): PublicClient {
  if (cached) return cached;
  const transports = [
    ...(walletProvider ? [custom(walletProvider, { retryCount: 1, retryDelay: 300 })] : []),
    http(PUBLIC_RPC_URL, { retryCount: 5, retryDelay: 400, timeout: 15_000 }),
  ];
  cached = createPublicClient({
    chain: arcTestnet,
    transport: fallback(transports, { retryCount: 0 }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
  return cached;
}
