"use client";

import { deployedContracts } from "@/lib/contracts";
import { usePreferences } from "./PreferencesProvider";
import { Pill } from "./ui";

export function DataModeBanner() {
  const { dataMode } = usePreferences();

  if (dataMode === "mock") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <Pill tone="amber">Mock data</Pill>
        <span>Sample values for demonstration. Switch to on-chain data in the header.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
      <Pill tone="green">On-chain data</Pill>
      <span>
        {deployedContracts.length > 0
          ? `Reading ${deployedContracts.length} contract${deployedContracts.length === 1 ? "" : "s"} on Arc testnet.`
          : "No contracts are listed in current.json yet, so there is nothing to read."}
      </span>
    </div>
  );
}
