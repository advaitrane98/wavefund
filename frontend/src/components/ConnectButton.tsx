"use client";

import { shortAddress } from "@/lib/chain";
import { usdc } from "@/lib/units";
import { DemoConnectButton } from "./DemoConnectButton";
import { usePreferences } from "./PreferencesProvider";
import { useWallet } from "./WalletProvider";

/** Mock mode connects the in-browser demo account; on-chain mode connects a wallet. */
export function ConnectButton() {
  const { dataMode } = usePreferences();
  return dataMode === "mock" ? <DemoConnectButton /> : <WalletConnectButton />;
}

function WalletConnectButton() {
  const {
    address,
    usdcBalance,
    onArc,
    chainId,
    connecting,
    error,
    connect,
    switchToArc,
    disconnect,
    clearError,
  } = useWallet();

  const errorLine = error ? (
    <span
      role="alert"
      className="mt-1 flex max-w-64 items-start justify-end gap-2 text-right text-xs text-red"
      data-wallet-error={error.kind}
    >
      <span>{error.message}</span>
      {error.kind !== "wrong-network" ? (
        <button type="button" onClick={clearError} className="shrink-0 text-faint hover:text-text">
          Dismiss
        </button>
      ) : null}
    </span>
  ) : null;

  if (!address) {
    return (
      <div className="flex flex-col items-end">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting}
          className="inline-flex min-h-11 items-center rounded-full bg-green px-4 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {connecting ? "Check your wallet…" : "Connect wallet"}
        </button>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center gap-2">
        {!onArc && chainId !== null ? (
          <button
            type="button"
            onClick={() => void switchToArc()}
            className="inline-flex min-h-11 items-center rounded-full bg-amber-soft px-3 text-xs font-medium text-amber"
          >
            Switch to Arc testnet
          </button>
        ) : null}
        <button
          type="button"
          onClick={disconnect}
          title="Disconnect"
          className="inline-flex min-h-11 items-center gap-3 rounded-full border border-border-strong px-4 text-sm transition-colors hover:bg-surface-2"
        >
          <span className="num text-violet">
            {usdcBalance === null ? "…" : usdc.format(usdcBalance)} USDC
          </span>
          <span className="num text-text">{shortAddress(address)}</span>
        </button>
      </div>
      {errorLine}
    </div>
  );
}
