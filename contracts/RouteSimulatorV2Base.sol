// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;
// --- Inline interfaces (no dependency files) ---

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes memory data) external;
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes memory data
    ) external returns (int256 amount0, int256 amount1);
}

interface IBalancerVault {
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

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external returns (uint256);

    function getPoolTokens(bytes32 poolId) external view returns (
        address[] memory tokens,
        uint256[] memory balances,
        uint256 lastChangeBlock
    );
}

interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes memory data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function sync(address token) external;
    function settle() external payable returns (uint256);
    function take(address token, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title RouteSimulatorV2Base — V2 adaptive packing (on-chain amountOut, balanceOf fallback)
/// @notice Inherits execution logic from V1, changes only _pack* methods.
///         Key differences from V1:
///         - V2 swap: 61B (was 73B), no amountOut, added fee_bps
///         - wrap/unwrap WETH: 15B (was 10B), amount=14 bytes
///         - New sweep command (0x0E): 41B, transfers entire token balance
///         - Intermediate hops: amtIn=0 (balanceOf fallback on-chain)
contract RouteSimulatorV2Base {

    /// @dev Swap call reverted without data — likely wrong selector.
    error SwapFailed(string dex, bytes4 selector);

    struct Hop {
        address pool;        // V2 pair / V3 pool / Curve pool / Balancer vault / V4 PoolManager
        uint8   dex;         // 0=V2, 1=V3, 2=V4, 3=Balancer, 4=Curve
        bool    zeroForOne;
        address tokenIn;
        address tokenOut;
        uint24  feeBps;      // V2: custom fee bps (30=0.3%); V4: fee tier
        int24   tickSpacing; // V4 only
        address hooks;       // V4 only
        bytes32 poolId;      // Balancer only
        bytes4  selector;    // swap function selector (all DEXes)
        uint256 idx0;        // Curve index 0
        uint256 idx1;        // Curve index 1
        address to;          // recipient override. address(0) = address(this) (default)
    }

    struct Diagnostic {
        address pool;
        uint256 amountIn;
        uint256 amountOut;
        uint24  feeBps;
        uint256 reserveIn;
        uint256 reserveOut;
        bool    success;
        string  error;
    }

    event SimulationStart(uint256 amountOut, uint256 totalAmountIn);
    uint256 public savedAmountIn;
    Hop[] internal _savedRoute;

    // V4 unlock context
    Hop internal _v4Hop;
    uint256 internal _v4AmountIn;
    uint256 internal _v4AmountOut;

    // V3 callback saves actual repay amount
    uint256 internal _v3UsedAmountIn;

    // Flash callback mode: 0 = forward swap, 1 = flash borrow
    uint8 internal _callbackMode;
    Hop[] internal _flashInnerHops;
    address internal _flashWeth;
    Hop internal _flashHop;
    uint256 internal _flashAmountIn;
    uint256 internal _flashWethBalanceBefore;

    // Flash callback → caller data passing (storage bridge)
    bytes internal _flashInnerCommands;
    uint256[2][] internal _flashAmounts;
    uint16[] internal _flashImpacts;
    bytes internal _flashV4BorrowCmds;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    address internal constant WETH_ADDR = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant NATIVE_ETH_ALIAS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // ===== Core simulation =====

    /// MANDATORY, NEVER SKIP: MUST BE SAME INNER LOGIC WITH FLASH CALLBACK, SAME LIKE ON-CHAIN!!!
    function simulate(Hop[] memory route, uint256 amountIn) public
        returns (uint256 amountOut, bytes memory commands, uint256[2][] memory amounts, uint16[] memory impacts)
    {
        return _simulate(route, amountIn, false);
    }

    /// @dev resolveAll=true → ALL hops packed with amount=0 (balanceOf fallback on-chain).
    /// Used by backrun() so on-chain execution resolves actual balances after victims.
    function simulateResolveAll(Hop[] memory route, uint256 amountIn) public
        returns (uint256 amountOut, bytes memory commands, uint256[2][] memory amounts, uint16[] memory impacts)
    {
        return _simulate(route, amountIn, true);
    }

    function _simulate(Hop[] memory route, uint256 amountIn, bool resolveAll) internal
        returns (uint256 amountOut, bytes memory commands, uint256[2][] memory amounts, uint16[] memory impacts)
    {
        amounts = new uint256[2][](route.length);
        impacts = new uint16[](route.length);
        amountOut = amountIn;
        for (uint256 i = 0; i < route.length; i++) {
            uint256 hopAmountIn = amountOut;
            uint256 usedAmountIn = hopAmountIn;
            bool isIntermediate = resolveAll || (i > 0);
            uint256 priceBefore = _getSpotPrice(route[i]);
            try this.executeHop(i, route[i], hopAmountIn) returns (uint256 hopOut, uint256 usedIn) {
                amountOut = hopOut;
                usedAmountIn = usedIn;
            } catch Error(string memory reason) {
                amountOut = _handleHopRevert(route[i], hopAmountIn, i, string.concat("[S] hop ", _toStr(i), ": ", reason));
            } catch Panic(uint256 code) {
                amountOut = _handleHopRevert(route[i], hopAmountIn, i, string.concat("[S] hop ", _toStr(i), ": panic(", _toStr(code), ")"));
            } catch (bytes memory raw) {
                amountOut = _handleHopRevert(route[i], hopAmountIn, i, string.concat("[S] hop ", _toStr(i), ": 0x", _toHexBytes(raw)));
            }
            uint256 priceAfter = _getSpotPrice(route[i]);
            impacts[i] = _computeImpactBips(priceBefore, priceAfter, route[i].dex);
            bytes memory cmd = _packCommand(route[i], usedAmountIn, amountOut, isIntermediate);
            amounts[i] = [usedAmountIn, amountOut];
            commands = bytes.concat(commands, cmd);
        }
    }

    // ===== Flash simulation (forward architecture) =====

    function simulateFlash(
        Hop[] memory route,
        uint256 amountOut,
        address weth,
        address vault,
        uint16 slippageBips
    ) public returns (uint256 profit, bytes memory calldata_, uint256[2][] memory amounts, uint16[] memory impacts) {
        require(slippageBips <= 10000, "bips>100%");
        require(route.length >= 2, "need >= 2 hops");
        Hop memory flashHop = route[0];

        delete _flashInnerHops;
        for (uint256 i = 1; i < route.length; i++) {
            _flashInnerHops.push(route[i]);
        }
        // Cap amountOut at pool's available balance - 1%
        address borrowToken = flashHop.tokenOut;
        uint256 poolBalance = _isNativeEth(borrowToken)
            ? flashHop.pool.balance
            : IERC20(borrowToken).balanceOf(flashHop.pool);
        uint256 maxBorrow = poolBalance - poolBalance * 100 / 10000;
        if (amountOut > maxBorrow) {
            amountOut = maxBorrow;
        }

        _flashWeth = weth;
        _flashHop = flashHop;
        _flashAmountIn = amountOut;
        _flashWethBalanceBefore = IERC20(weth).balanceOf(address(this));
        _callbackMode = 1;

        // Flash header (39 bytes)
        bytes memory flashHeader = _packFlashHeader(flashHop, amountOut);

        delete _flashInnerCommands;
        _flashAmounts = new uint256[2][](route.length);
        _flashAmounts[0] = [uint256(0), amountOut];
        _flashImpacts = new uint16[](route.length);

        uint256 flashPriceBefore = _getSpotPrice(flashHop);

        bytes memory flashData = abi.encode(uint8(1));
        try this.executeFlash(flashHop, amountOut, flashData) {
        } catch Error(string memory reason) {
            _callbackMode = 0;
            revert(string.concat("[SF] flash: ", reason));
        } catch Panic(uint256 code) {
            _callbackMode = 0;
            revert(string.concat("[SF] flash: panic(", _toStr(code), ")"));
        } catch (bytes memory raw) {
            _callbackMode = 0;
            revert(string.concat("[SF] flash: 0x", _toHexBytes(raw)));
        }

        _callbackMode = 0;

        uint256 flashPriceAfter = _getSpotPrice(flashHop);
        _flashImpacts[0] = _computeImpactBips(flashPriceBefore, flashPriceAfter, flashHop.dex);

        bytes memory innerCmds = _flashInnerCommands;
        amounts = _flashAmounts;
        impacts = _flashImpacts;
        delete _flashInnerCommands;
        delete _flashAmounts;
        delete _flashImpacts;

        uint256 wethAfter = IERC20(weth).balanceOf(address(this));
        if (wethAfter > _flashWethBalanceBefore) {
            uint256 rawProfit = wethAfter - _flashWethBalanceBefore;
            profit = rawProfit * (10000 - uint256(slippageBips)) / 10000;
        }
        uint256 minWeth = _flashWethBalanceBefore + profit;

        calldata_ = bytes.concat(
            flashHeader,
            bytes3(uint24(innerCmds.length)),
            innerCmds,
            _packBalanceCheck(address(this), weth, minWeth),
            _packSweep(weth, vault)
        );
    }

    // ===== V2 Pack helpers (CHANGED from V1) =====

    /// @dev Pack flash header: opcode(1) + selector(4) + amount(14) + pool(20) = 39 bytes
    function _packFlashHeader(Hop memory hop, uint256 amount) internal pure returns (bytes memory) {
        uint8 opcode;
        if (hop.dex == 0) {
            opcode = hop.zeroForOne ? 0x11 : 0x10;
        } else if (hop.dex == 1) {
            opcode = hop.zeroForOne ? 0x12 : 0x13;
        } else if (hop.dex == 2) {
            return abi.encodePacked(uint8(0x14), hop.pool);
        } else {
            revert("non-flash-capable dex");
        }
        return abi.encodePacked(opcode, hop.selector, _to14(amount), hop.pool);
    }

    /// @dev Pack sweep: 0x0E + token(20) + to(20) = 41 bytes
    function _packSweep(address token, address to) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0E), token, to);
    }

    /// @dev Pack transfer_erc20: 0x0C + token(20) + to(20) + amount(14) = 55 bytes
    function _packTransferERC20(address token, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0C), token, to, _to14(amount));
    }

    /// @dev Pack balance_check: 0x0D + account(20) + token(20) + minAmount(14) = 55 bytes
    function _packBalanceCheck(address account, address token, uint256 minAmount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0D), account, token, _to14(minAmount));
    }

    /// @dev Pack wrap_weth: 0x08 + amount(14) = 15 bytes (V2: 14-byte amount, was 9 in V1)
    function _packWrapWeth(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x08), _to14(amount));
    }

    /// @dev Pack unwrap_weth: 0x0A + amount(14) = 15 bytes (V2: 14-byte amount, was 9 in V1)
    function _packUnwrapWeth(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0A), _to14(amount));
    }

    /// @dev Pack transfer_eth: 0x0B + amount(14) + to(20) = 35 bytes
    function _packTransferEth(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0B), _to14(amount), to);
    }

    /// @dev Pack bribe: 0x09 + amount(9) = 10 bytes
    function _packBribe(uint256 amount) internal pure returns (bytes memory) {
        require(amount < (1 << 72), "overflow 9 bytes");
        return abi.encodePacked(uint8(0x09), bytes9(uint72(amount)));
    }

    // ===== Public self-call wrappers (for try-catch) =====

    function executeHop(uint256, Hop memory hop, uint256 amountIn) public returns (uint256 amountOut, uint256 actualAmountIn) {
        require(msg.sender == address(this), "only self");
        return _executeHop(hop, amountIn);
    }

    function probeHop(Hop memory hop, uint256 amountIn) external {
        require(msg.sender == address(this), "only self");
        (uint256 out,) = _executeHop(hop, amountIn);
        assembly { mstore(0, out) revert(0, 32) }
    }

    function executeFlash(Hop memory flashHop, uint256 amountOut, bytes memory flashData) public {
        require(msg.sender == address(this), "only self");
        require(flashHop.selector != bytes4(0), "ZERO_SEL");
        bool ok;
        bytes memory ret;
        if (flashHop.dex == 0) {
            uint256 a0 = flashHop.zeroForOne ? uint256(0) : amountOut;
            uint256 a1 = flashHop.zeroForOne ? amountOut : uint256(0);
            (ok, ret) = flashHop.pool.call(
                abi.encodeWithSelector(flashHop.selector, a0, a1, address(this), flashData)
            );
        } else if (flashHop.dex == 1) {
            uint160 limit = flashHop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
            (ok, ret) = flashHop.pool.call(
                abi.encodeWithSelector(flashHop.selector, address(this), flashHop.zeroForOne, -int256(amountOut), limit, flashData)
            );
        } else if (flashHop.dex == 2) {
            (ok, ret) = flashHop.pool.call(
                abi.encodeWithSelector(flashHop.selector, "")
            );
        } else {
            revert("non-flash-capable dex");
        }
        if (!ok) {
            if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
            revert SwapFailed("flash", flashHop.selector);
        }
    }

    receive() external payable {}

    fallback() external {
        // Try V2 layout
        if (msg.data.length >= 132) {
            uint256 offset;
            assembly { offset := calldataload(100) }
            uint256 dataStart = 4 + offset + 32;
            if (dataStart <= msg.data.length) {
                uint256 length;
                assembly { length := calldataload(add(4, offset)) }
                uint256 paddedLength = ((length + 31) / 32) * 32;
                if (4 + offset + 32 + paddedLength == msg.data.length) {
                    uint256 amount0; uint256 amount1; bytes memory data;
                    assembly {
                        amount0 := calldataload(36)
                        amount1 := calldataload(68)
                    }
                    data = new bytes(length);
                    assembly {
                        calldatacopy(add(data, 32), dataStart, length)
                    }
                    _v2Callback(amount0, amount1, data);
                    return;
                }
            }
        }

        // Try V3 layout
        if (msg.data.length >= 100) {
            uint256 offset;
            assembly { offset := calldataload(68) }
            uint256 dataStart = 4 + offset + 32;
            if (dataStart <= msg.data.length) {
                uint256 length;
                assembly { length := calldataload(add(4, offset)) }
                uint256 paddedLength = ((length + 31) / 32) * 32;
                if (4 + offset + 32 + paddedLength == msg.data.length) {
                    int256 amount0Delta; int256 amount1Delta; bytes memory data;
                    assembly {
                        amount0Delta := calldataload(4)
                        amount1Delta := calldataload(36)
                    }
                    data = new bytes(length);
                    assembly {
                        calldatacopy(add(data, 32), dataStart, length)
                    }
                    _v3Callback(amount0Delta, amount1Delta, data);
                    return;
                }
            }
        }

        revert("fallback: unknown callback");
    }

    function _executeHop(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        require(hop.selector != bytes4(0), "ZERO_SEL");
        if (hop.dex == 0) return _executeV2(hop, amountIn);
        if (hop.dex == 1) return _executeV3(hop, amountIn);
        if (hop.dex == 2) return _executeV4(hop, amountIn);
        if (hop.dex == 3) return _executeBalancer(hop, amountIn);
        if (hop.dex == 4) return _executeCurve(hop, amountIn);
        if (hop.dex == 6) return _executeBalancerV1(hop, amountIn);
        if (hop.dex == 7) return _executeFluid(hop, amountIn);
        if (hop.dex == 8) return _executeDodo(hop, amountIn);
        revert("unknown dex");
    }

    // ===== DEX handlers (identical to V1) =====

    function _executeV2(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        IUniswapV2Pair pair = IUniswapV2Pair(hop.pool);
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        require(reserve0 > 0 && reserve1 > 0, 'V2 LQD');

        uint256 reserveIn;
        uint256 reserveOut;
        if (hop.zeroForOne) {
            reserveIn = reserve0;
            reserveOut = reserve1;
        } else {
            reserveIn = reserve1;
            reserveOut = reserve0;
        }

        if (amountIn > reserveIn) {
            amountIn = reserveIn;
        }
        usedAmountIn = amountIn;

        require(IERC20(hop.tokenIn).balanceOf(address(this)) >= amountIn, 'V2 IIN');

        uint256 pairBalBefore = IERC20(hop.tokenIn).balanceOf(hop.pool);
        require(safeTransfer(hop.tokenIn, hop.pool, amountIn), 'TRF');
        uint256 actualAmountIn = IERC20(hop.tokenIn).balanceOf(hop.pool) - pairBalBefore;

        (reserve0, reserve1,) = pair.getReserves();
        require(reserve0 > 0 && reserve1 > 0, 'V2 HPT');
        if (hop.zeroForOne) {
            reserveIn = reserve0;
            reserveOut = reserve1;
        } else {
            reserveIn = reserve1;
            reserveOut = reserve0;
        }

        uint256 amountInWithFee = actualAmountIn * (10000 - uint256(hop.feeBps));
        uint256 _amountOut = amountInWithFee * reserveOut / (reserveIn * 10000 + amountInWithFee);

        _amountOut -= _amountOut * 10 / 10000;

        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));
        {
            uint256 a0 = hop.zeroForOne ? uint256(0) : _amountOut;
            uint256 a1 = hop.zeroForOne ? _amountOut : uint256(0);
            (bool ok, bytes memory ret) = hop.pool.call(
                abi.encodeWithSelector(hop.selector, a0, a1, address(this), new bytes(0))
            );
            if (!ok) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert SwapFailed("V2", hop.selector);
            }
        }
        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'V2 DRAIN!');
    }

    function _executeV3(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        _v3UsedAmountIn = amountIn;
        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));
        uint160 sqrtPriceLimit = hop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;

        (bool ok, bytes memory ret) = hop.pool.call(
            abi.encodeWithSelector(hop.selector, address(this), hop.zeroForOne, int256(amountIn), sqrtPriceLimit, abi.encode(hop.tokenIn))
        );
        if (!ok) {
            if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
            revert SwapFailed("V3", hop.selector);
        }

        usedAmountIn = _v3UsedAmountIn;
        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'V3 DRAIN!');
    }

    function _executeV4(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        hop.tokenIn = _normalizeNativeEth(hop.tokenIn);
        hop.tokenOut = _normalizeNativeEth(hop.tokenOut);
        _v4Hop = hop;
        _v4AmountIn = amountIn;

        if (_isNativeEth(hop.tokenIn)) {
            IWETH(WETH_ADDR).withdraw(amountIn);
        }

        uint256 balBefore;
        if (_isNativeEth(hop.tokenOut)) {
            balBefore = address(this).balance;
        } else {
            balBefore = IERC20(hop.tokenOut).balanceOf(address(this));
        }

        IPoolManager(hop.pool).unlock("");

        uint256 balAfter;
        if (_isNativeEth(hop.tokenOut)) {
            balAfter = address(this).balance;
            if (balAfter > balBefore) {
                IWETH(WETH_ADDR).deposit{value: balAfter - balBefore}();
            }
        } else {
            balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        }
        amountOut = balAfter - balBefore;
        usedAmountIn = _v4AmountIn;
        require(amountOut > 0, 'V4 DRAIN!');
    }

    function _executeBalancer(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        uint256 maxIn = _balancerMaxAmountIn(hop.pool, hop.poolId, hop.tokenIn);
        if (maxIn > 0 && amountIn > maxIn) {
            amountIn = maxIn;
        }
        usedAmountIn = amountIn;

        _safeApprove(hop.tokenIn, hop.pool, amountIn);
        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));

        {
            (bool ok, bytes memory ret) = hop.pool.call(
                abi.encodeWithSelector(
                    hop.selector,
                    IBalancerVault.SingleSwap({
                        poolId: hop.poolId,
                        kind: IBalancerVault.SwapKind.GIVEN_IN,
                        assetIn: hop.tokenIn,
                        assetOut: hop.tokenOut,
                        amount: amountIn,
                        userData: ""
                    }),
                    IBalancerVault.FundManagement({
                        sender: address(this),
                        fromInternalBalance: false,
                        recipient: payable(address(this)),
                        toInternalBalance: false
                    }),
                    uint256(0),
                    block.timestamp
                )
            );
            if (!ok) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert SwapFailed("Bal", hop.selector);
            }
        }

        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'Bal DRAIN!');
    }

    function _executeCurve(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        uint256 sellIdx = hop.zeroForOne ? hop.idx0 : hop.idx1;
        uint256 buyIdx  = hop.zeroForOne ? hop.idx1 : hop.idx0;

        uint256 maxInput = _curveMaxInput(hop.pool, sellIdx, buyIdx, hop.tokenOut);
        if (maxInput > 0 && amountIn > maxInput) {
            amountIn = maxInput;
        }
        usedAmountIn = amountIn;

        uint256 ethValue = 0;
        if (_isNativeEth(hop.tokenIn)) {
            IWETH(WETH_ADDR).withdraw(amountIn);
            ethValue = amountIn;
        } else {
            _safeApprove(hop.tokenIn, hop.pool, amountIn);
        }

        uint256 balBefore = _isNativeEth(hop.tokenOut)
            ? address(this).balance
            : IERC20(hop.tokenOut).balanceOf(address(this));

        (bool success, bytes memory returnData) = hop.pool.call{value: ethValue}(
            abi.encodeWithSelector(hop.selector, sellIdx, buyIdx, amountIn, uint256(0))
        );
        if (!success) {
            if (returnData.length > 0) {
                assembly { revert(add(returnData, 32), mload(returnData)) }
            }
            revert SwapFailed("Curve", hop.selector);
        }

        uint256 balAfter;
        if (_isNativeEth(hop.tokenOut)) {
            balAfter = address(this).balance;
            if (balAfter > balBefore) {
                IWETH(WETH_ADDR).deposit{value: balAfter - balBefore}();
            }
        } else {
            balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        }
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'Curve DRAIN!');
    }

    function _executeBalancerV1(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        // Balancer V1 BPool: tokenAmountIn <= balance * MAX_IN_RATIO (50%)
        uint256 maxIn = _balancerV1MaxAmountIn(hop.pool, hop.tokenIn);
        if (maxIn > 0 && amountIn > maxIn) {
            amountIn = maxIn;
        }
        usedAmountIn = amountIn;
        _safeApprove(hop.tokenIn, hop.pool, amountIn);
        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));

        {
            (bool ok, bytes memory ret) = hop.pool.call(
                abi.encodeWithSelector(
                    hop.selector,
                    hop.tokenIn,
                    amountIn,
                    hop.tokenOut,
                    uint256(0),
                    type(uint256).max
                )
            );
            if (!ok) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert SwapFailed("BalV1", hop.selector);
            }
        }

        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'BalV1 DRAIN!');
    }

    function _executeFluid(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        usedAmountIn = amountIn;
        IERC20(hop.tokenIn).transfer(hop.pool, amountIn);
        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));

        {
            (bool ok, bytes memory ret) = hop.pool.call(
                abi.encodeWithSelector(
                    hop.selector,
                    hop.zeroForOne,
                    amountIn,
                    uint256(0),
                    address(this)
                )
            );
            if (!ok) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert SwapFailed("Fluid", hop.selector);
            }
        }

        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'Fluid DRAIN!');
    }

    function _executeDodo(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut, uint256 usedAmountIn) {
        usedAmountIn = amountIn;
        IERC20(hop.tokenIn).transfer(hop.pool, amountIn);
        uint256 balBefore = IERC20(hop.tokenOut).balanceOf(address(this));

        {
            (bool ok, bytes memory ret) = hop.pool.call(
                abi.encodeWithSelector(
                    hop.selector,
                    address(this)
                )
            );
            if (!ok) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert SwapFailed("DODO", hop.selector);
            }
        }

        uint256 balAfter = IERC20(hop.tokenOut).balanceOf(address(this));
        amountOut = balAfter - balBefore;
        require(amountOut > 0, 'DODO DRAIN!');
    }

    // ===== Callbacks =====

    function _v2Callback(uint256 amount0, uint256 amount1, bytes memory data) internal {
        if (_callbackMode == 1 && data.length > 0) {
            Hop memory fh = _flashHop;
            IUniswapV2Pair pair = IUniswapV2Pair(fh.pool);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            uint256 amountOut = fh.zeroForOne ? amount1 : amount0;
            uint256 reserveIn = fh.zeroForOne ? uint256(r0) : uint256(r1);
            uint256 reserveOut = fh.zeroForOne ? uint256(r1) : uint256(r0);
            uint256 repay = (reserveIn * amountOut * 10000) / ((reserveOut - amountOut) * (10000 - uint256(fh.feeBps))) + 1;
            // Use actual balance for fee-on-transfer tokens
            _flashAmountIn = IERC20(fh.tokenOut).balanceOf(address(this));
            _flashForwardCallback(repay);
        } else {
            revert('V2: NOT EXPECTED!');
        }
    }

    function _v3Callback(int256 amount0Delta, int256 amount1Delta, bytes memory data) internal {
        uint256 repay;
        if (amount0Delta > 0) {
            repay = uint256(amount0Delta);
        } else {
            repay = uint256(amount1Delta);
        }

        if (_callbackMode == 1) {
            // Use actual balance for fee-on-transfer tokens
            _flashAmountIn = IERC20(_flashHop.tokenOut).balanceOf(address(this));
            _flashForwardCallback(repay);
        } else {
            _forwardSwapCallback(data, repay);
        }
    }

    function _forwardSwapCallback(bytes memory data, uint256 repay) internal {
        _v3UsedAmountIn = repay;
        (address repayToken) = abi.decode(data, (address));
        require(IERC20(repayToken).balanceOf(address(this)) >= repay, 'REPAY!');
        require(safeTransfer(repayToken, msg.sender, repay), 'TRF');
    }

    /// @dev Flash callback: run inner hops forward, repay to flash pool.
    function _flashForwardCallback(uint256 repayAmount) internal virtual {
        _callbackMode = 0;

        Hop[] memory innerHops = new Hop[](_flashInnerHops.length);
        for (uint256 i = 0; i < _flashInnerHops.length; i++) {
            innerHops[i] = _flashInnerHops[i];
        }

        (, bytes memory innerCmds, uint256[2][] memory innerAmounts, uint16[] memory innerImpacts) = simulateResolveAll(innerHops, _flashAmountIn);

        // Pack repay command: transfer exact repay amount to flash pool
        bytes memory repayCmd;
        if (_flashHop.dex == 2) {
            repayCmd = _packV4Settle(_flashHop.pool, _flashWeth, repayAmount);
        } else {
            require(IERC20(_flashWeth).balanceOf(address(this)) >= repayAmount, 'REPAY!');
            require(safeTransfer(_flashWeth, msg.sender, repayAmount), 'TRF');
            repayCmd = _packTransferERC20(_flashWeth, msg.sender, repayAmount);
        }

        if (_flashHop.dex == 2) {
            _flashInnerCommands = bytes.concat(_flashV4BorrowCmds, innerCmds, repayCmd);
        } else {
            _flashInnerCommands = bytes.concat(innerCmds, repayCmd);
        }

        _flashAmounts[0][0] = repayAmount;

        for (uint256 i = 0; i < innerAmounts.length; i++) {
            _flashAmounts[i + 1] = innerAmounts[i];
            _flashImpacts[i + 1] = innerImpacts[i];
        }
    }

    // unlockCallback — selector 0x91dd7346
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (_callbackMode == 1) {
            Hop memory fhop = _flashHop;
            IPoolManager fpm = IPoolManager(fhop.pool);
            uint256 borrowAmount = _flashAmountIn;

            address fc0 = fhop.zeroForOne ? fhop.tokenIn : fhop.tokenOut;
            address fc1 = fhop.zeroForOne ? fhop.tokenOut : fhop.tokenIn;
            uint160 fLimit = fhop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;

            int256 fdelta = fpm.swap(
                IPoolManager.PoolKey(fc0, fc1, fhop.feeBps, fhop.tickSpacing, fhop.hooks),
                IPoolManager.SwapParams(fhop.zeroForOne, -int256(borrowAmount), fLimit),
                ""
            );

            (uint256 repayAmount, uint256 actualBorrowed) = _decodeV4Delta(fdelta, fhop.zeroForOne);

            address borrowToken = fhop.tokenOut;
            fpm.take(borrowToken, address(this), actualBorrowed);

            // Use actual balance for fee-on-transfer tokens
            _flashAmountIn = IERC20(borrowToken).balanceOf(address(this));

            _flashV4BorrowCmds = bytes.concat(
                _packV4SwapCommand(fhop, borrowAmount),
                _packV4Take(fhop.pool, borrowToken, actualBorrowed)
            );

            _flashForwardCallback(repayAmount);

            require(IERC20(_flashWeth).balanceOf(address(this)) >= repayAmount, 'REPAY!');
            fpm.sync(_flashWeth);
            require(safeTransfer(_flashWeth, address(fpm), repayAmount), 'TRF');
            fpm.settle();

            return "";
        }

        Hop memory hop = _v4Hop;
        uint256 amountIn = _v4AmountIn;
        IPoolManager pm = IPoolManager(hop.pool);

        address currency0 = hop.zeroForOne ? hop.tokenIn : hop.tokenOut;
        address currency1 = hop.zeroForOne ? hop.tokenOut : hop.tokenIn;
        uint160 sqrtPriceLimit = hop.zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;

        int256 delta = pm.swap(
            IPoolManager.PoolKey(currency0, currency1, hop.feeBps, hop.tickSpacing, hop.hooks),
            IPoolManager.SwapParams(hop.zeroForOne, -int256(amountIn), sqrtPriceLimit),
            ""
        );

        (uint256 actualIn, uint256 amountOut) = _decodeV4Delta(delta, hop.zeroForOne);

        if (_isNativeEth(hop.tokenIn)) {
            pm.settle{value: actualIn}();
        } else {
            pm.sync(hop.tokenIn);
            require(safeTransfer(hop.tokenIn, address(pm), actualIn), 'TRF');
            pm.settle();
        }

        pm.take(hop.tokenOut, address(this), amountOut);

        _v4AmountIn = actualIn;
        _v4AmountOut = amountOut;
        return "";
    }

    // ===== Flash data encode/decode =====

    function _encodeChainData(
        Hop[] memory innerHops,
        uint256 amountOut,
        address repayToken,
        uint256 currentIndex
    ) internal pure returns (bytes memory) {
        return abi.encode(innerHops, amountOut, repayToken, currentIndex);
    }

    function _decodeFlashData(bytes memory data) internal pure returns (
        Hop[] memory innerHops,
        uint256 amountOut,
        address repayToken,
        uint256 currentIndex
    ) {
        (innerHops, amountOut, repayToken, currentIndex) =
            abi.decode(data, (Hop[], uint256, address, uint256));
    }

    // ===== Helpers =====

    uint256 internal constant POOLS_SLOT = 6;

    function _getSpotPrice(Hop memory hop) internal view returns (uint256) {
        if (hop.dex == 0) {
            (bool ok, bytes memory ret) = hop.pool.staticcall(abi.encodeWithSelector(0x0902f1ac));
            if (!ok || ret.length < 64) return 0;
            (uint112 r0, uint112 r1,) = abi.decode(ret, (uint112, uint112, uint32));
            if (hop.zeroForOne) {
                return r0 > 0 ? uint256(r1) * 1e18 / uint256(r0) : 0;
            } else {
                return r1 > 0 ? uint256(r0) * 1e18 / uint256(r1) : 0;
            }
        }

        if (hop.dex == 1) {
            (bool ok, bytes memory ret) = hop.pool.staticcall(abi.encodeWithSelector(0x3850c7bd));
            if (!ok || ret.length < 32) return 0;
            return uint256(abi.decode(ret, (uint160)));
        }

        if (hop.dex == 2) {
            address c0 = _normalizeNativeEth(hop.zeroForOne ? hop.tokenIn : hop.tokenOut);
            address c1 = _normalizeNativeEth(hop.zeroForOne ? hop.tokenOut : hop.tokenIn);
            bytes32 poolId = keccak256(abi.encode(c0, c1, hop.feeBps, hop.tickSpacing, hop.hooks));
            bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
            (bool ok, bytes memory ret) = hop.pool.staticcall(
                abi.encodeWithSelector(IPoolManager.extsload.selector, stateSlot)
            );
            if (!ok || ret.length < 32) return 0;
            return uint160(uint256(abi.decode(ret, (bytes32))));
        }

        if (hop.dex == 3) {
            (bool ok, bytes memory ret) = hop.pool.staticcall(
                abi.encodeWithSelector(0xf94d4668, hop.poolId)
            );
            if (!ok || ret.length < 96) return 0;
            (address[] memory tokens, uint256[] memory balances,) = abi.decode(ret, (address[], uint256[], uint256));
            uint256 balIn;
            uint256 balOut;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == hop.tokenIn) balIn = balances[i];
                if (tokens[i] == hop.tokenOut) balOut = balances[i];
            }
            return balIn > 0 ? balOut * 1e18 / balIn : 0;
        }

        if (hop.dex == 4) {
            uint256 sellIdx = hop.zeroForOne ? hop.idx0 : hop.idx1;
            uint256 buyIdx  = hop.zeroForOne ? hop.idx1 : hop.idx0;
            (bool ok, bytes memory ret) = hop.pool.staticcall(
                abi.encodeWithSelector(0x556d6e9f, sellIdx, buyIdx, 1e18)
            );
            if (ok && ret.length >= 32) return abi.decode(ret, (uint256));
            (ok, ret) = hop.pool.staticcall(
                abi.encodeWithSelector(0x5e0d443f, int128(int256(sellIdx)), int128(int256(buyIdx)), 1e18)
            );
            if (ok && ret.length >= 32) return abi.decode(ret, (uint256));
            return 0;
        }

        return 0;
    }

    function _computeImpactBips(uint256 priceBefore, uint256 priceAfter, uint8 dex) internal pure returns (uint16) {
        if (priceBefore == 0) return 0;
        uint256 diff = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore;
        uint256 bips = diff * 10000 / priceBefore;
        if (dex == 1 || dex == 2) {
            bips = bips * 2;
        }
        return bips > type(uint16).max ? type(uint16).max : uint16(bips);
    }

    function _handleHopRevert(Hop memory hop, uint256 hopAmountIn, uint256 hopIdx, string memory errMsg) internal returns (uint256) {
        if (hop.dex == 0 || hop.dex == 3 || hop.dex == 4) {
            (bool found, uint256 searchOut) = _binarySearchHop(hop, hopAmountIn, hopIdx);
            if (found) return searchOut;
        }
        revert(errMsg);
    }

    function _binarySearchHop(Hop memory hop, uint256 maxAmountIn, uint256 hopIdx) internal returns (bool found, uint256 amountOut) {
        uint256 lo = 0;
        uint256 hi = maxAmountIn;
        uint256 gasPerProbe = 0;
        for (uint256 j = 0; j < 10; j++) {
            if (gasPerProbe > 0 && gasleft() < gasPerProbe * 3) {
                revert(string.concat(
                    "[S] hop ", _toStr(hopIdx),
                    ": OOG in bsearch iter=", _toStr(j),
                    " gasPerProbe=", _toStr(gasPerProbe),
                    " pool=", _toHex(hop.pool)
                ));
            }
            uint256 mid = (lo + hi) / 2;
            if (mid == 0) break;
            uint256 gasBefore = gasleft();
            try this.probeHop(hop, mid) {
            } catch (bytes memory data) {
                if (data.length == 32) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            if (gasPerProbe == 0) {
                gasPerProbe = gasBefore - gasleft();
            }
        }
        if (lo > 0) {
            (amountOut,) = this.executeHop(0, hop, lo);
            found = true;
        }
    }

    function _balancerMaxAmountIn(address vault, bytes32 poolId, address tokenIn) internal view returns (uint256) {
        (address[] memory tokens, uint256[] memory balances,) = IBalancerVault(vault).getPoolTokens(poolId);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == tokenIn) {
                return balances[i];
            }
        }
        return 0;
    }

    /// Balancer V1 BPool: bmul(balance, MAX_IN_RATIO) where MAX_IN_RATIO = BONE/2.
    /// bmul(a, b) = (a * b + BONE/2) / BONE — matches BPool.sol exactly.
    function _balancerV1MaxAmountIn(address pool, address tokenIn) internal view returns (uint256) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("getBalance(address)", tokenIn));
        if (!ok || ret.length < 32) return 0;
        uint256 balance = abi.decode(ret, (uint256));
        uint256 BONE = 1e18;
        uint256 MAX_IN_RATIO = BONE / 2;
        return (balance * MAX_IN_RATIO + BONE / 2) / BONE;
    }

    function _curveMaxInput(address pool, uint256 sellIdx, uint256 buyIdx, address tokenOut) internal view returns (uint256) {
        uint256 poolOutBalance = _isNativeEth(tokenOut)
            ? pool.balance
            : IERC20(tokenOut).balanceOf(pool);
        if (poolOutBalance == 0) return 0;

        (bool ok, bytes memory ret) = pool.staticcall(
            abi.encodeWithSelector(0x556d6e9f, buyIdx, sellIdx, poolOutBalance)
        );
        if (ok && ret.length >= 32) return abi.decode(ret, (uint256));

        (ok, ret) = pool.staticcall(
            abi.encodeWithSelector(0x5e0d443f, int128(int256(buyIdx)), int128(int256(sellIdx)), poolOutBalance)
        );
        if (ok && ret.length >= 32) return abi.decode(ret, (uint256));

        return 0;
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool s1, bytes memory d1) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        require(s1 && (d1.length == 0 || abi.decode(d1, (bool))));
        if (amount > 0) {
            (bool s2, bytes memory d2) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
            require(s2 && (d2.length == 0 || abi.decode(d2, (bool))));
        }
    }

    function _toHexBytes(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        uint256 len = data.length > 128 ? 128 : data.length;
        bytes memory b = new bytes(len * 2);
        for (uint256 i = 0; i < len; i++) {
            b[i * 2] = alphabet[uint8(data[i]) >> 4];
            b[i * 2 + 1] = alphabet[uint8(data[i]) & 0x0f];
        }
        return string(b);
    }

    function _isNativeEth(address token) internal pure returns (bool) {
        return token == address(0) || token == NATIVE_ETH_ALIAS;
    }

    function _normalizeNativeEth(address token) internal pure returns (address) {
        return _isNativeEth(token) ? address(0) : token;
    }

    function _toHex(address a) internal pure returns (string memory) {
        bytes memory b = new bytes(42);
        b[0] = "0";
        b[1] = "x";
        bytes memory alphabet = "0123456789abcdef";
        uint160 v = uint160(a);
        for (uint256 i = 41; i >= 2; i--) {
            b[i] = alphabet[v & 0xf];
            v >>= 4;
        }
        return string(b);
    }

    function _toStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        uint256 tmp = v;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory b = new bytes(digits);
        while (v != 0) { digits--; b[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    // ===== Command packing (MEV_V2 format) =====

    function _packCommand(Hop memory hop, uint256 amountIn, uint256 amountOut, bool isIntermediate) internal pure returns (bytes memory) {
        if (hop.dex == 0) return _packV2Command(hop, amountIn, isIntermediate);
        if (hop.dex == 1) return _packV3Command(hop, amountIn, isIntermediate);
        if (hop.dex == 2) return _packV4Command(hop, amountIn, amountOut, isIntermediate);
        if (hop.dex == 3) return _packBalancerCommand(hop, amountIn, isIntermediate);
        if (hop.dex == 4) return _packCurveCommand(hop, amountIn, isIntermediate);
        if (hop.dex == 6) return _packBalancerV1Command(hop, amountIn, isIntermediate);
        if (hop.dex == 7) return _packFluidCommand(hop, amountIn, isIntermediate);
        if (hop.dex == 8) return _packDodoCommand(hop, amountIn, isIntermediate);
        revert("unknown dex in packCommand");
    }

    // V2 adaptive: op(1) + selector(4) + fee_bps(2) + pair(20) + tokenIn(20) + amountIn(14) = 61 bytes
    // Intermediate hops: amountIn=0 (balanceOf fallback on-chain)
    function _packV2Command(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint8 opcode = hop.zeroForOne ? 0x00 : 0x01;
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        return abi.encodePacked(opcode, hop.selector, _to2(hop.feeBps), hop.pool, hop.tokenIn, _to14(packedAmount));
    }

    // V3: op(1) + selector(4) + token0(20) + token1(20) + pool(20) + amountIn(14) = 79 bytes
    // Intermediate hops: amountIn=0
    function _packV3Command(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        if (hop.zeroForOne) {
            return abi.encodePacked(uint8(0x02), hop.selector, hop.tokenIn, hop.tokenOut, hop.pool, _to14(packedAmount));
        } else {
            return abi.encodePacked(uint8(0x03), hop.selector, hop.tokenOut, hop.tokenIn, hop.pool, _to14(packedAmount));
        }
    }

    // Balancer: op(1) + selector(4) + vault(20) + poolId(32) + token0(20) + token1(20) + amount(14) = 111 bytes
    // Intermediate hops: amountIn=0
    function _packBalancerCommand(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        if (hop.zeroForOne) {
            return abi.encodePacked(uint8(0x04), hop.selector, hop.pool, hop.poolId, hop.tokenIn, hop.tokenOut, _to14(packedAmount));
        } else {
            return abi.encodePacked(uint8(0x05), hop.selector, hop.pool, hop.poolId, hop.tokenOut, hop.tokenIn, _to14(packedAmount));
        }
    }

    // Curve: op(1) + selector(4) + pool(20) + idx0(6) + idx1(6) + token(20) + amount(14) = 71 bytes
    // Native ETH: prepend unwrap_weth / append wrap_weth
    // Intermediate hops: amountIn=0
    function _packCurveCommand(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint8 opcode = hop.zeroForOne ? 0x06 : 0x07;
        address tokenField = _isNativeEth(hop.tokenIn) ? address(0) : hop.tokenIn;
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        bytes memory cmd = abi.encodePacked(opcode, hop.selector, hop.pool, _to6(hop.idx0), _to6(hop.idx1), tokenField, _to14(packedAmount));

        if (_isNativeEth(hop.tokenIn)) {
            cmd = bytes.concat(_packUnwrapWeth(isIntermediate ? 0 : amountIn), cmd);
        }
        if (_isNativeEth(hop.tokenOut)) {
            cmd = bytes.concat(cmd, _packWrapWeth(isIntermediate ? 0 : amountIn));
        }
        return cmd;
    }

    // BalancerV1: op(1) + selector(4) + pool(20) + tokenIn(20) + tokenOut(20) + amount(14) = 79 bytes
    // Intermediate hops: amountIn=0
    function _packBalancerV1Command(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        if (hop.zeroForOne) {
            return abi.encodePacked(uint8(0x19), hop.selector, hop.pool, hop.tokenIn, hop.tokenOut, _to14(packedAmount));
        } else {
            return abi.encodePacked(uint8(0x1A), hop.selector, hop.pool, hop.tokenOut, hop.tokenIn, _to14(packedAmount));
        }
    }

    // Fluid: op(1) + selector(4) + pool(20) + tokenIn(20) + amount(14) = 59 bytes
    // Intermediate hops: amountIn=0
    function _packFluidCommand(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        if (hop.zeroForOne) {
            return abi.encodePacked(uint8(0x1B), hop.selector, hop.pool, hop.tokenIn, _to14(packedAmount));
        } else {
            return abi.encodePacked(uint8(0x1C), hop.selector, hop.pool, hop.tokenIn, _to14(packedAmount));
        }
    }

    // DODO: op(1) + selector(4) + pool(20) + tokenIn(20) + amount(14) = 59 bytes
    // Intermediate hops: amountIn=0
    function _packDodoCommand(Hop memory hop, uint256 amountIn, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedAmount = isIntermediate ? 0 : amountIn;
        if (hop.zeroForOne) {
            return abi.encodePacked(uint8(0x1D), hop.selector, hop.pool, hop.tokenIn, _to14(packedAmount));
        } else {
            return abi.encodePacked(uint8(0x1E), hop.selector, hop.pool, hop.tokenIn, _to14(packedAmount));
        }
    }

    /// @dev Pack V4 non-flash hop
    /// V4 swap: amount=0 triggers balanceOf fallback in MEV dispatcher (like V2/V3).
    /// V4 settle/take: always use real amounts — PM requires exact accounting, no balanceOf fallback.
    function _packV4Command(Hop memory hop, uint256 amountIn, uint256 amountOut, bool isIntermediate) internal pure returns (bytes memory) {
        uint256 packedSwapAmount = isIntermediate ? 0 : amountIn;
        bytes memory swapCmd = _packV4SwapCommand(hop, packedSwapAmount);
        bytes memory settleCmd = _packV4Settle(hop.pool, hop.tokenIn, amountIn);
        bytes memory takeCmd = _packV4Take(hop.pool, hop.tokenOut, amountOut);
        bytes memory inner = bytes.concat(swapCmd, settleCmd, takeCmd);
        bytes memory unlock = abi.encodePacked(uint8(0x14), hop.pool, bytes3(uint24(inner.length)), inner);

        if (_isNativeEth(hop.tokenIn)) {
            unlock = bytes.concat(_packUnwrapWeth(isIntermediate ? 0 : amountIn), unlock);
        }
        if (_isNativeEth(hop.tokenOut)) {
            unlock = bytes.concat(unlock, _packWrapWeth(isIntermediate ? 0 : amountOut));
        }
        return unlock;
    }

    function _decodeV4Delta(int256 delta, bool zeroForOne) internal pure returns (uint256 cost, uint256 gain) {
        assembly {
            switch zeroForOne
            case 1 {
                let a0 := sar(128, delta)
                cost := sub(0, a0)
                let a1 := signextend(15, delta)
                gain := a1
            }
            default {
                let a1 := signextend(15, delta)
                cost := sub(0, a1)
                let a0 := sar(128, delta)
                gain := a0
            }
        }
    }

    function _packV4SwapCommand(Hop memory hop, uint256 amount) internal pure returns (bytes memory) {
        address currency0 = _normalizeNativeEth(hop.zeroForOne ? hop.tokenIn : hop.tokenOut);
        address currency1 = _normalizeNativeEth(hop.zeroForOne ? hop.tokenOut : hop.tokenIn);
        uint8 opcode = hop.zeroForOne ? 0x15 : 0x16;
        return abi.encodePacked(
            opcode, hop.pool, currency0, currency1,
            bytes3(uint24(hop.feeBps)), _toTickSpacing3(hop.tickSpacing),
            hop.hooks, _to14(amount)
        );
    }

    function _packV4Settle(address pm, address token, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x17), pm, token, _to14(amount));
    }

    function _packV4Take(address pm, address token, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x18), pm, token, _to14(amount));
    }

    function _toTickSpacing3(int24 ts) internal pure returns (bytes3) {
        return bytes3(uint24(int24(ts)));
    }

    function _to14(uint256 value) internal pure returns (bytes14) {
        require(value < (1 << 112), "overflow 14 bytes");
        return bytes14(uint112(value));
    }

    function _to6(uint256 value) internal pure returns (bytes6) {
        require(value < (1 << 48), "overflow 6 bytes");
        return bytes6(uint48(value));
    }

    function _to2(uint24 value) internal pure returns (bytes2) {
        require(value < (1 << 16), "overflow 2 bytes");
        return bytes2(uint16(value));
    }

    function safeTransfer(address token, address recipient, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", recipient, amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }
}
