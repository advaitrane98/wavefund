"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { USDC_ADDRESS } from "@/lib/chain";
import { quantumRoundAbi } from "@/abis";
import { deployment } from "@/config/contracts";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import type { ProposalView, RoundView } from "@/lib/live/types";
import { credits, usdc } from "@/lib/units";
import { Eyebrow } from "../ui";
import { TxStatus, useTxRunner, type TxStep } from "./useTxRunner";
import { useWallet } from "../WalletProvider";

function AmountInput({
  label,
  value,
  onChange,
  onMax,
}: Readonly<{ label: string; value: string; onChange: (v: string) => void; onMax: () => void }>) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.00"
        aria-label={label}
        className="num min-h-12 w-full bg-transparent text-lg outline-none"
      />
      <button type="button" onClick={onMax} className="eyebrow min-h-11 shrink-0 px-2 text-green">
        Max
      </button>
    </div>
  );
}

export function LiveAccountPanel({
  round,
  selected,
}: Readonly<{ round: RoundView; selected: ProposalView }>) {
  const { address, onArc } = useWallet();
  const { snapshot } = useLiveData();
  const tx = useTxRunner();
  const [depositText, setDepositText] = useState("");
  const [claimText, setClaimText] = useState("");

  const qr = deployment.addresses.quantumRound;
  const open = round.phase === "trading";
  const ready = Boolean(address && onArc && qr);
  const balance = snapshot?.user?.usdc ?? 0n;
  const allowance = snapshot?.user?.usdcAllowanceRound ?? 0n;
  const deposit = round.user.deposit;
  const room = deposit > selected.user.claimed ? deposit - selected.user.claimed : 0n;

  const depositRaw = usdc.parse(depositText);
  const claimRaw = credits.parse(claimText);

  async function onDeposit() {
    if (!qr || depositRaw === null || depositRaw === 0n) return;
    const steps: TxStep[] = [];
    if (allowance < depositRaw) {
      steps.push({
        label: "Approving USDC",
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [qr, depositRaw],
      });
    }
    steps.push({
      label: "Depositing",
      address: qr,
      abi: quantumRoundAbi as never,
      functionName: "deposit",
      args: [BigInt(round.id), depositRaw],
    });
    if (await tx.run("Deposited.", steps)) setDepositText("");
  }

  async function onClaim(all: boolean) {
    if (!qr) return;
    const steps: TxStep[] = [];
    if (all) {
      for (const p of round.proposals) {
        const left = deposit > p.user.claimed ? deposit - p.user.claimed : 0n;
        if (left > 0n) {
          steps.push({
            label: `Claiming in proposal ${p.id}`,
            address: qr,
            abi: quantumRoundAbi as never,
            functionName: "claimCredits",
            args: [BigInt(round.id), BigInt(p.id), left],
          });
        }
      }
    } else if (claimRaw !== null && claimRaw > 0n) {
      steps.push({
        label: "Claiming credits",
        address: qr,
        abi: quantumRoundAbi as never,
        functionName: "claimCredits",
        args: [BigInt(round.id), BigInt(selected.id), claimRaw],
      });
    }
    if (steps.length === 0) return;
    if (await tx.run("Credits claimed.", steps)) setClaimText("");
  }

  const depositProblem =
    depositRaw !== null && depositRaw > balance ? "That is more USDC than your wallet holds." : null;
  const claimProblem =
    claimRaw !== null && claimRaw > room ? `You can claim up to ${credits.format(room)} credits here.` : null;
  const needsApproval = depositRaw !== null && depositRaw > 0n && allowance < depositRaw;

  return (
    <section className="card p-5" aria-label="Deposit and claim">
      <Eyebrow tone="violet">Your deposit</Eyebrow>
      <p className="num mt-3 text-2xl text-violet">{credits.format(deposit)} credits</p>
      <p className="num mt-1 text-xs text-muted">Wallet: {usdc.format(balance)} USDC</p>

      <div className="mt-4">
        <span className="eyebrow">USDC to deposit</span>
        <div className="mt-1.5">
          <AmountInput
            label="USDC to deposit"
            value={depositText}
            onChange={setDepositText}
            onMax={() => setDepositText(usdc.format(balance, 6).replace(/,/g, ""))}
          />
        </div>
        <button
          type="button"
          disabled={!ready || !open || tx.busy || depositRaw === null || depositRaw === 0n || !!depositProblem}
          onClick={() => void onDeposit()}
          className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-green px-5 text-sm font-medium text-on-accent enabled:hover:opacity-90 disabled:opacity-40"
        >
          {needsApproval ? "Approve USDC and deposit" : "Deposit"}
        </button>
        {depositProblem ? <p className="mt-2 text-xs text-red">{depositProblem}</p> : null}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <p className="text-sm">
          Claim in <span className="text-text">{selected.proposerName ?? (selected.isStatusQuo ? "the status quo" : "this proposal")}</span>
        </p>
        <p className="num mt-1 text-xs text-muted">
          Up to {credits.format(room)} credits per proposal (claimed {credits.format(selected.user.claimed)} here).
        </p>
        <div className="mt-3">
          <AmountInput
            label="Credits to claim"
            value={claimText}
            onChange={setClaimText}
            onMax={() => setClaimText(credits.format(room, 6).replace(/,/g, ""))}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!ready || !open || tx.busy || claimRaw === null || claimRaw === 0n || !!claimProblem}
            onClick={() => void onClaim(false)}
            className="min-h-11 rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
          >
            Claim
          </button>
          <button
            type="button"
            disabled={!ready || !open || tx.busy || deposit === 0n}
            onClick={() => void onClaim(true)}
            className="min-h-11 rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
          >
            Claim max in all
          </button>
        </div>
        {claimProblem ? <p className="mt-2 text-xs text-red">{claimProblem}</p> : null}
        {deposit === 0n ? (
          <p className="mt-2 text-xs text-muted">Deposit first, then claim credits in each proposal.</p>
        ) : null}
      </div>
      <TxStatus state={tx.state} />
    </section>
  );
}
