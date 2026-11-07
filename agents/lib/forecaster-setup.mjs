// Wires the forecaster runtime for agents/run.mjs. Returns null when no forecaster is selected, so `--only` a proposer
// never creates a market-data fetcher or fetches a forecast.
import { createMarketData } from './market-data.mjs';
import { createForecastClients, createForecastReads } from './forecast-chain.mjs';
import { createForecasterRuntime } from './forecasters.mjs';
import { createModelProvider } from './model-provider.mjs';

/**
 * `agents` = [{ def, signer, executor }] for every selected agent. Quant and Guardian share ONE model provider (its own candle
 * fetcher), so `--only guardian` still has a fresh Quant-equivalent model without any Quant trade being launched.
 * `deps` lets tests replace reads, model, market and the round source.
 */
export function buildForecasterRuntime({ agents, ledger, logger, execute, fired, stop, sleep, flags = {}, pollMs, roundSource, deps = {} }) {
  const forecasters = agents.filter((a) => a.def.type === 'forecaster');
  if (!forecasters.length) return null;
  const reads = deps.reads ?? (() => { const c = createForecastClients(); return createForecastReads({ client: c.standard, fastClient: c.fast }); })();
  const market = deps.market ?? createMarketData({ delays: [1500], ttlMs: 5_000, onRetry: (n, err) => logger.warn(`forecast market data attempt ${n} failed: ${err.message}`) });
  const model = deps.model ?? createModelProvider({ market });
  return createForecasterRuntime({
    agents: forecasters, ledger, logger, execute, fired, model, reads, sleep, stop, flags, pollMs,
    roundSource: roundSource ?? (() => reads.roundContext()), ...(deps.runtime ?? {}),
  });
}
