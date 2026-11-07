// Runs one contract call for one agent under the spending caps.
//   dry-run (default): simulate, estimate gas, check the caps, log the plan. Nothing is sent, nothing is reserved.
//   execute: reserve the gas estimate, send through the signer, replace the reservation with actual gas on
//            confirmation, release it if the transaction never reaches the chain.
import { formatUnits } from 'viem';
import { decodeError, gasPolicy, publicClient, txUrl } from '../../scripts/demo-round-common.mjs';
import { CapError } from './ledger.mjs';

export const DRY_RUN_FALLBACK_GAS = 300_000n;
const GAS_MARGIN_NUM = 12n; // +20% on the estimate
const GAS_MARGIN_DEN = 10n;
const usd = (wei) => formatUnits(wei, 18);

export class StepFailed extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StepFailed';
    this.detail = detail;
  }
}

export function createExecutor({ agent, signer, ledger, logger, execute = false, estimator = publicClient, gasFees = gasPolicy, getReceipt }) {
  const receiptOf = getReceipt ?? ((hash) => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }));
  let plannedWei = 0n; // dry-run bookkeeping so a multi-step plan is checked against the caps cumulatively

  async function estimate(step) {
    let gas;
    let simulated = true;
    let simulationError;
    try {
      gas = await estimator.estimateContractGas({ account: signer.address, address: step.to, abi: step.abi, functionName: step.functionName, args: step.args });
    } catch (err) {
      simulated = false;
      simulationError = decodeError(err).text;
      if (execute) throw new StepFailed(`${step.label}: would revert (${simulationError}); not sent`, { simulationError, errorName: decodeError(err).name });
      gas = DRY_RUN_FALLBACK_GAS;
    }
    const fees = await gasFees();
    let wei = (gas * fees.maxFeePerGas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN;
    const fee = await signer.estimateFee({ to: step.to, abi: step.abi, functionName: step.functionName, args: step.args });
    if (fee.networkFeeWei && fee.networkFeeWei > wei) wei = fee.networkFeeWei;
    return { gas, wei, simulated, simulationError, feeAttempts: fee.attempts };
  }

  async function run(step, { roundId }) {
    if (execute && ledger.pendingGas(agent.key).length) throw new StepFailed('wallet has an unresolved transaction; reconcile it before sending another', { ambiguous: true });
    const est = await estimate(step);
    const base = { step: step.label, to: step.to, fn: step.functionName, roundId: String(roundId), gas: est.gas.toString(), estimateUsdc: usd(est.wei) };
    if (!execute) {
      ledger.assertFits(agent.key, roundId, est.wei + plannedWei);
      plannedWei += est.wei;
      logger.tx(agent.key, {
        ...base, status: 'planned (dry-run, nothing sent)', simulated: est.simulated,
        ...(est.simulationError ? { simulationNote: `expected before earlier steps or funding: ${est.simulationError}` } : {}),
      });
      return { dryRun: true, wei: est.wei, simulated: est.simulated, simulationError: est.simulationError };
    }

    const reservation = ledger.reserve({ agent: agent.key, roundId, estimateWei: est.wei, label: step.label });
    logger.tx(agent.key, { ...base, status: 'reserved', reservation });
    let sent;
    try {
      sent = await signer.execute({ to: step.to, abi: step.abi, functionName: step.functionName, args: step.args, label: `${agent.key}:${step.label}` });
    } catch (err) {
      if (err.txHash) ledger.broadcast(reservation, err.txHash);
      const ambiguous = Boolean(err.maybeBroadcast || err.txHash);
      if (ambiguous) {
        ledger.markGasAmbiguous(reservation);
        logger.tx(agent.key, { ...base, status: 'unknown (kept reserved, recovered on next start)', error: err.message });
      } else {
        ledger.release(reservation, err.message);
        logger.tx(agent.key, { ...base, status: 'released (never broadcast)', error: err.message });
      }
      // `ambiguous`: the transaction may be on chain. Callers keep any budget they reserved for it (no duplicate spend).
      throw new StepFailed(`${step.label}: ${err.message}`, { cause: err.message, ambiguous, hash: err.txHash });
    }
    ledger.broadcast(reservation, sent.hash);
    logger.tx(agent.key, { ...base, status: 'broadcast', hash: sent.hash, url: txUrl(sent.hash) });
    let receipt;
    try {
      receipt = await receiptOf(sent.hash);
    } catch (err) {
      // Broadcast but no receipt yet: the gas stays reserved and any trade budget must stay counted.
      logger.tx(agent.key, { ...base, status: 'unknown (broadcast, no receipt yet)', hash: sent.hash, error: err.message });
      throw new StepFailed(`${step.label}: no receipt (${err.message})`, { cause: err.message, ambiguous: true, hash: sent.hash });
    }
    const actual = receipt.gasUsed * receipt.effectiveGasPrice;
    ledger.commit(reservation, actual);
    logger.tx(agent.key, { ...base, status: receipt.status === 'success' ? 'confirmed' : 'reverted', hash: sent.hash, actualUsdc: usd(actual) });
    if (receipt.status !== 'success') throw new StepFailed(`${step.label} reverted on chain (${txUrl(sent.hash)})`, { hash: sent.hash, reverted: true });
    return { hash: sent.hash, wei: actual };
  }

  return { run, mode: execute ? 'execute' : 'dry-run', CapError };
}
