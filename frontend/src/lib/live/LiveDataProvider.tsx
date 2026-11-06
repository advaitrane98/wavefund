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
import { usePreferences } from "@/components/PreferencesProvider";
import { useWallet } from "@/components/WalletProvider";
import { hasLiveDeployment } from "@/config/contracts";
import { getPublicClient } from "./client";
import { fetchHistory, fetchSnapshot, fetchUserRounds, type UserRoundRow } from "./snapshot";
import type { HistoryRow, Snapshot } from "./types";

const POLL_MS = 30_000;
const RETRY_MS = 8_000;

export type LiveStatus = "off" | "loading" | "ok" | "stale";

interface LiveData {
  /** True when on-chain mode is selected and a deployment is available. */
  enabled: boolean;
  snapshot: Snapshot | null;
  history: HistoryRow[];
  /** The connected user's deposit and redeemable amount per recent round. */
  userRounds: UserRoundRow[];
  status: LiveStatus;
  /** Re-read now. */
  refresh: () => Promise<void>;
  /** Re-read now and again shortly after, once the user's own transaction is confirmed. */
  refreshAfterTx: () => void;
}

const LiveDataContext = createContext<LiveData | null>(null);

export function LiveDataProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { dataMode } = usePreferences();
  const { address, chainId } = useWallet();
  const enabled = dataMode === "onchain" && hasLiveDeployment;

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [userRounds, setUserRounds] = useState<UserRoundRow[]>([]);
  const [status, setStatus] = useState<LiveStatus>("off");

  const inFlight = useRef(false);
  const lastOk = useRef(0);
  const historyKey = useRef("");
  const retryTimer = useRef<number | null>(null);
  const accountRef = useRef(address);
  accountRef.current = address;

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setStatus((s) => (s === "off" ? "loading" : s));
    try {
      const client = getPublicClient();
      const snap = await fetchSnapshot(client, accountRef.current);
      setSnapshot(snap);
      setStatus("ok");
      lastOk.current = Date.now();

      // History is re-read only when the round count, phase, or vault decision changes.
      const account = accountRef.current;
      const key = `${snap.currentRoundId}:${snap.round?.status ?? 0}:${snap.vault.unreportedRound}:${account ?? ""}`;
      if (key !== historyKey.current) {
        try {
          const [rows, mine] = await Promise.all([
            fetchHistory(client, snap.currentRoundId),
            account ? fetchUserRounds(client, snap.currentRoundId, account) : Promise.resolve([]),
          ]);
          setHistory(rows);
          setUserRounds(mine);
          historyKey.current = key;
        } catch {
          // Keep the previous history and try again on the next cycle.
        }
      }
    } catch {
      // Keep the last good data and show the stale notice. Retry sooner than the poll.
      setStatus("stale");
      if (retryTimer.current === null) {
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          void refresh();
        }, RETRY_MS);
      }
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  // Start, restart on account or chain change, poll every 30 s, pause while hidden.
  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    historyKey.current = "";
    void refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastOk.current > POLL_MS) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [enabled, address, chainId, refresh]);

  const refreshAfterTx = useCallback(() => {
    void refresh();
    window.setTimeout(() => void refresh(), 2_500);
  }, [refresh]);

  const value = useMemo<LiveData>(
    () => ({ enabled, snapshot, history, userRounds, status, refresh, refreshAfterTx }),
    [enabled, snapshot, history, userRounds, status, refresh, refreshAfterTx],
  );

  return <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>;
}

export function useLiveData(): LiveData {
  const ctx = useContext(LiveDataContext);
  if (!ctx) throw new Error("useLiveData must be used inside LiveDataProvider");
  return ctx;
}

/** Chain-time seconds, ticking every second. */
export function useChainNow(): number {
  const { snapshot } = useLiveData();
  const skew = snapshot?.clockSkew ?? 0;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000) + skew);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000) + skew);
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [skew]);
  return now;
}
