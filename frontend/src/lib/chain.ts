import { createPublicClient, defineChain, http } from "viem";

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
  testnet: true,
});

/** ERC-20 interface of the native USDC balance on Arc (6 decimals). */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

export const explorerAddressUrl = (address: string) =>
  `${arcTestnet.blockExplorers.default.url}/address/${address}`;

export const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
