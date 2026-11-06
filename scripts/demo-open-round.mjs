// npm run demo:open-round -- --preset judge|full [--trading-minutes N] [--evaluation-seconds N] [--twap-seconds N] [--yes]
// Opens a STATUS-QUO-ONLY round after preflight. Agents then propose. Presets:
//   full : 20 min trading, 600 s evaluation, TWAP window 50% of trading (min 300 s)
//   judge: 8 min trading, 240 s TWAP window, 120 s evaluation
import { cliArgs, confirm } from './demo-round-common.mjs';
import { openStatusQuoRound, resolveTiming } from './lib/round-actions.mjs';

const args = cliArgs({
  preset: { type: 'string', default: 'full' },
  'trading-minutes': { type: 'string' },
  'evaluation-seconds': { type: 'string' },
  'twap-seconds': { type: 'string' },
});
const timing = resolveTiming({
  preset: args.preset,
  trading: args['trading-minutes'],
  evaluation: args['evaluation-seconds'],
  twap: args['twap-seconds'],
});
console.log(`timing: trading ${timing.tradingSeconds}s, TWAP window ${timing.twapSeconds}s, evaluation ${timing.evaluationSeconds}s`);
await confirm('Open a new status-quo-only round from the keeper wallet.', { yes: args.yes, word: 'open' });
await openStatusQuoRound({ timing });
