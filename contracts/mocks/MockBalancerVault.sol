// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Minimal mock of Balancer V2 Vault that supports swap()
contract MockBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    /// @dev swap() with proper Balancer V2 ABI (selector 0x52bbbe29).
    /// Works for both RouteSimulator (standard ABI encoding) and MEV.yul
    /// (which also uses standard ABI encoding for this call).
    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256, // limit
        uint256  // deadline
    ) external returns (uint256) {
        uint256 amountIn;
        uint256 amountOut;

        if (singleSwap.kind == SwapKind.GIVEN_IN) {
            amountIn = singleSwap.amount;
            amountOut = amountIn * 997 / 1000;
        } else {
            // GIVEN_OUT: amount = desired output
            amountOut = singleSwap.amount;
            amountIn = (amountOut * 1000 + 996) / 997; // ceil div
        }

        // Pull input from sender
        IERC20(singleSwap.assetIn).transferFrom(funds.sender, address(this), amountIn);

        // Send output to recipient
        IERC20(singleSwap.assetOut).transfer(funds.recipient, amountOut);

        return singleSwap.kind == SwapKind.GIVEN_IN ? amountOut : amountIn;
    }

    // --- Pool registry for getPoolTokens ---

    mapping(bytes32 => address[]) private _poolTokens;

    function registerPool(bytes32 poolId, address[] calldata tokens) external {
        _poolTokens[poolId] = tokens;
    }

    function getPoolTokens(bytes32 poolId) external view returns (
        address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock
    ) {
        tokens = _poolTokens[poolId];
        balances = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
        lastChangeBlock = block.number;
    }

    receive() external payable {}
}
