// One shared, cached market model for Quant and Guardian ("exact Quant pFair, cached 60 seconds").
// - The cache holds the MODEL (price, drift, volatility); pFair is a pure function of it, so both agents see identical numbers.
// - It has its own candle fetcher, so neither agent ever waits for the proposers' market data or news.
// - Refreshes are single-flight. Guardian waits a bounded time and skips when the reference expires.
import { FORECAST } from './config.mjs';
import { ModelError, buildModel } from './fair.mjs';

export function createModelProvider({ market, now = () => Date.now(), ttlMs = FORECAST.modelTtlMs, maxStaleMs = FORECAST.modelMaxStaleMs, cfg = FORECAST, onError } = {}) {
  let cached = null; // { model, fetchedAt }
  let inflight = null;
  let lastError = null;
  const stats = { fetches: 0 };

  const age = () => (cached ? now() - cached.fetchedAt : Infinity);
  const isFresh = () => cached != null && age() < ttlMs; // expires AT ttl, never later

  function refresh() {
    if (inflight) return inflight;
    stats.fetches++;
    inflight = (async () => {
      try {
        const data = await market.candles({ fresh: true });
        const model = buildModel(data.candles, { nowSec: now() / 1000, cfg });
        cached = { model, fetchedAt: now() };
        lastError = null;
        return cached;
      } catch (err) {
        lastError = err;
        onError?.(err);
        throw err;
      } finally {
        inflight = null;
      }
    })();
    inflight.catch(() => {}); // a background refresh that nobody awaits must not become an unhandled rejection
    return inflight;
  }

  const view = (stale) => ({ model: cached.model, ageMs: age(), cached: true, stale, fetchedAt: cached.fetchedAt });

  return {
    stats,
    /** Fresh model, awaiting a refresh when the cache is older than the TTL. Throws if no model can be built. */
    async get() {
      if (isFresh()) return view(false);
      await refresh();
      return view(false);
    },
    /**
     * For the Guardian hot loop: never blocks longer than `waitMs`. An expired reference is never actionable.
     * Throws ModelError('no-model') while a refresh keeps running in the background.
     */
    async getBounded({ waitMs = 750 } = {}) {
      if (isFresh()) return view(false);
      const pending = refresh();
      let timer;
      const waited = await Promise.race([
        pending.then(() => 'done', () => 'failed'),
        new Promise((res) => { timer = setTimeout(() => res('timeout'), waitMs); }),
      ]);
      clearTimeout(timer);
      if (waited === 'done' && cached) return view(false);
      if (cached && age() < Math.min(ttlMs, maxStaleMs)) return view(false);
      throw new ModelError(`no usable market model (${waited}${lastError ? `: ${lastError.message}` : ''})`, 'no-model');
    },
    /** Keeps the cache warm; call on a timer. Never throws. */
    async warm() {
      if (isFresh()) return false;
      try { await refresh(); return true; } catch { return false; }
    },
    peek: () => (cached ? view(!isFresh()) : null),
    get lastError() { return lastError; },
  };
}
