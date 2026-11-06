"use client";

import { LiveGate } from "./live/LiveGate";
import { usePreferences } from "./PreferencesProvider";
import { WorkspaceGate } from "./WorkspaceGate";

/** Shows the simulated workspace in mock mode and the on-chain view in live mode. */
export function ModeSwitch({
  mock,
  live,
}: Readonly<{ mock: React.ReactNode; live: React.ReactNode }>) {
  const { dataMode } = usePreferences();
  return dataMode === "onchain" ? (
    <LiveGate>{live}</LiveGate>
  ) : (
    <WorkspaceGate>{mock}</WorkspaceGate>
  );
}
