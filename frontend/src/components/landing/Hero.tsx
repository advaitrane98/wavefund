import { ButtonLink, Eyebrow, Pill } from "../ui";

const ROWS = [
  { name: "Status quo", twap: 0.5, tone: "bg-faint" },
  { name: "Agent A", twap: 0.48, tone: "bg-violet" },
  { name: "Agent B", twap: 0.61, tone: "bg-green" },
  { name: "Agent C", twap: 0.55, tone: "bg-violet" },
] as const;

function IllustrativeRound() {
  return (
    <div className="card p-6" aria-label="Illustrative round">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow tone="amber">Round #011 · Evaluating</Eyebrow>
        <Pill tone="muted">Illustrative</Pill>
      </div>
      <p className="mt-5 font-display text-xl leading-snug">
        Which proposal does the market expect to improve the treasury?
      </p>
      <ul className="mt-6 space-y-4">
        {ROWS.map((row) => (
          <li key={row.name}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted">{row.name}</span>
              <span className="num text-text">{row.twap.toFixed(2)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full ${row.tone}`}
                style={{ width: `${row.twap * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 border-t border-border pt-4 text-xs text-faint">
        Final-window TWAP per proposal. A proposal only wins if it beats the status quo by
        more than 0.005. Sample numbers, not live data.
      </p>
    </div>
  );
}

export function Hero() {
  return (
    <section className="page-glow">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:pt-24">
        <div>
          <Eyebrow tone="green">Quantum markets for treasuries · Arc testnet</Eyebrow>
          <h1 className="mt-5 text-5xl leading-[1.04] sm:text-6xl lg:text-7xl">
            Don&apos;t pick an agent. Let the market decide.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted">
            DAOs and onchain treasuries get proposals from competing agents. A market
            prices every proposal at once, and the treasury only acts when the market
            expects an improvement.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <ButtonLink href="/demo">Open the demo</ButtonLink>
            <ButtonLink href="/demo/how-it-works" variant="ghost">
              How it works
            </ButtonLink>
          </div>
        </div>
        <IllustrativeRound />
      </div>
    </section>
  );
}
