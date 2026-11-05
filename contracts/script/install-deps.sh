#!/usr/bin/env bash
# Installs the Solidity dependencies into contracts/lib at the exact versions Wavefund was built and tested with.
# contracts/lib is git-ignored, so run this once after cloning:
#
#   bash contracts/script/install-deps.sh
#
# Override the target folder with LIB_DIR=/some/path. Re-running replaces the folders it manages.
set -euo pipefail

LIB_DIR="${LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib}"

# Pinned versions (see foundry.toml remappings).
V4_PERIPHERY_REPO="https://github.com/Uniswap/v4-periphery"
# Last v4-periphery commit that still ships BaseHook and HookMiner (src/utils). It pins v4-core 1.0.2.
V4_PERIPHERY_REF="3779387e5d296f39df543d23524b050f89a62917"
OPENZEPPELIN_REPO="https://github.com/OpenZeppelin/openzeppelin-contracts"
OPENZEPPELIN_REF="v5.6.1"
PERMIT2_REPO="https://github.com/Uniswap/permit2"
PERMIT2_REF="cc56ad0f3439c502c246fc5cfcc3db92bb8b7219"

mkdir -p "$LIB_DIR"

echo "==> v4-periphery @ ${V4_PERIPHERY_REF} (with v4-core 1.0.2, solmate, forge-std)"
rm -rf "$LIB_DIR/v4-periphery"
git clone --quiet "$V4_PERIPHERY_REPO" "$LIB_DIR/v4-periphery"
git -C "$LIB_DIR/v4-periphery" checkout --quiet "$V4_PERIPHERY_REF"
git -C "$LIB_DIR/v4-periphery" submodule update --quiet --init lib/v4-core
git -C "$LIB_DIR/v4-periphery/lib/v4-core" submodule update --quiet --init lib/solmate lib/forge-std

echo "==> openzeppelin-contracts @ ${OPENZEPPELIN_REF}"
rm -rf "$LIB_DIR/openzeppelin-contracts"
git clone --quiet --depth 1 --branch "$OPENZEPPELIN_REF" "$OPENZEPPELIN_REPO" "$LIB_DIR/openzeppelin-contracts"

echo "==> permit2 @ ${PERMIT2_REF}"
rm -rf "$LIB_DIR/permit2"
git clone --quiet "$PERMIT2_REPO" "$LIB_DIR/permit2"
git -C "$LIB_DIR/permit2" checkout --quiet "$PERMIT2_REF"

# Keep only the sources: drop git metadata so nothing nested is mistaken for a submodule.
find "$LIB_DIR" -name .git -prune -exec rm -rf {} +

echo "Done. Dependencies installed in ${LIB_DIR}"
