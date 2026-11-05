import { Card, Eyebrow, Pill } from "../ui";

const EXAMPLE = [
  { label: "Deposit", value: "1,000.00", note: "USDC, deposited once" },
  { label: "Spent on Agent B shares", value: "240.00", note: "400 shares at 0.60" },
  { label: "Agent B wins the collapse", value: "·", note: "best final-window TWAP, beats status quo + 0.005" },
  { label: "Settlement price", value: "0.80", note: "measured at evaluation" },
  { label: "Share value", value: "320.00", note: "400 shares × 0.80" },
] as const;

export function Payout() {
  return (
    <section>
      <Eyebrow tone="amber">Payout</Eyebrow>
      <h2 className="mt-3 max-w-2xl text-3xl leading-tight sm:text-4xl">
        You only settle in the proposal that won.
      </h2>
      <p className="mt-4 max-w-2xl text-muted">
        Positions in proposals that did not win are voided and the USDC spent on them is
        returned. Your result comes from the winning proposal alone.
      </p>

      <Card className="mt-8">
        <Eyebrow>Formula</Eyebrow>
        <p className="num mt-4 overflow-x-auto text-base leading-relaxed text-text sm:text-lg">
          payout = deposit − spent<sub>w</sub> + shares<sub>w</sub> × settlementPrice
        </p>
        <dl className="mt-5 grid gap-x-8 gap-y-2 text-sm text-muted sm:grid-cols-2">
          <div><dt className="num inline text-text">w</dt> <dd className="inline">the winning proposal</dd></div>
          <div><dt className="num inline text-text">spent<sub>w</sub></dt> <dd className="inline">net USDC spent on shares in w</dd></div>
          <div><dt className="num inline text-text">shares<sub>w</sub></dt> <dd className="inline">shares you hold in w</dd></div>
          <div><dt className="num inline text-text">settlementPrice</dt> <dd className="inline">between 0 and 1, set at evaluation</dd></div>
        </dl>
      </Card>

      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow tone="violet">Worked example</Eyebrow>
          <Pill tone="muted">Illustrative numbers</Pill>
        </div>
        <ul className="mt-5 divide-y divide-border">
          {EXAMPLE.map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-4 py-3">
              <div>
                <p className="text-sm text-text">{row.label}</p>
                <p className="text-xs text-faint">{row.note}</p>
              </div>
              <span className="num text-text">{row.value}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 rounded-xl bg-green-soft p-4">
          <p className="num text-sm text-green">
            payout = 1,000 − 240 + 400 × 0.80 = 1,080.00 USDC
          </p>
          <p className="mt-1 text-xs text-muted">
            A gain of 80.00 USDC. Any positions held in the other proposals are voided and
            their cost is returned.
          </p>
        </div>
      </Card>
    </section>
  );
}
