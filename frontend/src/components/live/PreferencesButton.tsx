"use client";

import { usePreferences } from "../PreferencesProvider";

/** Switches back to the simulated workspace. */
export function PreferencesButton() {
  const { setDataMode } = usePreferences();
  return (
    <button
      type="button"
      onClick={() => setDataMode("mock")}
      className="mt-5 inline-flex min-h-11 items-center rounded-full border border-border-strong px-5 text-sm hover:bg-surface-2"
    >
      Use mock data
    </button>
  );
}
