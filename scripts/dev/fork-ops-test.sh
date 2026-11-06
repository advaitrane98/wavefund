#!/usr/bin/env bash
# Exercises the operator scripts on a fork prepared by fork-dryrun.sh (run it with SKIP_SMOKE=1 and ANVIL_EXTERNAL=1 first).
#   keeper:run + demo:open-round + demo:manipulate + round-report + oracle watcher + write:sources + verify dry-run
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
export DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export ARC_TESTNET_RPC=http://127.0.0.1:8545
export DEPLOYMENTS_FILE=$ROOT/contracts/deployments/fork-current.json
export POSITION_FILE=$ROOT/contracts/deployments/fork-pool-position.json
export TEST_WALLET_PKS=$(cat ${LOG_DIR:-/tmp/dryrun}/test-wallet-keys)
LOG=${LOG_DIR:-/tmp/dryrun}
n() { node --env-file-if-exists=.env "$@"; }

# test wallets need USDC for the manipulation (agents are not used: status-quo-only round)
W3=$(node -e "import('viem/accounts').then(m=>console.log(m.privateKeyToAccount(process.argv[1].split(',')[3]).address))" "$TEST_WALLET_PKS")
FORGE_OUT=${FORGE_OUT:-/tmp/fastout} node scripts/dev-fork-usdc.mjs 10 $W3 | tail -1
n scripts/pool-recenter.mjs --yes --max-new-usdc 1 | tail -2

echo "== oracle watcher start/stop"
n scripts/oracle-start.mjs; sleep 2; n scripts/oracle-stop.mjs

echo "== open a judge-style round (short timings)"
n scripts/demo-open-round.mjs --preset judge --trading-minutes 1.5 --twap-seconds 40 --evaluation-seconds 40 --yes | grep -E "risk model|round .* open|FAIL|Error"

echo "== keeper (background) + manipulation"
n scripts/keeper-run.mjs --poll 2 > "$LOG/keeper.log" 2>&1 &
KP=$!
sleep 3
echo "second keeper must be refused:"; n scripts/keeper-run.mjs 2>&1 | head -2
n scripts/demo-manipulate.mjs --proposal 0 --side short --credits 1 --at-seconds-before-end 20 --wallet 3 --yes 2>&1 | grep -E "latency|landed|Error|failed"
for i in $(seq 1 120); do grep -q "idle (round .* Settled)" "$LOG/keeper.log" && break; sleep 3; done
kill -INT $KP; wait $KP; echo "keeper exit code after Ctrl+C: $?"
grep -E "done:|STOP|stopped|idle" "$LOG/keeper.log" | cut -c1-120

echo "== round report"
n scripts/round-report.mjs --round 1 | sed -n '1,40p' | cut -c1-170

echo "== write:sources and verify dry-run"
SOURCES_FILE=/tmp/fork-SOURCES.md n scripts/write-sources.mjs; head -20 /tmp/fork-SOURCES.md | cut -c1-200
n scripts/verify-contracts.mjs --dry-run | cut -c1-200
