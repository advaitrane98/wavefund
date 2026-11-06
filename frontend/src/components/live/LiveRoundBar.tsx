"use client";

import { formatUnits } from "viem";
import { quantumRoundAbi } from "@/generated/abis";
import { explorerTxUrl } from "@/lib/chain";
import { deployment } from "@/lib/contracts";
import {
  computePhase,
  formatCountdown,
  inFinalWindow,
  ratioToReturn,
  type RoundPhase,
} from "@/lib/live/logic";
import { useChainNow, useLiveData } from "@/lib/live/LiveDataProvider";
import type { RoundView } from "@/lib/live/types";
import { formatSignedPercent, usdc } from "@/lib/units";
import { Eyebrow } from "../ui";
import { TxStatus, useTxRunner } from "./useTxRunner";
import { useWallet } from "../WalletProvider";

const PHASE_LABEL: Record<RoundPhase, { label: string; tone: "green" | "amber" | "muted" }> = {
  none: { label: "No round", tone: "muted" },
  trading: { label: "Trading", tone: "green" },
  closed: { label: "Closed, awaiting collapse", tone: "amber" },
  evaluating: { label: "Evaluating", tone: "amber" },
  "awaiting-settlement": { label: "Evaluation ended, awaiting settlement", tone: "amber" },
  settled: { label: "Settled", tone: "amber" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const roundLabel = (id: number) => `#${String(id).padStart(3, "0")}`;

export function LiveRoundBar({ round }: Readonly<{ round: RoundView }>) {
  const now = useChainNow();
  const { history, snapshot } = useLiveData();
  const { address, onArc } = useWallet();
  const tx = useTxRunner();
  const addr = deployment.addresses.quantumRound;

  // Phase is recomputed against the live clock so the countdown flips states without a refetch.
  const phase = livePhase(round, now);
  const meta = PHASE_LABEL[phase];
  const finalWindow = phase === "trading" && inFinalWindow(now, round.tradingEnd, round.twapWindow);
  const winner = round.proposals.find((p) => p.id === round.winnerId);
  const tradeTx = history.find((h) => h.roundId === round.id)?.tradeTx ?? null;
  const pending = snapshot?.user?.pendingPayout ?? 0n;
  const canAct = Boolean(address && onArc && addr);

  return (
    <section className="card p-6" aria-label="Round">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Eyebrow tone={meta.tone === "muted" ? "muted" : meta.tone}>
            Round {roundLabel(round.id)} · {meta.label}
          </Eyebrow>
          <h2 className="mt-3 text-2xl leading-tight sm:text-3xl">
            Which allocation should the vault hold next?
          </h2>
          <p className="num mt-3 text-xs text-muted">
            Return range {formatSignedPercent(ratioToReturn(round.rMin))} to{" "}
            {formatSignedPercent(ratioToReturn(round.rMax))} · TWAP over the final{" "}
            {formatCountdown(round.twapWindow)}
          </p>
        </div>

        <div className="text-right">
          {phase === "trading" ? (
            <>
              <p className={`eyebrow ${finalWindow ? "text-amber" : ""}`}>
                {finalWindow ? "Final TWAP window" : "Trading ends in"}
              </p>
              <p className={`num mt-1 text-3xl ${finalWindow ? "text-amber" : "text-green"}`}>
                {formatCountdown(round.tradingEnd - now)}
              </p>
            </>
          ) : phase === "evaluating" ? (
            <>
              <p className="eyebrow">Evaluation ends in</p>
              <p className="num mt-1 text-3xl text-amber">{formatCountdown(round.evaluationEnd - now)}</p>
            </>
          ) : null}
        </div>
      </div>

      {finalWindow ? (
        <p className="mt-4 rounded-xl bg-amber-soft p-3 text-sm text-amber">
          The final TWAP window is open. Prices now count toward the winner.
        </p>
      ) : null}

      {phase === "closed" ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="max-w-lg text-sm text-muted">
            Trading has ended. Anyone can collapse the round. The best final-window TWAP wins if it beats
            the status quo by more than 0.005.
          </p>
          <button
            type="button"
            disabled={!canAct || tx.busy}
            onClick={() =>
              addr &&
              void tx.run("Round collapsed.", [
                {
                  label: "Collapsing round",
                  address: addr,
                  abi: quantumRoundAbi as never,
                  functionName: "collapse",
                  args: [BigInt(round.id)],
                },
              ])
            }
            className="inline-flex min-h-12 items-center rounded-full bg-amber px-6 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            Collapse round
          </button>
        </div>
      ) : null}

      {(phase === "evaluating" || phase === "awaiting-settlement" || phase === "settled") && winner ? (
        <div className="mt-5 rounded-xl bg-green-soft p-4 text-sm text-text">
          {round.winnerId === 0
            ? "No proposal beat the status quo. The vault keeps its allocation."
            : `${winner.proposerName ?? "A proposal"} won. The other markets are erased.`}
          {tradeTx ? (
            <>
              {" "}
              <a
                href={explorerTxUrl(tradeTx)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green underline"
              >
                View the vault trade
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {phase === "settled" ? (
        <dl className="num mt-5 grid grid-cols-3 gap-4 border-t border-border pt-5 text-sm">
          <div>
            <dt className="eyebrow">Realised return</dt>
            <dd className="mt-1 text-lg">{formatSignedPercent(ratioToReturn(round.realisedReturn))}</dd>
          </div>
          <div>
            <dt className="eyebrow">Pays per LONG</dt>
            <dd className="mt-1 text-lg text-green">{Number(formatUnits(round.pi, 18)).toFixed(4)} USDC</dd>
          </div>
          <div>
            <dt className="eyebrow">Pays per SHORT</dt>
            <dd className="mt-1 text-lg text-red">
              {Number(formatUnits(10n ** 18n - round.pi, 18)).toFixed(4)} USDC
            </dd>
          </div>
        </dl>
      ) : null}

      {phase === "cancelled" ? (
        <p className="mt-5 rounded-xl bg-amber-soft p-4 text-sm text-amber">
          The vault&apos;s slippage guard cancelled this round. Nothing was traded, and deposits redeem at
          par.
        </p>
      ) : null}

      {(phase === "settled" || phase === "cancelled") && round.user.previewRedeem > 0n ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="num text-sm text-muted">
            Redeemable: <span className="text-text">{usdc.format(round.user.previewRedeem)} USDC</span>
          </p>
          <button
            type="button"
            disabled={!canAct || tx.busy}
            onClick={() =>
              addr &&
              void tx.run("Redeemed.", [
                {
                  label: "Redeeming",
                  address: addr,
                  abi: quantumRoundAbi as never,
                  functionName: "redeem",
                  args: [BigInt(round.id)],
                },
              ])
            }
            className="inline-flex min-h-12 items-center rounded-full bg-green px-6 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            Redeem
          </button>
        </div>
      ) : null}

      {pending > 0n ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="num text-sm text-muted">
            A payout of <span className="text-text">{usdc.format(pending)} USDC</span> could not be sent
            directly and is waiting for you.
          </p>
          <button
            type="button"
            disabled={!canAct || tx.busy}
            onClick={() =>
              addr &&
              void tx.run("Payout claimed.", [
                {
                  label: "Claiming payout",
                  address: addr,
                  abi: quantumRoundAbi as never,
                  functionName: "claimPayout",
                },
              ])
            }
            className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-5 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            Claim payout
          </button>
        </div>
      ) : null}

      <TxStatus state={tx.state} />
    </section>
  );
}

/** Recomputes the phase from the chain clock so countdowns flip states on time. */
function livePhase(round: RoundView, now: number): RoundPhase {
  return computePhase(round.status, now, round.tradingEnd, round.evaluationEnd);
}
