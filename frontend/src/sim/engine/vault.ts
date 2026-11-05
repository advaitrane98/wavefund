import { r6 } from "../format";
import { navOf } from "../seed";
import type { SimState, Vault } from "../types";
import { clone, fail, requireAmount, requireConnected } from "./util";

const sharePrice = (v: Vault): number => navOf(v) / v.totalShares;

const queuedShares = (v: Vault): number =>
  v.queuedWithdrawals.reduce((a, w) => a + w.shares, 0);

/** Queue a vault deposit. USDC is escrowed now and processed at the next decision. */
export function queueDeposit(prev: SimState, usdc: number): SimState {
  requireConnected(prev);
  requireAmount(usdc);
  if (usdc > prev.usdc) fail("Not enough demo USDC.");
  const s = clone(prev);
  s.usdc = r6(s.usdc - usdc);
  s.vault.queuedDeposits.push({ id: s.nextId, usdc: r6(usdc), at: Date.now() });
  s.nextId += 1;
  return s;
}

/** Queue a vault withdrawal in shares, processed at the next decision. */
export function queueWithdraw(prev: SimState, shares: number): SimState {
  requireConnected(prev);
  requireAmount(shares);
  const free = prev.vault.userShares - queuedShares(prev.vault);
  if (shares > free + 1e-9) fail("You do not have that many free vault shares.");
  const s = clone(prev);
  s.vault.queuedWithdrawals.push({ id: s.nextId, shares: r6(shares), at: Date.now() });
  s.nextId += 1;
  return s;
}

export function cancelDeposit(prev: SimState, id: number): SimState {
  const item = prev.vault.queuedDeposits.find((d) => d.id === id);
  if (!item) fail("That deposit is no longer queued.");
  const s = clone(prev);
  s.vault.queuedDeposits = s.vault.queuedDeposits.filter((d) => d.id !== id);
  s.usdc = r6(s.usdc + item.usdc);
  return s;
}

export function cancelWithdraw(prev: SimState, id: number): SimState {
  if (!prev.vault.queuedWithdrawals.some((w) => w.id === id)) {
    fail("That withdrawal is no longer queued.");
  }
  const s = clone(prev);
  s.vault.queuedWithdrawals = s.vault.queuedWithdrawals.filter((w) => w.id !== id);
  return s;
}

/** Process queued deposits and withdrawals at the current share price. Mutates `s`. */
export function processQueue(s: SimState): void {
  const v = s.vault;
  for (const d of v.queuedDeposits) {
    const shares = d.usdc / sharePrice(v);
    v.usdc = r6(v.usdc + d.usdc);
    v.totalShares += shares;
    v.userShares += shares;
  }
  v.queuedDeposits = [];

  for (const w of v.queuedWithdrawals) {
    const amount = r6(w.shares * sharePrice(v));
    if (v.usdc < amount) {
      // Sell tETH in the pool to cover the shortfall.
      const need = amount - v.usdc;
      const tethSold = Math.min(v.teth, need / v.poolPrice);
      v.teth -= tethSold;
      v.usdc += tethSold * v.poolPrice;
    }
    v.usdc = r6(v.usdc - amount);
    v.totalShares -= w.shares;
    v.userShares -= w.shares;
    s.usdc = r6(s.usdc + amount);
  }
  v.queuedWithdrawals = [];
}

/**
 * Rebalance to a target tETH share by trading at the pool price. Mutates `s`.
 * NAV is measured at the oracle, so the oracle/pool gap shows up as slippage.
 */
export function rebalance(s: SimState, targetTethShare: number): void {
  const v = s.vault;
  const nav = navOf(v);
  const diffValue = nav * targetTethShare - v.teth * v.oracle;
  if (diffValue > 0) {
    const spend = Math.min(diffValue, v.usdc);
    v.usdc -= spend;
    v.teth += spend / v.poolPrice;
  } else if (diffValue < 0) {
    const tethSold = Math.min(v.teth, -diffValue / v.oracle);
    v.teth -= tethSold;
    v.usdc += tethSold * v.poolPrice;
  }
}
