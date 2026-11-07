// Chain reads for the forecasters, built on Multicall3 at its fixed address (the chain config is NOT assumed to carry it).
// Every function that must be atomic or fast is ONE multicall with batchSize: 0 (viem never splits it into several eth_calls).
// The client is injectable so tests can count calls and assert the exact parameters.
import { createPublicClient, http, parseAbi } from 'viem';
import { arc, decodeError, erc20Abi, RPC_URL } from '../../scripts/demo-round-common.mjs';
import { abis, loadBook } from './chain.mjs';
import { MULTICALL3 } from './config.mjs';

export const multicall3Abi = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256 timestamp)']);

/** Tight timeouts: the Guardian hot loop must never sit on a slow RPC. */
export function createForecastClients({ rpcUrl = RPC_URL } = {}) {
  return {
    fast: createPublicClient({ chain: arc, transport: http(rpcUrl, { timeout: 2_500, retryCount: 0 }) }),
    standard: createPublicClient({ chain: arc, transport: http(rpcUrl, { timeout: 6_000, retryCount: 1, retryDelay: 400 }) }),
  };
}

export const QUOTE_FN = { 'buy:long': 'quoteBuyLong', 'buy:short': 'quoteBuyShort', 'sell:long': 'quoteSellLong', 'sell:short': 'quoteSellShort' };

/** Adapter errors that mean "trading is over", not "something is broken". */
const CLOSED = /TradingClosed|TradingNotOpen/;
export function isTradingClosed(err) {
  if (!err) return false;
  const name = err.errorName ?? err.data?.errorName ?? err.cause?.data?.errorName ?? err.detail?.errorName;
  if (name && CLOSED.test(name)) return true;
  try {
    if (CLOSED.test(decodeError(err).text)) return true;
  } catch { /* not decodable: fall through to the message */ }
  return CLOSED.test(String(err.shortMessage ?? err.message ?? err));
}

export function createForecastReads({
  client, fastClient = client, book = loadBook(), A = abis(), multicallAddress = MULTICALL3,
} = {}) {
  const c = book.c;
  const tokenCache = new Map(); // `${round}:${proposal}` -> { credit, long, short }

  const mc = (cl, contracts, blockNumber) => cl.multicall({ contracts, allowFailure: true, multicallAddress, batchSize: 0, ...(blockNumber == null ? {} : { blockNumber }) });
  const ok = (r) => (r?.status === 'success' ? r.result : null);
  const qr = (functionName, args) => ({ address: c.QuantumRound, abi: A.QuantumRound, functionName, args });
  const market = (functionName, args) => ({ address: c.WaveV4ProposalMarket, abi: A.WaveV4ProposalMarket, functionName, args });
  const clock = () => ({ address: multicallAddress, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' });

  function parseRound(r) {
    if (!r) return null;
    return {
      tradingStart: Number(r[0]), tradingEnd: Number(r[1]), evaluationEnd: Number(r[2]), twapWindow: Number(r[3]),
      rMin: r[4], rMax: r[5], status: Number(r[6]), proposalCount: Number(r[7]), winnerId: Number(r[8]),
    };
  }

  return {
    multicallAddress,

    /** Current round id, its timings and the contract's EPSILON. Returns null while no round exists. */
    async roundContext() {
      const id = await client.readContract({ address: c.QuantumRound, abi: A.QuantumRound, functionName: 'currentRoundId' });
      if (id === 0n) return null;
      const [round, eps, ts] = await mc(client, [qr('rounds', [id]), qr('EPSILON', []), clock()]);
      const parsed = parseRound(ok(round));
      if (!parsed) throw new Error(`could not read round ${id}`);
      const now = Number(ok(ts) ?? 0);
      if (!Number.isSafeInteger(now) || now <= 0 || ok(eps) == null) throw new Error('round clock or EPSILON read unavailable');
      return { id, ...parsed, epsilon: ok(eps), now };
    },

    /**
     * THE Guardian prices call: ONE multicall with the chain clock, the current round id, the round header and, for every
     * proposal, spot probability, projected TWAP (probabilityTwap already extrapolates to tradingEnd) and allocation.
     */
    async guardianBatch(ctx) {
      const calls = [clock(), qr('currentRoundId', []), qr('rounds', [ctx.id])];
      for (let p = 0; p < ctx.proposalCount; p++) {
        calls.push(market('probabilities', [ctx.id, BigInt(p)]), market('probabilityTwap', [ctx.id, BigInt(p)]), qr('proposals', [ctx.id, BigInt(p)]));
      }
      const res = await mc(fastClient, calls);
      if (ok(res[0]) == null || ok(res[1]) == null || !parseRound(ok(res[2]))) throw new Error('Guardian round header or chain clock unavailable');
      const proposals = [];
      for (let p = 0; p < ctx.proposalCount; p++) {
        const prob = ok(res[3 + p * 3]);
        const twap = ok(res[4 + p * 3]);
        const info = ok(res[5 + p * 3]);
        proposals.push({ id: p, pLongX18: prob ? prob[0] : null, twapX18: twap ?? null, tEthBps: info ? Number(info[1]) : null });
      }
      return { now: Number(ok(res[0]) ?? 0), currentRoundId: ok(res[1]), round: parseRound(ok(res[2])), proposals, calls: 1 };
    },

    async tokensFor(roundId, count) {
      const need = [];
      for (let p = 0; p < count; p++) if (!tokenCache.has(`${roundId}:${p}`)) need.push(p);
      if (need.length) {
        const contracts = need.flatMap((p) => ['creditToken', 'longToken', 'shortToken'].map((fn) => ({ address: c.ProposalTokens, abi: A.ProposalTokens, functionName: fn, args: [roundId, BigInt(p)] })));
        const res = await mc(client, contracts);
        need.forEach((p, i) => {
          const [credit, long, short] = [0, 1, 2].map((k) => ok(res[i * 3 + k]));
          if (credit && long && short) tokenCache.set(`${roundId}:${p}`, { credit, long, short });
        });
      }
      return (p) => tokenCache.get(`${roundId}:${p}`) ?? null;
    },

    /** Quant view in one multicall: spot, allocation and this wallet's LONG/SHORT/credit balances for every proposal. */
    async quantView(ctx, address) {
      const tokens = await this.tokensFor(ctx.id, ctx.proposalCount);
      const calls = [clock()];
      const layout = [];
      for (let p = 0; p < ctx.proposalCount; p++) {
        const t = tokens(p);
        layout.push({ p, t, at: calls.length });
        calls.push(market('probabilities', [ctx.id, BigInt(p)]), qr('proposals', [ctx.id, BigInt(p)]));
        if (t) for (const tok of [t.long, t.short, t.credit]) calls.push({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      }
      const res = await mc(client, calls);
      const proposals = layout.map(({ p, t, at }) => {
        const prob = ok(res[at]);
        const info = ok(res[at + 1]);
        const bal = (k) => (t ? ok(res[at + 2 + k]) ?? 0n : 0n);
        return { id: p, pLongX18: prob ? prob[0] : null, tEthBps: info ? Number(info[1]) : null, position: { long: bal(0), short: bal(1), credits: bal(2) } };
      });
      return { now: Number(ok(res[0]) ?? 0), proposals };
    },

    /** Sizing batch for one market: spot pLong plus any number of adapter quote views, all in ONE multicall at one block. */
    batchFor(roundId, proposalId) {
      // A search combines cached finite differences: every refinement must see the same pool state.
      let block;
      return async ({ requests }) => {
        block ??= client.getBlockNumber({ cacheTime: 0 });
        const blockNumber = await block;
        const calls = [market('probabilities', [roundId, BigInt(proposalId)])];
        for (const r of requests) calls.push(market(QUOTE_FN[`${r.kind}:${r.side}`], [roundId, BigInt(proposalId), r.x]));
        const res = await mc(client, calls, blockNumber);
        const spot = ok(res[0]);
        if (!spot) throw new Error('market spot price unavailable');
        const results = requests.map((r, i) => {
          const item = res[i + 1];
          if (item?.status !== 'success') return { ok: false, error: item?.error };
          const v = item.result;
          return r.kind === 'buy' ? { ok: true, value: v } : { ok: true, value: { credits: v[0], longDust: v[1], shortDust: v[2] } };
        });
        return { pLongX18: spot[0], results };
      };
    },

    /** One fresh adapter quote (the number minOut is derived from). */
    async quote(roundId, proposalId, kind, side, x) {
      const out = await this.batchFor(roundId, proposalId)({ requests: [{ kind, side, x }] });
      const r = out.results[0];
      if (!r.ok) throw Object.assign(new Error(`quote failed: ${decodeError(r.error).text}`), { cause: r.error });
      return r.value;
    },

    /** What this wallet has in the round: deposit, credits claimed in this proposal, credit balance, USDC and allowance. */
    async haveState(roundId, proposalId, address) {
      const tokens = await this.tokensFor(roundId, proposalId + 1);
      const t = tokens(proposalId);
      if (!t) throw new Error(`proposal ${proposalId} token addresses unavailable`);
      const calls = [
        qr('deposits', [roundId, address]), qr('creditsClaimed', [roundId, BigInt(proposalId), address]),
        { address: c.USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
        { address: c.USDC, abi: erc20Abi, functionName: 'allowance', args: [address, c.QuantumRound] },
      ];
      if (t) for (const tok of [t.credit, t.long, t.short]) calls.push({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      const res = await mc(client, calls);
      const names = ['deposit', 'claimed credits', 'USDC balance', 'round allowance', 'credit balance', 'LONG balance', 'SHORT balance'];
      for (let i = 0; i < calls.length; i++) {
        if (res[i]?.status !== 'success' || typeof res[i].result !== 'bigint') throw new Error(`${names[i]} read unavailable for proposal ${proposalId}`);
      }
      const bal = (k) => res[4 + k].result;
      return {
        deposit: res[0].result, claimed: res[1].result, usdc: res[2].result, roundAllowance: res[3].result,
        credits: bal(0), position: { long: bal(1), short: bal(2) },
      };
    },

    /** Freshness gate before sending anything: same round, still Trading, chain clock before tradingEnd. */
    async roundFresh(roundId) {
      const [ts, cur, round] = await mc(client, [clock(), qr('currentRoundId', []), qr('rounds', [roundId])]);
      const r = parseRound(ok(round));
      const now = Number(ok(ts) ?? 0);
      if (ok(cur) == null || !Number.isSafeInteger(now) || now <= 0) return { ok: false, reason: 'chain clock or current round unavailable', now };
      if (!r) return { ok: false, reason: 'round unreadable', now };
      if (ok(cur) !== roundId) return { ok: false, reason: `round changed (now ${ok(cur)})`, now, closed: false };
      if (r.status !== 1) return { ok: false, reason: `round status is ${r.status}, not Trading`, now, closed: true };
      if (now >= r.tradingEnd) return { ok: false, reason: 'trading has ended', now, closed: true };
      return { ok: true, now, tradingEnd: r.tradingEnd };
    },

    /** Everything redeem needs to know about one round for one wallet. */
    async redeemInfo(roundId, address) {
      const [st, dep, red, prev] = await mc(client, [
        qr('roundStatus', [roundId]), qr('deposits', [roundId, address]), qr('redeemed', [roundId, address]), qr('previewRedeem', [roundId, address]),
      ]);
      return { status: Number(ok(st) ?? 0), deposit: ok(dep) ?? 0n, redeemed: ok(red) ?? false, preview: ok(prev) ?? 0n };
    },
  };
}
