"use client";

import { fmtTok, fmtUsdc } from "@/sim/format";
import { navOf } from "@/sim/seed";
import { useSim } from "@/sim/SimProvider";
import { Card, Eyebrow } from "../ui";
import { ConnectPrompt } from "../WorkspaceGate";
import { AllocationDonut } from "./AllocationDonut";
import { DecisionHistory } from "./DecisionHistory";
import { PriceCompare } from "./PriceCompare";
import { QueuePanel } from "./QueuePanel";

export function VaultView() {
  const { state } = useSim();
  const v = state.vault;
  const nav = navOf(v);
  const sharePrice = nav / v.totalShares;

  return (
    <div className="space-y-6">
      <ConnectPrompt text="Connect the demo account to queue vault deposits and withdrawals." />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <Eyebrow tone="green">Net asset value</Eyebrow>
          <p className="num mt-3 text-4xl">{fmtUsdc(nav)}</p>
          <p className="num text-sm text-muted">USDC</p>
          <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-4">
            <div>
              <dt className="eyebrow">Share price</dt>
              <dd className="num mt-1 text-sm">{sharePrice.toFixed(4)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Total shares</dt>
              <dd className="num mt-1 truncate text-sm">{fmtUsdc(v.totalShares, 0)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Your shares</dt>
              <dd className="num mt-1 truncate text-sm text-violet">{fmtTok(v.userShares)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <Eyebrow>Allocation</Eyebrow>
          <div className="mt-4">
            <AllocationDonut tethValue={v.teth * v.oracle} usdcValue={v.usdc} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <Eyebrow>Oracle vs pool price</Eyebrow>
          <div className="mt-4">
            <PriceCompare oracle={v.oracle} pool={v.poolPrice} />
          </div>
          <p className="num mt-4 border-t border-border pt-4 text-xs text-muted">
            Holding {fmtTok(v.teth)} tETH and {fmtUsdc(v.usdc)} USDC.
          </p>
        </Card>

        <Card>
          <Eyebrow tone="violet">Queued deposits and withdrawals</Eyebrow>
          <div className="mt-4">
            <QueuePanel />
          </div>
        </Card>
      </div>

      <Card>
        <Eyebrow tone="amber">Decision history</Eyebrow>
        <div className="mt-2">
          <DecisionHistory decisions={v.decisions} />
        </div>
      </Card>
    </div>
  );
}
