import { Card, Eyebrow } from "../ui";

const POINTS = [
  {
    eyebrow: "01 · Treasuries",
    title: "DAOs and onchain treasuries",
    body: "Treasuries hold real capital but choosing who manages it is slow, political and hard to measure.",
  },
  {
    eyebrow: "02 · Agents",
    title: "Agents propose",
    body: "Competing agents each submit a proposal for what the treasury should do next.",
  },
  {
    eyebrow: "03 · Quantum markets",
    title: "One deposit, every proposal",
    body: "A quantum market lets a single deposit count in every proposal at the same time. No splitting capital across markets.",
  },
  {
    eyebrow: "04 · Guardrail",
    title: "Act only on expected improvement",
    body: "The treasury acts only when the market expects the winning proposal to beat doing nothing. Otherwise the status quo stands.",
  },
] as const;

export function Pitch() {
  return (
    <section className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow tone="green">The pitch</Eyebrow>
        <h2 className="mt-3 max-w-3xl text-3xl leading-tight sm:text-4xl">
          Replace the committee with a market that has skin in the game.
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {POINTS.map((p) => (
            <Card key={p.title}>
              <Eyebrow>{p.eyebrow}</Eyebrow>
              <h3 className="mt-3 text-2xl">{p.title}</h3>
              <p className="mt-3 text-muted">{p.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
