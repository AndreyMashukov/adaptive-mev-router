// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @dev Minimal mock of Balancer V1 BPool that supports swapExactAmountIn()
contract MockBalancerV1Pool {
    address public token0;
    address public token1;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    /// @dev swapExactAmountIn(address tokenIn, uint tokenAmountIn, address tokenOut, uint minAmountOut, uint maxPrice)
    /// selector: 0x8201aa3f
    /// returns (uint tokenAmountOut, uint spotPriceAfter)
    function swapExactAmountIn(
        address tokenIn,
        uint256 tokenAmountIn,
        address tokenOut,
        uint256, // minAmountOut
        uint256  // maxPrice
    ) external returns (uint256 tokenAmountOut, uint256 spotPriceAfter) {
        tokenAmountOut = tokenAmountIn * 997 / 1000; // simple fee
        spotPriceAfter = 1e18; // dummy

        IERC20(tokenIn).transferFrom(msg.sender, address(this), tokenAmountIn);
        IERC20(tokenOut).transfer(msg.sender, tokenAmountOut);
    }
}
