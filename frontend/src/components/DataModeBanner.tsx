"use client";

import { useState } from "react";
import { deployedContracts } from "@/config/contracts";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { useSim } from "@/sim/SimProvider";
import { usePreferences } from "./PreferencesProvider";
import { Pill } from "./ui";

function ResetDemo() {
  const { reset } = useSim();
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="ml-auto flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          reset();
          setConfirming(false);
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-red px-4 text-xs font-medium text-on-accent"
      >
        Confirm reset
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-xs text-muted hover:bg-surface-2"
      >
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="ml-auto inline-flex min-h-11 items-center rounded-full border border-border px-4 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      Reset demo
    </button>
  );
}

export function DataModeBanner() {
  const { dataMode } = usePreferences();

  if (dataMode === "mock") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <Pill tone="amber">Mock data</Pill>
        <span>Simulated in your browser. Nothing here touches a chain.</span>
        <ResetDemo />
      </div>
    );
  }

  return <LiveBanner />;
}

function LiveBanner() {
  const { enabled, status, snapshot, refresh } = useLiveData();
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted" data-live-status={status}>
      <Pill tone="green">On-chain data</Pill>
      {!enabled ? (
        <span>
          {deployedContracts.length === 0
            ? "No deployment found yet. Add contracts/deployments/current.json and run the sync."
            : "The deployment file is missing a contract live mode needs."}
        </span>
      ) : status === "stale" ? (
        <span className="flex flex-wrap items-center gap-3 text-amber" role="status">
          Data may be stale, retrying.
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex min-h-11 items-center text-xs text-muted underline hover:text-text"
          >
            Retry now
          </button>
        </span>
      ) : status === "loading" || !snapshot ? (
        <span>Reading Arc testnet…</span>
      ) : (
        <span>Live from Arc testnet, block {snapshot.blockNumber.toString()}.</span>
      )}
    </div>
  );
}
