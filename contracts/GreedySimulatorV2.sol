// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "./RouteSimulatorV2Base.sol";

/// @title GreedySimulatorV2
/// @notice Greedy allocation of flash borrow across N parallel highway alternatives.
///         Inherits RouteSimulatorV2Base (V2 adaptive packing with on-chain amountOut).
///
/// Algorithm:
///   1. Select flash source — route with minimum loss (deepest pool)
///   2. Slice inner alts: alts[i] = routes[i][1..] for each i
///   3. Greedy loop (chunks iterations):
///      a. best = argmax(scores[])
///      b. simulate(alts[best], chunk) — real swap with commit
///      c. scores[best] = realFactor(amounts) — update from real execution
///      d. allocations[best] += chunk
///   4. Assemble calldata: for each alt with allocation > 0
///      pack commands for the full accumulated amount
///
/// Used ONLY for off-chain simulation (reth-mev node).
/// NOT for on-chain execution.
contract GreedySimulatorV2 is RouteSimulatorV2Base {

    struct GreedyResult {
        uint256   profit;          // WETH profit after repay
        uint256[] allocations;     // borrowed token per alt
        uint256[] amountsOut;      // WETH out per alt
        uint256[] finalFactors;    // real factor from last chunk
        bytes     calldata_;       // full packed calldata for MEV.huff
        string    error;
    }

    /// @param routes      Full routes: routes[i][0]=flash, routes[i][1..]=inner
    ///                    All routes must have same flash token (borrowToken = routes[i][0].tokenOut)
    ///                    and return WETH at output.
    ///                    Caller guarantees: inner pools don't overlap between routes.
    /// @param initFactors factor_loss * 1e18 from DB for each route
    /// @param initLosses  best_loss in bps from DB (for flash source selection)
    /// @param chunks      Granularity (recommended 20-50)
    /// @param weth        WETH address
    /// @param vault       Profit recipient
    function simulateGreedyFlash(
        Hop[][]   memory routes,
        uint256[] memory initFactors,
        uint256[] memory initLosses,
        uint256          chunks,
        address          weth,
        address          vault,
        uint16           slippageBips
    ) external returns (GreedyResult memory result) {
        require(slippageBips <= 10000, "bips>100%");
        uint256 n = routes.length;
        require(n >= 2 && n <= 8, "routes: 2..8");
        require(initFactors.length == n, "factors length mismatch");
        require(initLosses.length == n, "losses length mismatch");
        require(chunks >= 5 && chunks <= 100, "chunks: 5..100");

        result.allocations  = new uint256[](n);
        result.amountsOut   = new uint256[](n);
        result.finalFactors = new uint256[](n);

        // Copy initFactors as working scores
        uint256[] memory scores = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            scores[i] = initFactors[i];
        }

        // 1. Select flash source: route with minimum loss
        uint256 flashIdx = 0;
        for (uint256 i = 1; i < n; i++) {
            if (initLosses[i] < initLosses[flashIdx]) {
                flashIdx = i;
            }
        }
        Hop memory flashHop = routes[flashIdx][0];

        // 2. Slice inner alts
        Hop[][] memory alts = new Hop[][](n);
        for (uint256 i = 0; i < n; i++) {
            require(routes[i].length >= 2, "route too short");
            alts[i] = new Hop[](routes[i].length - 1);
            for (uint256 h = 1; h < routes[i].length; h++) {
                alts[i][h - 1] = routes[i][h];
            }
        }

        // 3. Flash borrow
        address borrowToken = flashHop.tokenOut;
        uint256 poolBalance = _isNativeEth(borrowToken)
            ? flashHop.pool.balance
            : IERC20(borrowToken).balanceOf(flashHop.pool);
        uint256 maxBorrow = poolBalance - poolBalance / 100; // -1%

        _flashWeth              = weth;
        _flashHop               = flashHop;
        _flashAmountIn          = maxBorrow;
        _flashWethBalanceBefore = IERC20(weth).balanceOf(address(this));
        _callbackMode           = 1;

        // Save context for callback via storage
        _greedyAlts    = alts;
        _greedyScores  = scores;
        _greedyChunks  = chunks;
        _greedyN       = n;
        _greedyVault   = vault;

        bytes memory flashData = abi.encode(uint8(1));
        try this.executeFlash(flashHop, maxBorrow, flashData) {
        } catch Error(string memory reason) {
            _callbackMode = 0;
            result.error = string.concat("[GF] flash: ", reason);
            _cleanGreedyStorage();
            return result;
        } catch (bytes memory raw) {
            _callbackMode = 0;
            result.error = string.concat("[GF] flash: 0x", _toHexBytes(raw));
            _cleanGreedyStorage();
            return result;
        }
        _callbackMode = 0;

        // 4. Collect result from storage (filled by callback)
        result.allocations  = _greedyResult.allocations;
        result.amountsOut   = _greedyResult.amountsOut;
        result.finalFactors = _greedyResult.finalFactors;

        uint256 wethAfter = IERC20(weth).balanceOf(address(this));
        if (wethAfter > _flashWethBalanceBefore) {
            uint256 rawProfit = wethAfter - _flashWethBalanceBefore;
            result.profit = rawProfit * (10000 - uint256(slippageBips)) / 10000;
        }
        uint256 minWeth = _flashWethBalanceBefore + result.profit;

        // 5. Assemble calldata
        bytes memory flashHeader = _packFlashHeader(flashHop, maxBorrow);
        bytes memory innerCmds = _greedyInnerCmds;
        bytes memory repayCmd = _packTransferERC20(weth, address(flashHop.pool), _greedyRepay);

        result.calldata_ = bytes.concat(
            flashHeader,
            bytes3(uint24(innerCmds.length + repayCmd.length)),
            innerCmds,
            repayCmd,
            _packBalanceCheck(address(this), weth, minWeth),
            _packSweep(weth, vault)
        );

        _cleanGreedyStorage();
    }

    // Override _flashForwardCallback to use greedy logic
    function _flashForwardCallback(uint256 repayAmount) internal override {
        _greedyForwardCallback(repayAmount);
    }

    /// @dev Greedy callback — instead of simulate(innerHops), greedy loop over alts.
    /// Uses storage arrays to avoid stack-too-deep.
    ///
    /// Two phases:
    ///   1. Chunk loop — simulate chunks, accumulate amounts per alt per hop
    ///   2. Pack — one _packCommand() per hop per alt with summed amounts
    function _greedyForwardCallback(uint256 repayAmount) internal {
        _callbackMode = 0;
        _greedyRepay  = repayAmount;

        uint256 n        = _greedyN;
        uint256 borrowed = _flashAmountIn;
        uint256 chunk    = borrowed / _greedyChunks;

        // Pre-allocate result arrays in storage
        _greedyResult.allocations  = new uint256[](n);
        _greedyResult.amountsOut   = new uint256[](n);
        _greedyResult.finalFactors = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            _greedyResult.finalFactors[i] = _greedyScores[i];
        }

        // Pre-allocate hop amount accumulators per alt
        _greedyHopAmounts = new uint256[2][][](n);
        for (uint256 i = 0; i < n; i++) {
            _greedyHopAmounts[i] = new uint256[2][](_greedyAlts[i].length);
        }

        // First chunk gets the remainder
        uint256 firstAmount = chunk + (borrowed - chunk * _greedyChunks);

        // Phase 1: chunk loop — simulate + accumulate amounts
        for (uint256 iter = 0; iter < _greedyChunks; iter++) {
            _greedyIteration(iter == 0 ? firstAmount : chunk, n);
        }

        // Phase 2: pack commands from accumulated amounts (no simulate)
        // V2 _packCommand takes 4 args: (hop, amountIn, amountOut, isIntermediate)
        // Greedy accumulated amounts are final totals → isIntermediate = false
        bytes memory allInnerCmds;
        for (uint256 i = 0; i < n; i++) {
            if (_greedyResult.allocations[i] > 0) {
                for (uint256 h = 0; h < _greedyAlts[i].length; h++) {
                    allInnerCmds = bytes.concat(allInnerCmds, _packCommand(
                        _greedyAlts[i][h], _greedyHopAmounts[i][h][0], _greedyHopAmounts[i][h][1], false
                    ));
                }
                _greedyResult.amountsOut[i] = _greedyHopAmounts[i][_greedyAlts[i].length - 1][1];
            }
        }

        // Repay (V2/V3: transfer WETH directly to pool)
        if (_flashHop.dex != 2) {
            require(IERC20(_flashWeth).balanceOf(address(this)) >= repayAmount, 'GREEDY REPAY!');
            require(safeTransfer(_flashWeth, msg.sender, repayAmount), 'GREEDY TRF');
        }

        _greedyInnerCmds = allInnerCmds;
    }

    /// @dev Single greedy iteration — split out to reduce stack depth.
    /// Accumulates allocations + hop amounts. No cmd packing.
    /// Failed routes get score=0 (excluded from future iterations).
    function _greedyIteration(uint256 amount, uint256 n) internal {
        // Find best alt by current score
        uint256 bestIdx   = 0;
        uint256 bestScore = 0;
        for (uint256 i = 0; i < n; i++) {
            if (_greedyScores[i] > bestScore) {
                bestScore = _greedyScores[i];
                bestIdx   = i;
            }
        }

        // No viable routes left — all scores are 0
        if (bestScore == 0) return;

        // Execute swap (with commit — state changes move reserves).
        // Wrap in try-catch: if route reverts, kill its score and retry
        // with next-best route in the same iteration.
        try this.simulate(_greedyAlts[bestIdx], amount)
            returns (uint256, bytes memory, uint256[2][] memory amounts, uint16[] memory)
        {
            // Update score from real execution factor
            uint256 newFactor = _factorFromAmounts(amounts);
            _greedyScores[bestIdx]             = newFactor;
            _greedyResult.finalFactors[bestIdx] = newFactor;

            // Accumulate allocation + per-hop amounts
            _greedyResult.allocations[bestIdx] += amount;
            for (uint256 h = 0; h < amounts.length; h++) {
                _greedyHopAmounts[bestIdx][h][0] += amounts[h][0];
                _greedyHopAmounts[bestIdx][h][1] += amounts[h][1];
            }
        } catch {
            // Route failed — exclude from future iterations
            _greedyScores[bestIdx] = 0;
            _greedyResult.finalFactors[bestIdx] = 0;
            // Retry this chunk with the next-best route (recursive, bounded by n)
            _greedyIteration(amount, n);
        }
    }

    // Helpers

    /// @dev Real execution factor from amounts[]: totalOut / totalIn * 1e18
    function _factorFromAmounts(uint256[2][] memory amounts) internal pure returns (uint256) {
        if (amounts.length == 0) return 0;
        uint256 totalIn  = amounts[0][0];
        uint256 totalOut = amounts[amounts.length - 1][1];
        if (totalIn == 0) return 0;
        return totalOut * 1e18 / totalIn;
    }

    // Greedy context storage (data passing through callback)

    struct GreedyStorageResult {
        uint256[] allocations;
        uint256[] amountsOut;
        uint256[] finalFactors;
    }

    Hop[][]   internal _greedyAlts;
    uint256[] internal _greedyScores;
    uint256   internal _greedyChunks;
    uint256   internal _greedyN;
    address   internal _greedyVault;
    uint256   internal _greedyRepay;
    bytes     internal _greedyInnerCmds;
    uint256[2][][] internal _greedyHopAmounts; // [altIdx][hopIdx][0=in, 1=out]
    GreedyStorageResult internal _greedyResult;

    function _cleanGreedyStorage() internal {
        delete _greedyAlts;
        delete _greedyScores;
        _greedyChunks = 0;
        _greedyN      = 0;
        _greedyVault  = address(0);
        _greedyRepay  = 0;
        delete _greedyInnerCmds;
        delete _greedyHopAmounts;
        delete _greedyResult;
    }
}
