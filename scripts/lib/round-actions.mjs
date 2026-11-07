// Round state, preflight, opening and the keeper's state machine. Shared by demo:*, keeper:run and the smoke test.
import { parseUnits } from 'viem';
import {
  abis, accountFrom, chainNow, loadBook, log, nativeBalance, publicClient, read, sendContract, usdc,
} from '../demo-round-common.mjs';
import { oracleState, updateOracle } from './oracle.mjs';
import { impactFor, oraclePrice, priceFromSqrt, readPool } from './pool-math.mjs';
import { riskBounds } from './risk-model.mjs';

export const STATUS = ['None', 'Trading', 'Collapsed', 'Settled', 'Cancelled'];
export const PRESETS = {
  full: { trading: 20 * 60, evaluation: 600, twap: null },
  judge: { trading: 8 * 60, evaluation: 120, twap: 240 },
};
export const MARKETS_NEEDED = 4n; // status quo + 3 agent proposals

// ---------------------------------------------------------------- reading

export async function snapshot(roundId, { blockNumber, reader = read, getBlock = (options) => publicClient.getBlock(options) } = {}) {
  const book = loadBook();
  const A = abis();
  const readAt = (address, abi, fn, args = []) => reader(address, abi, fn, args, { blockNumber });
  const id = roundId ?? (await readAt(book.c.QuantumRound, A.QuantumRound, 'currentRoundId'));
  if (id === 0n) return null;
  const r = await readAt(book.c.QuantumRound, A.QuantumRound, 'rounds', [id]);
  const v = await readAt(book.c.WavefundVault, A.WavefundVault, 'roundState', [id]);
  return {
    id,
    tradingStart: Number(r[0]), tradingEnd: Number(r[1]), evaluationEnd: Number(r[2]), twapWindow: Number(r[3]),
    rMin: r[4], rMax: r[5], status: r[6], proposalCount: r[7], winnerId: r[8], seedReleased: r[9],
    realisedReturn: r[10], pi: r[11], totalDeposits: r[12], depositsOutstanding: r[13], escrow: r[14], totalPaid: r[15],
    vault: { startValue: v[0], executed: v[5], reported: v[6], cancelled: v[7] },
    now: Number((await getBlock(blockNumber == null ? {} : { blockNumber })).timestamp),
  };
}

// ---------------------------------------------------------------- preflight

export async function preflight({ requireNoOpenRound = true } = {}) {
  const book = loadBook();
  const A = abis();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  try {
    const keeper = accountFrom('KEEPER_PK').address;
    const qr = book.c.QuantumRound;
    const codes = await Promise.all(['QuantumRound', 'WavefundVault', 'MockPriceOracle', 'WaveV4ProposalMarket', 'WaveHook', 'WavefundPoolHelper'].map(async (n) => [n, (await publicClient.getCode({ address: book.c[n] }))?.length > 2]));
    add('contracts deployed', codes.every(([, ok]) => ok), codes.filter(([, ok]) => !ok).map(([n]) => n).join(', ') || 'all have code');
    const keeperRole = await read(qr, A.QuantumRound, 'hasRole', [await read(qr, A.QuantumRound, 'KEEPER_ROLE'), keeper]);
    add('keeper has KEEPER_ROLE on QuantumRound', keeperRole, keeper);
    const src = await read(qr, A.QuantumRound, 'allocationSource');
    add('allocation source is the vault', src.toLowerCase() === book.c.WavefundVault.toLowerCase(), src);
    const nav = await read(book.c.WavefundVault, A.WavefundVault, 'navUsdc');
    add('vault funded', nav > 0n, `NAV ${usdc(nav)} USDC`);
    const reserve = await read(qr, A.QuantumRound, 'protocolLiquiditySeed');
    const seed = await read(qr, A.QuantumRound, 'initialLiquidityPerProposal');
    add(`reserve covers ${MARKETS_NEEDED} markets`, reserve >= MARKETS_NEEDED * seed, `${usdc(reserve)} USDC, needs ${usdc(MARKETS_NEEDED * seed)}`);
    const gas = await nativeBalance(keeper);
    add('keeper gas balance', gas >= parseUnits('0.25', 18), `${Number(gas) / 1e18} USDC`);
    const o = await oracleState();
    add('oracle readable', o.answer > 0n, `$${o.usd}, ${o.age}s old (refreshed on open)`);
    const pool = await readPool(book);
    if (pool.sqrtPriceX96 === 0n) {
      add('pool initialised', false, 'run npm run pool:recenter');
    } else {
      const price = priceFromSqrt(pool.sqrtPriceX96, pool.key.usdcIs0);
      const gap = Math.abs(price / o.usd - 1);
      add('pool within 0.5% of oracle', gap <= 0.005, `pool $${price.toFixed(2)} vs oracle $${o.usd} (${(gap * 100).toFixed(2)}%)`);
      const worst = Math.max(impactFor(pool, 2_000_000n, true, price), impactFor(pool, 2_000_000n, false, price));
      add('pool deep enough (2 USDC trade <= 2%)', worst <= 0.02, Number.isFinite(worst) ? `${(worst * 100).toFixed(2)}%` : 'no liquidity in range');
    }
    const snap = await snapshot();
    if (requireNoOpenRound) {
      add('previous round finished', !snap || snap.status === 3 || snap.status === 4, snap ? `round ${snap.id} is ${STATUS[snap.status]}` : 'no rounds yet');
    }
  } catch (err) {
    add('preflight could run', false, err.message);
  }
  return { ready: checks.every((c) => c.ok), checks };
}

export function printChecks(result) {
  for (const c of result.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(`\n${result.ready ? 'READY' : 'NOT READY'}`);
}

// ---------------------------------------------------------------- opening a status-quo-only round

export function resolveTiming({ preset = 'full', trading, evaluation, twap } = {}) {
  const base = PRESETS[preset];
  if (!base) throw new Error(`unknown preset "${preset}" (use full or judge)`);
  const tradingSeconds = trading != null ? Math.round(Number(trading) * 60) : base.trading;
  const evaluationSeconds = evaluation != null ? Math.round(Number(evaluation)) : base.evaluation;
  const twapSeconds = twap != null ? Math.round(Number(twap)) : (base.twap ?? Math.max(300, Math.round(tradingSeconds * 0.5)));
  if (!(tradingSeconds > 0 && evaluationSeconds > 0 && twapSeconds > 0)) throw new Error('timings must be positive');
  if (twapSeconds > tradingSeconds) throw new Error(`TWAP window ${twapSeconds}s is longer than trading ${tradingSeconds}s`);
  return { tradingSeconds, evaluationSeconds, twapSeconds };
}

export async function openStatusQuoRound({ timing, account = accountFrom('KEEPER_PK'), skipPreflight = false }) {
  const book = loadBook();
  if (!skipPreflight) {
    const pre = await preflight();
    printChecks(pre);
    if (!pre.ready) throw new Error('preflight failed, not opening a round');
  }
  await updateOracle({ account }); // proposal 0 reads the vault's oracle-marked allocation, so refresh first
  const bounds = await riskBounds(timing.evaluationSeconds);
  console.log(
    `risk model: sigma/min ${(bounds.sigma * 100).toFixed(4)}% over ${bounds.candles} candles -> half-width ${(bounds.half * 100).toFixed(2)}% (raw ${(bounds.raw * 100).toFixed(2)}%)`,
  );
  const tradingEnd = BigInt((await chainNow()) + timing.tradingSeconds);
  const res = await sendContract({
    account,
    address: book.c.QuantumRound,
    abi: abis().QuantumRound,
    functionName: 'openRound',
    args: [tradingEnd, BigInt(timing.evaluationSeconds), bounds.rMin, bounds.rMax, BigInt(timing.twapSeconds)],
    label: 'openRound (status quo only)',
  });
  const snap = await snapshot();
  console.log(`round ${snap.id} open: trading ends ${new Date(snap.tradingEnd * 1000).toISOString()}, evaluation ends ${new Date(snap.evaluationEnd * 1000).toISOString()}, TWAP ${snap.twapWindow}s`);
  return { snap, ...res };
}

// ---------------------------------------------------------------- the keeper's state machine

const OK_COLLAPSE = ['AlreadyCollapsed'];
const OK_TRADE = ['AlreadyProcessed'];
const OK_REPORT = ['AlreadyReported', 'NotCollapsed'];

/** Performs the next due action for the current round. Returns { action, wait? }. */
export async function nextStep({ keeper = accountFrom('KEEPER_PK') } = {}) {
  const book = loadBook();
  const A = abis();
  const s = await snapshot();
  if (!s || s.status === 3 || s.status === 4) return { action: 'idle', round: s?.id, status: s ? STATUS[s.status] : 'none' };

  if (s.status === 1) {
    if (s.now < s.tradingEnd) return { action: 'wait', wait: s.tradingEnd - s.now, why: `trading open for ${s.tradingEnd - s.now}s`, round: s.id };
    await sendContract({ account: keeper, address: book.c.QuantumRound, abi: A.QuantumRound, functionName: 'collapse', args: [s.id], label: `collapse round ${s.id}`, okErrors: OK_COLLAPSE });
    return { action: 'collapse', round: s.id };
  }

  // status 2: collapsed
  if (!s.vault.executed && !s.vault.cancelled) {
    if (s.now >= s.evaluationEnd) {
      await sendContract({ account: keeper, address: book.c.WavefundVault, abi: A.WavefundVault, functionName: 'cancelUnexecutedRound', args: [s.id], label: `cancelUnexecutedRound ${s.id}`, okErrors: OK_TRADE });
      return { action: 'cancel-unexecuted', round: s.id };
    }
    const [, bps] = await read(book.c.QuantumRound, A.QuantumRound, 'winningAllocation', [s.id]);
    await updateOracle({ account: keeper }); // the vault trade needs an oracle update from the last 5 minutes
    await sendContract({ account: keeper, address: book.c.WavefundVault, abi: A.WavefundVault, functionName: 'executeTrade', args: [s.id, BigInt(bps)], label: `vault executeTrade round ${s.id} -> ${bps} bps`, okErrors: OK_TRADE });
    return { action: 'execute-trade', round: s.id };
  }
  if (s.vault.executed && !s.vault.reported) {
    if (s.now < s.evaluationEnd) return { action: 'wait', wait: s.evaluationEnd - s.now, why: `evaluation ends in ${s.evaluationEnd - s.now}s`, round: s.id };
    await updateOracle({ account: keeper }); // reportReturn needs an oracle update at or after evaluationEnd
    await sendContract({ account: keeper, address: book.c.WavefundVault, abi: A.WavefundVault, functionName: 'reportReturn', args: [s.id], label: `reportReturn round ${s.id} (settles)`, okErrors: OK_REPORT });
    return { action: 'report-and-settle', round: s.id };
  }
  return { action: 'wait', wait: 3, why: 'waiting for the round to finish', round: s.id };
}

export async function reserveCoversMarkets() {
  const book = loadBook();
  const A = abis();
  const reserve = await read(book.c.QuantumRound, A.QuantumRound, 'protocolLiquiditySeed');
  const seed = await read(book.c.QuantumRound, A.QuantumRound, 'initialLiquidityPerProposal');
  return { ok: reserve >= MARKETS_NEEDED * seed, reserve, need: MARKETS_NEEDED * seed };
}

export { log, usdc, oraclePrice };
