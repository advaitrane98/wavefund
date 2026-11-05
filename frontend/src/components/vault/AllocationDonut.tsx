import { fmtPct, fmtUsdc } from "@/sim/format";

/** Two-segment donut: tETH (green) and USDC (violet). */
export function AllocationDonut({
  tethValue,
  usdcValue,
}: Readonly<{ tethValue: number; usdcValue: number }>) {
  const total = tethValue + usdcValue;
  const tethShare = total > 0 ? tethValue / total : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  const tethLen = c * tethShare;

  return (
    <div className="flex flex-wrap items-center gap-8">
      <svg viewBox="0 0 140 140" className="size-40 shrink-0 -rotate-90" role="img" aria-label="Vault allocation">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--violet)" strokeWidth="16" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke="var(--green)"
          strokeWidth="16"
          strokeDasharray={`${tethLen} ${c - tethLen}`}
        />
      </svg>
      <ul className="space-y-4">
        <li>
          <p className="eyebrow flex items-center gap-2">
            <span className="size-2 rounded-full bg-green" aria-hidden /> tETH
          </p>
          <p className="num mt-1 text-lg">{fmtPct(tethShare, 1)}</p>
          <p className="num text-xs text-muted">{fmtUsdc(tethValue)} USDC</p>
        </li>
        <li>
          <p className="eyebrow flex items-center gap-2">
            <span className="size-2 rounded-full bg-violet" aria-hidden /> USDC
          </p>
          <p className="num mt-1 text-lg">{fmtPct(1 - tethShare, 1)}</p>
          <p className="num text-xs text-muted">{fmtUsdc(usdcValue)} USDC</p>
        </li>
      </ul>
    </div>
  );
}
