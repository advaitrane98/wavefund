import { defineChain, numberToHex } from "viem";

/**
 * Arc testnet. USDC is the native gas token (18 decimals in the native view).
 * All displayed balances use the ERC-20 view of USDC (6 decimals) so one pool of
 * funds is never counted twice.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

/** 0x4cef52 */
export const ARC_CHAIN_ID_HEX = numberToHex(arcTestnet.id);

/** ERC-20 interface of the native USDC balance on Arc (6 decimals). */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;

/** Public RPC; NEXT_PUBLIC_ARC_RPC_URL overrides the default. It is public, so never put a secret in it. */
export const PUBLIC_RPC_URL: string =
  process.env.NEXT_PUBLIC_ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];

export const explorerAddressUrl = (address: string) =>
  `${arcTestnet.blockExplorers.default.url}/address/${address}`;

export const explorerTxUrl = (hash: string) =>
  `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;

export const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
