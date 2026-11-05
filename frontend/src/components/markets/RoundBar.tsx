"use client";

import { useState } from "react";
import { fmtPct, fmtSignedPct, fmtUsdc, roundLabel } from "@/sim/format";
import { MAX_ENTERED_RETURN, redeemableUsdc } from "@/sim/engine/round";
import { useSim } from "@/sim/SimProvider";
import type { Round } from "@/sim/types";
import { Eyebrow } from "../ui";

const STATUS = {
  open: { label: "Trading", tone: "green" },
  collapsed: { label: "Evaluating", tone: "amber" },
  settled: { label: "Settled", tone: "amber" },
} as const;

export function RoundBar({
  round,
  collapsing,
  onCollapse,
}: Readonly<{ round: Round; collapsing: boolean; onCollapse: () => void }>) {
  const { settle, redeem, nextRound } = useSim();
  const [entered, setEntered] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[round.status];

  const enteredNum = Number(entered) / 100;
  const clamped = Math.min(round.rMax, Math.max(round.rMin, enteredNum));
  const settlePrice = (clamped - round.rMin) / (round.rMax - round.rMin);
  const winner = round.winner !== null ? round.proposals[round.winner] : null;

  return (
    <section className="card p-6" aria-label="Round">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Eyebrow tone={status.tone}>
            Round {roundLabel(round.id)} · {status.label}
          </Eyebrow>
          <h2 className="mt-3 text-2xl leading-tight sm:text-3xl">
            Which allocation should the vault hold next?
          </h2>
          <p className="num mt-3 text-xs text-muted">
            Return range {fmtSignedPct(round.rMin, 0)} to {fmtSignedPct(round.rMax, 0)} · win
            margin {round.margin} over the status quo · TWAP of the last 12 samples
          </p>
        </div>

        {round.status === "open" ? (
          <button
            type="button"
            onClick={onCollapse}
            disabled={collapsing}
            className="inline-flex min-h-12 items-center rounded-full bg-amber px-6 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {collapsing ? "Collapsing…" : "Collapse round now"}
          </button>
        ) : null}
      </div>

      {round.collapse && winner ? (
        <div className="mt-5 rounded-xl bg-green-soft p-4">
          <p className="text-sm text-text">
            {round.winner === 0 ? (
              <>No agent beat the status quo by {round.margin}. The vault keeps its allocation.</>
            ) : (
              <>
                <span className="font-medium">{winner.name}</span> won. Its TWAP{" "}
                <span className="num">{round.collapse.winnerTwap.toFixed(4)}</span> beat the status
                quo <span className="num">{round.collapse.statusQuoTwap.toFixed(4)}</span> + {round.margin}.
              </>
            )}{" "}
            Other markets are erased.
          </p>
        </div>
      ) : null}

      {round.status === "collapsed" ? (
        <form
          className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            const res = settle(enteredNum);
            setError(res.ok ? null : res.error);
          }}
        >
          <label className="block">
            <span className="eyebrow">Realised return (%)</span>
            <input
              inputMode="decimal"
              value={entered}
              onChange={(e) => setEntered(e.target.value.replace(/[^0-9.-]/g, ""))}
              className="num mt-1.5 block min-h-12 w-36 rounded-xl border border-border bg-surface-2 px-3 text-lg outline-none"
            />
          </label>
          <p className="num pb-3 text-xs text-muted">
            Payout return {fmtSignedPct(clamped)} (clamped to range) · LONG pays {settlePrice.toFixed(4)}
            , SHORT pays {(1 - settlePrice).toFixed(4)}
          </p>
          <button
            type="submit"
            className="ml-auto inline-flex min-h-12 items-center rounded-full bg-green px-6 text-sm font-medium text-on-accent hover:opacity-90"
          >
            Settle round
          </button>
          <p className="basis-full text-xs text-faint">
            Allowed input: {fmtPct(-MAX_ENTERED_RETURN, 0)} to {fmtPct(MAX_ENTERED_RETURN, 0)}. Only the
            winning market affects your P&amp;L.
          </p>
        </form>
      ) : null}

      {round.status === "settled" && round.settlement ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
          <p className="num text-sm text-muted">
            Realised {fmtSignedPct(round.settlement.enteredReturn)} · payout return{" "}
            {fmtSignedPct(round.settlement.payoutReturn)} · LONG pays{" "}
            {round.settlement.price.toFixed(4)}
            {round.userDeposit !== null ? (
              <>
                {" "}
                ·{" "}
                {round.redeemed === null
                  ? `redeemable ${fmtUsdc(redeemableUsdc(round))} USDC`
                  : `redeemed ${fmtUsdc(round.redeemed)} USDC`}
              </>
            ) : null}
          </p>
          <div className="flex gap-2">
            {round.userDeposit !== null && round.redeemed === null ? (
              <button
                type="button"
                onClick={() => {
                  const res = redeem();
                  setError(res.ok ? null : res.error);
                }}
                className="inline-flex min-h-12 items-center rounded-full bg-green px-5 text-sm font-medium text-on-accent hover:opacity-90"
              >
                Redeem
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const res = nextRound();
                setError(res.ok ? null : res.error);
                setEntered("0");
              }}
              className="inline-flex min-h-12 items-center rounded-full border border-border-strong px-5 text-sm hover:bg-surface-2"
            >
              Start next round
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-xs text-red">
          {error}
        </p>
      ) : null}
    </section>
  );
}
