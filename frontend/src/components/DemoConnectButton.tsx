"use client";

import { useState } from "react";
import { fmtUsdc } from "@/sim/format";
import { useSim } from "@/sim/SimProvider";

export function DemoConnectButton() {
  const { state, hydrated, connect, faucet } = useSim();
  const [flash, setFlash] = useState(false);

  if (!hydrated) {
    return <span className="inline-flex min-h-11 w-40 rounded-full bg-surface-2" aria-hidden />;
  }

  if (!state.connected) {
    return (
      <button
        type="button"
        onClick={() => connect()}
        className="inline-flex min-h-11 items-center rounded-full bg-green px-4 text-sm font-medium text-on-accent transition-opacity hover:opacity-90"
      >
        Connect demo account
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex min-h-11 items-center gap-3 rounded-full border border-border-strong px-4 text-sm">
        <span className="eyebrow text-amber">Demo</span>
        <span className="num text-violet">{fmtUsdc(state.usdc)} USDC</span>
      </span>
      <button
        type="button"
        onClick={() => {
          faucet();
          setFlash(true);
          window.setTimeout(() => setFlash(false), 1200);
        }}
        className="inline-flex min-h-11 items-center rounded-full border border-border px-3 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        {flash ? "+1,000 added" : "Faucet"}
      </button>
    </div>
  );
}
