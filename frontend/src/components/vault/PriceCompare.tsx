import { fmtUsdc } from "@/sim/format";

/** Oracle price vs Uniswap v4 pool price for tETH. */
export function PriceCompare({
  oracle,
  pool,
}: Readonly<{ oracle: number; pool: number }>) {
  const gapBps = ((pool - oracle) / oracle) * 10_000;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-6">
        <div>
          <dt className="eyebrow">Oracle</dt>
          <dd className="num mt-1 text-2xl">{fmtUsdc(oracle)}</dd>
          <p className="num text-xs text-muted">USDC per tETH</p>
        </div>
        <div>
          <dt className="eyebrow">Uniswap v4 pool</dt>
          <dd className="num mt-1 text-2xl text-violet">{fmtUsdc(pool)}</dd>
          <p className="num text-xs text-muted">USDC per tETH</p>
        </div>
      </dl>
      <p className="num mt-4 text-sm text-muted">
        Pool vs oracle:{" "}
        <span className={Math.abs(gapBps) > 25 ? "text-amber" : "text-green"}>
          {gapBps > 0 ? "+" : ""}
          {gapBps.toFixed(1)} bps
        </span>
      </p>
    </div>
  );
}
