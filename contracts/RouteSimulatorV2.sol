// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import "./RouteSimulatorV2Base.sol";

/// @title RouteSimulatorV2 — Public entry points for V2 adaptive route simulation
/// @notice Inherits RouteSimulatorV2Base for all execution + V2 packing logic.
///         Adds frontrun/backrun (sandwich), diagnosticSwap, diagnosticFlashSwap.
contract RouteSimulatorV2 is RouteSimulatorV2Base {

    /// @notice Classical sandwich front leg. Executes route forward, saves state for backrun().
    function frontrun(Hop[] memory route, uint256 amountIn) public
        returns (uint256 amountOut, bytes memory commands, uint256[2][] memory amounts, uint16[] memory impacts)
    {
        (amountOut, commands, amounts, impacts) = simulate(route, amountIn);

        savedAmountIn = amountOut;
        delete _savedRoute;
        for (uint256 i = 0; i < route.length; i++) {
            _savedRoute.push(route[i]);
        }
    }

    /// @notice Classical sandwich back leg. Reverses saved route from frontrun().
    function backrun(address vault, uint16 slippageBips) public
        returns (uint256 amountOut, bytes memory commands, uint256[2][] memory amounts, uint16[] memory impacts)
    {
        require(slippageBips <= 10000, "bips>100%");
        require(savedAmountIn > 0, "no front executed");
        require(_savedRoute.length >= 1, "no saved route");

        Hop[] memory reversed = new Hop[](_savedRoute.length);
        for (uint256 i = 0; i < _savedRoute.length; i++) {
            Hop storage orig = _savedRoute[_savedRoute.length - 1 - i];
            reversed[i] = Hop({
                pool:        orig.pool,
                dex:         orig.dex,
                zeroForOne:  !orig.zeroForOne,
                tokenIn:     orig.tokenOut,
                tokenOut:    orig.tokenIn,
                feeBps:      orig.feeBps,
                tickSpacing: orig.tickSpacing,
                hooks:       orig.hooks,
                poolId:      orig.poolId,
                selector:    orig.selector,
                idx0:        orig.idx1,
                idx1:        orig.idx0,
                to:          address(0)
            });
        }

        // Use actual balance instead of saved amountIn — more robust after victims execute
        uint256 sellAmount = IERC20(reversed[0].tokenIn).balanceOf(address(this));
        require(sellAmount > 0, "no tokenIn balance");

        uint256 wethBefore = IERC20(WETH_ADDR).balanceOf(address(this));
        // resolveAll: all hops pack amount=0 → on-chain MEV.huff uses balanceOf(tokenIn)
        (amountOut, commands, amounts, impacts) = simulateResolveAll(reversed, sellAmount);
        uint256 wethAfter = IERC20(WETH_ADDR).balanceOf(address(this));

        if (wethAfter > wethBefore) {
            uint256 rawProfit = wethAfter - wethBefore;
            amountOut = rawProfit * (10000 - uint256(slippageBips)) / 10000;
        }
        uint256 minWeth = wethBefore + amountOut;
        commands = bytes.concat(
            commands,
            _packBalanceCheck(address(this), WETH_ADDR, minWeth),
            _packSweep(WETH_ADDR, vault)
        );

        savedAmountIn = 0;
        delete _savedRoute;
    }

    /// @notice Diagnostic: execute single hop swap with fee detection (V2) and error capture
    function diagnosticSwap(Hop memory hop, uint256 amountIn) external returns (Diagnostic memory d) {
        d.pool = hop.pool;
        d.amountIn = amountIn;

        if (hop.dex == 0) {
            IUniswapV2Pair pair = IUniswapV2Pair(hop.pool);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            d.reserveIn = hop.zeroForOne ? uint256(r0) : uint256(r1);
            d.reserveOut = hop.zeroForOne ? uint256(r1) : uint256(r0);

            if (d.reserveIn == 0 || d.reserveOut == 0) {
                d.error = string.concat("pool=", _toHex(hop.pool), " V2 LQD");
                return d;
            }

            if (amountIn > d.reserveIn) amountIn = d.reserveIn;
            d.amountIn = amountIn;

            if (!safeTransfer(hop.tokenIn, hop.pool, amountIn)) {
                d.error = string.concat("pool=", _toHex(hop.pool), " TRF");
                return d;
            }

            uint16[6] memory tiers = [uint16(10), 20, 25, 30, 50, 100];
            for (uint256 i = 0; i < tiers.length; i++) {
                uint256 inWithFee = amountIn * (10000 - uint256(tiers[i]));
                uint256 expected = inWithFee * d.reserveOut / (d.reserveIn * 10000 + inWithFee);
                if (expected == 0) continue;

                uint256 a0 = hop.zeroForOne ? uint256(0) : expected;
                uint256 a1 = hop.zeroForOne ? expected : uint256(0);
                (bool ok,) = hop.pool.call(
                    abi.encodeWithSelector(hop.selector, a0, a1, address(this), new bytes(0))
                );
                if (ok) {
                    d.feeBps = uint24(tiers[i]);
                    d.amountOut = expected;
                    d.success = true;
                    return d;
                }
            }
            d.error = string.concat("pool=", _toHex(hop.pool), " FEE");
            return d;
        }

        try this.executeHop(0, hop, amountIn) returns (uint256 out, uint256) {
            d.amountOut = out;
            d.success = true;
        } catch Error(string memory reason) {
            d.error = string.concat("pool=", _toHex(hop.pool), " ", reason);
        } catch (bytes memory raw) {
            d.error = string.concat("pool=", _toHex(hop.pool), " 0x", _toHexBytes(raw));
        }
    }

    /// @notice Flash swap diagnostic: test if pool supports flash and can repay.
    function diagnosticFlashSwap(
        Hop[] memory route,
        uint256 borrowAmount,
        address weth
    ) external returns (Diagnostic memory d) {
        require(route.length >= 2, "need >= 2 hops");
        d.pool = route[0].pool;
        d.amountIn = borrowAmount;

        if (route[0].dex == 0) {
            IUniswapV2Pair pair = IUniswapV2Pair(route[0].pool);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            d.reserveIn = route[0].zeroForOne ? uint256(r0) : uint256(r1);
            d.reserveOut = route[0].zeroForOne ? uint256(r1) : uint256(r0);
        }

        try this.simulateFlash(route, borrowAmount, weth, address(this), 0) returns (uint256 profit, bytes memory, uint256[2][] memory, uint16[] memory) {
            d.amountOut = profit;
            d.success = true;
        } catch Error(string memory reason) {
            d.error = string.concat("pool=", _toHex(route[0].pool), " ", reason);
        } catch (bytes memory raw) {
            d.error = string.concat("pool=", _toHex(route[0].pool), " 0x", _toHexBytes(raw));
        }
    }
}
