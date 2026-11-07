// Mutation check: copies agents/, scripts/ and the deployment book into scratch directories under .run/mutants/, breaks ONE
// production rule in each copy and runs the whole agent test suite there. Every mutant must be KILLED (at least one failing test).
// The repository itself is never modified.   Usage: node agents/tools/mutation-check.mjs [--only name,name]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = path.join(ROOT, '.run', 'mutants');

/** [name, file, exact text to find (must occur exactly once), replacement] */
export const MUTANTS = [
  ['shrinkage removed', 'agents/lib/fair.mjs', 'const shrunk = driftRaw * cfg.driftShrink;', 'const shrunk = driftRaw * 1;'],
  ['drift cap removed', 'agents/lib/fair.mjs', 'const drift = Math.max(-cfg.driftCapPerMin, Math.min(cfg.driftCapPerMin, shrunk));', 'const drift = shrunk;'],
  ['pFair clamp removed', 'agents/lib/fair.mjs', 'const pFair = Math.max(cfg.pFairMin, Math.min(cfg.pFairMax, raw));', 'const pFair = raw;'],
  ['lognormal convexity dropped', 'agents/lib/fair.mjs', 'model.drift * minutes + 0.5 * model.sigma * model.sigma * minutes', 'model.drift * minutes'],
  ['horizon minutes wrong', 'agents/lib/fair.mjs', 'return horizonSeconds / 60;', 'return horizonSeconds / 6;'],
  ['threshold made non-strict (market high)', 'agents/lib/decide.mjs', 'if (gapX18 > thr) return', 'if (gapX18 >= thr) return'],
  ['threshold made non-strict (market low)', 'agents/lib/decide.mjs', 'if (-gapX18 > thr) return', 'if (-gapX18 >= thr) return'],
  ['direction inverted', 'agents/lib/decide.mjs', "if (gapX18 > thr) return { gapX18, thresholdX18: thr, direction: 'lower'", "if (gapX18 > thr) return { gapX18, thresholdX18: thr, direction: 'raise'"],
  ['guardian thresholds swapped', 'agents/lib/decide.mjs', '? cfg.guardianThresholdFinal : cfg.guardianThresholdOutside', '? cfg.guardianThresholdOutside : cfg.guardianThresholdFinal'],
  ['status quo excluded from Quant', 'agents/lib/forecasters.mjs', 'for (const p of view.proposals) {\n      if (p.pLongX18 == null', 'for (const p of view.proposals.filter((x) => x.id !== 0)) {\n      if (p.pLongX18 == null'],
  ['leader epsilon made non-strict', 'agents/lib/decide.mjs', 'twaps[best] > t0 + epsilon', 'twaps[best] >= t0 + epsilon'],
  ['guardian candidate filter removed', 'agents/lib/decide.mjs', 'if (s0 != null) for (let p = 1; p < spots.length; p++) if (spots[p] != null && spots[p] >= s0) ids.add(p);', 'for (let p = 1; p < spots.length; p++) ids.add(p);'],
  ['sizing uses the average price', 'agents/lib/sizing.mjs', 'const pair = lo && hi && lo.inRaw < hi.inRaw ? [lo, hi] : lo && lo.inRaw < mid.inRaw ? [lo, mid] : null;', 'const pair = [{ inRaw: 0n, outRaw: 0n }, mid];'],
  ['sizing never stops at fair', 'agents/lib/sizing.mjs', 'over: raise ? est > targetX18 : est < targetX18', 'over: false'],
  ['sizing ignores the fee calibration', 'agents/lib/sizing.mjs', 'phi = calibratePhi(marginal(c1, c2), pLong0, leg);', 'phi = 997n * 10n ** 15n;'],
  ['quote output treated as swap output', 'agents/lib/sizing.mjs', 'return { inRaw: input, outRaw: value - input, quote: value };', 'return { inRaw: input, outRaw: value, quote: value };'],
  ['minOut without slippage', 'agents/lib/sizing.mjs', 'return (quote * num) / den;', 'return quote;'],
  ['minOut slippage 1%', 'agents/lib/sizing.mjs', 'return (quote * num) / den;', 'return (quote * 990n) / 1000n;'],
  ['per-trade cap back to 0.5', 'agents/lib/config.mjs', 'export const MAX_TRADE_CREDITS = 1_000_000n;', 'export const MAX_TRADE_CREDITS = 500_000n;'],
  ['per-proposal cap back to 1.0', 'agents/lib/config.mjs', 'export const MAX_PROPOSAL_CREDITS = 2_000_000n;', 'export const MAX_PROPOSAL_CREDITS = 1_000_000n;'],
  ['per-proposal cap ignored', 'agents/lib/ledger.mjs', 'const room = MAX_PROPOSAL_CREDITS - this.spentOnProposal(agent, roundId, proposalId);', 'const room = MAX_PROPOSAL_CREDITS;'],
  ['deposit on every trade', 'agents/lib/actions.mjs', 'const deposit = have.deposit > 0n ? 0n : depositAmount;', 'const deposit = depositAmount;'],
  ['claim shared across proposals', 'agents/lib/trader.mjs', "const k = key(roundId, proposalId);\n    const dep", "const k = key(roundId, 0);\n    const dep"],
  ['dry-run writes durable trade marks', 'agents/lib/trader.mjs', '\n        reservation = ledger.reserveTrade(agent.key, roundId, proposalId, sized.size, { persist: execute });', '\n        reservation = ledger.reserveTrade(agent.key, roundId, proposalId, sized.size, { persist: true });'],
  ['ambiguous broadcast releases budget', 'agents/lib/trader.mjs', 'if (detail.ambiguous) ledger.markTradeAmbiguous(reservation, err.message);\n        else ledger.releaseTrade', 'if (false) ledger.markTradeAmbiguous(reservation, err.message);\n        else ledger.releaseTrade'],
  ['guardian blocks on the transaction', 'agents/lib/forecasters.mjs', 'a.inflight = intervene(a, ctx, jobs, threshold).finally(() => { a.inflight = null; });', 'a.inflight = null; await intervene(a, ctx, jobs, threshold);'],
  ['loops run one after the other', 'agents/lib/forecasters.mjs', "if (ctxs.has('quant')) jobs.push(loop('quant', quantTick, once));", "if (ctxs.has('quant')) await loop('quant', quantTick, once);"],
  ['guardian reads prices in several calls', 'agents/lib/forecasters.mjs', 'let batch = await reads.guardianBatch(ctx);', 'let batch = await reads.guardianBatch(ctx); await reads.guardianBatch(ctx);'],
  ['multicall may be split by viem', 'agents/lib/forecast-chain.mjs', 'multicallAddress, batchSize: 0,', 'multicallAddress, batchSize: 1024,'],
  ['model cache never expires at 60 s', 'agents/lib/model-provider.mjs', 'cached != null && age() < ttlMs', 'cached != null && age() <= ttlMs'],
  ['model cache ttl 5 min', 'agents/lib/config.mjs', 'modelTtlMs: 60_000,', 'modelTtlMs: 300_000,'],
  ['older tracked rounds forgotten', 'agents/lib/redeemer.mjs', 'const candidates = new Set(ledger.trackedRounds(agent.key).map(Number));', 'const candidates = new Set();'],
  ['no startup redeem of the latest round', 'agents/lib/redeemer.mjs', 'if (first && cur > 0) for', 'if (false) for'],
  ['TradingClosed treated as failure', 'agents/lib/trader.mjs', "if (err.tradingClosed || isTradingClosed(err) || isTradingClosed({ errorName: detail.errorName, message: detail.simulationError })) {", 'if (false) {'],
  ['unbounded failed attempts', 'agents/lib/forecasters.mjs', 'const exhausted = (a, roundId, p) => (a.attempts.get(`${roundId}|${p}`) ?? 0) >= cfg.maxActionAttempts;', 'const exhausted = () => false;'],
  ['stale round not checked before acting', 'agents/lib/trader.mjs', "if (!fresh.ok) return done(fresh.closed ? 'closed' : 'stale', { reason: fresh.reason });", ''],
  ['guardian also buys LONG', 'agents/lib/forecasters.mjs', "const intervene = sig.direction === 'lower';", 'const intervene = sig.direction !== null;'],
  ['Guardian omits status quo', 'agents/lib/decide.mjs', 'const ids = new Set([leader, 0]);', 'const ids = new Set([leader]);'],
  ['expired reference allowed', 'agents/lib/model-provider.mjs', 'age() < Math.min(ttlMs, maxStaleMs)', 'age() < 180_000'],
  ['no resize after prerequisites', 'agents/lib/trader.mjs', 'if (prerequisite.length) {', 'if (false) {'],
  ['no pending wallet gate', 'agents/lib/trader.mjs', 'if (execute && ledger.unresolvedTradeReservations().some((r) => r.key.startsWith(`${agent.key}|`)))', 'if (false)'],
  ['keeper opens a third round', 'scripts/keeper-run.mjs', "if (r.action === 'idle' && roundsOpened >= maxRounds) {", 'if (false) {'],
  ['strike allows zero minimum output', 'scripts/demo-manipulate.mjs', 'minOutFromQuote(quote)]', '0n]'],
  ['failed Guardian passes disappear', 'agents/lib/forecasters.mjs', "if (ctxs.has('guardian')) record('failed', err.message);", "if (false) record('failed', err.message);"],
  ['event scan skips blocks', 'scripts/lib/read-events.mjs', 'from = end + 1n;', 'from = end + 2n;'],
  ['reconciliation loses its report block', 'scripts/lib/reconcile.mjs', 'reader(address, abi, fn, args, { blockNumber })', 'reader(address, abi, fn, args, {})'],
  ['round snapshot loses its report block', 'scripts/lib/round-actions.mjs', 'reader(address, abi, fn, args, { blockNumber })', 'reader(address, abi, fn, args, {})'],
];

function copyTree() {
  fs.mkdirSync(SCRATCH, { recursive: true });
}

function runSuite(dir) {
  const tests = ['agents/test', 'scripts/test'].flatMap(folder => fs.existsSync(path.join(dir, folder))
    ? fs.readdirSync(path.join(dir, folder)).filter(f => !f.startsWith('.') && f.endsWith('.test.mjs')).map(f => `${folder}/${f}`) : []);
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
    cwd: dir, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

export function runMutant([name, file, find, replace], idx, expectedCount = 0) {
  const dir = path.join(SCRATCH, `m${String(idx).padStart(2, '0')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'contracts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'agents'), path.join(dir, 'agents'), { recursive: true, filter: (s) => !s.includes(`${path.sep}tools`) });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'contracts', 'deployments'), path.join(dir, 'contracts', 'deployments'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  const target = path.join(dir, file);
  const text = fs.readFileSync(target, 'utf8');
  const patternCount = text.split(find).length - 1;
  if (patternCount !== 1) return { name, status: 'INVALID', detail: `pattern found ${patternCount} times in ${file}` };
  fs.writeFileSync(target, text.replace(find, () => replace));
  const run = runSuite(dir);
  const out = `${run.stdout}\n${run.stderr}`;
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].replace(/ #.*$/, '')).filter((n) => !/^\//.test(n));
  const count = Number(out.match(/^# tests (\d+)$/m)?.[1] ?? 0);
  const fail = Number(out.match(/^# fail (\d+)$/m)?.[1] ?? 0);
  const cancelled = Number(out.match(/^# cancelled (\d+)$/m)?.[1] ?? 0);
  const complete = !run.error && count >= Math.max(expectedCount, 1) && cancelled === 0;
  const killed = complete && run.status === 1 && fail > 0 && /ERR_ASSERTION|AssertionError/.test(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, status: killed ? 'KILLED' : complete ? 'SURVIVED' : 'INVALID', detail: `${count} tests, ${fail} failed; ` + (run.error ? `timeout/error: ${run.error.code ?? run.error.message}` : failed.slice(0, 2).join(' | ')) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  copyTree();
  const baseline = runSuite(ROOT);
  const expectedCount = Number(baseline.stdout?.match(/^# tests (\d+)$/m)?.[1] ?? 0);
  if (baseline.status !== 0 || baseline.error || !expectedCount) {
    fs.writeFileSync(path.join(SCRATCH, 'baseline-failure.log'), `${baseline.stdout}\n${baseline.stderr}`);
    throw new Error(`Mutation baseline did not pass (status ${baseline.status}, tests ${expectedCount}, ${baseline.error?.message ?? 'no process error'}); refusing to count mutants. See .run/mutants/baseline-failure.log`);
  }
  console.log(`Baseline: ${expectedCount} tests passed`);
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;
  const results = [];
  MUTANTS.forEach((m, i) => {
    if (only && !only.some((o) => m[0].includes(o))) return;
    const r = runMutant(m, i, expectedCount);
    results.push(r);
    console.log(`${r.status.padEnd(9)} ${r.name}${r.detail ? `  <- ${r.detail}` : ''}`);
  });
  const survived = results.filter((r) => r.status !== 'KILLED');
  console.log(`\n${results.length - survived.length}/${results.length} mutants killed`);
  process.exit(survived.length ? 1 : 0);
}
