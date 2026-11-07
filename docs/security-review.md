# Wavefund contracts: security review

Scope: every contract in `contracts/src` (11 contracts plus interfaces), targeting Arc Testnet.
A review like this is best effort and is not a substitute for a paid third-party audit.

## Status

The source code has been fixed (see below), re-tested, and **redeployed to Arc Testnet**. Addresses are in `contracts/deployments/current.json` and `docs/contract-api.md`. The earlier deployment without the fixes is archived in `contracts/deployments/previous-deployment-v1.json`.

## Test results (fixed source)

27 test suites pass with 0 failures: the original suites (updated where behaviour changed) plus new suites for the emergency exit, executed-round tracking, first-observation reporting, slippage and price-band limits, retry after a failed execution, and the empty-vault deposit bootstrap. The fork test and gas test were not part of this run. Static analysis found nothing that needs action.

## Fixed

1. **Withdrawals depended on the keeper.** New `emergencyWithdraw`: after 3 days, a withdrawal requester gets their pro-rata USDC and tETH in kind. It needs no oracle or swap.
2. **Emergency settlement could beat cancellation.** The round engine now records whether the vault executed the round. An emergency settle on an unexecuted round cancels it at par instead.
3. **The reporter could pick the settlement price.** The oracle keeps a price history and the report uses the first observation at or after the evaluation end.
4. **Vault rebalances could be sandwiched.** Swaps now carry a price limit derived from the oracle. Default tolerance is 1% (was 5%), with a 5% hard cap. The keeper can pass a tighter tolerance and a deadline.
5. **Bond asset not checked.** The registry requires 6 decimals and the round engine requires the registry to use the same USDC.
6. **Market wiring accepted any address.** `setQuantumRound` now requires a contract whose `market()` is the adapter.

Found and fixed during re-review:

7. **Deposits could be stranded after a full emergency exit.** Queued deposits are now converted to shares at the launch rate when the vault is empty.
8. **A manipulated pool price cancelled a round permanently.** A failed execution now reverts and the keeper can retry. Anyone can still cancel at par after the evaluation end.

## Known limit (accepted)

The vault trades through one USDC/tETH pool. Someone who keeps that pool outside the oracle band until the evaluation ends can stop execution and force the round to cancel at par. It costs them sustained capital, no vault funds are lost, and depositors can still cancel and exit. Closing this fully needs a second swap route.

## Trust assumptions treated as intentional (testnet)

- `MockPriceOracle` prices (and the timing of observations) are controlled by the keeper.
- `TestAsset` (tETH) supply is controlled by its owner.
- Admin roles start with the deployer wallet.
