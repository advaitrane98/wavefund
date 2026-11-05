// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IProposalMarket} from "./interfaces/IProposalMarket.sol";
import {IQuantumRound} from "./interfaces/IQuantumRound.sol";
import {IAllocationSource, IQuantumRoundControl, RoundStatus} from "./interfaces/IQuantumRoundControl.sol";
import {ProposalToken} from "./ProposalToken.sol";
import {ProposalTokens} from "./ProposalTokens.sol";
import {ProposerRegistry} from "./ProposerRegistry.sol";

/// @title QuantumRound
/// @notice Round engine: proposals, per-proposal credit claims, complete-set trading through the market adapter,
///         collapse to a single winning proposal, settlement by realised return, and redemption.
/// @dev USDC (6 decimals) is the only asset held. One credit = 1 raw USDC = one complete set (1e12 raw LONG + SHORT).
///      Only the winning proposal's tokens ever pay out. Everything held by the contract is accounted for as:
///      protocol reserve + (per round) deposits + the seed of every proposal that is still alive.
/// @custom:upgrade-strategy Immutable, non-upgradeable code keeps settlement accounting fixed; live role administration is not an upgrade mechanism.
contract QuantumRound is IQuantumRound, IQuantumRoundControl, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    /// @notice Margin (in probability, 1e18) a proposal's TWAP must beat proposal 0's TWAP by.
    uint256 public constant EPSILON = 0.005e18;
    /// @notice Including proposal 0.
    uint256 public constant MAX_PROPOSALS_PER_ROUND = 10;
    uint256 public constant EMERGENCY_SETTLE_DELAY = 2 days;
    uint256 public constant MAX_SEED_CREDITS = 1e12;

    uint256 private constant SCALE = 1e12;
    uint256 private constant ONE = 1e18;
    uint256 private constant BPS = 10_000;

    struct Round {
        uint64 tradingStart;
        uint64 tradingEnd;
        uint64 evaluationEnd;
        uint64 twapWindow;
        uint256 rMin;
        uint256 rMax;
        RoundStatus status;
        uint8 proposalCount;
        uint8 winnerId;
        bool seedReleased;
        uint256 realisedReturn;
        /// @dev LONG payout ratio in 1e18; SHORT pays 1e18 minus it.
        uint256 pi;
        uint256 totalDeposits;
        uint256 depositsOutstanding;
        /// @dev Fixed at collapse: deposits plus the winning seed. Everything paid out comes from here.
        uint256 escrow;
        uint256 totalPaid;
    }

    struct Proposal {
        address proposer;
        uint16 tEthBps;
        bool isStatusQuo;
        uint256 seedCredits;
        uint256 bond;
        uint256 probabilityTwap;
        string rationale;
    }

    struct Allocation {
        uint16 tEthBps;
    }

    IERC20 public immutable usdc;
    ProposalTokens public immutable tokens;
    ProposerRegistry public immutable registry;
    IProposalMarket public immutable market;

    address public allocationSource;
    /// @notice Credits (6 decimals, = raw USDC) each new proposal market is seeded with.
    uint256 public initialLiquidityPerProposal = 5e6;
    /// @notice UNALLOCATED protocol reserve in raw USDC. Seeds are drawn from it and returned to it.
    uint256 public protocolLiquiditySeed;
    uint256 public currentRoundId;

    mapping(uint256 roundId => Round) public rounds;
    mapping(uint256 roundId => mapping(uint256 proposalId => Proposal)) public proposals;
    mapping(uint256 roundId => mapping(address user => uint256)) public deposits;
    mapping(uint256 roundId => mapping(uint256 proposalId => mapping(address user => uint256))) public creditsClaimed;
    mapping(uint256 roundId => mapping(address user => bool)) public redeemed;
    /// @notice USDC owed to users whose direct payout transfer failed (for example a blocklisted address).
    mapping(address user => uint256) public pendingPayout;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidParameters();
    error InvalidAllocation(uint256 tEthBps);
    error AllocationSourceNotSet();
    error PreviousRoundActive(uint256 roundId);
    error RoundNotFound(uint256 roundId);
    error ProposalNotFound(uint256 roundId, uint256 proposalId);
    error TradingNotOpen(uint256 roundId);
    error TradingNotEnded(uint256 roundId);
    error TooManyProposals();
    error InsufficientProtocolSeed(uint256 needed, uint256 available);
    error ExceedsUnallocatedSeed(uint256 requested, uint256 available);
    error ClaimExceedsDeposit(uint256 deposited, uint256 totalClaimed);
    error AlreadyCollapsed(uint256 roundId);
    error NotCollapsed(uint256 roundId);
    error EvaluationNotEnded(uint256 roundId);
    error NotAuthorizedToSettle();
    error NotRedeemable(uint256 roundId);
    error NothingToRedeem();
    error NothingToClaim();
    error InvalidRedeemTarget(address user);
    error LiabilitiesRemain(uint256 roundId);
    error SolvencyViolation(uint256 roundId);

    event ProtocolSeedAdded(uint256 amount, uint256 reserve);
    event ProtocolSeedRescued(address indexed to, uint256 amount, uint256 reserve);
    event InitialLiquidityUpdated(uint256 credits);
    event AllocationSourceUpdated(address indexed source);
    event RoundOpened(
        uint256 indexed roundId, uint256 tradingEnd, uint256 evaluationEnd, uint256 rMin, uint256 rMax, uint256 twapWindow
    );
    event ProposalCreated(
        uint256 indexed roundId, uint256 indexed proposalId, address indexed proposer, uint16 tEthBps, string rationale
    );
    event Deposited(uint256 indexed roundId, address indexed user, uint256 amount);
    event CreditsClaimed(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, uint256 amount);
    event Bought(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, bool isLong, uint256 credits, uint256 tokensOut);
    event Sold(uint256 indexed roundId, uint256 indexed proposalId, address indexed user, bool isLong, uint256 tokensIn, uint256 creditsOut);
    event Collapsed(uint256 indexed roundId, uint256 indexed winnerId, uint256[] probabilities);
    event RoundCancelled(uint256 indexed roundId);
    event RoundSettled(uint256 indexed roundId, uint256 realisedReturn, uint256 pi, bool emergency);
    event Redeemed(uint256 indexed roundId, address indexed user, uint256 payout);
    event PayoutDeferred(address indexed user, uint256 amount);
    event PayoutClaimed(address indexed user, uint256 amount);
    event SeedReleased(uint256 indexed roundId, uint256 amount);

    constructor(address admin, IERC20 usdc_, ProposalTokens tokens_, ProposerRegistry registry_, IProposalMarket market_) {
        if (
            admin == address(0) || address(usdc_) == address(0) || address(tokens_) == address(0)
                || address(registry_) == address(0) || address(market_) == address(0)
        ) revert ZeroAddress();
        if (IERC20Metadata(address(usdc_)).decimals() != 6) revert InvalidParameters();
        usdc = usdc_;
        tokens = tokens_;
        registry = registry_;
        market = market_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    function setInitialLiquidityPerProposal(uint256 credits) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (credits == 0 || credits > MAX_SEED_CREDITS) revert InvalidParameters();
        initialLiquidityPerProposal = credits;
        emit InitialLiquidityUpdated(credits);
    }

    function setAllocationSource(address source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (source == address(0)) revert ZeroAddress();
        allocationSource = source;
        emit AllocationSourceUpdated(source);
    }

    /// @notice Pulls USDC from the admin into the protocol reserve.
    function addProtocolLiquiditySeed(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        protocolLiquiditySeed += amount;
        emit ProtocolSeedAdded(amount, protocolLiquiditySeed);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraws up to the UNALLOCATED reserve to the admin. Seeds in live markets cannot be touched.
    function rescueProtocolSeed(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > protocolLiquiditySeed) revert ExceedsUnallocatedSeed(amount, protocolLiquiditySeed);
        protocolLiquiditySeed -= amount;
        emit ProtocolSeedRescued(msg.sender, amount, protocolLiquiditySeed);
        usdc.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------ round opening and proposals

    /// @notice Opens the next round and creates proposal 0 (status quo) from the allocation source.
    /// @param tradingEnd Absolute timestamp; must be in the future.
    /// @param horizon Seconds from tradingEnd to evaluationEnd.
    /// @param rMin Return ratio (1e18) that pays SHORT in full, e.g. 0.99e18.
    /// @param rMax Return ratio (1e18) that pays LONG in full, e.g. 1.01e18.
    /// @param twapWindow Length of the final TWAP window, in seconds, ending at tradingEnd.
    function openRound(uint256 tradingEnd, uint256 horizon, uint256 rMin, uint256 rMax, uint256 twapWindow)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 roundId)
    {
        uint256 previous = currentRoundId;
        if (previous != 0) {
            RoundStatus s = rounds[previous].status;
            if (s != RoundStatus.Settled && s != RoundStatus.Cancelled) revert PreviousRoundActive(previous);
        }
        address source = allocationSource;
        if (source == address(0)) revert AllocationSourceNotSet();
        if (
            tradingEnd <= block.timestamp || twapWindow == 0 || twapWindow > tradingEnd - block.timestamp
                || horizon == 0 || rMin >= rMax
        ) revert InvalidParameters();

        roundId = previous + 1;
        currentRoundId = roundId;
        Round storage rd = rounds[roundId];
        rd.tradingStart = SafeCast.toUint64(block.timestamp);
        rd.tradingEnd = SafeCast.toUint64(tradingEnd);
        rd.evaluationEnd = SafeCast.toUint64(tradingEnd + horizon);
        rd.twapWindow = SafeCast.toUint64(twapWindow);
        rd.rMin = rMin;
        rd.rMax = rMax;
        rd.status = RoundStatus.Trading;
        rd.proposalCount = 1;
        emit RoundOpened(roundId, tradingEnd, tradingEnd + horizon, rMin, rMax, twapWindow);

        uint256 bps = IAllocationSource(source).currentTEthBps();
        if (bps > BPS) revert InvalidAllocation(bps);
        Proposal storage p0 = proposals[roundId][0];
        p0.tEthBps = uint16(bps);
        p0.isStatusQuo = true;
        p0.seedCredits = _seedMarket(roundId, 0);
        emit ProposalCreated(roundId, 0, address(0), uint16(bps), "");
    }

    /// @notice Registered, active proposers submit an allocation during trading. Locks the registry bond.
    function propose(uint256 roundId, Allocation calldata allocation, string calldata rationale)
        external
        nonReentrant
        returns (uint256 proposalId)
    {
        Round storage rd = _trading(roundId);
        if (rd.proposalCount >= MAX_PROPOSALS_PER_ROUND) revert TooManyProposals();
        if (allocation.tEthBps > BPS) revert InvalidAllocation(allocation.tEthBps);
        proposalId = rd.proposalCount;
        rd.proposalCount = uint8(proposalId + 1);

        uint256 bond = registry.DEFAULT_BOND();
        registry.lockBond(msg.sender, bond);
        registry.recordProposal(msg.sender);

        Proposal storage p = proposals[roundId][proposalId];
        p.proposer = msg.sender;
        p.tEthBps = allocation.tEthBps;
        p.bond = bond;
        p.rationale = rationale;
        p.seedCredits = _seedMarket(roundId, proposalId);
        emit ProposalCreated(roundId, proposalId, msg.sender, allocation.tEthBps, rationale);
    }

    /// @dev Creates the tokens, mints the seed complete sets to the adapter and seeds the pool from the reserve.
    function _seedMarket(uint256 roundId, uint256 proposalId) private returns (uint256 seed) {
        seed = initialLiquidityPerProposal;
        uint256 available = protocolLiquiditySeed;
        if (seed > available) revert InsufficientProtocolSeed(seed, available);
        protocolLiquiditySeed = available - seed;
        (, address long_, address short_) = tokens.createProposalTokens(roundId, proposalId);
        ProposalToken(long_).mint(address(market), seed * SCALE);
        ProposalToken(short_).mint(address(market), seed * SCALE);
        market.seedLiquidity(roundId, proposalId, seed);
    }

    // ------------------------------------------------------------------ deposits, credits and trading

    /// @notice Deposits USDC (raw, 6 decimals) as collateral for this round. Allowed while trading is open.
    function deposit(uint256 roundId, uint256 amount) external nonReentrant {
        Round storage rd = _trading(roundId);
        if (amount == 0) revert ZeroAmount();
        deposits[roundId][msg.sender] += amount;
        rd.totalDeposits += amount;
        rd.depositsOutstanding += amount;
        emit Deposited(roundId, msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Mints CREDIT in one proposal. The cap is per proposal: claimed(r,p,user) <= deposit(r,user).
    function claimCredits(uint256 roundId, uint256 proposalId, uint256 amount) external nonReentrant {
        Round storage rd = _trading(roundId);
        if (proposalId >= rd.proposalCount) revert ProposalNotFound(roundId, proposalId);
        if (amount == 0) revert ZeroAmount();
        uint256 total = creditsClaimed[roundId][proposalId][msg.sender] + amount;
        uint256 deposited = deposits[roundId][msg.sender];
        if (total > deposited) revert ClaimExceedsDeposit(deposited, total);
        creditsClaimed[roundId][proposalId][msg.sender] = total;
        ProposalToken(tokens.creditToken(roundId, proposalId)).mint(msg.sender, amount);
        emit CreditsClaimed(roundId, proposalId, msg.sender, amount);
    }

    /// @notice Spends `amount` credits on LONG. `minOut` is in raw LONG units.
    function buyLong(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)
        external
        nonReentrant
        returns (uint256)
    {
        return _buy(roundId, proposalId, amount, minOut, true);
    }

    /// @notice Spends `amount` credits on SHORT. `minOut` is in raw SHORT units.
    function buyShort(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)
        external
        nonReentrant
        returns (uint256)
    {
        return _buy(roundId, proposalId, amount, minOut, false);
    }

    /// @notice Sells `amount` raw LONG for credits. `minOut` is in credits.
    function sellLong(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)
        external
        nonReentrant
        returns (uint256)
    {
        return _sell(roundId, proposalId, amount, minOut, true);
    }

    /// @notice Sells `amount` raw SHORT for credits. `minOut` is in credits.
    function sellShort(uint256 roundId, uint256 proposalId, uint256 amount, uint256 minOut)
        external
        nonReentrant
        returns (uint256)
    {
        return _sell(roundId, proposalId, amount, minOut, false);
    }

    function _buy(uint256 roundId, uint256 proposalId, uint256 credits, uint256 minOut, bool isLong)
        private
        returns (uint256 out)
    {
        _live(roundId, proposalId, credits);
        ProposalToken(tokens.creditToken(roundId, proposalId)).burn(msg.sender, credits);
        uint256 raw = credits * SCALE;
        ProposalToken(tokens.longToken(roundId, proposalId)).mint(address(market), raw);
        ProposalToken(tokens.shortToken(roundId, proposalId)).mint(address(market), raw);
        out = isLong
            ? market.tradeBuyLong(roundId, proposalId, credits, minOut, msg.sender)
            : market.tradeBuyShort(roundId, proposalId, credits, minOut, msg.sender);
        emit Bought(roundId, proposalId, msg.sender, isLong, credits, out);
    }

    function _sell(uint256 roundId, uint256 proposalId, uint256 amountIn, uint256 minCredits, bool isLong)
        private
        returns (uint256 credits)
    {
        _live(roundId, proposalId, amountIn);
        ProposalToken sold =
            ProposalToken(isLong ? tokens.longToken(roundId, proposalId) : tokens.shortToken(roundId, proposalId));
        sold.burn(msg.sender, amountIn);
        sold.mint(address(market), amountIn);
        if (isLong) market.tradeSellLong(roundId, proposalId, amountIn, minCredits);
        else market.tradeSellShort(roundId, proposalId, amountIn, minCredits);
        (credits,,) = market.consumeSellSettlement(roundId, proposalId, msg.sender);
        if (credits != 0) {
            uint256 raw = credits * SCALE;
            ProposalToken(tokens.longToken(roundId, proposalId)).burn(address(this), raw);
            ProposalToken(tokens.shortToken(roundId, proposalId)).burn(address(this), raw);
            ProposalToken(tokens.creditToken(roundId, proposalId)).mint(msg.sender, credits);
        }
        emit Sold(roundId, proposalId, msg.sender, isLong, amountIn, credits);
    }

    // ------------------------------------------------------------------ collapse, cancel, settle

    /// @notice Anyone, after tradingEnd. Picks the winner, finalises every market and refunds every bond.
    /// @dev The best proposal (highest TWAP, lowest id on ties) wins only if it beats proposal 0's TWAP by more
    ///      than EPSILON; otherwise proposal 0 wins. Losing seeds return to the protocol reserve.
    function collapse(uint256 roundId) external nonReentrant {
        Round storage rd = rounds[roundId];
        if (rd.status == RoundStatus.None) revert RoundNotFound(roundId);
        if (rd.status != RoundStatus.Trading) revert AlreadyCollapsed(roundId);
        if (block.timestamp < rd.tradingEnd) revert TradingNotEnded(roundId);

        uint256 n = rd.proposalCount;
        uint256[] memory twaps = new uint256[](n);
        uint256 best;
        for (uint256 p; p < n; ++p) {
            (twaps[p],) = market.closeTwapWindow(roundId, p);
            proposals[roundId][p].probabilityTwap = twaps[p];
            if (p != 0 && (best == 0 || twaps[p] > twaps[best])) best = p;
        }
        uint256 winner = (best != 0 && twaps[best] > twaps[0] + EPSILON) ? best : 0;
        rd.status = RoundStatus.Collapsed;
        rd.winnerId = uint8(winner);

        for (uint256 p; p < n; ++p) {
            market.finalizeProposal(roundId, p);
            Proposal storage pr = proposals[roundId][p];
            if (p != winner) protocolLiquiditySeed += pr.seedCredits;
            if (p != 0) registry.refundBond(pr.proposer, pr.bond);
        }
        rd.escrow = rd.totalDeposits + proposals[roundId][winner].seedCredits;
        if (winner != 0) registry.recordWin(proposals[roundId][winner].proposer);
        emit Collapsed(roundId, winner, twaps);
    }

    /// @notice VAULT_ROLE only: the vault's slippage guard. A cancelled round redeems deposits at par.
    function cancelRound(uint256 roundId) external onlyRole(VAULT_ROLE) nonReentrant {
        Round storage rd = rounds[roundId];
        if (rd.status != RoundStatus.Collapsed) revert NotCollapsed(roundId);
        rd.status = RoundStatus.Cancelled;
        emit RoundCancelled(roundId);
        _releaseIfClear(roundId, rd);
    }

    /// @notice RESOLVER_ROLE after evaluationEnd with the realised return ratio (1e18).
    /// @dev Anyone may call after evaluationEnd + EMERGENCY_SETTLE_DELAY, but then the supplied value is IGNORED and
    ///      the round settles at the midpoint of [rMin, rMax], so a stranger can never choose the outcome.
    function settle(uint256 roundId, uint256 realisedReturn) external nonReentrant {
        Round storage rd = rounds[roundId];
        if (rd.status != RoundStatus.Collapsed) revert NotCollapsed(roundId);
        if (block.timestamp < rd.evaluationEnd) revert EvaluationNotEnded(roundId);
        bool emergency = !hasRole(RESOLVER_ROLE, msg.sender);
        uint256 value = realisedReturn;
        if (emergency) {
            if (block.timestamp < uint256(rd.evaluationEnd) + EMERGENCY_SETTLE_DELAY) revert NotAuthorizedToSettle();
            value = (rd.rMin + rd.rMax) / 2;
        }
        uint256 clamped = Math.min(Math.max(value, rd.rMin), rd.rMax);
        uint256 pi = Math.mulDiv(clamped - rd.rMin, ONE, rd.rMax - rd.rMin);
        rd.realisedReturn = value;
        rd.pi = pi;
        rd.status = RoundStatus.Settled;
        emit RoundSettled(roundId, value, pi, emergency);
        _releaseIfClear(roundId, rd);
    }

    // ------------------------------------------------------------------ redemption

    /// @notice Pays the caller. Settled: (deposit - claimed[winner]) + winner CREDIT + LONG*pi + SHORT*(1-pi),
    ///         using only the winning proposal's tokens (burned here). Cancelled: the deposit at par.
    function redeem(uint256 roundId) external nonReentrant returns (uint256) {
        return _redeem(roundId, msg.sender);
    }

    /// @notice Same as `redeem`, for any `user`, so that nobody can hold the round's seed hostage by not redeeming.
    ///         The payout always goes to `user`; if that transfer fails it becomes a pending payout `user` can claim.
    function redeemFor(uint256 roundId, address user) external nonReentrant returns (uint256) {
        return _redeem(roundId, user);
    }

    /// @notice Pulls USDC that could not be sent to the caller during a redemption.
    function claimPayout() external nonReentrant {
        uint256 amount = pendingPayout[msg.sender];
        if (amount == 0) revert NothingToClaim();
        delete pendingPayout[msg.sender];
        emit PayoutClaimed(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    function _redeem(uint256 roundId, address user) private returns (uint256 payout) {
        // The tokens this contract holds are the market's returned inventory, not a user liability.
        if (user == address(this)) revert InvalidRedeemTarget(user);
        Round storage rd = rounds[roundId];
        RoundStatus s = rd.status;
        if (s != RoundStatus.Settled && s != RoundStatus.Cancelled) revert NotRedeemable(roundId);

        uint256 deposited = deposits[roundId][user];
        bool active = deposited != 0 && !redeemed[roundId][user];
        if (active) {
            redeemed[roundId][user] = true;
            rd.depositsOutstanding -= deposited;
            payout = deposited;
        }
        if (s == RoundStatus.Settled) {
            uint256 w = rd.winnerId;
            if (active) payout -= creditsClaimed[roundId][w][user];
            (uint256 c, uint256 l, uint256 sh) = _burnTokensOf(roundId, w, user);
            if (c != 0 || l != 0 || sh != 0) active = true;
            payout += c + Math.mulDiv(l, rd.pi, ONE * SCALE) + Math.mulDiv(sh, ONE - rd.pi, ONE * SCALE);
        }
        if (!active) revert NothingToRedeem();

        rd.totalPaid += payout;
        if (rd.totalPaid > rd.escrow) revert SolvencyViolation(roundId);
        emit Redeemed(roundId, user, payout);
        if (payout != 0) _pay(user, payout);
        _releaseIfClear(roundId, rd);
    }

    function _pay(address user, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (user, amount)));
        if (!(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (uint256)) == 1)))) {
            pendingPayout[user] += amount;
            emit PayoutDeferred(user, amount);
        }
    }

    /// @notice Permissionless. Returns the remaining winning seed to the reserve once nobody can still claim.
    ///         Reverts while liabilities remain; does nothing if the seed was already released.
    function releaseSeed(uint256 roundId) external nonReentrant {
        Round storage rd = rounds[roundId];
        if (rd.status != RoundStatus.Settled && rd.status != RoundStatus.Cancelled) revert NotRedeemable(roundId);
        if (rd.seedReleased) return;
        if (!_liabilitiesClear(roundId, rd)) revert LiabilitiesRemain(roundId);
        _releaseSeed(roundId, rd);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IQuantumRound
    function marketTiming(uint256 roundId, uint256)
        external
        view
        returns (uint64 tradingStart, uint64 tradingEnd, uint64 finalWindowSeconds)
    {
        Round storage rd = rounds[roundId];
        return (rd.tradingStart, rd.tradingEnd, rd.twapWindow);
    }

    function roundStatus(uint256 roundId) external view returns (RoundStatus) {
        return rounds[roundId].status;
    }

    function evaluationEnd(uint256 roundId) external view returns (uint256) {
        return rounds[roundId].evaluationEnd;
    }

    function winningAllocation(uint256 roundId) external view returns (uint256 proposalId, uint16 tEthBps) {
        Round storage rd = rounds[roundId];
        if (rd.status == RoundStatus.None || rd.status == RoundStatus.Trading) revert NotCollapsed(roundId);
        proposalId = rd.winnerId;
        tEthBps = proposals[roundId][proposalId].tEthBps;
    }

    function liabilitiesClear(uint256 roundId) external view returns (bool) {
        Round storage rd = rounds[roundId];
        return (rd.status == RoundStatus.Settled || rd.status == RoundStatus.Cancelled)
            && _liabilitiesClear(roundId, rd);
    }

    /// @notice What `redeem` would pay `user` right now (0 if not redeemable).
    function previewRedeem(uint256 roundId, address user) external view returns (uint256 payout) {
        Round storage rd = rounds[roundId];
        RoundStatus s = rd.status;
        if (s != RoundStatus.Settled && s != RoundStatus.Cancelled) return 0;
        uint256 deposited = deposits[roundId][user];
        bool first = deposited != 0 && !redeemed[roundId][user];
        if (first) payout = deposited;
        if (s == RoundStatus.Settled) {
            uint256 w = rd.winnerId;
            if (first) payout -= creditsClaimed[roundId][w][user];
            payout += IERC20(tokens.creditToken(roundId, w)).balanceOf(user)
                + Math.mulDiv(IERC20(tokens.longToken(roundId, w)).balanceOf(user), rd.pi, ONE * SCALE)
                + Math.mulDiv(IERC20(tokens.shortToken(roundId, w)).balanceOf(user), ONE - rd.pi, ONE * SCALE);
        }
    }

    // ------------------------------------------------------------------ internals

    function _trading(uint256 roundId) private view returns (Round storage rd) {
        rd = rounds[roundId];
        if (rd.status == RoundStatus.None) revert RoundNotFound(roundId);
        if (rd.status != RoundStatus.Trading || block.timestamp >= rd.tradingEnd) revert TradingNotOpen(roundId);
    }

    function _live(uint256 roundId, uint256 proposalId, uint256 amount) private view {
        Round storage rd = _trading(roundId);
        if (proposalId >= rd.proposalCount) revert ProposalNotFound(roundId, proposalId);
        if (amount == 0) revert ZeroAmount();
    }

    function _burnTokensOf(uint256 roundId, uint256 proposalId, address user)
        private
        returns (uint256 c, uint256 l, uint256 s)
    {
        ProposalToken credit = ProposalToken(tokens.creditToken(roundId, proposalId));
        ProposalToken long_ = ProposalToken(tokens.longToken(roundId, proposalId));
        ProposalToken short_ = ProposalToken(tokens.shortToken(roundId, proposalId));
        c = credit.balanceOf(user);
        l = long_.balanceOf(user);
        s = short_.balanceOf(user);
        if (c != 0) credit.burn(user, c);
        if (l != 0) long_.burn(user, l);
        if (s != 0) short_.burn(user, s);
    }

    /// @dev Supply of a winning token held by anyone other than this contract (which keeps the market's returned lumps).
    function _external(address token) private view returns (uint256) {
        return IERC20(token).totalSupply() - IERC20(token).balanceOf(address(this));
    }

    function _liabilitiesClear(uint256 roundId, Round storage rd) private view returns (bool) {
        if (rd.depositsOutstanding != 0) return false;
        if (rd.status == RoundStatus.Cancelled) return true;
        uint256 w = rd.winnerId;
        // LONG/SHORT below one credit's worth (1e12 raw) always redeem to 0 USDC. The pool manager keeps a few wei of
        // rounding dust that nobody can redeem, so only a full credit's worth of either leg counts as a liability.
        return _external(tokens.creditToken(roundId, w)) == 0 && _external(tokens.longToken(roundId, w)) < SCALE
            && _external(tokens.shortToken(roundId, w)) < SCALE;
    }

    function _releaseIfClear(uint256 roundId, Round storage rd) private {
        if (rd.seedReleased) return;
        if (rd.status != RoundStatus.Settled && rd.status != RoundStatus.Cancelled) return;
        if (_liabilitiesClear(roundId, rd)) _releaseSeed(roundId, rd);
    }

    function _releaseSeed(uint256 roundId, Round storage rd) private {
        rd.seedReleased = true;
        uint256 remaining = rd.escrow - rd.totalPaid;
        protocolLiquiditySeed += remaining;
        emit SeedReleased(roundId, remaining);
    }
}
