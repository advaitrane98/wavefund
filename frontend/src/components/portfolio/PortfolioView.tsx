"use client";

import { useState } from "react";
import { fmtTok, fmtUsdc } from "@/sim/format";
import { navOf } from "@/sim/seed";
import { useSim } from "@/sim/SimProvider";
import { Card, Eyebrow } from "../ui";
import { ConnectPrompt } from "../WorkspaceGate";
import { RoundSummary } from "./RoundSummary";

function Balance({
  label,
  value,
  unit,
  tone = "text-text",
}: Readonly<{ label: string; value: string; unit: string; tone?: string }>) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`num mt-1 truncate text-xl ${tone}`}>{value}</dd>
      <p className="num text-xs text-faint">{unit}</p>
    </div>
  );
}

export function PortfolioView() {
  const { state, faucet } = useSim();
  const [flash, setFlash] = useState(false);
  const v = state.vault;
  const round = state.round;

  const sharePrice = navOf(v) / v.totalShares;
  const vaultValue = v.userShares * sharePrice;
  const queued = v.queuedDeposits.reduce((a, d) => a + d.usdc, 0);
  const escrow = round.userDeposit !== null && round.redeemed === null ? round.userDeposit : 0;

  return (
    <div className="space-y-6">
      <ConnectPrompt text="Connect the demo account to see your balances and positions." />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow tone="violet">Balances</Eyebrow>
          <button
            type="button"
            disabled={!state.connected}
            onClick={() => {
              faucet();
              setFlash(true);
              window.setTimeout(() => setFlash(false), 1200);
            }}
            className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
          >
            {flash ? "+1,000 added" : "Faucet: +1,000 USDC"}
          </button>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Balance label="Demo wallet" value={fmtUsdc(state.usdc)} unit="USDC" tone="text-violet" />
          <Balance label="Escrowed in round" value={fmtUsdc(escrow)} unit="USDC (credits)" />
          <Balance label="Vault shares" value={fmtTok(v.userShares)} unit={`worth ${fmtUsdc(vaultValue)} USDC`} />
          <Balance label="Queued vault deposits" value={fmtUsdc(queued)} unit="USDC" />
        </dl>
        <p className="num mt-5 border-t border-border pt-4 text-xs text-muted">
          Total {fmtUsdc(state.usdc + escrow + vaultValue + queued)} USDC (one pool of demo USDC, ERC-20 view).
        </p>
      </Card>

      <Card>
        <RoundSummary round={round} />
      </Card>

      {state.pastRounds.length > 0 ? (
        <section>
          <Eyebrow>Past rounds</Eyebrow>
          <div className="mt-3 space-y-3">
            {state.pastRounds.map((r) => (
              <details key={r.id} className="card group p-6">
                <summary className="cursor-pointer list-none">
                  <RoundHeaderLine id={r.id} />
                </summary>
                <div className="mt-5">
                  <RoundSummary round={r} />
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RoundHeaderLine({ id }: Readonly<{ id: number }>) {
  return (
    <span className="eyebrow">
      Round #{String(id).padStart(3, "0")} · tap to expand
    </span>
  );
}
