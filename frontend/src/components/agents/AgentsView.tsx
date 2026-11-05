"use client";

import { AGENTS } from "@/sim/agents";
import { fmtPct, fmtSignedPct, roundLabel } from "@/sim/format";
import { useSim } from "@/sim/SimProvider";
import { Card, Eyebrow, Pill } from "../ui";

export function AgentsView() {
  const { state } = useSim();
  const inRound = new Set(state.round.proposals.map((p) => p.agentId).filter(Boolean));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone="amber">Illustrative</Pill>
        <p className="text-sm text-muted">
          These agents and their track records are invented for the demo. They are not real agents.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {AGENTS.map((a) => {
          const winRate = a.roundsWon / a.roundsProposed;
          const active = inRound.has(a.id);
          return (
            <Card key={a.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-display text-2xl leading-tight">{a.name}</h2>
                  <p className="eyebrow mt-2">{a.kind}</p>
                </div>
                {active ? <Pill tone="green">In round {roundLabel(state.round.id)}</Pill> : null}
              </div>
              <p className="mt-4 text-sm text-muted">{a.summary}</p>

              <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4">
                <div>
                  <dt className="eyebrow">Proposed</dt>
                  <dd className="num mt-1 text-sm">{a.roundsProposed}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Win rate</dt>
                  <dd className="num mt-1 text-sm">{fmtPct(winRate, 0)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Avg return</dt>
                  <dd className={`num mt-1 text-sm ${a.avgRealisedReturn >= 0 ? "text-green" : "text-red"}`}>
                    {fmtSignedPct(a.avgRealisedReturn)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4">
                <Eyebrow>Typical tETH share</Eyebrow>
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="bg-green" style={{ width: `${a.baseTethShare * 100}%` }} />
                  <div className="bg-violet" style={{ width: `${(1 - a.baseTethShare) * 100}%` }} />
                </div>
                <p className="num mt-2 text-xs text-muted">
                  {fmtPct(a.baseTethShare, 0)} tETH · {fmtPct(1 - a.baseTethShare, 0)} USDC
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
