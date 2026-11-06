// Accounting reconciliation: every USDC in QuantumRound and the vault must be explained by the contracts' books.
import { abis, erc20Abi, loadBook, read, usdc } from '../demo-round-common.mjs';

/** `holders` are addresses whose pendingPayout / claimableUsdc should be counted (test wallets, deployer). */
export async function reconcile(holders = []) {
  const book = loadBook();
  const A = abis();
  const QR = book.c.QuantumRound;
  const V = book.c.WavefundVault;
  const reserve = await read(QR, A.QuantumRound, 'protocolLiquiditySeed');
  const last = await read(QR, A.QuantumRound, 'currentRoundId');
  let expected = reserve;
  const lines = [`reserve ${usdc(reserve)}`];
  for (let id = 1n; id <= last; id++) {
    const r = await read(QR, A.QuantumRound, 'rounds', [id]);
    const status = r[6];
    const released = r[9];
    let held = 0n;
    if (status === 1) {
      held = r[12]; // deposits
      for (let p = 0; p < r[7]; p++) held += (await read(QR, A.QuantumRound, 'proposals', [id, BigInt(p)]))[3];
    } else if ((status === 2 || status === 3 || status === 4) && !released) {
      held = r[14] - r[15]; // escrow - paid
    }
    if (held) lines.push(`round ${id} holds ${usdc(held)}`);
    expected += held;
  }
  let pending = 0n;
  for (const h of holders) pending += await read(QR, A.QuantumRound, 'pendingPayout', [h]);
  if (pending) lines.push(`pending payouts ${usdc(pending)}`);
  expected += pending;
  const qrBalance = await read(book.c.USDC, erc20Abi, 'balanceOf', [QR]);

  const vaultUsdc = await read(V, A.WavefundVault, 'totalVaultUsdc');
  const queued = await read(V, A.WavefundVault, 'queuedDepositsUsdc');
  const claimable = await read(V, A.WavefundVault, 'claimableUsdcTotal');
  const vaultTEth = await read(V, A.WavefundVault, 'totalVaultTEth');
  const vaultBalance = await read(book.c.USDC, erc20Abi, 'balanceOf', [V]);
  const vaultTEthBalance = await read(book.c.TestAsset, erc20Abi, 'balanceOf', [V]);
  return {
    quantumRound: { balance: qrBalance, expected, unaccounted: qrBalance - expected, lines },
    vault: {
      usdcBalance: vaultBalance,
      usdcExpected: vaultUsdc + queued + claimable,
      usdcUnaccounted: vaultBalance - (vaultUsdc + queued + claimable),
      tEthUnaccounted: vaultTEthBalance - vaultTEth,
    },
  };
}

export function printReconcile(rec) {
  console.log(`QuantumRound USDC ${usdc(rec.quantumRound.balance)} vs books ${usdc(rec.quantumRound.expected)} -> unaccounted ${usdc(rec.quantumRound.unaccounted)}  (${rec.quantumRound.lines.join('; ')})`);
  console.log(`Vault USDC unaccounted ${usdc(rec.vault.usdcUnaccounted)}, tETH unaccounted ${rec.vault.tEthUnaccounted}`);
  return rec.quantumRound.unaccounted === 0n && rec.vault.usdcUnaccounted === 0n && rec.vault.tEthUnaccounted === 0n;
}
