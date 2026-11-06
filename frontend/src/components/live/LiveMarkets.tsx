"use client";

import { useState } from "react";
import { computePhase } from "@/lib/live/logic";
import { useChainNow, useLiveData } from "@/lib/live/LiveDataProvider";
import { Card, Eyebrow } from "../ui";
import { LiveAccountPanel } from "./LiveAccountPanel";
import { WalletPrompt } from "./LiveGate";
import { LiveProposalCard } from "./LiveProposalCard";
import { LiveRoundBar } from "./LiveRoundBar";
import { LiveTicket } from "./LiveTicket";

export function LiveMarkets() {
  const { snapshot } = useLiveData();
  const now = useChainNow();
  const [selected, setSelected] = useState(1);

  const round = snapshot?.round ?? null;
  if (!round || round.proposals.length === 0) {
    return (
      <Card>
        <Eyebrow tone="amber">No round yet</Eyebrow>
        <p className="mt-3 text-sm text-muted">
          No round has been opened on the deployed contracts. A keeper opens one, then proposals and
          trading appear here.
        </p>
      </Card>
    );
  }

  const phase = computePhase(round.status, now, round.tradingEnd, round.evaluationEnd);
  const index = Math.min(selected, round.proposals.length - 1);
  const proposal = round.proposals[index];

  return (
    <div className="space-y-6">
      <LiveRoundBar round={round} />
      <WalletPrompt text="Connect your wallet on Arc testnet to deposit and trade." />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid gap-4 sm:grid-cols-2">
          {round.proposals.map((p) => (
            <LiveProposalCard
              key={`${round.id}-${p.id}`}
              proposal={p}
              round={round}
              phase={phase}
              selected={index === p.id}
              onSelect={() => setSelected(p.id)}
            />
          ))}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-28">
          <LiveAccountPanel round={round} selected={proposal} />
          {phase === "trading" ? <LiveTicket round={round} proposal={proposal} /> : null}
        </aside>
      </div>
    </div>
  );
}
