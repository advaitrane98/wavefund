// npm run demo:preflight   Prints READY / NOT READY with every check. Exit code 0 only when READY.
import { preflight, printChecks } from './lib/round-actions.mjs';

const result = await preflight();
printChecks(result);
process.exit(result.ready ? 0 : 1);
