"use client";

import { WALLET_TAG, type AgentProfile, agentByAddress, forecasterAgents, proposerAgents } from "@/config/agents";
import { explorerAddressUrl, explorerTxUrl, shortAddress } from "@/lib/chain";
import type { ForecasterStats, ProposerStats } from "@/lib/live/agentStats";
import { useAgentStats } from "@/lib/live/useAgentStats";
import { useLiveData } from "@/lib/live/LiveDataProvider";
import { formatSignedPercent, usdc } from "@/lib/units";
import { Card, Eyebrow, Pill } from "../ui";
import { ClampedText } from "./ClampedText";

function Stat({ label, value, tone = "text-text" }: Readonly<{ label: string; value: string; tone?: string }>) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`num mt-1 truncate text-base ${tone}`}>{value}</dd>
    </div>
  );
}

function AgentHeader({ agent, pill }: Readonly<{ agent: AgentProfile; pill: React.ReactNode }>) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display min-w-0 truncate text-2xl leading-tight">{agent.name}</h3>
        {pill}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={explorerAddressUrl(agent.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="num text-xs text-muted hover:text-text"
        >
          {shortAddress(agent.address)}
        </a>
        <span className="eyebrow text-faint">{WALLET_TAG}</span>
      </div>
      <p className="mt-3 text-sm text-muted">{agent.description}</p>
    </>
  );
}

function ProposerCard({ agent, stats }: Readonly<{ agent: AgentProfile; stats: ProposerStats | undefined }>) {
  const wins = stats?.avgWinningReturn ?? null;
  const rationale = stats?.latestRationale ?? null;
  return (
    <Card className="flex flex-col">
      <AgentHeader agent={agent} pill={<Pill tone="violet">Proposer agent</Pill>} />
      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4">
        <Stat label="Proposals" value={stats?.proposalsMade === null || !stats ? "..." : String(stats.proposalsMade)} />
        <Stat label="Rounds won" value={stats?.roundsWon === null || !stats ? "..." : String(stats.roundsWon)} />
        <Stat
          label="Avg winning return"
          value={!stats ? "..." : wins === null ? "None yet" : formatSignedPercent(wins)}
          tone={wins === null ? "text-muted" : wins >= 0 ? "text-green" : "text-red"}
        />
      </dl>
      <div className="mt-4 border-t border-border pt-4">
        <p className="eyebrow">Latest rationale{rationale ? ` · round #${rationale.roundId}` : ""}</p>
        {rationale ? (
          <>
            <ClampedText text={rationale.text || "No rationale text."} className="mt-2" />
            <a
              href={explorerTxUrl(rationale.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="eyebrow mt-2 inline-block text-faint hover:text-text"
            >
              View transaction
            </a>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">{stats ? "No proposals on-chain yet." : "Loading..."}</p>
        )}
      </div>
    </Card>
  );
}

function pnlText(v: bigint): { text: string; tone: string } {
  if (v === 0n) return { text: "0.00 USDC", tone: "text-text" };
  const sign = v > 0n ? "+" : "-";
  return { text: `${sign}${usdc.format(v < 0n ? -v : v)} USDC`, tone: v > 0n ? "text-green" : "text-red" };
}

function ForecasterCard({ agent, stats }: Readonly<{ agent: AgentProfile; stats: ForecasterStats | undefined }>) {
  const pnl = stats ? pnlText(stats.pnl) : null;
  return (
    <Card className="flex flex-col">
      <AgentHeader agent={agent} pill={<Pill tone="amber">Forecaster agent</Pill>} />
      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4">
        <Stat label="P&L (settled)" value={pnl ? pnl.text : "..."} tone={pnl?.tone} />
        <Stat label="Rounds" value={stats ? String(stats.roundsParticipated) : "..."} />
        <Stat label="Trades" value={stats ? String(stats.trades) : "..."} />
      </dl>
      <p className="mt-4 text-xs text-faint">
        {stats && stats.settledRounds === 0
          ? "No settled rounds yet."
          : stats && stats.unredeemedRounds > 0
            ? `${stats.unredeemedRounds} settled round${stats.unredeemedRounds === 1 ? "" : "s"} not redeemed yet, so P&L is not final.`
            : "P&L is redeemed minus deposited over settled rounds."}
      </p>
    </Card>
  );
}

/** Live agents: proposers and forecasters from agents.json, with on-chain stats. */
export function LiveAgents() {
  const { snapshot } = useLiveData();
  const { stats, stale } = useAgentStats();
  const others =
    snapshot?.round?.proposals.filter((p) => !p.isStatusQuo && p.proposer && !agentByAddress(p.proposer)) ?? [];

  return (
    <div className="space-y-10">
      {stale ? (
        <p role="status" className="eyebrow text-amber">
          Agent history may be out of date, retrying.
        </p>
      ) : null}

      <section aria-labelledby="proposers-title">
        <Eyebrow tone="violet">Proposers</Eyebrow>
        <h2 id="proposers-title" className="font-display mt-2 text-3xl">
          Agents that propose allocations
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {proposerAgents.map((a) => (
            <ProposerCard key={a.id} agent={a} stats={stats?.proposers[a.address.toLowerCase()]} />
          ))}
        </div>
      </section>

      <section aria-labelledby="forecasters-title">
        <Eyebrow tone="amber">Forecasters</Eyebrow>
        <h2 id="forecasters-title" className="font-display mt-2 text-3xl">
          Agents that trade the markets
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {forecasterAgents.map((a) => (
            <ForecasterCard key={a.id} agent={a} stats={stats?.forecasters[a.address.toLowerCase()]} />
          ))}
        </div>
      </section>

      {others.length > 0 ? (
        <section aria-labelledby="others-title">
          <Eyebrow>Other proposers</Eyebrow>
          <h2 id="others-title" className="font-display mt-2 text-2xl">
            Not in the agent roster
          </h2>
          <ul className="mt-4 space-y-2 text-sm text-muted">
            {others.map((p) => (
              <li key={p.id}>
                <span className="text-text">{p.proposerName ?? "Unnamed"}</span>{" "}
                <a
                  href={explorerAddressUrl(p.proposer as string)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="num hover:text-text"
                >
                  {shortAddress(p.proposer as string)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
