"use client";

import { useState } from "react";
import { fmtDate, fmtTok, fmtUsdc } from "@/sim/format";
import { useSim } from "@/sim/SimProvider";
import type { SimResult } from "@/sim/types";
import { Eyebrow } from "../ui";

function AmountForm({
  label,
  unit,
  max,
  cta,
  disabled,
  onSubmit,
}: Readonly<{
  label: string;
  unit: string;
  max: number;
  cta: string;
  disabled: boolean;
  onSubmit: (amount: number) => SimResult;
}>) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const res = onSubmit(Number(value));
        if (res.ok) {
          setValue("");
          setErr(null);
        } else setErr(res.error);
      }}
    >
      <span className="eyebrow">{label}</span>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
          aria-label={label}
          className="num min-h-12 w-full bg-transparent text-lg outline-none"
        />
        <button type="button" onClick={() => setValue(String(max))} className="eyebrow min-h-11 shrink-0 px-2 text-green">
          Max
        </button>
        <span className="eyebrow shrink-0">{unit}</span>
      </div>
      <button
        type="submit"
        disabled={disabled || !(Number(value) > 0)}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
      >
        {cta}
      </button>
      {err ? (
        <p role="alert" className="mt-2 text-xs text-red">
          {err}
        </p>
      ) : null}
    </form>
  );
}

export function QueuePanel() {
  const { state, queueDeposit, queueWithdraw, cancelDeposit, cancelWithdraw } = useSim();
  const v = state.vault;
  const queuedShares = v.queuedWithdrawals.reduce((a, w) => a + w.shares, 0);
  const free = Math.max(0, v.userShares - queuedShares);
  const empty = v.queuedDeposits.length === 0 && v.queuedWithdrawals.length === 0;

  return (
    <div>
      <p className="max-w-xl text-sm text-muted">
        Deposits and withdrawals are queued and processed at the next decision, at the share price
        then. Queued USDC is held aside until that point.
      </p>
      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <AmountForm
          label="Queue a deposit"
          unit="USDC"
          max={state.usdc}
          cta="Queue deposit"
          disabled={!state.connected}
          onSubmit={queueDeposit}
        />
        <AmountForm
          label="Queue a withdrawal"
          unit="shares"
          max={free}
          cta="Queue withdrawal"
          disabled={!state.connected || free <= 0}
          onSubmit={queueWithdraw}
        />
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <Eyebrow>Queued for the next decision</Eyebrow>
        {empty ? (
          <p className="mt-3 text-sm text-faint">Nothing queued.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {v.queuedDeposits.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm">Deposit</p>
                  <p className="num text-xs text-faint">{fmtDate(d.at)}</p>
                </div>
                <span className="num text-sm text-violet">{fmtUsdc(d.usdc)} USDC</span>
                <button
                  type="button"
                  onClick={() => cancelDeposit(d.id)}
                  className="eyebrow min-h-11 px-2 hover:text-text"
                >
                  Cancel
                </button>
              </li>
            ))}
            {v.queuedWithdrawals.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm">Withdrawal</p>
                  <p className="num text-xs text-faint">{fmtDate(w.at)}</p>
                </div>
                <span className="num text-sm">{fmtTok(w.shares)} shares</span>
                <button
                  type="button"
                  onClick={() => cancelWithdraw(w.id)}
                  className="eyebrow min-h-11 px-2 hover:text-text"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
