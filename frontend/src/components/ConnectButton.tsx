"use client";

import { shortAddress } from "@/lib/chain";
import { DemoConnectButton } from "./DemoConnectButton";
import { usePreferences } from "./PreferencesProvider";
import { useWallet } from "./WalletProvider";

function formatUsdc(value: string | null): string {
  if (value === null) return "…";
  const n = Number(value);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Mock mode connects the in-browser demo account; on-chain mode connects a wallet. */
export function ConnectButton() {
  const { dataMode } = usePreferences();
  return dataMode === "mock" ? <DemoConnectButton /> : <WalletConnectButton />;
}

function WalletConnectButton() {
  const { address, usdcBalance, wrongNetwork, connecting, error, connect, disconnect } =
    useWallet();

  if (!address) {
    return (
      <div className="flex flex-col items-end">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting}
          className="inline-flex min-h-11 items-center rounded-full bg-green px-4 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
        {error ? (
          <span role="alert" className="mt-1 max-w-56 text-right text-xs text-red">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {wrongNetwork ? (
        <button
          type="button"
          onClick={() => void connect()}
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
        <span className="num text-violet">{formatUsdc(usdcBalance)} USDC</span>
        <span className="num text-text">{shortAddress(address)}</span>
      </button>
    </div>
  );
}
