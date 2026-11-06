// MockPriceOracle helpers: Coinbase ETH/USD spot -> oracle (8 decimals), and the 60 s watcher that only runs
// while a round is open (Trading or Collapsed, i.e. not yet settled or cancelled).
import { abis, accountFrom, loadBook, log, publicClient, read, sendContract, sleep, usdc } from '../demo-round-common.mjs';
import { fetchSpot } from './risk-model.mjs';

export async function updateOracle({ account = accountFrom('KEEPER_PK'), price } = {}) {
  const book = loadBook();
  const spot = price ?? (await fetchSpot());
  const answer = BigInt(Math.round(spot * 1e8));
  const res = await sendContract({
    account,
    address: book.c.MockPriceOracle,
    abi: abis().MockPriceOracle,
    functionName: 'updatePrice',
    args: [answer],
    label: `oracle.updatePrice(${spot})`,
  });
  return { spot, answer, ...res };
}

export async function oracleState() {
  const book = loadBook();
  const [answer, updatedAt] = await read(book.c.MockPriceOracle, abis().MockPriceOracle, 'latestPrice');
  const block = await publicClient.getBlock();
  return { answer, updatedAt: Number(updatedAt), age: Number(block.timestamp) - Number(updatedAt), usd: Number(answer) / 1e8 };
}

/** A round is open from openRound until it is settled or cancelled. Status: 1 Trading, 2 Collapsed. */
export async function roundIsOpen() {
  const book = loadBook();
  const id = await read(book.c.QuantumRound, abis().QuantumRound, 'currentRoundId');
  if (id === 0n) return false;
  const status = await read(book.c.QuantumRound, abis().QuantumRound, 'roundStatus', [id]);
  return status === 1 || status === 2;
}

/** Updates every `everyMs` while a round is open. Returns a stop function. */
export function startOracleWatcher({ everyMs = 60_000, account = accountFrom('KEEPER_PK') } = {}) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (await roundIsOpen()) {
          const r = await updateOracle({ account });
          log(`oracle updated to $${r.spot}`);
        }
      } catch (err) {
        log(`oracle watcher: ${err.message}`);
      }
      for (let waited = 0; waited < everyMs && !stopped; waited += 1000) await sleep(1000);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

export { usdc };
