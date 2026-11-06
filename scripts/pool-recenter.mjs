// npm run pool:recenter [-- --max-new-usdc 1 | --remove | --measure | --yes]
// Removes the helper's position, aligns the (empty) pool to the oracle, re-adds liquidity at -10% / +20% around the
// oracle price using the recovered USDC plus at most --max-new-usdc fresh USDC. Every transaction is simulated by
// sendContract before it is broadcast. Persists contracts/deployments/pool-position.json.
import fs from 'node:fs';
import { maxUint256, parseUnits } from 'viem';
import {
  POSITION_FILE, abis, accountFrom, addressUrl, cliArgs, confirm, erc20Abi, loadBook, log, nativeBalance, publicClient,
  read, sendContract, usdc, tokens18, walletFor,
} from './demo-round-common.mjs';
import {
  helperAddress, impactFor, legsForLiquidity, liquidityForUsdc, oraclePrice, priceFromSqrt, rangeTicks, readPool,
  sqrtPriceFromAnswer,
} from './lib/pool-math.mjs';

const GAS_RESERVE = parseUnits('0.3', 18); // native USDC kept for gas (18-decimal view)
const TARGET_IMPACT = 0.02;

export function loadPosition() {
  return fs.existsSync(POSITION_FILE) ? JSON.parse(fs.readFileSync(POSITION_FILE, 'utf8')) : null;
}

export async function measureTable(pool, price, range) {
  const rows = [];
  for (const amount of [0.5, 1, 2]) {
    const raw = BigInt(Math.round(amount * 1e6));
    rows.push({
      usdc: amount,
      buyTethImpactPct: impactFor(pool, raw, true, price, range) * 100,
      sellTethImpactPct: impactFor(pool, raw, false, price, range) * 100,
    });
  }
  return rows;
}

export function printMeasure(rows, header) {
  console.log(`\n${header}`);
  console.log('  trade      buy tETH    sell tETH');
  for (const r of rows) {
    const f = (x) => (Number.isFinite(x) ? `${x.toFixed(3)}%`.padStart(9) : 'beyond range');
    console.log(`  ${String(r.usdc).padEnd(4)} USDC  ${f(r.buyTethImpactPct)}  ${f(r.sellTethImpactPct)}`);
  }
  const two = rows.find((r) => r.usdc === 2);
  const ok = Math.max(two.buyTethImpactPct, two.sellTethImpactPct) <= TARGET_IMPACT * 100;
  console.log(`  target: a 2 USDC trade moves spot <= ${TARGET_IMPACT * 100}%  ->  ${ok ? 'MET' : 'NOT MET'}`);
  return ok;
}

export async function main(argv) {
  const args = cliArgs(
    {
      'max-new-usdc': { type: 'string', default: '1' },
      remove: { type: 'boolean', default: false },
      measure: { type: 'boolean', default: false },
    },
    argv,
  );
  const book = loadBook();
  const deployer = accountFrom('DEPLOYER_PK');
  const helper = await helperAddress(book);
  const A = abis();
  let pool = await readPool(book);
  const { usdcIs0 } = pool.key;
  const oracle = await oraclePrice(book);
  const position = loadPosition();

  const spot = pool.sqrtPriceX96 === 0n ? null : priceFromSqrt(pool.sqrtPriceX96, usdcIs0);
  console.log(`oracle $${oracle.price}  pool spot ${spot ? `$${spot.toFixed(4)}` : 'not initialised'}  in-range liquidity ${pool.liquidity}`);
  if (position?.liquidity && position.liquidity !== '0') {
    console.log(`recorded position: ticks ${position.tickLower}..${position.tickUpper}, liquidity ${position.liquidity}`);
  }

  if (args.measure) {
    if (!spot) throw new Error('pool is not initialised');
    printMeasure(await measureTable(pool, spot, position ?? undefined), 'Impact of trades on the current pool (model, fee included):');
    return;
  }

  const maxNew = parseUnits(args['max-new-usdc'], 6);
  const usdcBal = await read(book.c.USDC, erc20Abi, 'balanceOf', [deployer.address]);
  console.log(`deployer USDC ${usdc(usdcBal)}  (native gas view ${Number(await nativeBalance(deployer.address)) / 1e18})`);
  console.log(
    args.remove
      ? 'plan: remove the recorded position (no re-add)'
      : `plan: [init if needed] -> remove old position -> align to oracle -> add -10%/+20% with recovered USDC + up to ${usdc(maxNew)} new USDC`,
  );
  await confirm('This will send transactions from the deployer wallet.', { yes: args.yes, word: 'recenter' });

  // approvals (helper pulls from the deployer)
  for (const token of [book.c.USDC, book.c.TestAsset]) {
    const allowance = await read(token, erc20Abi, 'allowance', [deployer.address, helper]);
    if (allowance < 2n ** 200n) {
      await sendContract({ account: deployer, address: token, abi: erc20Abi, functionName: 'approve', args: [helper, maxUint256], label: 'approve helper' });
    }
  }

  const sqrtTarget = sqrtPriceFromAnswer(oracle.answer, usdcIs0);
  if (pool.sqrtPriceX96 === 0n) {
    await sendContract({ account: deployer, address: helper, abi: A.WavefundPoolHelper, functionName: 'initializePool', args: [sqrtTarget], label: 'initialize pool at oracle' });
    pool = await readPool(book);
  }

  // 1. remove the old position
  let recovered = 0n;
  const before = await read(book.c.USDC, erc20Abi, 'balanceOf', [deployer.address]);
  if (position?.liquidity && position.liquidity !== '0') {
    await sendContract({
      account: deployer, address: helper, abi: A.WavefundPoolHelper, functionName: 'modifyLiquidity',
      args: [position.tickLower, position.tickUpper, -BigInt(position.liquidity)], label: 'remove position',
    });
    recovered = (await read(book.c.USDC, erc20Abi, 'balanceOf', [deployer.address])) - before;
    console.log(`  recovered ${usdc(recovered)} USDC`);
    fs.writeFileSync(POSITION_FILE, JSON.stringify({ ...position, liquidity: '0', removedAt: new Date().toISOString() }, null, 2));
  }
  if (args.remove) return;

  // 2. align the pool to the oracle (free when the pool has no other liquidity)
  pool = await readPool(book);
  const drift = Math.abs(priceFromSqrt(pool.sqrtPriceX96, usdcIs0) / oracle.price - 1);
  if (drift > 0.0005) {
    const zeroForOne = sqrtTarget < pool.sqrtPriceX96;
    await sendContract({
      account: deployer, address: helper, abi: A.WavefundPoolHelper, functionName: 'swap',
      args: [zeroForOne, -1n, sqrtTarget], label: `align pool (${(drift * 100).toFixed(2)}% off)`,
    });
    pool = await readPool(book);
  }

  // 3. add liquidity at -10% / +20% around the oracle price
  const { tickLower, tickUpper } = rangeTicks(oracle.price, usdcIs0);
  const walletUsdc = await read(book.c.USDC, erc20Abi, 'balanceOf', [deployer.address]);
  const budget = (recovered + maxNew) * 998n / 1000n;
  const usable = walletUsdc > budget ? budget : walletUsdc - GAS_RESERVE / 10n ** 12n;
  if (usable <= 0n) throw new Error('not enough USDC in the deployer wallet for liquidity');
  const L = liquidityForUsdc(usable, usdcIs0, pool.sqrtPriceX96, tickLower, tickUpper);
  const legs = legsForLiquidity(L, usdcIs0, pool.sqrtPriceX96, tickLower, tickUpper);
  console.log(`  adding L=${L} over ticks ${tickLower}..${tickUpper}: ~${usdc(legs.usdc)} USDC + ~${tokens18(legs.teth)} tETH`);

  const tethHave = await read(book.c.TestAsset, erc20Abi, 'balanceOf', [deployer.address]);
  const tethNeed = (legs.teth * 102n) / 100n + 1000n;
  if (tethHave < tethNeed) {
    await sendContract({ account: deployer, address: book.c.TestAsset, abi: A.TestAsset, functionName: 'mint', args: [deployer.address, tethNeed - tethHave], label: 'mint tETH' });
  }
  const added = await sendContract({
    account: deployer, address: helper, abi: A.WavefundPoolHelper, functionName: 'modifyLiquidity',
    args: [tickLower, tickUpper, L], label: 'add position',
  });
  pool = await readPool(book);
  const record = {
    helper, tickLower, tickUpper, liquidity: L.toString(), oracleAnswer: oracle.answer.toString(),
    sqrtPriceX96: pool.sqrtPriceX96.toString(), addTx: added.hash, updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(POSITION_FILE, JSON.stringify(record, null, 2));
  console.log(`  saved ${POSITION_FILE.replace(process.cwd() + '/', '')}`);
  printMeasure(await measureTable(pool, priceFromSqrt(pool.sqrtPriceX96, usdcIs0), record), 'Impact after recentering:');
  console.log(`helper: ${addressUrl(helper)}`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  });
}
