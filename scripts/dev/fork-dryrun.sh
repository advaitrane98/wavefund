#!/usr/bin/env bash
# Full rehearsal on a local anvil fork of Arc Testnet. Nothing is broadcast to the real network.
#   bash scripts/dev/fork-dryrun.sh            # deploy + wire + fund + pool + checks + smoke test
# Uses anvil's well-known dev keys (public, worthless) and a throwaway set of test wallets.
# Anvil cannot run Arc's USDC ERC-20 transfers (blocklist precompile), so the fork swaps in a plain 6-decimal ERC-20
# at the USDC address; this is the only difference from the real chain that matters to these scripts.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
export DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
export ARC_TESTNET_RPC=http://127.0.0.1:8545
export BOOK_FILE=deployments/fork-current.json
export DEPLOYMENTS_FILE=$ROOT/contracts/$BOOK_FILE
export POSITION_FILE=$ROOT/contracts/deployments/fork-pool-position.json
export FORGE_OUT=${FORGE_OUT:-$ROOT/contracts/out}
export INITIAL_ETH_USD_E8=$(node -e "fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot').then(r=>r.json()).then(j=>console.log(Math.round(Number(j.data.amount)*1e8)))")
LOG=${LOG_DIR:-/tmp/dryrun}; mkdir -p "$LOG"
rm -f "$DEPLOYMENTS_FILE" "$POSITION_FILE"

echo "== start anvil fork"
if [ "${ANVIL_EXTERNAL:-0}" != "1" ]; then
  setsid anvil --fork-url "${FORK_SOURCE:-https://rpc.testnet.arc.io}" --port 8545 --block-time 1 --balance 10000 > "$LOG/anvil.log" 2>&1 &
  ANVIL=$!
  if [ "${KEEP_FORK:-0}" != "1" ]; then trap 'kill $ANVIL 2>/dev/null || true' EXIT; fi
fi
for i in $(seq 1 60); do cast chain-id --rpc-url "$ARC_TESTNET_RPC" >/dev/null 2>&1 && break; sleep 1; done

echo "== forge scripts (no USDC moved)"
for s in Deploy DeployWaveHook DeployPoolHelper Wire; do
  echo "-- $s"
  node scripts/forge-run.mjs $s --broadcast 2>&1 | grep -E "Error|Estimated|COMPLETE|revert|check:|base fee" || true
done

echo "== fork-only USDC stand-in and test wallets"
node scripts/export-abis.mjs
KEYS=$(node -e "import('viem/accounts').then(m=>console.log(Array.from({length:5},()=>m.generatePrivateKey()).join(',')))")
ADDRS=$(node -e "import('viem/accounts').then(m=>console.log(process.argv[1].split(',').map(k=>m.privateKeyToAccount(k).address).join(' ')))" "$KEYS")
export TEST_WALLET_PKS=$KEYS
node scripts/dev-fork-usdc.mjs 1000 $DEPLOYER $KEEPER > "$LOG/mint.log"
node scripts/dev-fork-usdc.mjs 0 $ADDRS > /dev/null

echo "== operator scripts"
node scripts/oracle-update.mjs | tail -1
node scripts/fund-protocol.mjs --yes --amount 30 | tail -1
node scripts/fund-vault.mjs --yes --amount 5 | tail -1
node scripts/pool-recenter.mjs --yes --max-new-usdc 11 | tail -9
node scripts/check-contracts.mjs | tail -3
node scripts/demo-preflight.mjs | tail -3
echo "$TEST_WALLET_PKS" > "$LOG/test-wallet-keys"
if [ "${SKIP_SMOKE:-0}" = "1" ]; then echo "== smoke test skipped"; exit 0; fi
echo "== smoke test"
echo "$TEST_WALLET_PKS" > "$LOG/test-wallet-keys"
node scripts/smoke-round.mjs --yes | tee "$LOG/smoke.log" | grep -E "PASS|FAIL|checks passed|unaccounted|Error"
