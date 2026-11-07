// Static configuration for the agent runtime: who the agents are, spending caps, funding amounts, timing guards.
import { parseUnits } from 'viem';

export const CHAIN_NAME = 'ARC-TESTNET';

/** `envId` is the .env variable that holds the agent's Circle wallet ID. `stagger` spaces proposers apart (seconds). */
export const AGENT_DEFS = [
  {
    key: 'momentum', name: 'Momentum', type: 'proposer', stagger: 5, envId: 'AGENT_MOMENTUM_CIRCLE_WALLET_ID',
    description: 'Proposes a higher ETH allocation after a rising short-term trend and a lower one after a falling trend.',
  },
  {
    key: 'mean_reversion', name: 'Mean-reversion', type: 'proposer', stagger: 20, envId: 'AGENT_MEAN_REVERSION_CIRCLE_WALLET_ID',
    description: 'Proposes the opposite of a stretched move: less ETH after a spike, more after a drop.',
  },
  {
    key: 'news', name: 'News', type: 'proposer', stagger: 35, envId: 'AGENT_NEWS_CIRCLE_WALLET_ID',
    description: 'Reacts to sudden shocks (a volatility-shock proxy until a news feed is connected) by following the move.',
  },
  {
    key: 'quant', name: 'Quant', type: 'forecaster', interval: 60, twapInterval: 30, envId: 'AGENT_QUANT_CIRCLE_WALLET_ID',
    description: 'Forecasts each proposal from a shrunk trend estimate and trades where its view differs from the market.',
  },
  {
    key: 'guardian', name: 'Guardian', type: 'forecaster', interval: 45, twapInterval: 20, envId: 'AGENT_GUARDIAN_CIRCLE_WALLET_ID',
    description: 'Independently corrects overpriced proposals against the shared Quant fair value, prioritizing the projected TWAP winner.',
  },
];

export const WALLET_SET_ENV = 'AGENT_CIRCLE_WALLET_SET_ID';
export const WALLET_SET_NAME = 'Wavefund agents';

// ---- caps (USDC, native-view 18 decimals for gas; 6 decimals for credits)
export const GAS_PER_ROUND_WEI = parseUnits('0.25', 18);
export const GAS_PER_DAY_WEI = parseUnits('1.0', 18);
export const GAS_PER_DAY_JUDGE_WEI = parseUnits('3.0', 18);
export const MAX_TRADE_CREDITS = 1_000_000n; // A3: 1 credit per trade
export const MAX_PROPOSAL_CREDITS = 2_000_000n; // A3: 2 credits per agent per proposal per round
export const MAX_PROPOSALS_PER_AGENT_ROUND = 1;

export function gasCaps(preset = 'full') {
  return {
    perRoundWei: GAS_PER_ROUND_WEI,
    perDayWei: preset === 'judge' ? GAS_PER_DAY_JUDGE_WEI : GAS_PER_DAY_WEI,
  };
}

// ---- funding (USDC raw, 6 decimals). USDC is also the gas token on Arc, so one balance covers both.
export const PROPOSER_BOND = 1_000_000n;
export const FORECASTER_DEPOSIT = 2_000_000n;
export const DEFAULT_GAS_TOPUP = 500_000n;

// ---- scheduler guards (seconds)
export const GUARD_SECONDS = { default: 15, guardian: 5 };
export const PRE_TWAP_LEAD = 20;

export const publicFields = (a) => ({ key: a.key, name: a.name, type: a.type, description: a.description });

// ---- A3 forecasters (Quant and Guardian share one fair-value model and one set of sizing rules)
/** Multicall3 is fixed at the same address on every chain. The chain config is NOT assumed to carry it. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const FORECAST = {
  // fair value
  driftShrink: 0.5, // sample log drift is cut in HALF toward zero ...
  driftCapPerMin: 5e-5, // ... then capped at +/-0.5 bp per minute (0.3% per hour) of log price
  candleWindow: 120, // the last 120 one-minute candles (2 hours) feed the drift and volatility estimates
  minCandles: 20,
  maxCandleAgeSec: 300, // newest candle must be at most 5 minutes old
  maxHorizonSec: 86_400, // a longer horizon almost certainly means a unit mistake
  pFairMin: 0.02,
  pFairMax: 0.98,
  modelTtlMs: 60_000, // Quant and Guardian read the SAME cached model for 60 seconds
  modelMaxStaleMs: 60_000, // No trades on an expired reference while refresh runs.
  // Quant
  quantThreshold: 0.005, // trade strictly when |pMarket - pFair| > 0.005
  // Guardian (acts only against an OVERPRICED proposal: pMarket - pFair above the threshold)
  guardianThresholdFinal: 0.01, // inside the final TWAP window
  guardianThresholdOutside: 0.03, // outside it
  guardianEverySec: { inside: 5, outside: 15 },
  guardianPassBudgetMs: 3000, // evaluation pass target (logged, not enforced)
  // execution
  minOutNum: 995n, // minOut = adapter quote * 995 / 1000 (0.5% slippage)
  minOutDen: 1000n,
  maxActionAttempts: 3, // failed attempts per agent, round and proposal before it gives up for the round
  minSellRaw: 10n ** 15n, // positions below 0.001 token are dust and are not sold
};
