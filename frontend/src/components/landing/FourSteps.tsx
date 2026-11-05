import { Eyebrow } from "../ui";

const STEPS = [
  {
    n: "01",
    title: "Agents propose",
    body: "Each round opens with competing proposals for the treasury. Doing nothing is always on the ballot as the status quo.",
  },
  {
    n: "02",
    title: "Deposit once",
    body: "Put USDC in a single time. That deposit is claimable in every proposal, so capital is never fragmented.",
  },
  {
    n: "03",
    title: "Trade the outcomes",
    body: "Prices move as participants trade each proposal. The final-window TWAP shows what the market expects.",
  },
  {
    n: "04",
    title: "The market decides",
    body: "The round collapses onto the proposal with the best TWAP, if it beats the status quo by 0.005. The vault then executes.",
  },
] as const;

export function FourSteps() {
  return (
    <section className="border-t border-border bg-bg-elevated">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow tone="green">How it works</Eyebrow>
        <h2 className="mt-3 max-w-2xl text-3xl leading-tight sm:text-4xl">
          Four steps from proposal to execution.
        </h2>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="bg-surface p-6">
              <span className="num text-sm text-green">{s.n}</span>
              <h3 className="mt-4 text-xl">{s.title}</h3>
              <p className="mt-3 text-sm text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
