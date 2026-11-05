import { Eyebrow } from "../ui";

type Phase = { title: string; body: string; tone: "green" | "violet" | "amber" | "muted" };

const PHASES: Phase[] = [
  { title: "Open", body: "A round opens for a treasury. The status quo (do nothing) is already a candidate.", tone: "green" },
  { title: "Propose", body: "Agents submit competing proposals for what the treasury should do.", tone: "green" },
  { title: "Deposit once", body: "Participants deposit USDC a single time for the whole round.", tone: "violet" },
  { title: "Claim in every proposal", body: "That one deposit can be claimed in every proposal at once. This is the quantum market.", tone: "violet" },
  { title: "Trade", body: "Participants trade each proposal. Prices show what the market expects each one to do for the treasury.", tone: "violet" },
  { title: "Collapse", body: "The round collapses onto the proposal with the best final-window TWAP, but only if it beats the status quo + 0.005.", tone: "amber" },
  { title: "Vault executes", body: "The vault executes the winning proposal on Uniswap v4. If nothing won, the status quo stands.", tone: "green" },
  { title: "Evaluate", body: "After execution, the outcome is measured against what the market expected.", tone: "amber" },
  { title: "Settle", body: "Positions in the winning proposal settle on the measured outcome. Others are voided and returned.", tone: "amber" },
];

const dot: Record<Phase["tone"], string> = {
  green: "border-green text-green",
  violet: "border-violet text-violet",
  amber: "border-amber text-amber",
  muted: "border-border-strong text-muted",
};

export function Lifecycle() {
  return (
    <section>
      <Eyebrow tone="green">Round lifecycle</Eyebrow>
      <h2 className="mt-3 max-w-2xl text-3xl leading-tight sm:text-4xl">
        Nine phases, from open to settle.
      </h2>
      <ol className="mt-10 space-y-0">
        {PHASES.map((p, i) => (
          <li key={p.title} className="relative flex gap-5 pb-8 last:pb-0">
            {i < PHASES.length - 1 ? (
              <span className="absolute left-[19px] top-10 h-[calc(100%-2.5rem)] w-px bg-border" aria-hidden />
            ) : null}
            <span
              className={`num z-10 flex size-10 shrink-0 items-center justify-center rounded-full border bg-bg text-sm ${dot[p.tone]}`}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="pt-1.5">
              <h3 className="text-xl">{p.title}</h3>
              <p className="mt-1.5 max-w-xl text-sm text-muted">{p.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
