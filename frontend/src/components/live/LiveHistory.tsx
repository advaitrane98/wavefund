"use client";

import { explorerTxUrl } from "@/lib/chain";
import { ratioToReturn } from "@/lib/live/logic";
import type { HistoryRow } from "@/lib/live/types";
import { formatBps, formatSignedPercent, usdc } from "@/lib/units";
import { Pill } from "../ui";

/** Return text for a round. A ratio of 1.034 is a +3.4% return; nothing is shown before a decision. */
export function resultOf(h: HistoryRow): { text: string; tone: string } {
  if (h.status === 4 || h.cancelled) return { text: "Cancelled, redeemed at par", tone: "text-muted" };
  if (h.status === 3) {
    const r = ratioToReturn(h.realisedReturn);
    return { text: formatSignedPercent(r), tone: r >= 0 ? "text-green" : "text-red" };
  }
  if (h.executed) return { text: "Evaluating", tone: "text-amber" };
  return { text: "Starting NAV pending", tone: "text-faint" };
}

const roundLabel = (id: number) => `#${String(id).padStart(3, "0")}`;

export function LiveHistory({ rows }: Readonly<{ rows: HistoryRow[] }>) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-faint">No rounds yet.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((h) => {
        const result = resultOf(h);
        const decided = h.status >= 2;
        return (
          <li
            key={h.roundId}
            className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]"
          >
            <div>
              <p className="num text-sm">{roundLabel(h.roundId)}</p>
              <p className="eyebrow mt-1">{h.status === 1 ? "Trading" : h.status === 2 ? "Collapsed" : h.status === 3 ? "Settled" : "Cancelled"}</p>
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm">{h.winnerName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {decided ? (
                  <Pill tone={h.winnerId === 0 ? "muted" : "green"}>
                    {h.winnerId === 0 ? "Status quo kept" : "Executed"}
                  </Pill>
                ) : null}
                {h.tradeTx ? (
                  <a
                    href={explorerTxUrl(h.tradeTx)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="eyebrow text-green hover:underline"
                  >
                    Vault trade
                  </a>
                ) : null}
              </div>
            </div>
            <div>
              <p className="eyebrow">tETH share</p>
              <p className="num mt-1 text-sm">
                {decided
                  ? `${formatBps(h.statusQuoTEthBps, 0)} → ${formatBps(h.winnerTEthBps, 0)}`
                  : "·"}
              </p>
              <p className="num text-xs text-faint">
                {h.executed ? `Start NAV ${usdc.format(h.startValueUsdc, 0)}` : "Starting NAV pending"}
              </p>
            </div>
            <div>
              <p className="eyebrow">Result</p>
              <p className={`num mt-1 text-sm ${result.tone}`}>{result.text}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
