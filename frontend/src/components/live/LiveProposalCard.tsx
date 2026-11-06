"use client";

import { explorerAddressUrl, shortAddress } from "@/lib/chain";
import { formatBps, formatProbability, formatSignedPercent, credits, long, short } from "@/lib/units";
import type { RoundPhase } from "@/lib/live/logic";
import type { ProposalView, RoundView } from "@/lib/live/types";
import { Pill } from "../ui";

function Metric({
  label,
  value,
  tone = "text-text",
}: Readonly<{ label: string; value: string; tone?: string }>) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p className={`num mt-1 truncate text-base ${tone}`}>{value}</p>
    </div>
  );
}

export function LiveProposalCard({
  proposal,
  round,
  phase,
  selected,
  onSelect,
}: Readonly<{
  proposal: ProposalView;
  round: RoundView;
  phase: RoundPhase;
  selected: boolean;
  onSelect: () => void;
}>) {
  const decided = phase === "evaluating" || phase === "awaiting-settlement" || phase === "settled";
  const isWinner = decided && round.winnerId === proposal.id;
  const state = decided ? (isWinner ? "winner" : "erased") : undefined;
  const tradable = phase === "trading";
  const teth = Number(proposal.tEthBps) / 100;
  const name = proposal.isStatusQuo
    ? "Keep current allocation (Protocol)"
    : (proposal.proposerName ?? (proposal.proposer ? shortAddress(proposal.proposer) : "Proposal"));

  return (
    <article
      className={`market-card card p-5 ${selected && tradable ? "border-border-strong ring-1 ring-green/40" : ""}`}
      data-state={state}
      aria-label={name}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl leading-tight">{name}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Pill tone={proposal.isStatusQuo ? "muted" : "violet"}>
              {proposal.isStatusQuo ? "Protocol" : "Agent"}
            </Pill>
            {proposal.proposer ? (
              <a
                href={explorerAddressUrl(proposal.proposer)}
                target="_blank"
                rel="noopener noreferrer"
                className="eyebrow hover:text-text"
              >
                {shortAddress(proposal.proposer)}
              </a>
            ) : null}
          </div>
        </div>
        <span className="num shrink-0 text-xs text-faint">#{proposal.id}</span>
      </div>

      <div className="mt-5">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-green" style={{ width: `${teth}%` }} />
          <div className="bg-violet" style={{ width: `${100 - teth}%` }} />
        </div>
        <p className="num mt-2 text-xs text-muted">
          <span className="text-green">{formatBps(proposal.tEthBps)} tETH</span>
          {" · "}
          <span className="text-violet">{formatBps(10_000 - proposal.tEthBps)} USDC</span>
        </p>
      </div>

      {proposal.rationale ? (
        <p className="mt-4 line-clamp-3 text-sm text-muted">{proposal.rationale}</p>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Metric
          label="pLong / pShort"
          value={`${formatProbability(proposal.pLong)} / ${formatProbability(proposal.pShort)}`}
        />
        <Metric label="Final-window TWAP" value={(Number(proposal.twap) / 1e18).toFixed(4)} />
        <Metric
          label="Implied return"
          value={formatSignedPercent(proposal.impliedReturn)}
          tone={proposal.impliedReturn >= 0 ? "text-green" : "text-red"}
        />
        <Metric label="Your credits" value={credits.format(proposal.user.credits)} />
        <Metric label="Your LONG" value={long.format(proposal.user.long)} />
        <Metric label="Your SHORT" value={short.format(proposal.user.short)} />
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        {isWinner ? (
          <Pill tone="green">Winner</Pill>
        ) : decided ? (
          <Pill tone="muted">Erased</Pill>
        ) : (
          <span className="eyebrow">{tradable ? "Open" : "Closed"}</span>
        )}
        {tradable ? (
          <button
            type="button"
            onClick={onSelect}
            className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm transition-colors ${
              selected ? "bg-green text-on-accent" : "border border-border-strong text-text hover:bg-surface-2"
            }`}
          >
            {selected ? "Selected" : "Trade"}
          </button>
        ) : null}
      </div>

      <span className="erased-stamp absolute right-4 top-1/2 -translate-y-1/2 rounded-md border-2 border-faint px-3 py-1 font-mono text-lg font-medium uppercase tracking-[0.2em] text-muted">
        Erased
      </span>
    </article>
  );
}
