"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { vaultAbi } from "@/generated/abis";
import { USDC_ADDRESS } from "@/lib/chain";
import { deployment } from "@/lib/contracts";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { usdc, wave } from "@/lib/units";
import { Eyebrow } from "../ui";
import { TxStatus, useTxRunner, type TxStep } from "./useTxRunner";
import { useWallet } from "../WalletProvider";

const MIN_DEPOSIT = 1_000_000n; // MIN_DEPOSIT_REQUEST: 1 USDC

function Field({
  label,
  value,
  onChange,
  onMax,
  unit,
}: Readonly<{ label: string; value: string; onChange: (v: string) => void; onMax: () => void; unit: string }>) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3">
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
        <span className="eyebrow shrink-0">{unit}</span>
      </div>
    </div>
  );
}

export function LiveQueue() {
  const { address, onArc } = useWallet();
  const { snapshot } = useLiveData();
  const tx = useTxRunner();
  const [depositText, setDepositText] = useState("");
  const [withdrawText, setWithdrawText] = useState("");

  const vaultAddr = deployment.addresses.vault;
  const v = snapshot?.vault;
  const u = snapshot?.user;
  if (!v || !vaultAddr) return null;

  const ready = Boolean(address && onArc);
  const usdcBalance = u?.usdc ?? 0n;
  const allowance = u?.usdcAllowanceVault ?? 0n;

  const depositRaw = usdc.parse(depositText);
  const withdrawRaw = wave.parse(withdrawText);
  const freeShares = v.user.wave;

  // Value of the shares at the current share price, against what the vault holds in USDC.
  const withdrawValue = withdrawRaw !== null ? (withdrawRaw * v.sharePriceUsdc) / 10n ** 18n : 0n;
  const exceedsFree = withdrawValue > v.totalVaultUsdc;

  const depositProblem =
    depositRaw !== null && depositRaw < MIN_DEPOSIT
      ? "The minimum deposit is 1 USDC."
      : depositRaw !== null && depositRaw > usdcBalance
        ? "That is more USDC than your wallet holds."
        : null;
  const withdrawProblem =
    withdrawRaw !== null && withdrawRaw > freeShares ? "That is more WAVE than you hold." : null;

  async function queueDeposit() {
    if (depositRaw === null || depositProblem || !vaultAddr) return;
    const steps: TxStep[] = [];
    if (allowance < depositRaw) {
      steps.push({
        label: "Approving USDC",
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddr, depositRaw],
      });
    }
    steps.push({
      label: "Queueing deposit",
      address: vaultAddr,
      abi: vaultAbi as never,
      functionName: "requestDeposit",
      args: [depositRaw],
    });
    if (await tx.run("Deposit queued for the next decision.", steps)) setDepositText("");
  }

  const simple = (label: string, done: string, functionName: string, args?: readonly unknown[]) =>
    vaultAddr && void tx.run(done, [{ label, address: vaultAddr, abi: vaultAbi as never, functionName, args }]);

  const hasClaim = v.user.claimableShares > 0n || v.user.claimableUsdcFromEpochs > 0n;

  return (
    <div>
      <p className="max-w-xl text-sm text-muted">
        Deposits and withdrawals are queued and priced together at the next decision. Collect your shares or
        USDC afterwards.
      </p>

      <dl className="num mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="eyebrow">Your queued deposit</dt>
          <dd className="mt-1 text-violet">{usdc.format(v.user.depositRequest)} USDC</dd>
        </div>
        <div>
          <dt className="eyebrow">Your queued withdrawal</dt>
          <dd className="mt-1">{wave.format(v.user.withdrawRequest)} WAVE</dd>
        </div>
      </dl>

      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <div>
          <Field
            label="Queue a deposit"
            unit="USDC"
            value={depositText}
            onChange={setDepositText}
            onMax={() => setDepositText(usdc.format(usdcBalance, 6).replace(/,/g, ""))}
          />
          <button
            type="button"
            disabled={!ready || tx.busy || depositRaw === null || !!depositProblem}
            onClick={() => void queueDeposit()}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
          >
            {depositRaw !== null && allowance < depositRaw ? "Approve and queue deposit" : "Queue deposit"}
          </button>
          {depositProblem ? <p className="mt-2 text-xs text-red">{depositProblem}</p> : null}
          {v.user.depositRequest > 0n ? (
            <button
              type="button"
              disabled={!ready || tx.busy}
              onClick={() => simple("Cancelling deposit", "Deposit cancelled and refunded.", "cancelDepositRequest")}
              className="eyebrow mt-2 min-h-11 hover:text-text"
            >
              Cancel queued deposit
            </button>
          ) : null}
        </div>

        <div>
          <Field
            label="Queue a withdrawal"
            unit="WAVE"
            value={withdrawText}
            onChange={setWithdrawText}
            onMax={() => setWithdrawText(wave.format(freeShares, 18).replace(/,/g, ""))}
          />
          <button
            type="button"
            disabled={!ready || tx.busy || withdrawRaw === null || withdrawRaw === 0n || !!withdrawProblem || exceedsFree}
            onClick={async () => {
              if (withdrawRaw === null) return;
              if (await tx.run("Withdrawal queued for the next decision.", [{ label: "Queueing withdrawal", address: vaultAddr, abi: vaultAbi as never, functionName: "requestWithdraw", args: [withdrawRaw] }])) {
                setWithdrawText("");
              }
            }}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border-strong text-sm enabled:hover:bg-surface-2 disabled:opacity-40"
          >
            Queue withdrawal
          </button>
          {exceedsFree ? (
            <p className="mt-2 text-xs text-amber" role="status">
              This is worth {usdc.format(withdrawValue)} USDC, more than the vault&apos;s free USDC (
              {usdc.format(v.totalVaultUsdc)}). Withdrawals are disabled until you ask for less.
            </p>
          ) : null}
          {withdrawProblem ? <p className="mt-2 text-xs text-red">{withdrawProblem}</p> : null}
          {v.user.withdrawRequest > 0n ? (
            <button
              type="button"
              disabled={!ready || tx.busy}
              onClick={() => simple("Cancelling withdrawal", "Withdrawal cancelled, shares returned.", "cancelWithdrawRequest")}
              className="eyebrow mt-2 min-h-11 hover:text-text"
            >
              Cancel queued withdrawal
            </button>
          ) : null}
        </div>
      </div>

      {hasClaim || v.user.claimableUsdc > 0n ? (
        <div className="mt-6 border-t border-border pt-4">
          <Eyebrow tone="green">Ready to collect</Eyebrow>
          <p className="num mt-2 text-sm text-muted">
            {v.user.claimableShares > 0n ? `${wave.format(v.user.claimableShares)} WAVE` : null}
            {v.user.claimableShares > 0n && v.user.claimableUsdcFromEpochs > 0n ? " · " : null}
            {v.user.claimableUsdcFromEpochs > 0n ? `${usdc.format(v.user.claimableUsdcFromEpochs)} USDC` : null}
            {v.user.claimableUsdc > 0n ? ` · ${usdc.format(v.user.claimableUsdc)} USDC held back` : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {hasClaim && address ? (
              <button
                type="button"
                disabled={!ready || tx.busy}
                onClick={() => simple("Collecting", "Collected.", "claimFor", [address])}
                className="inline-flex min-h-11 items-center rounded-full bg-green px-5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
              >
                Collect
              </button>
            ) : null}
            {v.user.claimableUsdc > 0n ? (
              <button
                type="button"
                disabled={!ready || tx.busy}
                onClick={() => simple("Claiming USDC", "USDC claimed.", "claimUsdc")}
                className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-5 text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                Claim held-back USDC
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <TxStatus state={tx.state} />
    </div>
  );
}
