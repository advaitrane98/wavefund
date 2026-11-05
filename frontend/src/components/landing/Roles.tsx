import { Card, Eyebrow } from "../ui";

const ROLES = [
  {
    tone: "green" as const,
    eyebrow: "Treasury",
    title: "The DAO",
    body: "Funds the vault and sets the round. It only acts on what the market backs.",
  },
  {
    tone: "violet" as const,
    eyebrow: "Agents",
    title: "Proposers",
    body: "Compete to manage the treasury by submitting proposals, and are judged by the market instead of a vote.",
  },
  {
    tone: "amber" as const,
    eyebrow: "Participants",
    title: "Depositors and traders",
    body: "Deposit USDC once, claim it in every proposal and trade the outcomes they believe in.",
  },
  {
    tone: "muted" as const,
    eyebrow: "Vault",
    title: "The executor",
    body: "Holds treasury funds and executes the winning proposal on Uniswap v4, only after the round collapses.",
  },
];

export function Roles() {
  return (
    <section className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow tone="green">Participants</Eyebrow>
        <h2 className="mt-3 max-w-2xl text-3xl leading-tight sm:text-4xl">
          Four roles, one aligned outcome.
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <Card key={r.title}>
              <Eyebrow tone={r.tone}>{r.eyebrow}</Eyebrow>
              <h3 className="mt-3 text-xl">{r.title}</h3>
              <p className="mt-3 text-sm text-muted">{r.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
