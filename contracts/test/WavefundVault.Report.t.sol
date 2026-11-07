// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VaultBase} from "./VaultBase.sol";
import {WavefundVault} from "../src/WavefundVault.sol";
import {RoundStatus} from "../src/interfaces/IQuantumRoundControl.sol";

/// @notice reportReturn marks the executed portfolio at the FIRST oracle observation at or after evaluationEnd.
contract WavefundVaultReportTest is VaultBase {
    uint256 internal r;
    uint256 internal end;
    uint256 internal window;

    function setUp() public override {
        super.setUp();
        window = vault.REPORT_WINDOW();
    }

    function _executedRound() internal {
        r = _winner1Round();
        _execute(r, 6000);
        end = qr.evaluationEnd(r);
    }

    /// @dev R the vault must report if the executed portfolio is marked at `answer8`.
    function _expectedR(int256 answer8) internal view returns (uint256 navNow, uint256 start, uint256 ratio) {
        (uint256 startValue, uint256 tEthAtStart, uint256 usdcAtStart,,,,,) = vault.roundState(r);
        start = startValue;
        navNow = usdcAtStart + Math.mulDiv(tEthAtStart, uint256(answer8), 1e20);
        ratio = Math.mulDiv(navNow, ONE, start);
    }

    function test_usesTheFirstObservationAfterEvaluationEnd_notTheLatestPrice() public {
        _executedRound();
        vm.warp(end + 10);
        _price(2100e8); // first observation after the end
        vm.warp(end + 2 hours);
        _price(1000e8); // a later, very different update must not matter
        vm.warp(end + 20 hours); // reporting late, with a stale oracle, is fine inside the window
        (uint256 navNow, uint256 start, uint256 expected) = _expectedR(2100e8);
        vm.expectEmit(true, false, false, true, address(vault));
        emit WavefundVault.ReturnReported(r, navNow, start, expected);
        vault.reportReturn(r);
        assertEq(_realised(r), expected);
        assertEq(uint256(qr.roundStatus(r)), uint256(RoundStatus.Settled));
    }

    function test_reportedValueIsIndependentOfWhenInsideTheWindowTheReportIsMade() public {
        _executedRound();
        vm.warp(end + 1);
        _price(2100e8);
        vm.warp(end + 5);
        _price(1234e8);
        uint256 snap = vm.snapshotState();
        vm.warp(end + 6);
        vault.reportReturn(r);
        uint256 early = _realised(r);
        vm.revertToState(snap);
        vm.warp(end + window);
        vault.reportReturn(r);
        assertEq(_realised(r), early);
        (,, uint256 expected) = _expectedR(2100e8);
        assertEq(early, expected);
    }

    function test_anObservationExactlyAtEvaluationEndCounts() public {
        _executedRound();
        vm.warp(end);
        _price(2100e8);
        vm.warp(end + 1 hours);
        _price(1500e8);
        vault.reportReturn(r);
        (,, uint256 expected) = _expectedR(2100e8);
        assertEq(_realised(r), expected);
    }

    function test_observationsBeforeEvaluationEndAreIgnored() public {
        _executedRound();
        vm.warp(end - 1);
        _price(3000e8); // the latest price at the end, but it predates it
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.OracleNotUpdated.selector, 0, end));
        vault.reportReturn(r);
        vm.warp(end + 1 hours);
        _price(2100e8);
        vault.reportReturn(r);
        (,, uint256 expected) = _expectedR(2100e8);
        assertEq(_realised(r), expected);
    }

    function test_revertsWhenNoObservationExistsAtOrAfterTheEnd() public {
        _executedRound();
        vm.warp(end + window); // last second of the window, still nothing newer than the decision-time price
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.OracleNotUpdated.selector, 0, end));
        vault.reportReturn(r);
        (,,, bool reported) = _flags();
        assertFalse(reported);
    }

    function test_revertsWhenTheFirstObservationIsLaterThanTheWindow() public {
        _executedRound();
        vm.warp(end + window + 1);
        _price(2100e8);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ReportWindowClosed.selector, r));
        vault.reportReturn(r);
    }

    function test_revertsAfterTheWindowEvenWithAnInWindowObservation() public {
        _executedRound();
        vm.warp(end + 1 hours);
        _price(2100e8);
        vm.warp(end + window + 1);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.ReportWindowClosed.selector, r));
        vault.reportReturn(r);
    }

    function test_anObservationExactlyAtTheWindowBoundaryIsUsable() public {
        _executedRound();
        vm.warp(end + window);
        _price(2100e8);
        vault.reportReturn(r);
        (,, uint256 expected) = _expectedR(2100e8);
        assertEq(_realised(r), expected);
    }

    function test_evaluationMustHaveEndedAndOnlyExecutedRoundsReport() public {
        _executedRound();
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.EvaluationNotEnded.selector, r));
        vault.reportReturn(r);
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.EvaluationNotEnded.selector, r));
        vault.reportReturn(r);
        vm.expectRevert(abi.encodeWithSelector(WavefundVault.NotExecuted.selector, 99));
        vault.reportReturn(99);
    }

    function test_unchangedPriceReportsAnUnchangedPortfolio() public {
        r = _statusQuoRound();
        _execute(r, 3333);
        end = qr.evaluationEnd(r);
        vm.warp(end + 1);
        _price(2000e8);
        vault.reportReturn(r);
        assertEq(_realised(r), ONE);
    }

    function _flags() internal view returns (uint256, bool, bool, bool) {
        (,,,,, bool executed, bool reported, bool cancelled) = vault.roundState(r);
        return (0, executed, cancelled, reported);
    }
}
