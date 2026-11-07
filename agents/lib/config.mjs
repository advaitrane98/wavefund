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
    description: 'Risk-averse forecaster: leans against proposals that move far from the current allocation.',
  },
];

export const WALLET_SET_ENV = 'AGENT_CIRCLE_WALLET_SET_ID';
export const WALLET_SET_NAME = 'Wavefund agents';

// ---- caps (USDC, native-view 18 decimals for gas; 6 decimals for credits)
export const GAS_PER_ROUND_WEI = parseUnits('0.25', 18);
export const GAS_PER_DAY_WEI = parseUnits('1.0', 18);
export const GAS_PER_DAY_JUDGE_WEI = parseUnits('3.0', 18);
export const MAX_TRADE_CREDITS = 500_000n; // 0.5 credit per trade
export const MAX_PROPOSAL_CREDITS = 1_000_000n; // 1.0 credit per agent per proposal
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
