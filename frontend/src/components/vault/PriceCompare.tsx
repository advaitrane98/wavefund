import { fmtUsdc } from "@/sim/format";

/** Oracle price vs Uniswap v4 pool price for tETH. A pool price of 0 means the pool is not initialised. */
export function PriceCompare({
  oracle,
  pool,
}: Readonly<{ oracle: number; pool: number }>) {
  const hasPool = pool > 0;
  const gapBps = hasPool ? ((pool - oracle) / oracle) * 10_000 : 0;
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
          <dd className={`num mt-1 text-2xl ${hasPool ? "text-violet" : "text-faint"}`}>
            {hasPool ? fmtUsdc(pool) : "Not set"}
          </dd>
          <p className="num text-xs text-muted">{hasPool ? "USDC per tETH" : "Pool not initialised yet"}</p>
        </div>
      </dl>
      {hasPool ? (
        <p className="num mt-4 text-sm text-muted">
          Pool vs oracle:{" "}
          <span className={Math.abs(gapBps) > 25 ? "text-amber" : "text-green"}>
            {gapBps > 0 ? "+" : ""}
            {gapBps.toFixed(1)} bps
          </span>
        </p>
      ) : null}
    </div>
  );
}
