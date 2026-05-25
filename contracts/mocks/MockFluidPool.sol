// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Minimal mock of Fluid DEX pool that supports swap()
/// Real interface: swap(bool swap0to1, uint256 amountIn, uint256 amountOut, address to) → uint256
contract MockFluidPool {
    address public token0;
    address public token1;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    /// @dev swap(bool swap0to1, uint256 amountIn, uint256 amountOut, address to)
    /// selector: 0xf9366446
    /// Transfer-first pattern: caller must transfer tokenIn to pool before calling swap
    function swap(
        bool swap0to1,
        uint256 amountIn,
        uint256, // amountOut (minimum, ignored in mock)
        address to
    ) external returns (uint256) {
        uint256 amountOut = amountIn * 997 / 1000; // simple fee

        address tokenOut = swap0to1 ? token1 : token0;
        IERC20(tokenOut).transfer(to, amountOut);

        return amountOut;
    }
}
