// Test fixtures for the A3 forecasters: a NON-constant-product pool (log-price AMM), a fake chain "world" that serves the same
// reads as agents/lib/forecast-chain.mjs, and a fake executor that applies steps to that world.
import { StepFailed } from '../lib/executor.mjs';
import { gasCaps } from '../lib/config.mjs';
import { SpendLedger } from '../lib/ledger.mjs';
import { createLogger } from '../lib/logger.mjs';
import { clock, tmpDir } from './helpers.mjs';

export const SCALE = 10n ** 12n;
const E18 = 1e18;
export const x18 = (p) => BigInt(Math.round(p * 1e12)) * 10n ** 6n;
const raw = (tokens) => BigInt(Math.round(tokens * E18));
const depthError = () => Object.assign(new Error('InsufficientDepth'), { errorName: 'InsufficientDepth' });

/**
 * Log-price market: z = ln(P), P = SHORT per LONG. Pushing one token of the input leg moves z by kappa (up when SHORT goes in),
 * and the marginal output per input token is phi/P (SHORT in) or phi*P (LONG in). That is NOT a constant-product curve:
 * out(a) = phi/(kappa*P0) * (1 - exp(-kappa*a)). Closed forms make exact terminal prices available to the tests.
 */
export function makeLogPool({ pLong = 0.5, kappa = 0.5, phi = 0.997, pMin = 0.01, pMax = 0.99 } = {}) {
  const logit = (p) => Math.log(p / (1 - p));
  const state = { z: logit(pLong) };
  const zMin = logit(pMin);
  const zMax = logit(pMax);

  function swap(leg, inRaw, z = state.z) {
    const a = Number(inRaw) / E18;
    if (leg === 'short') {
      const zAfter = z + kappa * a;
      if (zAfter > zMax) throw depthError();
      return { out: raw((phi * Math.exp(-z) * (1 - Math.exp(-kappa * a))) / kappa), zAfter };
    }
    const zAfter = z - kappa * a;
    if (zAfter < zMin) throw depthError();
    return { out: raw((phi * Math.exp(z) * (1 - Math.exp(-kappa * a))) / kappa), zAfter };
  }
  const p = (z) => Math.exp(z) / (1 + Math.exp(z));

  function solveSell(side, amountIn) {
    let lo = 0n;
    let hi = amountIn;
    for (let i = 0; hi - lo > 1_000_000n && i < 64; i++) {
      const mid = lo + (hi - lo) / 2n;
      let ge;
      try { ge = swap(side, mid).out >= amountIn - mid; } catch { ge = true; }
      if (ge) hi = mid; else lo = mid;
    }
    const { out, zAfter } = swap(side, hi);
    const remaining = amountIn - hi;
    const matched = remaining < out ? remaining : out;
    const credits = matched / SCALE;
    const burn = credits * SCALE;
    const soldDust = remaining - burn;
    const otherDust = out - burn;
    return { credits, longDust: side === 'long' ? soldDust : otherDust, shortDust: side === 'long' ? otherDust : soldDust, swapInput: hi, zAfter };
  }

  return {
    params: { kappa, phi },
    get pLong() { return p(state.z); },
    pLongX18: () => x18(p(state.z)),
    quoteBuy(side, credits) {
      const input = credits * SCALE;
      return input + swap(side === 'long' ? 'short' : 'long', input).out;
    },
    quoteSell(side, amountIn) { const r = solveSell(side, amountIn); return { credits: r.credits, longDust: r.longDust, shortDust: r.shortDust }; },
    sellDetail(side, amountIn) { const r = solveSell(side, amountIn); return { swapInput: r.swapInput, credits: r.credits, swapOutput: r.credits * SCALE + (side === 'long' ? r.shortDust : r.longDust) }; },
    applyBuy(side, credits) { state.z = swap(side === 'long' ? 'short' : 'long', credits * SCALE).zAfter; },
    applySell(side, amountIn) { state.z = solveSell(side, amountIn).zAfter; },
    /** Exact terminal pLong after a buy of `credits`, from the closed form (no rounding). */
    exactAfterBuy(side, credits) { const a = Number(credits) * 1e-6; return p(side === 'long' ? state.z + kappa * a : state.z - kappa * a); },
    /** Exact credits (float, micro-credits) whose buy lands exactly on `target`. */
    exactCreditsFor(side, target) { return (Math.abs(logit(target) - state.z) / kappa) * 1e6; },
    setP(v) { state.z = logit(v); },
  };
}

/** Pool whose deep side is cut off (InsufficientDepth beyond `maxCredits` of input). */
export function shallow(pool, maxCredits) {
  const quoteBuy = pool.quoteBuy;
  return { ...pool, quoteBuy(side, c) { if (c > maxCredits) throw depthError(); return quoteBuy(side, c); } };
}

export const poolBatch = (pool) => async ({ requests }) => ({
  pLongX18: pool.pLongX18(),
  results: requests.map((r) => {
    try { return { ok: true, value: r.kind === 'buy' ? pool.quoteBuy(r.side, r.x) : pool.quoteSell(r.side, r.x) }; } catch (error) { return { ok: false, error }; }
  }),
});

/** Candles with a given per-minute log drift and noise, ending at `endT`. */
export function makeCandles({ n = 120, endT = 1_800_000_000, price = 2000, drift = 0, noise = 0.0005, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const out = [];
  let px = price * Math.exp(-drift * n);
  for (let i = 0; i < n; i++) {
    px *= Math.exp(drift + (rnd() - 0.5) * 2 * noise);
    out.push({ t: endT - (n - 1 - i) * 60, close: px });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------ the fake chain
export const ADDR = { quant: '0x66617018c7d91e1345eA9F51b44a062aad2D439e', guardian: '0x4A1bA43Da2b795D68f63f34fba185D92A08f1d5f' };

export function makeWorld({
  pools, tEthBps = [5000, 7000, 3000], now = 1_800_000_000, tradingStart, tradingEnd, twapWindow = 240, horizon = 600,
  rMin = 0.99, rMax = 1.01, status = 1, id = 1n, usdc = 2_500_000n,
} = {}) {
  const w = {
    id, status, now, tradingStart: tradingStart ?? now - 120, tradingEnd: tradingEnd ?? now + 400, twapWindow,
    get evaluationEnd() { return this.tradingEnd + horizon; },
    rMin: BigInt(Math.round(rMin * 1e6)) * 10n ** 12n, rMax: BigInt(Math.round(rMax * 1e6)) * 10n ** 12n,
    epsilon: 5n * 10n ** 15n, pools, tEthBps, twaps: [], wallets: new Map(), calls: { guardianBatch: 0, roundContext: 0, quantView: 0, quotes: 0, roundFresh: 0 },
    settled: new Map(), // round id -> status for older rounds
  };
  w.wallet = (address) => {
    if (!w.wallets.has(address)) w.wallets.set(address, { usdc, allowance: 0n, deposit: new Map(), claimed: new Map(), credits: new Map(), long: new Map(), short: new Map(), redeemed: new Set() });
    return w.wallets.get(address);
  };
  const header = () => ({
    tradingStart: w.tradingStart, tradingEnd: w.tradingEnd, evaluationEnd: w.evaluationEnd, twapWindow: w.twapWindow,
    rMin: w.rMin, rMax: w.rMax, status: w.status, proposalCount: w.pools.length, winnerId: 0,
  });
  w.ctx = () => ({ id: w.id, ...header(), epsilon: w.epsilon, now: w.now });
  const k = (p) => Number(p);
  w.reads = {
    async roundContext() { w.calls.roundContext++; return w.ctx(); },
    async guardianBatch(ctx) {
      w.calls.guardianBatch++;
      return {
        now: w.now, currentRoundId: w.id, round: header(), calls: 1,
        proposals: w.pools.map((pool, i) => ({ id: i, pLongX18: pool.pLongX18(), twapX18: w.twaps[i] ?? pool.pLongX18(), tEthBps: w.tEthBps[i] })),
      };
    },
    async quantView(ctx, address) {
      w.calls.quantView++;
      const wl = w.wallet(address);
      return {
        now: w.now,
        proposals: w.pools.map((pool, i) => ({ id: i, pLongX18: pool.pLongX18(), tEthBps: w.tEthBps[i], position: { long: wl.long.get(i) ?? 0n, short: wl.short.get(i) ?? 0n, credits: wl.credits.get(i) ?? 0n } })),
      };
    },
    batchFor(r, p) {
      return async ({ requests }) => { w.calls.quotes += requests.length; return poolBatch(w.pools[k(p)])({ requests }); };
    },
    async haveState(r, p, address) {
      const wl = w.wallet(address);
      return {
        deposit: wl.deposit.get(String(r)) ?? 0n, claimed: wl.claimed.get(k(p)) ?? 0n, usdc: wl.usdc, roundAllowance: wl.allowance, credits: wl.credits.get(k(p)) ?? 0n,
        position: { long: wl.long.get(k(p)) ?? 0n, short: wl.short.get(k(p)) ?? 0n },
      };
    },
    async roundFresh(r) {
      w.calls.roundFresh++;
      if (r !== w.id) return { ok: false, reason: 'round changed', now: w.now };
      if (w.status !== 1) return { ok: false, reason: 'not trading', closed: true, now: w.now };
      if (w.now >= w.tradingEnd) return { ok: false, reason: 'trading has ended', closed: true, now: w.now };
      return { ok: true, now: w.now, tradingEnd: w.tradingEnd };
    },
    async redeemInfo(r, address) {
      const wl = w.wallet(address);
      const status = r === w.id ? w.status : w.settled.get(Number(r)) ?? 0;
      const dep = wl.deposit.get(String(r)) ?? 0n;
      const redeemed = wl.redeemed.has(String(r));
      return { status, deposit: dep, redeemed, preview: dep > 0n && !redeemed && (status === 3 || status === 4) ? dep : 0n };
    },
  };
  return w;
}

/** Executor that applies QuantumRound steps to the fake world. `gate` (a promise) holds every step until it resolves. */
export function makeWorldExecutor(world, address, { gate, calls = [], failOn, apply = true, onStep } = {}) {
  return {
    mode: 'fake',
    calls,
    async run(step, { roundId }) {
      calls.push({ label: step.label, fn: step.functionName, args: step.args });
      if (gate) await gate;
      onStep?.(step);
      if (failOn?.(step)) throw failOn(step);
      if (!apply) return { dryRun: true, wei: 1n };
      const wl = world.wallet(address);
      const [r, p, a, b] = step.args;
      const pi = Number(p);
      const add = (m, key, d) => m.set(key, (m.get(key) ?? 0n) + d);
      switch (step.functionName) {
        case 'approve': wl.allowance = step.args[1]; break;
        case 'deposit': add(wl.deposit, String(r), p); wl.usdc -= p; break;
        case 'claimCredits': add(wl.claimed, pi, a); add(wl.credits, pi, a); break;
        case 'buyLong': case 'buyShort': {
          const side = step.functionName === 'buyLong' ? 'long' : 'short';
          const out = world.pools[pi].quoteBuy(side, a);
          if (out < b) throw new StepFailed(`${step.label}: Slippage`, { reverted: true });
          add(wl.credits, pi, -a);
          world.pools[pi].applyBuy(side, a);
          add(side === 'long' ? wl.long : wl.short, pi, out);
          break;
        }
        case 'sellLong': case 'sellShort': {
          const side = step.functionName === 'sellLong' ? 'long' : 'short';
          const q = world.pools[pi].quoteSell(side, a);
          if (q.credits < b) throw new StepFailed(`${step.label}: Slippage`, { reverted: true });
          add(side === 'long' ? wl.long : wl.short, pi, -a);
          add(wl.credits, pi, q.credits);
          world.pools[pi].applySell(side, a);
          break;
        }
        case 'redeem': wl.redeemed.add(String(r)); break;
        default: break;
      }
      void roundId;
      return { hash: `0x${(calls.length).toString(16).padStart(64, '0')}`, wei: 1n };
    },
  };
}

export function rig({ execute = false } = {}) {
  const dir = tmpDir();
  const c = clock();
  const ledger = new SpendLedger({ file: `${dir}/ledger.json`, caps: gasCaps('full'), now: c.now });
  const logger = createLogger({ dir: `${dir}/logs`, now: c.now, echo: false, env: {} });
  const firedMemory = new Set();
  const fired = { has: (key) => firedMemory.has(key) || ledger.hasFired(key), mark: (key) => { firedMemory.add(key); if (execute) ledger.markFired(key); } };
  return { dir, c, ledger, logger, fired, execute };
}
