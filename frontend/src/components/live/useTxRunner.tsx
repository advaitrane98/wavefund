"use client";

import { useCallback, useState } from "react";
import type { Hash } from "viem";
import { explorerTxUrl } from "@/lib/chain";
import { explainError } from "@/lib/live/errors";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import type { TxRequest } from "@/lib/live/tx";
import { useWallet } from "../WalletProvider";

export interface TxStep extends TxRequest {
  /** Shown while this step waits for the wallet and the chain, e.g. "Approving USDC". */
  label: string;
}

interface TxState {
  busy: string | null;
  error: string | null;
  hash: Hash | null;
  done: string | null;
}

const IDLE: TxState = { busy: null, error: null, hash: null, done: null };

/**
 * Runs one or more contract calls in order (for example approve then deposit),
 * then refreshes the live data. Errors are shown in plain language.
 */
export function useTxRunner() {
  const wallet = useWallet();
  const live = useLiveData();
  const [state, setState] = useState<TxState>(IDLE);

  const run = useCallback(
    async (doneLabel: string, steps: TxStep[]): Promise<boolean> => {
      setState({ ...IDLE, busy: steps[0]?.label ?? "Confirm in your wallet" });
      let last: Hash | null = null;
      try {
        for (let i = 0; i < steps.length; i += 1) {
          const step = steps[i];
          setState((s) => ({ ...s, busy: `${step.label}${steps.length > 1 ? ` (${i + 1}/${steps.length})` : ""}` }));
          last = await wallet.send(step);
        }
        setState({ busy: null, error: null, hash: last, done: doneLabel });
        live.refreshAfterTx();
        return true;
      } catch (err) {
        setState({ busy: null, error: explainError(err), hash: last, done: null });
        live.refreshAfterTx();
        return false;
      }
    },
    [wallet, live],
  );

  const clear = useCallback(() => setState(IDLE), []);
  return { state, run, clear, busy: state.busy !== null };
}

export function TxStatus({
  state,
}: Readonly<{ state: { busy: string | null; error: string | null; hash: Hash | null; done: string | null } }>) {
  if (state.busy) {
    return (
      <p role="status" className="mt-3 text-xs text-amber">
        {state.busy}… confirm in your wallet and wait for the block.
      </p>
    );
  }
  if (state.error) {
    return (
      <p role="alert" className="mt-3 text-xs text-red" data-tx-error>
        {state.error}
      </p>
    );
  }
  if (state.done) {
    return (
      <p role="status" className="mt-3 text-xs text-green">
        {state.done}
        {state.hash ? (
          <>
            {" "}
            <a
              href={explorerTxUrl(state.hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View transaction
            </a>
          </>
        ) : null}
      </p>
    );
  }
  return null;
}
