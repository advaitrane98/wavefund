"use client";

import { explorerAddressUrl } from "@/lib/chain";
import { deployment } from "@/lib/contracts";
import { useChainNow, useLiveData } from "@/lib/live/LiveDataProvider";
import { usdc, wave, teth, formatBps } from "@/lib/units";
import { Card, Eyebrow } from "../ui";
import { AllocationDonut } from "../vault/AllocationDonut";
import { PriceCompare } from "../vault/PriceCompare";
import { WalletPrompt } from "./LiveGate";
import { LiveHistory } from "./LiveHistory";
import { LiveQueue } from "./LiveQueue";

const ORACLE_STALE_SECONDS = 5 * 60;

export function LiveVault() {
  const { snapshot, history } = useLiveData();
  const now = useChainNow();
  if (!snapshot) return null;
  const v = snapshot.vault;

  const tethValueRaw = (v.totalVaultTEth * v.oraclePriceUsdc) / 10n ** 18n;
  const oracle = Number(v.oraclePriceUsdc) / 1e6;
  const pool = Number(v.poolPriceUsdc) / 1e6;
  const gap = oracle > 0 && pool > 0 ? Math.abs(pool - oracle) / oracle : 0;
  const oracleAge = v.oracleUpdatedAt === null ? null : now - v.oracleUpdatedAt;
  const userValue = (v.user.wave * v.sharePriceUsdc) / 10n ** 18n;
  const vaultAddress = deployment.addresses.vault;

  return (
    <div className="space-y-6">
      <WalletPrompt text="Connect your wallet on Arc testnet to queue vault deposits and withdrawals." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Eyebrow tone="green">Net asset value</Eyebrow>
          <p className="num mt-3 text-4xl">{usdc.format(v.navUsdc)}</p>
          <p className="num text-sm text-muted">USDC</p>
          <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-border pt-4">
            <div className="min-w-0">
              <dt className="eyebrow">Share price</dt>
              <dd className="num mt-1 truncate text-sm">{usdc.format(v.sharePriceUsdc, 4)} USDC</dd>
            </div>
            <div className="min-w-0">
              <dt className="eyebrow">Total WAVE</dt>
              <dd className="num mt-1 truncate text-sm">{wave.format(v.totalSupply, 2)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="eyebrow">Your WAVE</dt>
              <dd className="num mt-1 truncate text-sm text-violet">{wave.format(v.user.wave)}</dd>
              <p className="num text-xs text-faint">{usdc.format(userValue)} USDC</p>
            </div>
          </dl>
          {vaultAddress ? (
            <a
              href={explorerAddressUrl(vaultAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="eyebrow mt-4 inline-block hover:text-text"
            >
              Vault on Arc Explorer
            </a>
          ) : null}
        </Card>

        <Card>
          <Eyebrow>Allocation</Eyebrow>
          <div className="mt-4">
            <AllocationDonut tethValue={Number(tethValueRaw) / 1e6} usdcValue={Number(v.totalVaultUsdc) / 1e6} />
          </div>
          <p className="num mt-4 border-t border-border pt-4 text-xs text-muted">
            {teth.format(v.totalVaultTEth)} tETH and {usdc.format(v.totalVaultUsdc)} USDC. tETH share{" "}
            {formatBps(v.tEthBps)}.
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Eyebrow>Oracle vs pool price</Eyebrow>
          <div className="mt-4">
            <PriceCompare oracle={oracle} pool={pool} />
          </div>
          {gap > 0.02 ? (
            <p className="mt-4 rounded-xl bg-amber-soft p-3 text-xs text-amber" role="status">
              The pool price differs from the oracle by {(gap * 100).toFixed(1)}%. A vault trade that is more
              than 5% worse than the oracle is rolled back and the round is cancelled.
            </p>
          ) : null}
          {oracleAge !== null && oracleAge > ORACLE_STALE_SECONDS ? (
            <p className="mt-3 text-xs text-muted">
              The oracle last updated {Math.floor(oracleAge / 60)} minutes ago. The vault needs an update from
              the last 5 minutes to trade.
            </p>
          ) : null}
        </Card>

        <Card>
          <Eyebrow tone="violet">Queued deposits and withdrawals</Eyebrow>
          <p className="num mt-2 text-xs text-muted">
            Vault-wide: {usdc.format(v.queuedDepositsUsdc)} USDC in, {wave.format(v.queuedWithdrawShares)} WAVE
            out.
          </p>
          <div className="mt-4">
            <LiveQueue />
          </div>
        </Card>
      </div>

      <Card>
        <Eyebrow tone="amber">Decision history</Eyebrow>
        <div className="mt-2">
          <LiveHistory rows={history} />
        </div>
      </Card>
    </div>
  );
}
