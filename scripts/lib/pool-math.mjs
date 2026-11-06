// Uniswap v4 helpers for the vault's USDC/tETH pool (no hook, fee 3000, spacing 60): pool state through
// PoolManager.extsload, price <-> sqrtPrice <-> tick conversions, liquidity maths and an impact model.
import { encodeAbiParameters, keccak256, concat, toHex, getAddress } from 'viem';
import { abis, loadBook, publicClient, read } from '../demo-round-common.mjs';

export const Q96 = 2n ** 96n;
export const FEE = 3000;
export const SPACING = 60;

export const isqrt = (n) => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};

export function poolKey(book = loadBook()) {
  const usdc = getAddress(book.c.USDC);
  const teth = getAddress(book.c.TestAsset);
  const usdcIs0 = BigInt(usdc) < BigInt(teth);
  return {
    currency0: usdcIs0 ? usdc : teth,
    currency1: usdcIs0 ? teth : usdc,
    fee: FEE,
    tickSpacing: SPACING,
    hooks: '0x0000000000000000000000000000000000000000',
    usdcIs0,
  };
}

export function poolId(key) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const extsloadAbi = [
  { type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
];

/** Reads slot0 and in-range liquidity. sqrtPriceX96 = 0 means "not initialised". */
export async function readPool(book = loadBook()) {
  const key = poolKey(book);
  const base = BigInt(keccak256(concat([poolId(key), toHex(6n, { size: 32 })])));
  const slot = (n) => toHex(base + BigInt(n), { size: 32 });
  const [s0, liq] = await Promise.all([
    publicClient.readContract({ address: book.c.PoolManager, abi: extsloadAbi, functionName: 'extsload', args: [slot(0)] }),
    publicClient.readContract({ address: book.c.PoolManager, abi: extsloadAbi, functionName: 'extsload', args: [slot(3)] }),
  ]);
  const v = BigInt(s0);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 1 << 23) tick -= 1 << 24;
  return { key, sqrtPriceX96, tick, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
}

// ---------------------------------------------------------------- price conversions

/** Raw ratio token1/token0 as a (numerator, denominator) pair for an oracle answer (USD per ETH, 8 decimals). */
function ratioFrac(answer, usdcIs0) {
  // tETH is currency0: USDC_raw per tETH_raw = answer / 1e20.  USDC is currency0: 1e20 / answer.
  return usdcIs0 ? [10n ** 20n, answer] : [answer, 10n ** 20n];
}

export function sqrtPriceFromAnswer(answer, usdcIs0) {
  const [num, den] = ratioFrac(BigInt(answer), usdcIs0);
  return isqrt((num << 192n) / den);
}

/** USDC per 1 tETH (float) from a sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96, usdcIs0) {
  const r = Number(sqrtPriceX96) / Number(Q96);
  const ratio = r * r;
  return usdcIs0 ? 1e12 / ratio : ratio * 1e12;
}

/** The oracle answer (8 dec) equivalent of a USDC-per-tETH float. */
export const answerFromPrice = (p) => BigInt(Math.round(p * 1e8));

export function tickFromPrice(priceUsdcPerTeth, usdcIs0) {
  const ratio = usdcIs0 ? 1e12 / priceUsdcPerTeth : priceUsdcPerTeth / 1e12;
  return Math.log(ratio) / Math.log(1.0001);
}

export function sqrtAtTick(tick) {
  // Float based: relative error ~1e-15, ample for planning. Contract maths is exact and is checked by simulation.
  const s = Math.sqrt(Math.pow(1.0001, tick));
  return BigInt(Math.round(s * 2 ** 48)) * (Q96 / 2n ** 48n);
}

/** Tick range for [price*(1-down), price*(1+up)] in USDC-per-tETH terms, aligned outward to the spacing. */
export function rangeTicks(price, usdcIs0, down = 0.1, up = 0.2) {
  const a = tickFromPrice(price * (1 - down), usdcIs0);
  const b = tickFromPrice(price * (1 + up), usdcIs0);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { tickLower: Math.floor(lo / SPACING) * SPACING, tickUpper: Math.ceil(hi / SPACING) * SPACING };
}

// ---------------------------------------------------------------- liquidity maths (current price inside the range)

const mulDiv = (a, b, d) => (a * b) / d;

export function amountsForLiquidity(L, sqrtP, sqrtA, sqrtB) {
  const a1 = mulDiv(L, sqrtP - sqrtA, Q96);
  const a0 = mulDiv(mulDiv(L, Q96, sqrtP) * (sqrtB - sqrtP), 1n, sqrtB);
  return { amount0: a0, amount1: a1 };
}

export function liquidityForAmount0(amount0, sqrtP, sqrtB) {
  return mulDiv(amount0, mulDiv(sqrtP, sqrtB, Q96), sqrtB - sqrtP);
}

export function liquidityForAmount1(amount1, sqrtP, sqrtA) {
  return mulDiv(amount1, Q96, sqrtP - sqrtA);
}

/** Largest liquidity whose USDC leg does not exceed `usdcBudget` (raw), for a position over [tickLower, tickUpper]. */
export function liquidityForUsdc(usdcBudget, usdcIs0, sqrtP, tickLower, tickUpper) {
  const sA = sqrtAtTick(tickLower);
  const sB = sqrtAtTick(tickUpper);
  return usdcIs0 ? liquidityForAmount0(usdcBudget, sqrtP, sB) : liquidityForAmount1(usdcBudget, sqrtP, sA);
}

export function legsForLiquidity(L, usdcIs0, sqrtP, tickLower, tickUpper) {
  const { amount0, amount1 } = amountsForLiquidity(L, sqrtP, sqrtAtTick(tickLower), sqrtAtTick(tickUpper));
  return usdcIs0 ? { usdc: amount0, teth: amount1 } : { usdc: amount1, teth: amount0 };
}

// ---------------------------------------------------------------- impact model (single in-range position)

/**
 * Spot price change (fraction) for a trade worth `usdcAmount` (raw USDC) in one direction, fee included.
 * Returns Infinity when the trade would leave the in-range liquidity.
 */
export function impactFor(pool, usdcAmount, buyTeth, price, range) {
  const L = pool.liquidity;
  if (L === 0n) return Infinity;
  const sqrtP = pool.sqrtPriceX96;
  const usdcIs0 = pool.key.usdcIs0;
  const feeAdj = (x) => (x * BigInt(1_000_000 - FEE)) / 1_000_000n;
  const tethAmount = BigInt(Math.round((Number(usdcAmount) / price) * 1e12)); // 6-dec USDC -> 18-dec tETH
  // Which token goes in: buying tETH spends USDC; selling tETH spends tETH.
  const inIsToken0 = buyTeth ? usdcIs0 : !usdcIs0;
  const dIn = feeAdj(buyTeth ? usdcAmount : tethAmount);
  let next;
  if (inIsToken0) next = (L * Q96 * sqrtP) / (L * Q96 + dIn * sqrtP);
  else next = sqrtP + (dIn * Q96) / L;
  if (range) {
    const lo = sqrtAtTick(range.tickLower);
    const hi = sqrtAtTick(range.tickUpper);
    if (next <= lo || next >= hi) return Infinity;
  }
  const after = priceFromSqrt(next, usdcIs0);
  return Math.abs(after / price - 1);
}

export async function helperAddress(book = loadBook()) {
  if (!book.c.WavefundPoolHelper) throw new Error('WavefundPoolHelper is not in the address book. Run DeployPoolHelper.');
  return book.c.WavefundPoolHelper;
}

export async function oraclePrice(book = loadBook()) {
  const [answer, updatedAt] = await read(book.c.MockPriceOracle, abis().MockPriceOracle, 'latestPrice');
  return { answer, updatedAt: Number(updatedAt), price: Number(answer) / 1e8 };
}
