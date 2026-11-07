// Baseline decision rules. They are deliberately simple and fully explained in `reasoning`; swap them for richer
// models later without touching the runtime (signers, caps, scheduler and logging do not depend on them).
//
// Proposers:   decideProposal({ agent, features, statusQuoBps, round }) -> { action, tEthBps?, rationale?, reasoning }
// Forecasters: decideTrade({ agent, features, round, proposals: [{ id, tEthBps, pLong }], statusQuoBps })
//                -> { action, proposalId?, long?, credits?, reasoning }
import { MAX_TRADE_CREDITS } from '../lib/config.mjs';

const clampBps = (x) => Math.max(0, Math.min(10_000, Math.round(x)));
const STEP_BPS = 2000; // proposers move the ETH share by 20 percentage points
const MIN_EDGE = 0.05; // forecasters need a 5 point probability edge to trade

function proposal(statusQuoBps, deltaBps, why, rationale) {
  const tEthBps = clampBps(statusQuoBps + deltaBps);
  if (Math.abs(tEthBps - statusQuoBps) < 500) {
    return { action: 'skip', reasoning: `${why}; the resulting allocation ${tEthBps} bps is within 500 bps of the status quo ${statusQuoBps}, so it would not change the outcome` };
  }
  return { action: 'propose', tEthBps, rationale, reasoning: `${why}; moving from ${statusQuoBps} to ${tEthBps} bps` };
}

export const proposers = {
  momentum({ features: f, statusQuoBps }) {
    if (f.ret15 > 0.0005) return proposal(statusQuoBps, STEP_BPS, `15-minute return ${(f.ret15 * 100).toFixed(3)}% is positive (trend up)`, 'Momentum: trend is up, take more ETH exposure.');
    if (f.ret15 < -0.0005) return proposal(statusQuoBps, -STEP_BPS, `15-minute return ${(f.ret15 * 100).toFixed(3)}% is negative (trend down)`, 'Momentum: trend is down, cut ETH exposure.');
    return { action: 'skip', reasoning: `15-minute return ${(f.ret15 * 100).toFixed(3)}% is inside the +/-0.05% dead zone, no trend to follow` };
  },
  mean_reversion({ features: f, statusQuoBps }) {
    if (f.z > 1.5) return proposal(statusQuoBps, -STEP_BPS, `price is ${f.z.toFixed(2)} standard deviations above its 30-minute mean`, 'Mean reversion: price is stretched up, expect a pullback.');
    if (f.z < -1.5) return proposal(statusQuoBps, STEP_BPS, `price is ${f.z.toFixed(2)} standard deviations below its 30-minute mean`, 'Mean reversion: price is stretched down, expect a bounce.');
    return { action: 'skip', reasoning: `z-score ${f.z.toFixed(2)} is inside +/-1.5, price is not stretched` };
  },
  news({ features: f, statusQuoBps }) {
    if (f.shock < 3) return { action: 'skip', reasoning: `5-minute move is ${f.shock.toFixed(2)} sigma, below the 3 sigma shock threshold (volatility-shock proxy; no news feed connected yet)` };
    const up = f.ret5 > 0;
    return proposal(statusQuoBps, up ? STEP_BPS : -STEP_BPS, `5-minute move of ${(f.ret5 * 100).toFixed(3)}% is a ${f.shock.toFixed(1)} sigma shock`, `Shock ${up ? 'up' : 'down'}: follow the move until the market reprices.`);
  },
};

/** Fair pLong of a proposal: expected vault return 1 + w * mu, mapped linearly onto [rMin, rMax]. */
export function fairPLong({ w, mu, rMin, rMax }) {
  const p = (1 + w * mu - rMin) / (rMax - rMin);
  return Math.max(0.02, Math.min(0.98, p));
}

function expectedEthReturn(agent, f, horizonMin) {
  // Quant: 30-minute trend, extrapolated over the horizon and shrunk to 30% (trend persistence is weak).
  if (agent.key === 'quant') return 0.3 * (f.ret30 / 30) * horizonMin;
  // Guardian: no directional view; it prices risk instead (see below).
  return 0;
}

export const forecasters = {
  decide({ agent, features: f, round, proposals, statusQuoBps }) {
    const horizonMin = Math.max(1, (round.evaluationEnd - round.tradingEnd) / 60);
    const rMin = Number(round.rMin) / 1e18;
    const rMax = Number(round.rMax) / 1e18;
    const mu = expectedEthReturn(agent, f, horizonMin);
    const view = proposals.map((p) => {
      const w = p.tEthBps / 10_000;
      let fair = fairPLong({ w, mu, rMin, rMax });
      if (agent.key === 'guardian') {
        // Penalise moving far from the status quo: extra exposure risk over the horizon, in units of the range half-width.
        const risk = (Math.abs(p.tEthBps - statusQuoBps) / 10_000) * f.sigma * Math.sqrt(horizonMin) * 3 / ((rMax - rMin) / 2);
        fair = Math.max(0.02, Math.min(0.98, 0.5 - 0.5 * Math.min(1, risk)));
      }
      return { id: p.id, tEthBps: p.tEthBps, pLong: p.pLong, fair, edge: p.pLong == null ? null : fair - p.pLong };
    }).filter((v) => v.edge != null);
    if (!view.length) return { action: 'skip', reasoning: 'no seeded proposal markets to trade yet', view };
    const best = view.reduce((a, b) => (Math.abs(b.edge) > Math.abs(a.edge) ? b : a));
    if (Math.abs(best.edge) < MIN_EDGE) {
      return { action: 'skip', reasoning: `largest edge is ${(best.edge * 100).toFixed(1)} points on proposal ${best.id}, below the ${MIN_EDGE * 100}-point threshold`, view };
    }
    const long = best.edge > 0;
    // 0.1 credit per 1 point of edge, capped per trade; the executor applies the per-proposal cap as well.
    const raw = BigInt(Math.round(Math.abs(best.edge) * 100)) * 100_000n;
    const credits = raw > MAX_TRADE_CREDITS ? MAX_TRADE_CREDITS : raw;
    return {
      action: 'trade', proposalId: best.id, long, credits, view,
      reasoning: `fair pLong ${best.fair.toFixed(3)} vs market ${best.pLong.toFixed(3)} on proposal ${best.id} (${best.tEthBps} bps): edge ${(best.edge * 100).toFixed(1)} points, buy ${long ? 'LONG' : 'SHORT'} with ${credits} credits (6 decimals)`,
    };
  },
};
