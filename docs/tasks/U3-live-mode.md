# TASK U3: live mode reading and writing the deployed contracts

Addresses and generated ABIs come from `contracts/deployments/current.json`; an ABI-generation script runs from the forge build.

- **Wallet:** EIP-6963 discovery preferring MetaMask (fallback `window.ethereum`); `eth_requestAccounts`; `wallet_switchEthereumChain` to `0x4cef52`, on error 4902 `wallet_addEthereumChain` (name "Arc Testnet", RPC, explorer, native currency USDC with 18 decimals). Show real errors (4001 rejected, -32002 pending, no wallet, wrong network). Listen for `accountsChanged` / `chainChanged`; restore on reload. Header shows the ERC-20 USDC balance (6 decimals).
- **Reads:** viem with Multicall3 batching; transport = `fallback` (wallet provider when on Arc, then the public RPC, overridable by `NEXT_PUBLIC_ARC_RPC_URL`); retry with exponential backoff on 429s; poll every 30 s, paused while the tab is hidden, refresh after the user's own transactions; re-read history only when the round count or phase changes. If a refresh fails, keep the last good data with a small "data may be stale, retrying" notice, never a raw error page.
- **Markets:** current round, proposals (proposer name from ProposerRegistry, rationale), adapter probabilities, `probabilityTwap`, implied return, user balances. Trades use the adapter's `quote*` functions for the preview and `minOut` (quote less 0.5%); show amount in, expected out, average price, impact, pLong after; warn near the 0.01/0.99 bounds. Handle USDC approvals. Round states: Trading (countdown, final-window highlight) → Closed, awaiting collapse (Collapse button) → Collapsed (winner + ERASED) → Evaluating (countdown) → Settled (realised return, payout per LONG/SHORT, Redeem) → Cancelled (slippage guard; redeem at par). Show the vault trade's explorer link.
- **Vault:** live NAV, allocation, oracle vs pool price (warn above 2%), WAVE balance and share price, queue/cancel deposit and withdrawal (disable withdrawal with a warning if it exceeds the vault's free USDC), history with correct return formatting ("Starting NAV pending" before a decision).
- **Portfolio:** per-round deposit, credits, positions and redeemable amount with Redeem buttons.
- **Formatting:** one helper per unit (USDC 6, credits 6, LONG/SHORT/WAVE/tETH 18).

## Checks

`npm run build`; a Playwright script `npm run e2e:live` that opens the production URL in live and mock mode, visits every page, waits two refresh cycles and fails on console errors, 429s or error banners. Then a manual test with a real wallet during an open round. Stop.
