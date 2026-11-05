"use client";

import { useState } from "react";
import { fmtUsdc } from "@/sim/format";
import { useSim } from "@/sim/SimProvider";
import { r6 } from "@/sim/format";
import type { Proposal, Round } from "@/sim/types";
import { Eyebrow } from "../ui";

export function AccountPanel({
  round,
  selected,
}: Readonly<{ round: Round; selected: Proposal }>) {
  const { state, deposit, claim, claimAll } = useSim();
  const [depositAmt, setDepositAmt] = useState("");
  const [claimAmt, setClaimAmt] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const open = round.status === "open";
  const dep = round.userDeposit;
  const pos = round.positions[selected.index];
  const room = dep === null ? 0 : r6(dep - pos.claimed);

  function report(res: { ok: true } | { ok: false; error: string }, ok: string) {
    setMsg(res.ok ? { tone: "ok", text: ok } : { tone: "err", text: res.error });
    return res.ok;
  }

  return (
    <section className="card p-5" aria-label="Deposit and claim">
      <Eyebrow tone="violet">Your deposit</Eyebrow>

      {dep === null ? (
        <>
          <p className="mt-3 text-sm text-muted">
            Deposit USDC once. It becomes credits you can claim in every proposal.
          </p>
          <label className="mt-4 block">
            <span className="eyebrow">USDC to deposit</span>
            <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
              <input
                inputMode="decimal"
                value={depositAmt}
                onChange={(e) => setDepositAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                className="num min-h-12 w-full bg-transparent text-lg outline-none"
              />
              <button
                type="button"
                onClick={() => setDepositAmt(String(state.usdc))}
                className="eyebrow min-h-11 shrink-0 px-2 text-green"
              >
                Max
              </button>
            </div>
            <span className="num mt-1.5 block text-xs text-faint">
              Wallet: {fmtUsdc(state.usdc)} USDC
            </span>
          </label>
          <button
            type="button"
            disabled={!state.connected || !open || !(Number(depositAmt) > 0)}
            onClick={() => {
              if (report(deposit(Number(depositAmt)), "Deposited.")) setDepositAmt("");
            }}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-green px-5 text-sm font-medium text-on-accent enabled:hover:opacity-90 disabled:opacity-40"
          >
            Deposit once
          </button>
        </>
      ) : (
        <>
          <p className="num mt-3 text-2xl text-violet">{fmtUsdc(dep)} credits</p>
          <p className="mt-1 text-xs text-muted">Deposited once for this round.</p>

          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm">
              Claim in <span className="text-text">{selected.name}</span>
            </p>
            <p className="num mt-1 text-xs text-muted">
              Up to {fmtUsdc(room)} credits per proposal (claimed {fmtUsdc(pos.claimed)} here).
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
              <input
                inputMode="decimal"
                value={claimAmt}
                onChange={(e) => setClaimAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                aria-label="Credits to claim"
                className="num min-h-12 w-full bg-transparent text-lg outline-none"
              />
              <button
                type="button"
                onClick={() => setClaimAmt(String(room))}
                className="eyebrow min-h-11 shrink-0 px-2 text-green"
              >
                Max
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!open || !(Number(claimAmt) > 0)}
                onClick={() => {
                  if (report(claim(selected.index, Number(claimAmt)), "Credits claimed.")) {
                    setClaimAmt("");
                  }
                }}
                className="min-h-11 rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
              >
                Claim
              </button>
              <button
                type="button"
                disabled={!open}
                onClick={() => report(claimAll(), "Claimed the maximum in every proposal.")}
                className="min-h-11 rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
              >
                Claim max in all
              </button>
            </div>
          </div>
        </>
      )}

      {msg ? (
        <p role="status" className={`mt-3 text-xs ${msg.tone === "ok" ? "text-green" : "text-red"}`}>
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
