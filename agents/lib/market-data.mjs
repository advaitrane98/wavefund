// Coinbase 1-minute ETH-USD candles with retry (3 attempts over about 20 s) and a short cache.
export const CANDLES_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60';
export const RETRY_DELAYS_MS = [7000, 13000]; // waits before attempts 2 and 3: about 20 s in total
export const CACHE_TTL_MS = 20_000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMarketData({
  fetchImpl = fetch, sleep = realSleep, now = () => Date.now(), ttlMs = CACHE_TTL_MS, delays = RETRY_DELAYS_MS, onRetry,
} = {}) {
  let cached = null;

  async function once() {
    const res = await fetchImpl(CANDLES_URL, { headers: { 'user-agent': 'wavefund-agents' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Coinbase candles failed: HTTP ${res.status}`);
    const rows = await res.json(); // [time, low, high, open, close, volume], newest first
    if (!Array.isArray(rows) || rows.length < 3) throw new Error('Coinbase candles returned too little data');
    const candles = rows
      .map((r) => ({ t: Number(r[0]), low: Number(r[1]), high: Number(r[2]), open: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .filter((c) => c.close > 0)
      .sort((a, b) => a.t - b.t);
    return { candles, closes: candles.map((c) => c.close), last: candles[candles.length - 1].close, fetchedAt: now() };
  }

  async function candles({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.fetchedAt < ttlMs) return { ...cached, cached: true };
    let lastErr;
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      try {
        cached = await once();
        return { ...cached, cached: false, attempts: attempt };
      } catch (err) {
        lastErr = err;
        if (attempt <= delays.length) {
          onRetry?.(attempt, err);
          await sleep(delays[attempt - 1]);
        }
      }
    }
    throw new Error(`market data unavailable after ${delays.length + 1} attempts: ${lastErr.message}`);
  }

  return { candles };
}

// ---- features used by the baseline strategies
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

export function features(closes) {
  const n = closes.length;
  if (n < 20) throw new Error(`need at least 20 candles, have ${n}`);
  const last = closes[n - 1];
  const ret = (k) => last / closes[n - 1 - k] - 1;
  const logRets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const window = closes.slice(-30);
  const sigma = sd(logRets);
  return {
    last,
    ret5: ret(5),
    ret15: ret(Math.min(15, n - 1)),
    ret30: ret(Math.min(30, n - 1)),
    sigma,
    z: sd(window) > 0 ? (last - mean(window)) / sd(window) : 0,
    shock: sigma > 0 ? Math.abs(ret(5)) / (sigma * Math.sqrt(5)) : 0,
    candles: n,
  };
}
