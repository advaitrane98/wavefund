// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuantumRound} from "../../src/interfaces/IQuantumRound.sol";
import {ProposalTokens} from "../../src/ProposalTokens.sol";
import {ProposalToken} from "../../src/ProposalToken.sol";
import {WaveV4ProposalMarket} from "../../src/WaveV4ProposalMarket.sol";

/// @notice Test double for the real QuantumRound. Holds QUANTUM_ROUND_ROLE on ProposalTokens and drives the
///         push-model adapter exactly like the real round will (mint -> call adapter -> burn/mint).
contract MockQuantumRound is IQuantumRound {
    uint256 internal constant SCALE = 1e12;

    struct Timing {
        bool set;
        uint64 start;
        uint64 end;
        uint64 fw;
    }

    ProposalTokens public immutable tokens;
    WaveV4ProposalMarket public market;
    uint64 public defaultDuration = 1 days;
    uint64 public defaultFinalWindow = 1 hours;
    mapping(uint256 => mapping(uint256 => Timing)) internal _timing;

    constructor(ProposalTokens tokens_) {
        tokens = tokens_;
    }

    function setMarket(WaveV4ProposalMarket market_) external {
        market = market_;
    }

    function setDefaults(uint64 duration, uint64 finalWindow) external {
        defaultDuration = duration;
        defaultFinalWindow = finalWindow;
    }

    function setTiming(uint256 r, uint256 p, uint64 start, uint64 end, uint64 fw) external {
        _timing[r][p] = Timing(true, start, end, fw);
    }

    function marketTiming(uint256 r, uint256 p) external view returns (uint64, uint64, uint64) {
        Timing memory t = _timing[r][p];
        if (t.set) return (t.start, t.end, t.fw);
        uint64 start = uint64(block.timestamp);
        return (start, start + defaultDuration, defaultFinalWindow);
    }

    // ---------------------------------------------------------------- token helpers
    function longOf(uint256 r, uint256 p) public view returns (ProposalToken) {
        return ProposalToken(tokens.longToken(r, p));
    }

    function shortOf(uint256 r, uint256 p) public view returns (ProposalToken) {
        return ProposalToken(tokens.shortToken(r, p));
    }

    function creditOf(uint256 r, uint256 p) public view returns (ProposalToken) {
        return ProposalToken(tokens.creditToken(r, p));
    }

    function mintLegs(address to, uint256 r, uint256 p, uint256 rawLong, uint256 rawShort) public {
        if (rawLong != 0) longOf(r, p).mint(to, rawLong);
        if (rawShort != 0) shortOf(r, p).mint(to, rawShort);
    }

    // ---------------------------------------------------------------- lifecycle
    function createTokens(uint256 r, uint256 p) external {
        tokens.createProposalTokens(r, p);
    }

    /// @dev Mints the seed complete sets to the adapter and seeds (tokens must already exist).
    function seed(uint256 r, uint256 p, uint256 seedCredits) public {
        mintLegs(address(market), r, p, seedCredits * SCALE, seedCredits * SCALE);
        market.seedLiquidity(r, p, seedCredits);
    }

    function openMarket(uint256 r, uint256 p, uint256 seedCredits) external {
        tokens.createProposalTokens(r, p);
        seed(r, p, seedCredits);
    }

    /// @dev Test convenience: CREDIT appears in the user's wallet (stands in for the USDC deposit).
    function fund(address user, uint256 r, uint256 p, uint256 credits) external {
        creditOf(r, p).mint(user, credits);
    }

    function buy(address user, uint256 r, uint256 p, uint256 credits, bool long_, uint256 minOut)
        external
        returns (uint256 out)
    {
        creditOf(r, p).burn(user, credits);
        mintLegs(address(market), r, p, credits * SCALE, credits * SCALE);
        out = long_
            ? market.tradeBuyLong(r, p, credits, minOut, user)
            : market.tradeBuyShort(r, p, credits, minOut, user);
    }

    /// @dev First half of a sale: the sold leg moves from the user to the adapter, then the adapter trades.
    function sellStep(address user, uint256 r, uint256 p, uint256 amountIn, bool long_, uint256 minCredits)
        public
        returns (uint256 credits)
    {
        ProposalToken sold = long_ ? longOf(r, p) : shortOf(r, p);
        sold.burn(user, amountIn);
        sold.mint(address(market), amountIn);
        credits = long_
            ? market.tradeSellLong(r, p, amountIn, minCredits)
            : market.tradeSellShort(r, p, amountIn, minCredits);
    }

    /// @dev Second half of a sale: burn the matched sets and pay the seller in CREDIT.
    function consume(address user, uint256 r, uint256 p)
        public
        returns (uint256 credits, uint256 longDust, uint256 shortDust)
    {
        (credits, longDust, shortDust) = market.consumeSellSettlement(r, p, user);
        longOf(r, p).burn(address(this), credits * SCALE);
        shortOf(r, p).burn(address(this), credits * SCALE);
        creditOf(r, p).mint(user, credits);
    }

    function sell(address user, uint256 r, uint256 p, uint256 amountIn, bool long_, uint256 minCredits)
        external
        returns (uint256 credits, uint256 longDust, uint256 shortDust)
    {
        sellStep(user, r, p, amountIn, long_, minCredits);
        return consume(user, r, p);
    }

    function finalize(uint256 r, uint256 p) external {
        market.finalizeProposal(r, p);
    }
}
