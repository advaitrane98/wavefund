"use client";

import { useEffect, useMemo, useState } from "react";
import { marketAbi, quantumRoundAbi } from "@/generated/abis";
import { deployment } from "@/lib/contracts";
import { getPublicClient } from "@/lib/live/client";
import { explainError } from "@/lib/live/errors";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { estimatePLongAfter, nearBound } from "@/lib/live/logic";
import type { ProposalView, RoundView } from "@/lib/live/types";
import {
  COMPLETE_SET_SCALE,
  applySlippage,
  credits,
  long,
  short,
  type Unit,
} from "@/lib/units";
import { Eyebrow } from "../ui";
import { TxStatus, useTxRunner } from "./useTxRunner";
import { useWallet } from "../WalletProvider";

type Action = "buy" | "sell";
type Side = "LONG" | "SHORT";

function Row({ label, value, tone }: Readonly<{ label: string; value: string; tone?: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`num text-right text-sm ${tone ?? "text-text"}`}>{value}</dd>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: Readonly<{ value: T; options: readonly T[]; onChange: (v: T) => void; label: string }>) {
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

interface Preview {
  out: bigint;
  avgPrice: number;
  impact: number;
  pLongAfter: number;
  minOut: bigint;
}

export function LiveTicket({
  round,
  proposal,
}: Readonly<{ round: RoundView; proposal: ProposalView }>) {
  const { address, onArc } = useWallet();
  const { snapshot } = useLiveData();
  const tx = useTxRunner();
  const [action, setAction] = useState<Action>("buy");
  const [side, setSide] = useState<Side>("LONG");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const market = deployment.addresses.market;
  const qr = deployment.addresses.quantumRound;
  const open = round.phase === "trading";
  const ready = Boolean(address && onArc && market && qr);

  const inUnit: Unit = action === "buy" ? credits : side === "LONG" ? long : short;
  const amountRaw = inUnit.parse(text);
  const held = action === "buy" ? proposal.user.credits : side === "LONG" ? proposal.user.long : proposal.user.short;
  const tooMuch = amountRaw !== null && amountRaw > held;
  const blockNumber = snapshot?.blockNumber;

  // Quote from the adapter's quote* functions (debounced; refreshed when the chain moves).
  useEffect(() => {
    setPreview(null);
    setQuoteError(null);
    if (!open || !market || amountRaw === null || amountRaw === 0n) {
      setQuoting(false);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = window.setTimeout(async () => {
      try {
        const fn = `quote${action === "buy" ? "Buy" : "Sell"}${side === "LONG" ? "Long" : "Short"}`;
        const raw = await getPublicClient().readContract({
          address: market,
          abi: marketAbi,
          functionName: fn as never,
          args: [BigInt(round.id), BigInt(proposal.id), amountRaw] as never,
        });
        if (cancelled) return;

        const pLong = Number(proposal.pLong) / 1e18;
        const spot = side === "LONG" ? pLong : 1 - pLong;
        const seed = Number(proposal.seedCredits);
        let out: bigint;
        let legOutCredits: number;
        let avgPrice: number;
        let impact: number;
        if (action === "buy") {
          out = raw as bigint;
          legOutCredits = Number(out - amountRaw * COMPLETE_SET_SCALE) / 1e12;
          avgPrice = Number(amountRaw) / 1e6 / (Number(out) / 1e18);
          impact = avgPrice / spot - 1;
        } else {
          const [creditsOut, longDust, shortDust] = raw as readonly [bigint, bigint, bigint];
          out = creditsOut;
          const dust = side === "LONG" ? shortDust : longDust;
          legOutCredits = Number(creditsOut) + Number(dust) / 1e12;
          avgPrice = Number(creditsOut) / 1e6 / (Number(amountRaw) / 1e18);
          impact = 1 - avgPrice / spot;
        }
        setPreview({
          out,
          avgPrice,
          impact,
          pLongAfter: estimatePLongAfter({ action, side, pLong, seedCredits: seed, legOutCredits }),
          minOut: applySlippage(out),
        });
        setQuoteError(null);
      } catch (err) {
        if (!cancelled) setQuoteError(explainError(err));
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, market, action, side, amountRaw, round.id, proposal.id, proposal.pLong, proposal.seedCredits, blockNumber]);

  const outUnit: Unit = action === "buy" ? (side === "LONG" ? long : short) : credits;
  const warn = useMemo(() => {
    if (!preview) return null;
    if (nearBound(preview.pLongAfter)) {
      return "This trade would leave the price near the 1% / 99% bounds. Large trades there can fail for lack of liquidity.";
    }
    return null;
  }, [preview]);

  let hint: string | null = null;
  if (!address) hint = "Connect your wallet to trade.";
  else if (!onArc) hint = "Switch your wallet to Arc testnet.";
  else if (!open) hint = "Trading is closed for this round.";
  else if (tooMuch)
    hint =
      action === "buy"
        ? "Not enough credits in this proposal. Claim more credits first."
        : `You only hold ${inUnit.format(held)} ${side} here.`;

  async function submit() {
    if (!qr || amountRaw === null || !preview) return;
    const fn = `${action}${side === "LONG" ? "Long" : "Short"}`;
    const ok = await tx.run(action === "buy" ? "Trade filled." : "Sold.", [
      {
        label: action === "buy" ? `Buying ${side}` : `Selling ${side}`,
        address: qr,
        abi: quantumRoundAbi as never,
        functionName: fn,
        args: [BigInt(round.id), BigInt(proposal.id), amountRaw, preview.minOut],
      },
    ]);
    if (ok) setText("");
  }

  return (
    <section className="card p-5" aria-label="Trade ticket">
      <Eyebrow tone="green">
        Ticket · {proposal.isStatusQuo ? "Status quo" : (proposal.proposerName ?? `Proposal ${proposal.id}`)}
      </Eyebrow>
      <div className="mt-4 space-y-3">
        <Segmented label="Action" value={action} options={["buy", "sell"] as const} onChange={(v) => { setAction(v); setText(""); }} />
        <Segmented label="Side" value={side} options={["LONG", "SHORT"] as const} onChange={(v) => { setSide(v); setText(""); }} />
      </div>

      <label className="mt-4 block">
        <span className="eyebrow">{action === "buy" ? "Credits to spend" : `${side} to sell`}</span>
        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
          <input
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            className="num min-h-12 w-full bg-transparent text-lg outline-none"
          />
          <button
            type="button"
            onClick={() => setText(inUnit.format(held, inUnit.decimals).replace(/,/g, ""))}
            className="eyebrow min-h-11 shrink-0 px-2 text-green"
          >
            Max
          </button>
        </div>
        <span className="num mt-1.5 block text-xs text-faint">
          Available: {inUnit.format(held)} {action === "buy" ? "credits" : side}
        </span>
      </label>

      <dl className="mt-4 divide-y divide-border border-y border-border">
        <Row label="Amount in" value={amountRaw ? `${inUnit.format(amountRaw)} ${action === "buy" ? "credits" : side}` : "·"} />
        <Row
          label="Expected out"
          value={preview ? `${outUnit.format(preview.out)} ${action === "buy" ? side : "credits"}` : quoting ? "Quoting…" : "·"}
        />
        <Row label="Average price" value={preview ? `${preview.avgPrice.toFixed(4)} credits` : "·"} />
        <Row
          label="Price impact"
          value={preview ? `${(preview.impact * 100).toFixed(2)}%` : "·"}
          tone={preview && preview.impact > 0.02 ? "text-amber" : undefined}
        />
        <Row label="pLong after (estimate)" value={preview ? `${(preview.pLongAfter * 100).toFixed(2)}%` : "·"} />
        <Row
          label="Minimum received (0.5% slippage)"
          value={preview ? `${outUnit.format(preview.minOut)} ${action === "buy" ? side : "credits"}` : "·"}
        />
      </dl>

      {warn ? <p className="mt-3 rounded-xl bg-amber-soft p-3 text-xs text-amber">{warn}</p> : null}
      {quoteError ? (
        <p role="alert" className="mt-3 text-xs text-red">
          {quoteError}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready || !open || tx.busy || !preview || tooMuch || amountRaw === null}
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-green px-5 text-sm font-medium text-on-accent transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
      >
        {action === "buy" ? "Buy" : "Sell"} {side}
      </button>
      {hint ? <p className="mt-3 text-xs text-muted">{hint}</p> : null}
      <TxStatus state={tx.state} />
    </section>
  );
}
