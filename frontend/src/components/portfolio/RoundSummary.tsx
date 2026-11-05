import { redeemableUsdc } from "@/sim/engine/round";
import { fmtSigned, fmtUsdc, roundLabel } from "@/sim/format";
import type { Round } from "@/sim/types";
import { Eyebrow } from "../ui";
import { PositionRows } from "./PositionRows";

const STATUS = {
  open: { label: "Trading", tone: "green" },
  collapsed: { label: "Evaluating", tone: "amber" },
  settled: { label: "Settled", tone: "amber" },
} as const;

function Stat({
  label,
  value,
  tone = "text-text",
}: Readonly<{ label: string; value: string; tone?: string }>) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`num mt-1 truncate text-lg ${tone}`}>{value}</dd>
    </div>
  );
}

export function RoundSummary({ round }: Readonly<{ round: Round }>) {
  const status = STATUS[round.status];
  const dep = round.userDeposit;
  const settled = round.status === "settled" && dep !== null;
  const redeemable = settled ? redeemableUsdc(round) : null;
  const pnl = redeemable !== null && dep !== null ? redeemable - dep : null;

  return (
    <div>
      <Eyebrow tone={status.tone}>
        Round {roundLabel(round.id)} · {status.label}
      </Eyebrow>

      {dep === null ? (
        <p className="mt-3 text-sm text-muted">You did not deposit in this round.</p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Stat label="Deposit" value={`${fmtUsdc(dep)} credits`} tone="text-violet" />
            <Stat
              label={round.redeemed !== null ? "Redeemed" : "Redeemable"}
              value={
                round.redeemed !== null
                  ? `${fmtUsdc(round.redeemed)} USDC`
                  : redeemable !== null
                    ? `${fmtUsdc(redeemable)} USDC`
                    : "After settlement"
              }
            />
            <Stat
              label="P&L (winning market)"
              value={pnl === null ? "·" : `${fmtSigned(pnl)} USDC`}
              tone={pnl === null ? "text-muted" : pnl >= 0 ? "text-green" : "text-red"}
            />
            <Stat
              label="Winner"
              value={round.winner !== null ? round.proposals[round.winner].name : "Not decided"}
            />
          </dl>
          <div className="mt-6">
            <PositionRows round={round} />
          </div>
        </>
      )}
    </div>
  );
}
