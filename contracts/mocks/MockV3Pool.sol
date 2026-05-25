// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Minimal mock of Uniswap V3 pool that supports swap() with callback
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    bool public immutable bonus; // true = positive fee (give more output)

    constructor(address _token0, address _token1, uint24 _fee, bool _bonus) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        bonus = _bonus;
    }

    function tickSpacing() external view returns (int24) {
        if (fee == 100) return 1;
        if (fee == 500) return 10;
        if (fee == 3000) return 60;
        if (fee == 10000) return 200;
        return 60;
    }

    /// @dev swap() matching Uniswap V3 signature — uses K invariant with reserves
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 /* sqrtPriceLimitX96 */,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        // Read reserves from token balances (like real pools)
        uint256 reserve0 = IERC20(token0).balanceOf(address(this));
        uint256 reserve1 = IERC20(token1).balanceOf(address(this));
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;

        // bonus: fee is positive (ask less), normal: fee is negative (charge fee)
        uint256 feeMul = bonus ? (1e6 + uint256(fee)) : (1e6 - uint256(fee));

        uint256 amountIn;
        uint256 amountOut;
        if (amountSpecified > 0) {
            // Exact input: K invariant
            amountIn = uint256(amountSpecified);
            uint256 amountInWithFee = amountIn * feeMul;
            amountOut = amountInWithFee * reserveOut / (reserveIn * 1e6 + amountInWithFee);
        } else {
            // Exact output: K invariant (ceil div)
            amountOut = uint256(-amountSpecified);
            amountIn = reserveIn * amountOut * 1e6 / ((reserveOut - amountOut) * feeMul) + 1;
        }
        require(amountOut < reserveOut, "insufficient liquidity");

        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(amountOut);
        } else {
            amount0 = -int256(amountOut);
            amount1 = int256(amountIn);
        }

        // Transfer output tokens to recipient
        address tokenOut = zeroForOne ? token1 : token0;
        IERC20(tokenOut).transfer(recipient, amountOut);

        // Call the swap callback to receive input tokens
        // uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes data)
        (bool success,) = msg.sender.call(
            abi.encodeWithSelector(_callbackSelector(), amount0, amount1, data)
        );
        require(success, "callback failed");

        return (amount0, amount1);
    }

    function _callbackSelector() internal pure virtual returns (bytes4) {
        return 0xfa461e33; // uniswapV3SwapCallback(int256,int256,bytes)
    }

    /// @dev flash() matching Uniswap V3 signature: flash(address,uint256,uint256,bytes)
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external {
        // Transfer flash amounts
        if (amount0 > 0) {
            IERC20(token0).transfer(recipient, amount0);
        }
        if (amount1 > 0) {
            IERC20(token1).transfer(recipient, amount1);
        }

        // Call flash callback: uniswapV3FlashCallback(uint256,uint256,bytes)
        // selector 0xe9cbafb0
        (bool success,) = msg.sender.call(
            abi.encodeWithSelector(0xe9cbafb0, amount0, amount1, data)
        );
        require(success, "flash callback failed");
    }
}
