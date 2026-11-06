// npm run demo:close-round   Manual equivalent of the keeper: waits for each due step and performs it until the
// current round is settled or cancelled.
import { cliArgs, confirm, log, sleep } from './demo-round-common.mjs';
import { nextStep, snapshot, STATUS } from './lib/round-actions.mjs';

const args = cliArgs({});
const s0 = await snapshot();
if (!s0) throw new Error('no round exists');
await confirm(`Drive round ${s0.id} (${STATUS[s0.status]}) to completion from the keeper wallet.`, { yes: args.yes, word: 'close' });
for (;;) {
  const r = await nextStep();
  if (r.action === 'idle') break;
  if (r.action === 'wait') {
    log(r.why);
    await sleep(Math.min(Math.max(r.wait, 1), 5) * 1000);
  } else log(`done: ${r.action}`);
}
const s = await snapshot();
console.log(`round ${s.id} is ${STATUS[s.status]}`);
