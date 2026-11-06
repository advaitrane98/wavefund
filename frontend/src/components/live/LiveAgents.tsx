"use client";

import { explorerAddressUrl, shortAddress } from "@/lib/chain";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { formatBps, formatProbability, formatSignedPercent } from "@/lib/units";
import { Card, Eyebrow, Pill } from "../ui";

/** Proposers in the current round, read from the QuantumRound and the ProposerRegistry. */
export function LiveAgents() {
  const { snapshot } = useLiveData();
  const round = snapshot?.round;
  const proposers = round?.proposals.filter((p) => !p.isStatusQuo) ?? [];

  if (!round || proposers.length === 0) {
    return (
      <Card>
        <Eyebrow tone="amber">No proposers yet</Eyebrow>
        <p className="mt-3 max-w-xl text-sm text-muted">
          Registered agents propose allocations while a round is open. They appear here when they do.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {proposers.map((p) => (
        <Card key={p.id} className="flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display min-w-0 truncate text-2xl leading-tight">
              {p.proposerName ?? "Unnamed agent"}
            </h2>
            <Pill tone="violet">Proposal {p.id}</Pill>
          </div>
          {p.proposer ? (
            <a
              href={explorerAddressUrl(p.proposer)}
              target="_blank"
              rel="noopener noreferrer"
              className="num mt-2 text-xs text-muted hover:text-text"
            >
              {shortAddress(p.proposer)}
            </a>
          ) : null}
          <p className="mt-4 flex-1 text-sm text-muted">{p.rationale || "No rationale provided."}</p>
          <dl className="num mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
            <div>
              <dt className="eyebrow">tETH</dt>
              <dd className="mt-1">{formatBps(p.tEthBps)}</dd>
            </div>
            <div>
              <dt className="eyebrow">pLong</dt>
              <dd className="mt-1">{formatProbability(p.pLong)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Implied</dt>
              <dd className={`mt-1 ${p.impliedReturn >= 0 ? "text-green" : "text-red"}`}>
                {formatSignedPercent(p.impliedReturn)}
              </dd>
            </div>
          </dl>
        </Card>
      ))}
    </div>
  );
}
