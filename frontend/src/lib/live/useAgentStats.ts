"use client";

import { useEffect, useState } from "react";
import { getPublicClient } from "./client";
import { type AgentStats, fetchAgentStats } from "./agentStats";
import { useLiveData } from "./LiveDataProvider";

type Loaded = AgentStats & { source: "explorer" | "rpc" };

// Shared across mounts so switching pages does not re-query the explorer.
let cache: { key: string; at: number; stats: Loaded } | null = null;
const FRESH_MS = 60_000;

/**
 * Agent stats for the Agents page. Re-reads when the round count, phase or vault report changes,
 * keeps the last good data if a refresh fails.
 */
export function useAgentStats() {
  const { enabled, snapshot } = useLiveData();
  const [stats, setStats] = useState<Loaded | null>(cache?.stats ?? null);
  const [stale, setStale] = useState(false);

  const key = snapshot
    ? `${snapshot.currentRoundId}:${snapshot.round?.status ?? 0}:${snapshot.vault.unreportedRound}`
    : null;

  useEffect(() => {
    if (!enabled || key === null) return;
    if (cache && cache.key === key && Date.now() - cache.at < FRESH_MS) {
      setStats(cache.stats);
      setStale(false);
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await fetchAgentStats(getPublicClient());
        if (cancelled) return;
        cache = { key, at: Date.now(), stats: next };
        setStats(next);
        setStale(false);
      } catch {
        if (cancelled) return;
        setStale(true);
        retry = setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [enabled, key]);

  return { stats, stale, loading: stats === null && !stale };
}
