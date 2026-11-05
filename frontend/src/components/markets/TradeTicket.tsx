"use client";

import { useMemo, useState } from "react";
import { SLIPPAGE, quoteBuy, quoteSell } from "@/sim/amm";
import { fmtPct, fmtTok } from "@/sim/format";
import { useSim } from "@/sim/SimProvider";
import type { Position, Proposal, Round, Side, TradeAction } from "@/sim/types";
import { Eyebrow } from "../ui";

function Row({ label, value, tone }: Readonly<{ label: string; value: string; tone?: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`num text-sm ${tone ?? "text-text"}`}>{value}</dd>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: Readonly<{
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  label: string;
}>) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 rounded-full bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={`min-h-11 rounded-full text-sm transition-colors ${
            value === o ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function TradeTicket({
  proposal,
  position,
  round,
}: Readonly<{ proposal: Proposal; position: Position; round: Round }>) {
  const { state, trade } = useSim();
  const [action, setAction] = useState<TradeAction>("buy");
  const [side, setSide] = useState<Side>("LONG");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const value = Number(amount);
  const quote = useMemo(() => {
    if (!(value > 0)) return null;
    return action === "buy"
      ? quoteBuy(proposal.reserves, side, value)
      : quoteSell(proposal.reserves, side, value);
  }, [action, side, value, proposal.reserves]);

  const held = side === "LONG" ? position.long : position.short;
  const max = action === "buy" ? position.credits : held;
  const open = round.status === "open";
  const canSubmit = state.connected && open && quote !== null && value <= max + 1e-9;

  let hint: string | null = null;
  if (!state.connected) hint = "Connect the demo account to trade.";
  else if (!open) hint = "Trading is closed for this round.";
  else if (round.userDeposit === null) hint = "Deposit once, then claim credits in this proposal.";
  else if (value > max + 1e-9) {
    hint =
      action === "buy"
        ? "Not enough credits here. Claim more credits in this proposal."
        : `You only hold ${fmtTok(held)} ${side}.`;
  }

  const outUnit = action === "buy" ? side : "credits";

  function submit() {
    const res = trade(proposal.index, action, side, value);
    if (res.ok) {
      setMsg({ tone: "ok", text: "Trade filled." });
      setAmount("");
    } else {
      setMsg({ tone: "err", text: res.error });
    }
  }

  return (
    <section className="card p-5" aria-label="Trade ticket">
      <Eyebrow tone="green">Ticket · {proposal.name}</Eyebrow>
      <div className="mt-4 space-y-3">
        <Segmented
          label="Action"
          value={action}
          options={["buy", "sell"] as const}
          onChange={(v) => {
            setAction(v);
            setAmount("");
            setMsg(null);
          }}
        />
        <Segmented
          label="Side"
          value={side}
          options={["LONG", "SHORT"] as const}
          onChange={(v) => {
            setSide(v);
            setMsg(null);
          }}
        />
      </div>

      <label className="mt-4 block">
        <span className="eyebrow">{action === "buy" ? "Credits to spend" : `${side} to sell`}</span>
        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ""));
              setMsg(null);
            }}
            placeholder="0.00"
            className="num min-h-12 w-full bg-transparent text-lg outline-none"
          />
          <button
            type="button"
            onClick={() => setAmount(String(max))}
            className="eyebrow min-h-11 shrink-0 px-2 text-green"
          >
            Max
          </button>
        </div>
        <span className="num mt-1.5 block text-xs text-faint">
          Available: {fmtTok(max)} {action === "buy" ? "credits" : side}
        </span>
      </label>

      <dl className="mt-4 divide-y divide-border border-y border-border">
        <Row label="Quote (you receive)" value={quote ? `${fmtTok(quote.out)} ${outUnit}` : "·"} />
        <Row label="Average price" value={quote ? `${quote.avgPrice.toFixed(4)} credits` : "·"} />
        <Row
          label="Price impact"
          value={quote ? fmtPct(quote.impact) : "·"}
          tone={quote && quote.impact > 0.02 ? "text-amber" : undefined}
        />
        <Row label="pLong after" value={quote ? fmtPct(quote.pLongAfter, 2) : "·"} />
        <Row
          label={`Minimum received (${(SLIPPAGE * 100).toFixed(1)}% slippage)`}
          value={quote ? `${fmtTok(quote.minOut)} ${outUnit}` : "·"}
        />
      </dl>

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-green px-5 text-sm font-medium text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
      >
        {action === "buy" ? "Buy" : "Sell"} {side}
      </button>
      {hint ? <p className="mt-3 text-xs text-muted">{hint}</p> : null}
      {msg ? (
        <p role="status" className={`mt-3 text-xs ${msg.tone === "ok" ? "text-green" : "text-red"}`}>
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
