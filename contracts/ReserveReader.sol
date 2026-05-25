// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IBalancerVault {
    function getPoolTokens(bytes32 poolId) external view returns (
        address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock
    );
}

interface IBalancerV1Pool {
    function getCurrentTokens() external view returns (address[] memory);
    function getBalance(address token) external view returns (uint256);
}

interface IPoolManager {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title ReserveReader — batched reserve query for all DEX types
/// @dev Deploy via state override (eth_call). One call → all reserves.
///      Input: (address, poolId, dex) per pool. Output: (reserve0, reserve1) per pool.
///      On failure for any pool → (0, 0), no revert.
contract ReserveReader {
    // Dex enum: 0=V2, 1=V3, 2=V4, 3=Balancer, 4=Curve, 5=Unknown, 6=BalancerV1, 7=FluidDex, 8=DodoV2

    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    struct PoolQuery {
        address pool;
        bytes32 poolId;
        uint8 dex;
    }

    /// @notice Read reserves for a batch of pools
    /// @param queries Array of (pool address, poolId, dex type)
    /// @param tokens0 Array of token0 addresses (parallel to queries)
    /// @param tokens1 Array of token1 addresses (parallel to queries)
    /// @return reserves0 reserve of token0 per pool
    /// @return reserves1 reserve of token1 per pool
    function getReserves(
        PoolQuery[] calldata queries,
        address[] calldata tokens0,
        address[] calldata tokens1
    ) external view returns (uint256[] memory reserves0, uint256[] memory reserves1) {
        uint256 len = queries.length;
        reserves0 = new uint256[](len);
        reserves1 = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            // External self-call for gas isolation: if one pool OOGs or panics,
            // only that call fails — the rest of the batch continues.
            try this.readSingle(
                queries[i].pool, queries[i].poolId, queries[i].dex,
                tokens0[i], tokens1[i]
            ) returns (uint256 r0, uint256 r1) {
                reserves0[i] = r0;
                reserves1[i] = r1;
            } catch {
                reserves0[i] = 0;
                reserves1[i] = 0;
            }
        }
    }

    /// @notice Read reserves for a single pool (external for try/catch gas isolation)
    function readSingle(
        address pool, bytes32 poolId, uint8 dex,
        address token0, address token1
    ) external view returns (uint256 r0, uint256 r1) {
        if (dex == 3) {
            // Balancer V2: vault.getPoolTokens(poolId)
            (address[] memory tokens, uint256[] memory balances,) =
                IBalancerVault(BALANCER_VAULT).getPoolTokens(poolId);
            for (uint256 j = 0; j < tokens.length; j++) {
                if (tokens[j] == token0) r0 = balances[j];
                if (tokens[j] == token1) r1 = balances[j];
            }
            return (r0, r1);
        }

        if (dex == 6) {
            // Balancer V1: pool.getBalance(token)
            r0 = IBalancerV1Pool(pool).getBalance(token0);
            r1 = IBalancerV1Pool(pool).getBalance(token1);
            return (r0, r1);
        }

        if (dex == 2) {
            // V4: read virtual reserves from PoolManager via extsload
            address poolManager = 0x000000000004444C5dC75cb16c3024b0B4C6736f;
            // Pool state slot: keccak256(abi.encode(poolId, POOLS_SLOT))
            // POOLS_SLOT = 6 in PoolManager storage layout
            bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(6)));
            // stateSlot + 0: low 160 bits = sqrtPriceX96
            uint160 sqrtPriceX96 = uint160(uint256(
                IPoolManager(poolManager).extsload(stateSlot)
            ));
            // stateSlot + 1: low 128 bits = liquidity
            uint128 liquidity = uint128(uint256(
                IPoolManager(poolManager).extsload(bytes32(uint256(stateSlot) + 1))
            ));
            if (sqrtPriceX96 == 0 || liquidity == 0) return (0, 0);
            // Virtual reserves: r0 = L * 2^96 / sqrtP, r1 = L * sqrtP / 2^96
            r0 = uint256(liquidity) * (1 << 96) / uint256(sqrtPriceX96);
            r1 = uint256(liquidity) * uint256(sqrtPriceX96) / (1 << 96);
            return (r0, r1);
        }

        // V2(0), V3(1), Curve(4), FluidDex(7), DodoV2(8), Unknown(5): balanceOf on pool
        r0 = IERC20(token0).balanceOf(pool);
        r1 = IERC20(token1).balanceOf(pool);
        return (r0, r1);
    }
}
