// Shared risk model: sigma of 1-minute log returns from recent Coinbase candles.
// rMin / rMax = 1 -/+ 3 * sigma * sqrt(horizon in minutes), with the half-width clamped to 0.5% .. 2%.

export const MIN_HALF_WIDTH = 0.005;
export const MAX_HALF_WIDTH = 0.02;

export async function fetchSpot() {
  const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  if (!res.ok) throw new Error(`Coinbase spot failed: HTTP ${res.status}`);
  const body = await res.json();
  const price = Number(body?.data?.amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Coinbase spot returned an invalid price');
  return price;
}

/** Closes of the most recent 1-minute candles, oldest first. */
export async function fetchCloses() {
  const res = await fetch('https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60', {
    headers: { 'user-agent': 'wavefund-ops' },
  });
  if (!res.ok) throw new Error(`Coinbase candles failed: HTTP ${res.status}`);
  const rows = await res.json(); // [time, low, high, open, close, volume], newest first
  return rows
    .sort((a, b) => a[0] - b[0])
    .map((r) => Number(r[4]))
    .filter((x) => x > 0);
}

export function sigmaOf(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 2) throw new Error('not enough candles to estimate sigma');
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v);
}

export function boundsFromSigma(sigma, horizonSeconds) {
  const raw = 3 * sigma * Math.sqrt(horizonSeconds / 60);
  const half = Math.min(MAX_HALF_WIDTH, Math.max(MIN_HALF_WIDTH, raw));
  const e18 = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
  return { sigma, raw, half, rMin: e18(1 - half), rMax: e18(1 + half) };
}

/** Fetches candles and returns the bounds for a given evaluation horizon (seconds). */
export async function riskBounds(horizonSeconds) {
  const closes = await fetchCloses();
  return { ...boundsFromSigma(sigmaOf(closes), horizonSeconds), candles: closes.length };
}
