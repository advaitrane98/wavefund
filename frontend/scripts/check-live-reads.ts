/**
 * Reads the live deployment on Arc testnet with the same code the app uses, and prints a summary.
 * Run: bun scripts/check-live-reads.ts [0xYourAddress]
 * Read-only: no transactions, no keys.
 */
import { getPublicClient } from "../src/lib/live/client";
import { fetchHistory, fetchSnapshot, fetchUserRounds } from "../src/lib/live/snapshot";
import { hasLiveDeployment } from "../src/config/contracts";
import { usdc, wave } from "../src/lib/units";

if (!hasLiveDeployment) {
  console.error("No live deployment in src/config/deployment.json");
  process.exit(1);
}

const account = (process.argv[2] as `0x${string}` | undefined) ?? null;
const client = getPublicClient();

const started = Date.now();
const snap = await fetchSnapshot(client, account);
console.log(`snapshot in ${Date.now() - started} ms, block ${snap.blockNumber}, round ${snap.currentRoundId}`);

const v = snap.vault;
console.log("vault", {
  nav: usdc.format(v.navUsdc),
  usdc: usdc.format(v.totalVaultUsdc),
  tEthBps: v.tEthBps,
  oracle: usdc.format(v.oraclePriceUsdc, 4),
  pool: usdc.format(v.poolPriceUsdc, 4),
  supply: wave.format(v.totalSupply),
  sharePrice: usdc.format(v.sharePriceUsdc, 4),
  oracleUpdatedAt: v.oracleUpdatedAt,
});

if (snap.round) {
  const r = snap.round;
  console.log("round", {
    id: r.id,
    status: r.status,
    phase: r.phase,
    tradingEnd: r.tradingEnd,
    evaluationEnd: r.evaluationEnd,
    proposals: r.proposals.length,
  });
  for (const p of r.proposals) {
    console.log("  proposal", p.id, p.proposerName ?? "(status quo)", `${p.tEthBps} bps`, {
      pLong: Number(p.pLong) / 1e18,
      twap: Number(p.twap) / 1e18,
      tokens: p.tokens,
    });
  }
} else {
  console.log("no round yet");
}

const history = await fetchHistory(client, snap.currentRoundId);
console.log(`history: ${history.length} rows`);
for (const h of history) console.log("  ", JSON.stringify(h, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

if (account) {
  const mine = await fetchUserRounds(client, snap.currentRoundId, account);
  console.log("my rounds", JSON.stringify(mine, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
}
