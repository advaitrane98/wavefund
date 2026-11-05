"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { connectDemo, faucet } from "./engine/account";
import { claim, claimAll, depositOnce, trade } from "./engine/market";
import { collapseRound, nextRound, redeem, settleRound } from "./engine/round";
import { SimError } from "./engine/util";
import {
  cancelDeposit,
  cancelWithdraw,
  queueDeposit,
  queueWithdraw,
} from "./engine/vault";
import { initialState } from "./seed";
import { clearSim, loadSim, saveSim } from "./storage";
import type { Side, SimResult, SimState, TradeAction } from "./types";

type Transform = (s: SimState) => SimState;

interface SimApi {
  state: SimState;
  hydrated: boolean;
  connect: () => SimResult;
  faucet: () => SimResult;
  deposit: (amount: number) => SimResult;
  claim: (index: number, amount: number) => SimResult;
  claimAll: () => SimResult;
  trade: (index: number, action: TradeAction, side: Side, amount: number) => SimResult;
  collapse: () => SimResult;
  settle: (enteredReturn: number) => SimResult;
  redeem: () => SimResult;
  nextRound: () => SimResult;
  queueDeposit: (usdc: number) => SimResult;
  queueWithdraw: (shares: number) => SimResult;
  cancelDeposit: (id: number) => SimResult;
  cancelWithdraw: (id: number) => SimResult;
  reset: () => void;
}

const SimContext = createContext<SimApi | null>(null);

export function SimProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [state, setState] = useState<SimState>(() => initialState());
  const [hydrated, setHydrated] = useState(false);
  const ref = useRef(state);

  // Load saved state once on the client.
  useEffect(() => {
    const loaded = loadSim();
    ref.current = loaded;
    setState(loaded);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveSim(state);
  }, [state, hydrated]);

  const run = useCallback((fn: Transform): SimResult => {
    try {
      const next = fn(ref.current);
      ref.current = next;
      setState(next);
      return { ok: true };
    } catch (err) {
      if (err instanceof SimError) return { ok: false, error: err.message };
      throw err;
    }
  }, []);

  const api = useMemo<SimApi>(
    () => ({
      state,
      hydrated,
      connect: () => run(connectDemo),
      faucet: () => run(faucet),
      deposit: (amount) => run((s) => depositOnce(s, amount)),
      claim: (index, amount) => run((s) => claim(s, index, amount)),
      claimAll: () => run(claimAll),
      trade: (index, action, side, amount) =>
        run((s) => trade(s, index, action, side, amount)),
      collapse: () => run(collapseRound),
      settle: (r) => run((s) => settleRound(s, r)),
      redeem: () => run(redeem),
      nextRound: () => run(nextRound),
      queueDeposit: (usdc) => run((s) => queueDeposit(s, usdc)),
      queueWithdraw: (shares) => run((s) => queueWithdraw(s, shares)),
      cancelDeposit: (id) => run((s) => cancelDeposit(s, id)),
      cancelWithdraw: (id) => run((s) => cancelWithdraw(s, id)),
      reset: () => {
        const fresh = initialState();
        clearSim();
        ref.current = fresh;
        setState(fresh);
      },
    }),
    [state, hydrated, run],
  );

  return <SimContext.Provider value={api}>{children}</SimContext.Provider>;
}

export function useSim(): SimApi {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error("useSim must be used inside SimProvider");
  return ctx;
}
