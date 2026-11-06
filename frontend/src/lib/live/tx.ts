import {
  createWalletClient,
  custom,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hash,
  type PublicClient,
} from "viem";
import { arcTestnet } from "@/lib/chain";
import { getPublicClient } from "./client";

const GWEI = 1_000_000_000n;
/** Gas policy for broadcasts: 1 gwei priority fee, max fee about 2x the current base fee. */
const PRIORITY_FEE = 1n * GWEI;
/** Arc's mempool enforces a 20 gwei maxFeePerGas floor (docs.arc.io EVM differences). */
const MIN_MAX_FEE = 20n * GWEI;

export async function feeOverrides(
  client: PublicClient,
): Promise<{ maxPriorityFeePerGas: bigint; maxFeePerGas: bigint }> {
  const block = await client.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const twice = base * 2n + PRIORITY_FEE;
  return {
    maxPriorityFeePerGas: PRIORITY_FEE,
    maxFeePerGas: twice > MIN_MAX_FEE ? twice : MIN_MAX_FEE,
  };
}

export interface TxRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Simulate (so reverts decode into readable errors), broadcast with the gas policy,
 * then wait for the receipt. Throws if the transaction reverts.
 */
export async function sendContractTx(
  provider: EIP1193Provider,
  account: Address,
  req: TxRequest,
): Promise<Hash> {
  const publicClient = getPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: custom(provider),
  });
  const fees = await feeOverrides(publicClient);
  const { request } = await publicClient.simulateContract({
    account,
    address: req.address,
    abi: req.abi,
    functionName: req.functionName,
    args: req.args,
    ...fees,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    pollingInterval: 1_000,
    timeout: 90_000,
  });
  if (receipt.status !== "success") throw new Error("The transaction reverted onchain.");
  return hash;
}
