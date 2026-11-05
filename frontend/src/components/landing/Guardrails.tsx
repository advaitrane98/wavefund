import { Eyebrow } from "../ui";

const RAILS = [
  {
    title: "Status quo is always a candidate",
    body: "Doing nothing competes with every proposal. A proposal has to beat it, not just exist.",
  },
  {
    title: "A margin of 0.005",
    body: "The winner must beat the status quo by more than 0.005 on the final-window TWAP. Close calls leave the treasury untouched.",
  },
  {
    title: "TWAP, not spot price",
    body: "Only the time-weighted price over the final window counts, so a last-second trade cannot swing the result.",
  },
  {
    title: "Execution is separate and checked",
    body: "Only the vault moves treasury funds, on Uniswap v4, and every round is evaluated and settled afterwards.",
  },
];

export function Guardrails() {
  return (
    <section className="border-t border-border bg-bg-elevated">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <Eyebrow tone="amber">Guardrails</Eyebrow>
          <h2 className="mt-3 text-3xl leading-tight sm:text-4xl">
            The default answer is no.
          </h2>
          <p className="mt-4 text-muted">
            The treasury moves only when the market clearly expects improvement.
          </p>
        </div>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {RAILS.map((r) => (
            <li key={r.title} className="p-6">
              <h3 className="text-xl">{r.title}</h3>
              <p className="mt-2 text-sm text-muted">{r.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
