import { r6 } from "../format";
import { FAUCET_USDC, START_USDC } from "../seed";
import type { SimState } from "../types";
import { clone, requireConnected } from "./util";

/** Connect the demo account and fund it with demo USDC (once). */
export function connectDemo(prev: SimState): SimState {
  if (prev.connected) return prev;
  const s = clone(prev);
  s.connected = true;
  s.usdc = r6(s.usdc + START_USDC);
  return s;
}

/** Faucet: add demo USDC to the wallet. */
export function faucet(prev: SimState): SimState {
  requireConnected(prev);
  const s = clone(prev);
  s.usdc = r6(s.usdc + FAUCET_USDC);
  return s;
}
