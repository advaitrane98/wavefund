import { pLongOf } from "@/sim/amm";
import { redeemValue } from "@/sim/engine/round";
import { fmtTok, fmtUsdc } from "@/sim/format";
import type { Round } from "@/sim/types";
import { Pill } from "../ui";

const GRID =
  "grid grid-cols-2 gap-x-4 gap-y-3 py-4 md:grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))_6rem] md:items-center";

function Cell({
  label,
  children,
  tone = "text-text",
}: Readonly<{ label: string; children: React.ReactNode; tone?: string }>) {
  return (
    <div className="min-w-0">
      <p className="eyebrow md:hidden">{label}</p>
      <p className={`num mt-1 truncate text-sm md:mt-0 md:text-right ${tone}`}>{children}</p>
    </div>
  );
}

export function PositionRows({ round }: Readonly<{ round: Round }>) {
  const decided = round.status !== "open" && round.winner !== null;

  return (
    <div role="table" aria-label={`Positions in round ${round.id}`}>
      <div
        role="row"
        className="hidden gap-x-4 border-b border-border pb-2 md:grid md:grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))_6rem]"
      >
        <span role="columnheader" className="eyebrow">Market</span>
        {["Credits", "LONG", "SHORT", round.status === "settled" ? "Redeemable" : "Mark value"].map((h) => (
          <span key={h} role="columnheader" className="eyebrow text-right">
            {h}
          </span>
        ))}
        <span role="columnheader" className="eyebrow text-right">Status</span>
      </div>

      <div className="divide-y divide-border">
        {round.proposals.map((p) => {
          const pos = round.positions[p.index];
          const isWinner = decided && round.winner === p.index;
          const erased = decided && !isWinner;
          const pLong = pLongOf(p.reserves);
          let value = pos.credits + pos.long * pLong + pos.short * (1 - pLong);
          if (round.status === "settled") value = isWinner ? redeemValue(round) : 0;

          return (
            <div key={p.index} role="row" className={`${GRID} ${erased ? "opacity-50" : ""}`}>
              <div className="col-span-2 min-w-0 md:col-span-1">
                <p className="truncate text-sm">{p.name}</p>
                <p className="eyebrow mt-0.5 truncate">{p.kind}</p>
              </div>
              <Cell label="Credits">{fmtUsdc(pos.credits)}</Cell>
              <Cell label="LONG">{fmtTok(pos.long)}</Cell>
              <Cell label="SHORT">{fmtTok(pos.short)}</Cell>
              <Cell label={round.status === "settled" ? "Redeemable" : "Mark value"}>
                {erased ? "·" : fmtUsdc(value)}
              </Cell>
              <div className="md:text-right">
                {isWinner ? (
                  <Pill tone="green">Winner</Pill>
                ) : erased ? (
                  <Pill tone="muted">Erased</Pill>
                ) : (
                  <Pill tone="muted">Open</Pill>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
