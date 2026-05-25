// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev V2 pair mock with configurable fee enforced in K invariant.
///      Real Uniswap V2 uses: balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * 10000^2
///      where balanceAdjusted = balance * 10000 - amountIn * fee_bps.
contract MockV2PairWithFee {
    address public token0;
    address public token1;
    uint256 public feeBps;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    constructor(address _token0, address _token1, uint256 _feeBps) {
        if (uint160(_token0) < uint160(_token1)) {
            token0 = _token0;
            token1 = _token1;
        } else {
            token0 = _token1;
            token1 = _token0;
        }
        feeBps = _feeBps;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function sync() external {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
        blockTimestampLast = uint32(block.timestamp);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "insufficient output");
        require(amount0Out < reserve0 && amount1Out < reserve1, "insufficient liquidity");

        uint256 _reserve0 = uint256(reserve0);
        uint256 _reserve1 = uint256(reserve1);

        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        // Fee-adjusted K check (matches real Uniswap V2 logic)
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;

        uint256 balance0Adjusted = balance0 * 10000 - amount0In * feeBps;
        uint256 balance1Adjusted = balance1 * 10000 - amount1In * feeBps;
        require(balance0Adjusted * balance1Adjusted >= _reserve0 * _reserve1 * 10000 * 10000, "K");

        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
    }
}
