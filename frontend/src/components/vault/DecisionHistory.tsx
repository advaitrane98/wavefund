import { fmtDate, fmtPct, fmtSignedPct, fmtUsdc, roundLabel } from "@/sim/format";
import type { Decision } from "@/sim/types";
import { Pill } from "../ui";

export function DecisionHistory({ decisions }: Readonly<{ decisions: Decision[] }>) {
  return (
    <ul className="divide-y divide-border">
      {decisions.map((d) => (
        <li key={d.round} className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className="num text-sm">{roundLabel(d.round)}</p>
            <p className="num text-xs text-faint">{fmtDate(d.at)}</p>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm">{d.winnerName}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Pill tone={d.keptStatusQuo ? "muted" : "green"}>
                {d.keptStatusQuo ? "Status quo kept" : "Executed"}
              </Pill>
              {d.illustrative ? <Pill tone="amber">Illustrative</Pill> : null}
            </div>
          </div>
          <div>
            <p className="eyebrow">tETH share</p>
            <p className="num mt-1 text-sm">
              {fmtPct(d.prevTethShare, 0)} → {fmtPct(d.newTethShare, 0)}
            </p>
            <p className="num text-xs text-faint">
              TWAP {d.winnerTwap.toFixed(3)} vs {d.statusQuoTwap.toFixed(3)}
            </p>
          </div>
          <div>
            <p className="eyebrow">Result</p>
            <p
              className={`num mt-1 text-sm ${
                d.settledReturn === null ? "text-amber" : d.settledReturn >= 0 ? "text-green" : "text-red"
              }`}
            >
              {d.settledReturn === null ? "Evaluating" : fmtSignedPct(d.settledReturn)}
            </p>
            <p className="num text-xs text-faint">NAV {fmtUsdc(d.navAfter, 0)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
