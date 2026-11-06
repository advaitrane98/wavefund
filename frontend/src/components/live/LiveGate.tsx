"use client";

import { hasLiveDeployment } from "@/config/contracts";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { PreferencesButton } from "./PreferencesButton";
import { useWallet } from "../WalletProvider";
import { Card, Eyebrow } from "../ui";

/** Renders live children once a first snapshot has loaded; otherwise a calm placeholder. */
export function LiveGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const { enabled, snapshot, status } = useLiveData();

  if (!hasLiveDeployment || !enabled) {
    return (
      <Card>
        <Eyebrow tone="amber">No deployment yet</Eyebrow>
        <h2 className="mt-3 text-2xl">Live mode needs deployed contracts</h2>
        <p className="mt-3 max-w-xl text-sm text-muted">
          The deployment file lists no QuantumRound, market, vault, registry and token contracts yet. Once{" "}
          <span className="num">contracts/deployments/current.json</span> is filled in and synced with{" "}
          <span className="num">npm run gen:abis</span>, this page reads and writes them.
        </p>
        <PreferencesButton />
      </Card>
    );
  }

  if (!snapshot) {
    return status === "stale" ? (
      <Card>
        <Eyebrow tone="amber">Reconnecting</Eyebrow>
        <p className="mt-3 text-sm text-muted" role="status">
          Arc testnet is not responding right now. Data may be stale, retrying.
        </p>
      </Card>
    ) : (
      <div className="card h-64 animate-pulse bg-surface-2" aria-label="Loading on-chain data" />
    );
  }

  return <>{children}</>;
}

/** Prompt shown where an action needs a connected wallet on Arc. */
export function WalletPrompt({ text }: Readonly<{ text: string }>) {
  const { address, onArc, chainId, connecting, connect, switchToArc } = useWallet();
  if (address && (onArc || chainId === null)) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-4 border-amber/40 p-5">
      <p className="max-w-lg text-sm text-muted">
        {address ? "Your wallet is on the wrong network. Switch to Arc testnet to continue." : text}
      </p>
      <button
        type="button"
        onClick={() => void (address ? switchToArc() : connect())}
        disabled={connecting}
        className="inline-flex min-h-11 items-center rounded-full bg-green px-5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-60"
      >
        {address ? "Switch to Arc testnet" : connecting ? "Check your wallet…" : "Connect wallet"}
      </button>
    </div>
  );
}
