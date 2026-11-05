import { initialState } from "./seed";
import type { SimState } from "./types";

export const SIM_STORAGE_KEY = "wavefund:sim:v1";

function isSimState(value: unknown): value is SimState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SimState>;
  return (
    v.version === 1 &&
    typeof v.connected === "boolean" &&
    typeof v.usdc === "number" &&
    typeof v.round === "object" &&
    v.round !== null &&
    typeof v.vault === "object" &&
    v.vault !== null &&
    Array.isArray(v.pastRounds)
  );
}

export function loadSim(): SimState {
  try {
    const raw = window.localStorage.getItem(SIM_STORAGE_KEY);
    if (!raw) return initialState();
    const parsed: unknown = JSON.parse(raw);
    return isSimState(parsed) ? parsed : initialState();
  } catch {
    return initialState();
  }
}

export function saveSim(state: SimState): void {
  try {
    window.localStorage.setItem(SIM_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the demo keeps working in memory.
  }
}

export function clearSim(): void {
  try {
    window.localStorage.removeItem(SIM_STORAGE_KEY);
  } catch {
    // ignore
  }
}
