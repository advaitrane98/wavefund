"use client";

import { quantumRoundAbi } from "@/generated/abis";
import { deployment } from "@/lib/contracts";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import type { ProposalView, RoundView } from "@/lib/live/types";
import { credits, long, short, usdc, wave } from "@/lib/units";
import { Card, Eyebrow, Pill } from "../ui";
import { WalletPrompt } from "./LiveGate";
import { TxStatus, useTxRunner } from "./useTxRunner";
import { useWallet } from "../WalletProvider";

const GRID =
  "grid grid-cols-2 gap-x-4 gap-y-3 py-4 md:grid-cols-[minmax(0,1.7fr)_repeat(3,minmax(0,1fr))_6rem] md:items-center";

function Cell({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="min-w-0">
      <p className="eyebrow md:hidden">{label}</p>
      <p className="num mt-1 truncate text-sm md:mt-0 md:text-right">{children}</p>
    </div>
  );
}

function PositionRows({ round }: Readonly<{ round: RoundView }>) {
  const decided = round.status >= 2;
  return (
    <div role="table" aria-label={`Positions in round ${round.id}`}>
      <div
        role="row"
        className="hidden gap-x-4 border-b border-border pb-2 md:grid md:grid-cols-[minmax(0,1.7fr)_repeat(3,minmax(0,1fr))_6rem]"
      >
        <span role="columnheader" className="eyebrow">Market</span>
        {["Credits", "LONG", "SHORT"].map((h) => (
          <span key={h} role="columnheader" className="eyebrow text-right">{h}</span>
        ))}
        <span role="columnheader" className="eyebrow text-right">Status</span>
      </div>
      <div className="divide-y divide-border">
        {round.proposals.map((p: ProposalView) => {
          const isWinner = decided && round.winnerId === p.id;
          const erased = decided && !isWinner && round.status !== 4;
          return (
            <div key={p.id} role="row" className={`${GRID} ${erased ? "opacity-50" : ""}`}>
              <div className="col-span-2 min-w-0 md:col-span-1">
                <p className="truncate text-sm">
                  {p.isStatusQuo ? "Keep current allocation (Protocol)" : (p.proposerName ?? `Proposal ${p.id}`)}
                </p>
                <p className="eyebrow mt-0.5">{p.isStatusQuo ? "Status quo" : "Agent"}</p>
              </div>
              <Cell label="Credits">{credits.format(p.user.credits)}</Cell>
              <Cell label="LONG">{long.format(p.user.long)}</Cell>
              <Cell label="SHORT">{short.format(p.user.short)}</Cell>
              <div className="md:text-right">
                {isWinner ? <Pill tone="green">Winner</Pill> : erased ? <Pill tone="muted">Erased</Pill> : <Pill tone="muted">{decided ? "Cancelled" : "Open"}</Pill>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STATUS = ["None", "Trading", "Collapsed", "Settled", "Cancelled"] as const;

export function LivePortfolio() {
  const { snapshot, history, userRounds } = useLiveData();
  const { address, onArc } = useWallet();
  const tx = useTxRunner();
  const qr = deployment.addresses.quantumRound;
  if (!snapshot) return null;

  const u = snapshot.user;
  const v = snapshot.vault;
  const round = snapshot.round;
  const ready = Boolean(address && onArc && qr);
  const vaultValue = (v.user.wave * v.sharePriceUsdc) / 10n ** 18n;
  const statusOf = (id: number) => history.find((h) => h.roundId === id)?.status ?? 0;
  const mine = userRounds.filter((r) => r.deposit > 0n || r.previewRedeem > 0n);

  return (
    <div className="space-y-6">
      <WalletPrompt text="Connect your wallet on Arc testnet to see your balances and positions." />

      <Card>
        <Eyebrow tone="violet">Balances</Eyebrow>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="eyebrow">Wallet</dt>
            <dd className="num mt-1 truncate text-xl text-violet">{u ? usdc.format(u.usdc) : "·"}</dd>
            <p className="num text-xs text-faint">USDC</p>
          </div>
          <div className="min-w-0">
            <dt className="eyebrow">Deposited this round</dt>
            <dd className="num mt-1 truncate text-xl">{round ? credits.format(round.user.deposit) : "·"}</dd>
            <p className="num text-xs text-faint">credits</p>
          </div>
          <div className="min-w-0">
            <dt className="eyebrow">Vault shares</dt>
            <dd className="num mt-1 truncate text-xl">{wave.format(v.user.wave)}</dd>
            <p className="num text-xs text-faint">WAVE, worth {usdc.format(vaultValue)} USDC</p>
          </div>
          <div className="min-w-0">
            <dt className="eyebrow">Queued vault deposit</dt>
            <dd className="num mt-1 truncate text-xl">{usdc.format(v.user.depositRequest)}</dd>
            <p className="num text-xs text-faint">USDC</p>
          </div>
        </dl>
      </Card>

      {round ? (
        <Card>
          <Eyebrow tone="green">
            Round #{String(round.id).padStart(3, "0")} · {STATUS[round.status] ?? "Unknown"}
          </Eyebrow>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <div>
              <dt className="eyebrow">Deposit</dt>
              <dd className="num mt-1 text-lg text-violet">{credits.format(round.user.deposit)} credits</dd>
            </div>
            <div>
              <dt className="eyebrow">{round.user.redeemed ? "Redeemed" : "Redeemable"}</dt>
              <dd className="num mt-1 text-lg">
                {round.status >= 3 ? `${usdc.format(round.user.previewRedeem)} USDC` : "After settlement"}
              </dd>
            </div>
          </dl>
          <div className="mt-6">
            <PositionRows round={round} />
          </div>
        </Card>
      ) : null}

      <section>
        <Eyebrow>Your rounds</Eyebrow>
        {mine.length === 0 ? (
          <p className="mt-3 text-sm text-faint">You have not deposited in any recent round.</p>
        ) : (
          <ul className="card mt-3 divide-y divide-border">
            {mine.map((r) => {
              const status = statusOf(r.roundId);
              const redeemable = (status === 3 || status === 4) && r.previewRedeem > 0n;
              return (
                <li key={r.roundId} className="flex flex-wrap items-center justify-between gap-3 p-5">
                  <div>
                    <p className="num text-sm">Round #{String(r.roundId).padStart(3, "0")}</p>
                    <p className="eyebrow mt-1">{STATUS[status] ?? "Unknown"}</p>
                  </div>
                  <p className="num text-sm text-muted">
                    Deposit <span className="text-text">{credits.format(r.deposit)}</span> · {r.redeemed ? "Redeemed" : "Redeemable"}{" "}
                    <span className="text-text">{status >= 3 ? `${usdc.format(r.previewRedeem)} USDC` : "after settlement"}</span>
                  </p>
                  {redeemable && qr ? (
                    <button
                      type="button"
                      disabled={!ready || tx.busy}
                      onClick={() =>
                        void tx.run("Redeemed.", [
                          {
                            label: "Redeeming",
                            address: qr,
                            abi: quantumRoundAbi as never,
                            functionName: "redeem",
                            args: [BigInt(r.roundId)],
                          },
                        ])
                      }
                      className="inline-flex min-h-11 items-center rounded-full bg-green px-5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
                    >
                      Redeem
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <TxStatus state={tx.state} />
      </section>
    </div>
  );
}
