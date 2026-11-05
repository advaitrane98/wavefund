"use client";

import { useEffect, useRef, useState } from "react";
import { useSim } from "@/sim/SimProvider";
import { ConnectPrompt } from "../WorkspaceGate";
import { AccountPanel } from "./AccountPanel";
import { ProposalCard } from "./ProposalCard";
import { RoundBar } from "./RoundBar";
import { TradeTicket } from "./TradeTicket";

const COLLAPSE_MS = 1100;

export function MarketsView() {
  const { state, collapse } = useSim();
  const round = state.round;
  const [selected, setSelected] = useState(1);
  const [collapsing, setCollapsing] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Keep the selection valid when a new round starts.
  const index = Math.min(selected, round.proposals.length - 1);
  const proposal = round.proposals[index];
  const open = round.status === "open";

  function onCollapse() {
    setCollapsing(true);
    timer.current = window.setTimeout(() => {
      collapse();
      setCollapsing(false);
    }, COLLAPSE_MS);
  }

  return (
    <div className="space-y-6">
      <RoundBar round={round} collapsing={collapsing} onCollapse={onCollapse} />
      <ConnectPrompt text="Connect the demo account to get 10,000 demo USDC, then deposit once and trade." />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid gap-4 sm:grid-cols-2">
          {round.proposals.map((p) => (
            <ProposalCard
              key={`${round.id}-${p.index}`}
              proposal={p}
              position={round.positions[p.index]}
              round={round}
              selected={index === p.index}
              collapsing={collapsing}
              onSelect={() => setSelected(p.index)}
            />
          ))}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-28">
          {state.connected ? <AccountPanel round={round} selected={proposal} /> : null}
          {open ? <TradeTicket proposal={proposal} position={round.positions[index]} round={round} /> : null}
        </aside>
      </div>
    </div>
  );
}
