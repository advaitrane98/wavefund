// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IWaveHook} from "../src/interfaces/IWaveHook.sol";
import {WaveV4ProposalMarket} from "../src/WaveV4ProposalMarket.sol";
import {ProposalTokens} from "../src/ProposalTokens.sol";
import {WaveBase} from "./WaveBase.sol";
import {MockQuantumRound} from "./mocks/MockQuantumRound.sol";

/// @notice Wiring, seeding, views, TWAP snapshot and finalize behaviour of the adapter.
contract WaveV4ProposalMarketTest is WaveBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant SEED = 5_000_000; // 5 USDC

    // ------------------------------------------------------------------ wiring
    function _fresh() internal returns (WaveV4ProposalMarket a) {
        a = new WaveV4ProposalMarket(pm, tokens, address(this));
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        new WaveV4ProposalMarket(IPoolManager(address(0)), tokens, address(this));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        new WaveV4ProposalMarket(pm, ProposalTokens(address(0)), address(this));
    }

    function test_HarnessWiring_OwnershipMovedToQuantumRound() public view {
        assertEq(adapter.owner(), address(qr));
        assertEq(adapter.quantumRound(), address(qr));
        assertEq(adapter.waveHook(), address(hook));
        assertEq(hook.adapter(), address(adapter));
        assertEq(uint160(address(hook)) & 0x3FFF, 2752, "hook flags");
        assertEq(adapter.completeSetScale(), 1e12);
        assertEq(adapter.COMPLETE_SET_SCALE(), 1e12);
    }

    function test_OwnershipMovesOnlyAfterBothWires_RoundFirst() public {
        WaveV4ProposalMarket a = _fresh();
        address h = address(_deployHookAt(_hookAddr(0x5001), address(a)));
        MockQuantumRound r = _roundFor(a);
        a.setQuantumRound(address(r));
        assertEq(a.owner(), address(this), "still deployer after one wire");
        a.setWaveHook(h);
        assertEq(a.owner(), address(r), "handed to round after both");
    }

    function test_OwnershipMovesOnlyAfterBothWires_HookFirst() public {
        WaveV4ProposalMarket a = _fresh();
        address h = address(_deployHookAt(_hookAddr(0x5002), address(a)));
        a.setWaveHook(h);
        assertEq(a.owner(), address(this));
        MockQuantumRound r = _roundFor(a);
        a.setQuantumRound(address(r));
        assertEq(a.owner(), address(r));
    }

    function test_SetQuantumRound_Reverts() public {
        WaveV4ProposalMarket a = _fresh();
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        a.setQuantumRound(address(0));
        MockQuantumRound r = _roundFor(a);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.setQuantumRound(address(r));
        a.setQuantumRound(address(r));
        vm.expectRevert(WaveV4ProposalMarket.AlreadyWired.selector);
        a.setQuantumRound(address(0xBEEF));
    }

    function test_SetQuantumRound_RejectsEoaAndLeavesWiringOpen() public {
        WaveV4ProposalMarket a = _fresh();
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.InvalidQuantumRound.selector, stranger));
        a.setQuantumRound(stranger);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.InvalidQuantumRound.selector, address(0xBEEF)));
        a.setQuantumRound(address(0xBEEF));
        assertEq(a.quantumRound(), address(0), "nothing wired");
        // a proper controller can still be wired afterwards
        a.setQuantumRound(address(_roundFor(a)));
        assertTrue(a.quantumRound() != address(0));
    }

    function test_SetQuantumRound_RejectsContractWithoutMarketGetter() public {
        WaveV4ProposalMarket a = _fresh();
        // the test contract has code but no `market()` function
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.InvalidQuantumRound.selector, address(this)));
        a.setQuantumRound(address(this));
        // a different contract with code and no market() (the pool manager)
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.InvalidQuantumRound.selector, address(pm)));
        a.setQuantumRound(address(pm));
        assertEq(a.quantumRound(), address(0));
    }

    function test_SetQuantumRound_RejectsControllerBoundToAnotherMarket() public {
        WaveV4ProposalMarket a = _fresh();
        // `qr` is bound to the harness adapter, not to `a`
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.QuantumRoundMarketMismatch.selector, address(adapter)));
        a.setQuantumRound(address(qr));
        // a controller whose market is unset reports address(0)
        MockQuantumRound unset = new MockQuantumRound(tokens);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.QuantumRoundMarketMismatch.selector, address(0)));
        a.setQuantumRound(address(unset));
        assertEq(a.quantumRound(), address(0));
        assertEq(a.owner(), address(this), "ownership untouched");
    }

    function test_SetWaveHook_Reverts() public {
        WaveV4ProposalMarket a = _fresh();
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        a.setWaveHook(address(0));
        // hook bound to a different adapter
        address wrong = address(_deployHookAt(_hookAddr(0x5003), address(0xBEEF)));
        vm.expectRevert(WaveV4ProposalMarket.InvalidHookAdapter.selector);
        a.setWaveHook(wrong);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        a.setWaveHook(wrong);
        address good = address(_deployHookAt(_hookAddr(0x5004), address(a)));
        a.setWaveHook(good);
        vm.expectRevert(WaveV4ProposalMarket.AlreadyWired.selector);
        a.setWaveHook(good);
    }

    function test_WiringIsOneWayAfterHandoff() public {
        // deployer is no longer owner, round (new owner) cannot rewire either
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        adapter.setQuantumRound(address(0xBEEF));
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.AlreadyWired.selector);
        adapter.setQuantumRound(address(0xBEEF));
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.AlreadyWired.selector);
        adapter.setWaveHook(address(hook));
    }

    function test_OwnershipTransferAndRenounceDisabled() public {
        WaveV4ProposalMarket a = _fresh();
        vm.expectRevert(WaveV4ProposalMarket.OwnershipLocked.selector);
        a.transferOwnership(stranger);
        vm.expectRevert(WaveV4ProposalMarket.OwnershipLocked.selector);
        a.renounceOwnership();
        vm.startPrank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.OwnershipLocked.selector);
        adapter.transferOwnership(stranger);
        vm.expectRevert(WaveV4ProposalMarket.OwnershipLocked.selector);
        adapter.renounceOwnership();
        vm.stopPrank();
        assertEq(adapter.owner(), address(qr));
    }

    function test_OnlyQuantumRound_GatesEveryStateChangingEntryPoint() public {
        _open(R, P, SEED);
        bytes4 sel = WaveV4ProposalMarket.NotQuantumRound.selector;
        vm.startPrank(stranger);
        vm.expectRevert(sel);
        adapter.seedLiquidity(R, P, 1);
        vm.expectRevert(sel);
        adapter.tradeBuyLong(R, P, 1, 0, stranger);
        vm.expectRevert(sel);
        adapter.tradeBuyShort(R, P, 1, 0, stranger);
        vm.expectRevert(sel);
        adapter.tradeSellLong(R, P, 1, 0);
        vm.expectRevert(sel);
        adapter.tradeSellShort(R, P, 1, 0);
        vm.expectRevert(sel);
        adapter.consumeSellSettlement(R, P, stranger);
        vm.expectRevert(sel);
        adapter.finalizeProposal(R, P);
        vm.stopPrank();
    }

    function test_UnlockCallbackRejectsOutsiders() public {
        vm.expectRevert(WaveV4ProposalMarket.NotPoolManager.selector);
        adapter.unlockCallback("");
        vm.prank(address(pm));
        vm.expectRevert(WaveV4ProposalMarket.UnexpectedCallback.selector);
        adapter.unlockCallback("");
    }

    // ------------------------------------------------------------------ seeding
    function test_SeedRequiresCompleteWiring() public {
        WaveV4ProposalMarket a = _fresh();
        MockQuantumRound r = _roundFor(a);
        a.setQuantumRound(address(r));
        vm.prank(address(r));
        vm.expectRevert(WaveV4ProposalMarket.WiringIncomplete.selector);
        a.seedLiquidity(R, P, 1);
    }

    function test_SeedRevertsOnZeroAmountMissingTokensAndSecondSeed() public {
        vm.startPrank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAmount.selector);
        adapter.seedLiquidity(R, P, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotFound.selector, R, P));
        adapter.seedLiquidity(R, P, 1);
        vm.stopPrank();
        _open(R, P, SEED);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.AlreadySeeded.selector, R, P));
        qr.seed(R, P, SEED);
    }

    function test_SeedRegistersInitialisesAndAddsOnePosition() public {
        qr.createTokens(R, P);
        PoolId id = _id(R, P);
        uint256 t0 = _now();
        vm.expectEmit(true, true, true, true, address(adapter));
        emit WaveV4ProposalMarket.MarketSeeded(R, P, id, SEED, uint128(SEED * SCALE));
        qr.seed(R, P, SEED);

        // registered with the hook, timing taken from the round
        assertTrue(hook.isRegistered(id));
        IWaveHook.PoolData memory d = hook.poolDetails(id);
        assertEq(d.roundId, R);
        assertEq(d.proposalId, P);
        assertEq(d.longToken, _long(R, P));
        assertEq(uint256(d.tradingStart), t0);
        assertEq(uint256(d.tradingEnd), t0 + 1 days);
        assertEq(uint256(d.finalWindowSeconds), 1 hours);
        assertEq(d.longIsCurrency0, _longIs0(R, P));
        assertEq(d.lastProbability, 0.5e18);
        assertEq(d.lastPrice, 1e18);

        // initialised at exactly 1:1
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(id);
        assertEq(uint256(sqrtP), uint256(Q96));
        assertEq(int256(tick), int256(0));
        assertEq(_pLong(R, P), 0.5e18);

        // liquidity == complete-set notional, single position over the full tick range
        assertEq(uint256(pm.getLiquidity(id)), SEED * SCALE);
        bytes32 posKey = Position.calculatePositionKey(address(adapter), -45900, 45900, bytes32(0));
        assertEq(uint256(pm.getPositionLiquidity(id, posKey)), SEED * SCALE);
        (uint128 grossLo, int128 netLo) = pm.getTickLiquidity(id, -45900);
        (uint128 grossHi, int128 netHi) = pm.getTickLiquidity(id, 45900);
        assertEq(uint256(grossLo), SEED * SCALE);
        assertEq(uint256(grossHi), SEED * SCALE);
        assertEq(int256(netLo), int256(SEED * SCALE));
        assertEq(int256(netHi), -int256(SEED * SCALE));
    }

    function test_SeedLeavesIdleSetsInAdapter() public {
        _open(R, P, SEED);
        uint256 L = SEED * SCALE;
        uint256 idleL = _bal(_long(R, P), address(adapter));
        uint256 idleS = _bal(_short(R, P), address(adapter));
        uint256 inPoolL = _bal(_long(R, P), address(pm));
        uint256 inPoolS = _bal(_short(R, P), address(pm));
        // deposit at 1:1 over [-45900, 45900] is L*(1 - 1/sqrt(P_upper)) ~ 0.8992 L (P_upper ~ 98.5)
        emit log_named_decimal_uint("idle LONG sets (raw/1e18)", idleL, 18);
        emit log_named_decimal_uint("idle / L  (x1e18)", idleL * 1e18 / L, 18);
        assertEq(idleL + inPoolL, L, "LONG conserved");
        assertEq(idleS + inPoolS, L, "SHORT conserved");
        assertApproxEqRel(idleL, L * (1e18 - 0.8992e18) / 1e18, 0.005e18, "idle ~ 10.08% of L");
        assertLe(_absDiff(idleL, idleS), 1e3, "legs symmetric to rounding");
        assertApproxEqAbs(inPoolL, inPoolS, 1e3);
    }

    // ------------------------------------------------------------------ views
    function test_ViewsRevertBeforeSeed() public {
        qr.createTokens(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.spotPrice(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.probabilities(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.probabilityTwap(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.twap(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.closeTwapWindow(R, P);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.MarketNotSeeded.selector, R, P));
        adapter.quoteBuyLong(R, P, 1);
    }

    function test_ViewsAtSeedPrice() public {
        _open(R, P, SEED);
        (uint256 pl, uint256 ps) = adapter.probabilities(R, P);
        assertEq(pl, 0.5e18);
        assertEq(ps, 0.5e18);
        assertEq(adapter.spotPrice(R, P), 1e18);
        assertEq(adapter.probabilityTwap(R, P), 0.5e18);
        assertEq(adapter.twap(R, P), 1e18);
    }

    function test_CloseTwapWindow_RequiresEndSnapshotsAndIsIdempotent() public {
        _open(R, P, SEED);
        uint256 end = _now() + 1 days;
        vm.warp(_now() + 23 hours + 30 minutes);
        _buy(alice, R, P, 1_000_000, true);
        uint256 pAfter = _pLong(R, P);
        vm.warp(end - 1);
        vm.expectRevert(WaveV4ProposalMarket.TradingNotEnded.selector);
        adapter.closeTwapWindow(R, P);

        vm.warp(end);
        uint256 liveP = adapter.probabilityTwap(R, P);
        uint256 liveT = adapter.twap(R, P);
        vm.expectEmit(true, true, false, true, address(adapter));
        emit WaveV4ProposalMarket.TwapWindowClosed(R, P, liveP, liveT);
        (uint256 tp, uint256 tpr) = adapter.closeTwapWindow(R, P);
        assertEq(tp, liveP);
        assertEq(tpr, liveT);
        // 30 min at 0.5 then 30 min at pAfter
        assertEq(tp, (0.5e18 * 1800 + pAfter * 1800) / 3600, "hand-computed TWAP");

        // idempotent: no second event, same values, getters return the snapshot
        vm.recordLogs();
        vm.warp(end + 10 days);
        (uint256 tp2, uint256 tpr2) = adapter.closeTwapWindow(R, P);
        assertEq(vm.getRecordedLogs().length, 0, "no event on second close");
        assertEq(tp2, tp);
        assertEq(tpr2, tpr);
        assertEq(adapter.probabilityTwap(R, P), tp);
        assertEq(adapter.twap(R, P), tpr);

        // finalizing (which moves the pool) does not move the frozen snapshot
        qr.finalize(R, P);
        assertEq(adapter.probabilityTwap(R, P), tp);
        assertEq(adapter.twap(R, P), tpr);
    }

    // ------------------------------------------------------------------ pending settlement
    function test_PendingSettlementRules() public {
        _open(R, P, SEED);
        _buy(alice, R, P, 1_000_000, true);
        uint256 half = _bal(_long(R, P), alice) / 2;

        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.NoPendingSettlement.selector, R, P));
        qr.consume(alice, R, P);

        qr.sellStep(alice, R, P, half, true, 0);
        qr.mintLegs(alice, R, P, 0, 1e16);
        // second sell (either leg) and quoting while pending revert
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P));
        qr.sellStep(alice, R, P, 1e15, true, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P));
        qr.sellStep(alice, R, P, 1e15, false, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P));
        adapter.quoteSellLong(R, P, 1e15);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P));
        adapter.quoteSellShort(R, P, 1e15);

        // finalize blocked while unconsumed
        vm.warp(_now() + 1 days);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.PendingRemainder.selector, R, P));
        qr.finalize(R, P);

        // consume once, then it is gone and finalize works
        (uint256 c,,) = qr.consume(alice, R, P);
        assertGt(c, 0);
        vm.expectRevert(abi.encodeWithSelector(WaveV4ProposalMarket.NoPendingSettlement.selector, R, P));
        qr.consume(alice, R, P);
        qr.finalize(R, P);
    }

    function test_ConsumeRejectsZeroSeller() public {
        _open(R, P, SEED);
        vm.prank(address(qr));
        vm.expectRevert(WaveV4ProposalMarket.ZeroAddress.selector);
        adapter.consumeSellSettlement(R, P, address(0));
    }

    function test_ConsumeEmitsEventAndPaysDust() public {
        _open(R, P, SEED);
        _buy(alice, R, P, 1_000_000, true);
        uint256 amt = _bal(_long(R, P), alice);
        (uint256 qc, uint256 qld, uint256 qsd) = adapter.quoteSellLong(R, P, amt);
        qr.sellStep(alice, R, P, amt, true, 0);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit WaveV4ProposalMarket.SellSettlementConsumed(R, P, alice, qc, qld, qsd);
        (uint256 c, uint256 ld, uint256 sd) = qr.consume(alice, R, P);
        assertEq(c, qc);
        assertEq(ld, qld);
        assertEq(sd, qsd);
        assertEq(_bal(_long(R, P), alice), ld);
        assertEq(_bal(_short(R, P), alice), sd);
        assertEq(_bal(_credit(R, P), alice), c);
    }

    // ------------------------------------------------------------------ finalize
    function test_FinalizeOnlyAfterTradingEnd() public {
        _open(R, P, SEED);
        uint256 end = _now() + 1 days;
        vm.warp(end - 1);
        vm.expectRevert(WaveV4ProposalMarket.TradingNotEnded.selector);
        qr.finalize(R, P);
        vm.warp(end); // exactly tradingEnd: removal is open
        qr.finalize(R, P);
    }

    function test_FinalizeRemovesAllLiquidityAndReturnsEverythingToRound() public {
        uint64 mStart = uint64(_now());
        _open(R, P, SEED);
        _buy(alice, R, P, 1_000_000, true);
        _buy(bob, R, P, 700_000, false);
        _sell(alice, R, P, _bal(_long(R, P), alice) / 3, true);
        uint256 idleL = _bal(_long(R, P), address(adapter));
        uint256 idleS = _bal(_short(R, P), address(adapter));
        assertGt(idleL, 0);

        vm.warp(_now() + 1 days);
        PoolId id = _id(R, P);
        assertGt(uint256(pm.getLiquidity(id)), 0);
        uint256 supplyL = _supply(_long(R, P));
        qr.finalize(R, P);

        assertEq(pm.getLiquidity(id), 0, "pool liquidity zero");
        bytes32 posKey = Position.calculatePositionKey(address(adapter), -45900, 45900, bytes32(0));
        assertEq(pm.getPositionLiquidity(id, posKey), 0, "position gone");
        assertEq(_bal(_long(R, P), address(adapter)), 0, "adapter LONG zero");
        assertEq(_bal(_short(R, P), address(adapter)), 0, "adapter SHORT zero");

        // everything (idle + pool principal + fees) sits with users or the round; PM keeps at most rounding dust
        uint256 usersL = _bal(_long(R, P), alice) + _bal(_long(R, P), bob);
        uint256 usersS = _bal(_short(R, P), alice) + _bal(_short(R, P), bob);
        uint256 qrL = _bal(_long(R, P), address(qr));
        uint256 qrS = _bal(_short(R, P), address(qr));
        assertLe(_bal(_long(R, P), address(pm)), 10, "PM LONG dust");
        assertLe(_bal(_short(R, P), address(pm)), 10, "PM SHORT dust");
        assertEq(qrL + usersL + _bal(_long(R, P), address(pm)), supplyL, "LONG fully accounted");
        assertEq(qrS + usersS + _bal(_short(R, P), address(pm)), supplyL, "SHORT fully accounted");
        assertGt(qrL, idleL, "round received pool principal on top of idle");
        assertGt(qrS, idleS);
        emit log_named_uint("round received LONG", qrL);
        emit log_named_uint("round received SHORT", qrS);

        bytes memory finalized = abi.encodeWithSelector(WaveV4ProposalMarket.AlreadyFinalized.selector, R, P);
        vm.expectRevert(finalized);
        qr.finalize(R, P);
        vm.expectRevert(finalized);
        qr.buy(alice, R, P, 1, true, 0);
        // Quotes check the trading window first; finalize is only possible at/after tradingEnd, so a quote on a
        // finalized market reports TradingClosed (the AlreadyFinalized check inside _quotableMarket is unreachable).
        vm.expectRevert(
            abi.encodeWithSelector(WaveV4ProposalMarket.TradingClosed.selector, mStart, mStart + 1 days, _now())
        );
        adapter.quoteBuyLong(R, P, 1);
    }

    function test_FinalizeEmitsReturnedAmounts() public {
        _open(R, P, SEED);
        vm.warp(_now() + 1 days);
        vm.recordLogs();
        qr.finalize(R, P);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(adapter) && logs[i].topics[0] == WaveV4ProposalMarket.ProposalFinalized.selector) {
                (uint256 lr, uint256 sr) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(lr, _bal(_long(R, P), address(qr)));
                assertEq(sr, _bal(_short(R, P), address(qr)));
                found = true;
            }
        }
        assertTrue(found, "ProposalFinalized");
    }
}
