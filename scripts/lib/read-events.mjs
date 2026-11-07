// Read a complete fixed-block event range. Shrink provider-limited ranges, then fail explicitly at the minimum.
export class EventReadError extends Error {
  constructor(from, to, cause) {
    super(`event read failed for blocks ${from}..${to}: ${cause.message}`, { cause });
    this.name = 'EventReadError';
  }
}

export async function readEvents({ client, address, abi, fromBlock, toBlock, initialStep = 50_000n, minStep = 1000n }) {
  if (initialStep <= 0n || minStep <= 0n) throw new Error('event read steps must be positive');
  let from = fromBlock;
  let step = initialStep < minStep ? minStep : initialStep;
  const logs = [];
  while (from <= toBlock) {
    const end = from + step - 1n < toBlock ? from + step - 1n : toBlock;
    try {
      logs.push(...await client.getContractEvents({ address, abi, fromBlock: from, toBlock: end }));
      from = end + 1n;
    } catch (err) {
      if (step <= minStep) throw new EventReadError(from, end, err);
      step = step / 4n > minStep ? step / 4n : minStep;
    }
  }
  return logs;
}
