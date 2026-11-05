import type { SimState } from "../types";

export class SimError extends Error {}

export function fail(message: string): never {
  throw new SimError(message);
}

export const clone = (s: SimState): SimState => structuredClone(s);

export function requireConnected(s: SimState): void {
  if (!s.connected) fail("Connect the demo account first.");
}

export function requireOpen(s: SimState): void {
  if (s.round.status !== "open") fail("This round is no longer open for trading.");
}

export function requireAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) fail("Enter an amount greater than zero.");
}
