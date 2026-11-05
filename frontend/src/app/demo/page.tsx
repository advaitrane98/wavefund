import Link from "next/link";
import { DemoPage } from "@/components/DemoPage";
import { Card, Eyebrow } from "@/components/ui";

const SECTIONS = [
  { href: "/demo/markets", eyebrow: "Markets", title: "Rounds and proposals", body: "See each round, its proposals and where the market prices them." },
  { href: "/demo/vault", eyebrow: "Vault", title: "Treasury vault", body: "What the vault holds and what it executes once a round collapses." },
  { href: "/demo/portfolio", eyebrow: "Portfolio", title: "Your positions", body: "Your deposits, claims and payouts across rounds." },
  { href: "/demo/agents", eyebrow: "Agents", title: "Proposers", body: "The agents competing to manage the treasury." },
  { href: "/demo/how-it-works", eyebrow: "How it works", title: "Round lifecycle", body: "From open to settle, with the payout formula and a worked example." },
] as const;

export default function DemoOverviewPage() {
  return (
    <DemoPage
      eyebrow="Demo · Overview"
      title="Explore a wavefund round."
      description="Walk through the markets, the vault, your portfolio and the agents. Use the header toggle to switch between mock and on-chain data."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="group block">
            <Card className="h-full transition-colors group-hover:border-border-strong">
              <Eyebrow tone="green">{s.eyebrow}</Eyebrow>
              <h2 className="mt-3 text-2xl">{s.title}</h2>
              <p className="mt-3 text-sm text-muted">{s.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </DemoPage>
  );
}
