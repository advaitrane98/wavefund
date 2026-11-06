"use client";

import { deployedContracts } from "@/config/contracts";
import { useSim } from "@/sim/SimProvider";
import { usePreferences } from "./PreferencesProvider";
import { Card, Eyebrow } from "./ui";

/** Renders children only in mock mode, once the saved demo state has loaded. */
export function WorkspaceGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const { dataMode, setDataMode } = usePreferences();
  const { hydrated } = useSim();

  if (dataMode === "onchain") {
    return (
      <Card>
        <Eyebrow tone="green">On-chain data</Eyebrow>
        <h2 className="mt-3 text-2xl">Nothing to read yet</h2>
        <p className="mt-3 max-w-xl text-sm text-muted">
          {deployedContracts.length === 0
            ? "No contracts are listed in current.json, so there is no on-chain data to show."
            : "On-chain reads for this page are not built yet."}{" "}
          The simulated workspace is available in mock mode.
        </p>
        <button
          type="button"
          onClick={() => setDataMode("mock")}
          className="mt-5 inline-flex min-h-11 items-center rounded-full border border-border-strong px-5 text-sm hover:bg-surface-2"
        >
          Use mock data
        </button>
      </Card>
    );
  }

  if (!hydrated) {
    return <div className="card h-64 animate-pulse bg-surface-2" aria-label="Loading demo" />;
  }

  return <>{children}</>;
}

/** Shown where an action needs the demo account. */
export function ConnectPrompt({ text }: Readonly<{ text: string }>) {
  const { state, connect } = useSim();
  if (state.connected) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-4 border-amber/40 p-5">
      <p className="max-w-lg text-sm text-muted">{text}</p>
      <button
        type="button"
        onClick={() => connect()}
        className="inline-flex min-h-11 items-center rounded-full bg-green px-5 text-sm font-medium text-on-accent hover:opacity-90"
      >
        Connect demo account
      </button>
    </div>
  );
}
