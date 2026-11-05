"use client";

import { impliedReturn, pLongOf, twapOf } from "@/sim/amm";
import { fmtPct, fmtSignedPct, fmtTok, fmtUsdc } from "@/sim/format";
import type { Position, Proposal, Round } from "@/sim/types";
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

export function ProposalCard({
  proposal,
  position,
  round,
  selected,
  collapsing,
  onSelect,
}: Readonly<{
  proposal: Proposal;
  position: Position;
  round: Round;
  selected: boolean;
  collapsing: boolean;
  onSelect: () => void;
}>) {
  const pLong = pLongOf(proposal.reserves);
  const twap = twapOf(proposal.samples);
  const implied = impliedReturn(pLong, round.rMin, round.rMax);
  const decided = round.status !== "open" && round.winner !== null;
  const isWinner = decided && round.winner === proposal.index;
  const state = collapsing
    ? "collapsing"
    : decided
      ? isWinner
        ? "winner"
        : "erased"
      : undefined;
  const teth = Math.round(proposal.tethShare * 100);

  return (
    <article
      className={`market-card card p-5 ${selected && !decided ? "border-border-strong ring-1 ring-green/40" : ""}`}
      data-state={state}
      aria-label={proposal.name}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl leading-tight">{proposal.name}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Pill tone={proposal.type === "Protocol" ? "muted" : "violet"}>
              {proposal.type}
            </Pill>
            <span className="eyebrow">{proposal.kind}</span>
          </div>
        </div>
        <span className="num shrink-0 text-xs text-faint">#{proposal.index}</span>
      </div>

      <div className="mt-5">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-green" style={{ width: `${teth}%` }} />
          <div className="bg-violet" style={{ width: `${100 - teth}%` }} />
        </div>
        <p className="num mt-2 text-xs text-muted">
          <span className="text-green">{teth}% tETH</span>
          {" · "}
          <span className="text-violet">{100 - teth}% USDC</span>
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Metric label="pLong / pShort" value={`${fmtPct(pLong, 1)} / ${fmtPct(1 - pLong, 1)}`} />
        <Metric label="Final-window TWAP" value={twap.toFixed(4)} />
        <Metric
          label="Implied return"
          value={fmtSignedPct(implied)}
          tone={implied >= 0 ? "text-green" : "text-red"}
        />
        <Metric label="Your credits" value={fmtUsdc(position.credits)} />
        <Metric label="Your LONG" value={fmtTok(position.long)} />
        <Metric label="Your SHORT" value={fmtTok(position.short)} />
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        {isWinner ? (
          <Pill tone="green">Winner</Pill>
        ) : decided ? (
          <Pill tone="muted">Erased</Pill>
        ) : (
          <span className="eyebrow">{collapsing ? "Evaluating…" : "Open"}</span>
        )}
        {round.status === "open" ? (
          <button
            type="button"
            onClick={onSelect}
            disabled={collapsing}
            className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm transition-colors ${
              selected
                ? "bg-green text-on-accent"
                : "border border-border-strong text-text hover:bg-surface-2"
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
