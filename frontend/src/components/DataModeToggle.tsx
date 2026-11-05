"use client";

import { usePreferences } from "./PreferencesProvider";

export function DataModeToggle() {
  const { dataMode, setDataMode } = usePreferences();
  const onchain = dataMode === "onchain";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={onchain}
      onClick={() => setDataMode(onchain ? "mock" : "onchain")}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-3 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${onchain ? "bg-green" : "bg-border-strong"}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-bg transition-[left] ${onchain ? "left-3.5" : "left-0.5"}`}
        />
      </span>
      <span className="whitespace-nowrap">
        {onchain ? "Use mock data" : "Use on-chain data"}
      </span>
    </button>
  );
}
