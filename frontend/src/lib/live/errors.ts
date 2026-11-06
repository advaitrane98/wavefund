import { BaseError, ContractFunctionRevertedError } from "viem";

/** Readable text for custom errors the contracts can raise. */
const FRIENDLY: Record<string, string> = {
  TradingNotOpen: "Trading is not open for this round.",
  TradingClosed: "Trading has closed for this market.",
  TradingNotEnded: "Trading has not ended yet.",
  InsufficientDepth: "Not enough liquidity for a trade this size. Try a smaller amount.",
  Slippage: "The price moved more than 0.5% while you were confirming. Try again.",
  ClaimExceedsDeposit: "You can only claim up to your deposit in each proposal.",
  ZeroAmount: "Enter an amount greater than zero.",
  NothingToRedeem: "There is nothing to redeem for this round.",
  NotRedeemable: "This round is not redeemable yet.",
  NothingToClaim: "There is nothing to claim.",
  AlreadyCollapsed: "This round has already collapsed.",
  EvaluationNotEnded: "The evaluation period has not ended.",
  BelowMinimum: "The amount is below the minimum.",
  NoRequest: "You have no queued request to cancel.",
  NotBootstrapped: "The vault has no shares yet.",
  ProbabilityOutOfBounds: "That trade would push the price outside the 1% to 99% bounds.",
  PriceOutOfRange: "That trade would push the price out of range.",
  PendingRemainder: "Another sell is still settling in this market. Try again shortly.",
  ERC20InsufficientBalance: "Insufficient balance.",
  ERC20InsufficientAllowance: "Approve the spend first.",
  SafeERC20FailedOperation: "The token transfer failed. Check your balance and approval.",
};

type Coded = { code?: number; name?: string; shortMessage?: string; message?: string; status?: number };

function walk(err: unknown): Coded[] {
  const chain: Coded[] = [];
  let current: unknown = err;
  for (let i = 0; i < 8 && current && typeof current === "object"; i += 1) {
    chain.push(current as Coded);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export type TxErrorKind = "rejected" | "pending" | "rate-limited" | "revert" | "other";

export function classifyError(err: unknown): { kind: TxErrorKind; message: string } {
  const chain = walk(err);

  if (chain.some((e) => e.code === 4001 || e.name === "UserRejectedRequestError")) {
    return { kind: "rejected", message: "You rejected the request in your wallet." };
  }
  if (chain.some((e) => e.code === -32002 || e.name === "ResourceUnavailableRpcError")) {
    return {
      kind: "pending",
      message: "Your wallet already has a pending request. Open it and approve or reject it first.",
    };
  }
  if (chain.some((e) => e.status === 429 || e.name === "HttpRequestError" && /429/.test(e.message ?? ""))) {
    return { kind: "rate-limited", message: "The RPC is rate limiting requests. Retrying shortly." };
  }

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason ?? "";
      const friendly = FRIENDLY[name];
      if (friendly) return { kind: "revert", message: friendly };
      if (name) return { kind: "revert", message: `The contract rejected this: ${name}.` };
    }
    return { kind: "other", message: err.shortMessage };
  }
  const first = chain[0];
  return { kind: "other", message: first?.shortMessage ?? first?.message ?? "Something went wrong." };
}

export const explainError = (err: unknown): string => classifyError(err).message;
