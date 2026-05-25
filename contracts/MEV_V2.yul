object "MEV_V2" {
    code {
        // Deploy the contract
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            // receive function
            if eq(calldatasize(), 0) {
                return(0, 0)
            }

            let value := callvalue()
            if gt(value, 0) {
                // operator dispatch: callvalue > 0
                auth()
                dispatcher(0, value)
                return(0, 0)
            }

            // callback path: callvalue == 0, must be operator-initiated tx
            auth()

            switch selector()
            case 0xe9cbafb0 {
                flash_loan_callback(132)
                return(0, 0)
            }
            // Uniswap V4 unlockCallback(bytes)
            case 0x91dd7346 {
                v4_unlock_callback(68)
                mstore(0, 32)
                mstore(32, 0)
                return(0, 64)
            }
            default {
                // Dynamic callback detection via calldata layout
                // V2: (address, uint256, uint256, bytes) — bytes offset at cd[100..132]
                // V3: (int256, int256, bytes)            — bytes offset at cd[68..100]

                // Try V2 layout
                if iszero(lt(calldatasize(), 164)) {
                    let v2_off := calldataload(100)
                    let v2_data_pos := add(4, v2_off)
                    if iszero(gt(add(v2_data_pos, 32), calldatasize())) {
                        let v2_len := calldataload(v2_data_pos)
                        let v2_padded := mul(div(add(v2_len, 31), 32), 32)
                        if eq(add(add(v2_data_pos, 32), v2_padded), calldatasize()) {
                            v2_flash_callback(add(v2_data_pos, 32))
                            return(0, 0)
                        }
                    }
                }

                // Try V3 layout
                if iszero(lt(calldatasize(), 132)) {
                    let v3_off := calldataload(68)
                    let v3_data_pos := add(4, v3_off)
                    if iszero(gt(add(v3_data_pos, 32), calldatasize())) {
                        let v3_len := calldataload(v3_data_pos)
                        let v3_padded := mul(div(add(v3_len, 31), 32), 32)
                        if eq(add(add(v3_data_pos, 32), v3_padded), calldatasize()) {
                            swap_v3_callback(add(v3_data_pos, 32))
                            return(0, 0)
                        }
                    }
                }

                revert(0, 0)
            }

            // ===== DISPATCHER =====
            // V2 adaptive: on-chain amountOut computation, balanceOf fallback for amount_in=0
            function dispatcher(cursor, limit) {
                for { } lt(cursor, limit) { } {
                    let command := byte(0, calldataload(cursor))
                    cursor := add(cursor, 1)
                    switch command
                    // --- V2 swap adaptive (on-chain compute) ---
                    // Layout: selector(4) + fee_bps(2) + pair(20) + tokenIn(20) + amountIn(14) = 60
                    case 0x00 {
                        swap_v2_adaptive_zfo(cursor)
                        cursor := add(cursor, 60)
                    }
                    case 0x01 {
                        swap_v2_adaptive_ofz(cursor)
                        cursor := add(cursor, 60)
                    }
                    // --- V3 swap (balanceOf fallback) ---
                    // Layout: selector(4) + token0(20) + token1(20) + pool(20) + amountIn(14) = 78
                    case 0x02 {
                        swap_uni_v3_zfo(cursor)
                        cursor := add(cursor, 78)
                    }
                    case 0x03 {
                        swap_uni_v3_ofz(cursor)
                        cursor := add(cursor, 78)
                    }
                    // --- Balancer V2 swap (balanceOf fallback) ---
                    // Layout: selector(4) + vault(20) + poolId(32) + token0(20) + token1(20) + amountIn(14) = 110
                    case 0x04 {
                        swap_balancer_v2_zfo(cursor)
                        cursor := add(cursor, 110)
                    }
                    case 0x05 {
                        swap_balancer_v2_ofz(cursor)
                        cursor := add(cursor, 110)
                    }
                    // --- Curve swap (balanceOf fallback) ---
                    // Layout: selector(4) + pool(20) + idx0(6) + idx1(6) + tokenIn(20) + amountIn(14) = 70
                    case 0x06 {
                        swap_curve_zfo(cursor)
                        cursor := add(cursor, 70)
                    }
                    case 0x07 {
                        swap_curve_ofz(cursor)
                        cursor := add(cursor, 70)
                    }
                    // --- Wrap WETH (0 -> selfbalance) ---
                    // Layout: amount(14) = 14
                    case 0x08 {
                        wrap_weth_adaptive(cursor)
                        cursor := add(cursor, 14)
                    }
                    // --- Bribe ---
                    // Layout: amount(9) = 9
                    case 0x09 {
                        bribe(cursor)
                        cursor := add(cursor, 9)
                    }
                    // --- Unwrap WETH (0 -> balanceOf(WETH)) ---
                    // Layout: amount(14) = 14
                    case 0x0A {
                        unwrap_weth_adaptive(cursor)
                        cursor := add(cursor, 14)
                    }
                    // --- Transfer ETH ---
                    // Layout: amount(14) + address(20) = 34
                    case 0x0B {
                        transfer_eth(cursor)
                        cursor := add(cursor, 34)
                    }
                    // --- Transfer ERC20 ---
                    // Layout: token(20) + account(20) + amount(14) = 54
                    case 0x0C {
                        transfer_erc20(cursor)
                        cursor := add(cursor, 54)
                    }
                    // --- Balance check ---
                    // Layout: account(20) + token(20) + minAmount(14) = 54
                    case 0x0D {
                        balance_check(cursor)
                        cursor := add(cursor, 54)
                    }
                    // --- Sweep (transfer entire balance) ---
                    // Layout: token(20) + to(20) = 40
                    case 0x0E {
                        sweep(cursor)
                        cursor := add(cursor, 40)
                    }
                    // --- Flash commands (unchanged from V1) ---
                    // V2 flash z: selector(4) + amount(14) + pair(20) + innerLen(3) + inner(var)
                    case 0x10 {
                        let shift := uni_v2_flash_z(cursor)
                        cursor := add(cursor, shift)
                    }
                    case 0x11 {
                        let shift := uni_v2_flash_o(cursor)
                        cursor := add(cursor, shift)
                    }
                    // V3 flash z/o: selector(4) + amount(14) + pool(20) + innerLen(3) + inner(var)
                    case 0x12 {
                        let shift := uni_v3_flash_swap_z(cursor)
                        cursor := add(cursor, shift)
                    }
                    case 0x13 {
                        let shift := uni_v3_flash_swap_o(cursor)
                        cursor := add(cursor, shift)
                    }
                    // V4 unlock: pm(20) + innerLen(3) + inner(var)
                    case 0x14 {
                        let shift := uni_v4_unlock(cursor)
                        cursor := add(cursor, shift)
                    }
                    // --- V4 swap ---
                    // Layout: pm(20) + c0(20) + c1(20) + fee(3) + tickSpacing(3) + hooks(20) + amount(14) = 100
                    case 0x15 {
                        swap_uni_v4_zfo(cursor)
                        cursor := add(cursor, 100)
                    }
                    case 0x16 {
                        swap_uni_v4_ofz(cursor)
                        cursor := add(cursor, 100)
                    }
                    // V4 settle/take: pm(20) + token(20) + amount(14) = 54
                    case 0x17 {
                        v4_settle(cursor)
                        cursor := add(cursor, 54)
                    }
                    case 0x18 {
                        v4_take(cursor)
                        cursor := add(cursor, 54)
                    }
                    // --- Balancer V1 (balanceOf fallback) ---
                    // Layout: selector(4) + pool(20) + tokenIn(20) + tokenOut(20) + amount(14) = 78
                    case 0x19 {
                        swap_bal_v1_zfo(cursor)
                        cursor := add(cursor, 78)
                    }
                    case 0x1A {
                        swap_bal_v1_ofz(cursor)
                        cursor := add(cursor, 78)
                    }
                    // --- Fluid DEX (balanceOf fallback) ---
                    // Layout: selector(4) + pool(20) + tokenIn(20) + amount(14) = 58
                    case 0x1B {
                        swap_fluid_zfo(cursor)
                        cursor := add(cursor, 58)
                    }
                    case 0x1C {
                        swap_fluid_ofz(cursor)
                        cursor := add(cursor, 58)
                    }
                    // --- DODO V2 (balanceOf fallback) ---
                    // Layout: selector(4) + pool(20) + tokenIn(20) + amount(14) = 58
                    case 0x1D {
                        swap_dodo_zfo(cursor)
                        cursor := add(cursor, 58)
                    }
                    case 0x1E {
                        swap_dodo_ofz(cursor)
                        cursor := add(cursor, 58)
                    }
                }
            }

            // ===== CORE: resolve_amount (balanceOf fallback) =====
            function resolve_amount(amount, token) -> resolved {
                switch iszero(amount)
                case 1 { resolved := balance_of(token, address()) }
                default { resolved := amount }
            }

            // ===== V2 ADAPTIVE SWAP (on-chain amountOut computation) =====

            // V2 on-chain compute amountOut from reserves + fee
            function v2_compute_amount_out(pair, amountIn, feeBps, zfo) -> amountOut {
                // Call getReserves()
                mstore(0, shl(224, 0x0902f1ac))
                if iszero(staticcall(gas(), pair, 0, 4, 0, 64)) {
                    revert(0, 0)
                }
                let r0 := mload(0)
                let r1 := mload(32)
                let rIn := r0
                let rOut := r1
                if iszero(zfo) {
                    rIn := r1
                    rOut := r0
                }
                // amountInWithFee = amountIn * (10000 - feeBps)
                let amtFee := mul(amountIn, sub(10000, feeBps))
                // amountOut = amtFee * rOut / (rIn * 10000 + amtFee)
                amountOut := div(mul(amtFee, rOut), add(mul(rIn, 10000), amtFee))
            }

            // V2 adaptive zfo: read calldata, resolve amount, compute amountOut, transfer + swap
            // Layout: selector(4) + fee_bps(2) + pair(20) + tokenIn(20) + amountIn(14) = 60
            function swap_v2_adaptive_zfo(cursor) {
                let sig := shr(224, calldataload(cursor))
                let feeBps := and(shr(240, calldataload(add(cursor, 4))), 0xFFFF)
                let pair := shr(96, calldataload(add(cursor, 6)))
                let tokenIn := shr(96, calldataload(add(cursor, 26)))
                let amountIn := shr(144, calldataload(add(cursor, 46)))

                // Resolve: 0 -> balanceOf(this, tokenIn)
                amountIn := resolve_amount(amountIn, tokenIn)

                // Compute amountOut on-chain
                let amountOut := v2_compute_amount_out(pair, amountIn, feeBps, 1)

                // Transfer tokenIn to pair, then swap
                transfer_token(tokenIn, pair, amountIn)
                swap_v2(sig, pair, 0, amountOut, address())
            }

            // V2 adaptive ofz: same pattern, reverse direction
            function swap_v2_adaptive_ofz(cursor) {
                let sig := shr(224, calldataload(cursor))
                let feeBps := and(shr(240, calldataload(add(cursor, 4))), 0xFFFF)
                let pair := shr(96, calldataload(add(cursor, 6)))
                let tokenIn := shr(96, calldataload(add(cursor, 26)))
                let amountIn := shr(144, calldataload(add(cursor, 46)))

                // Resolve: 0 -> balanceOf(this, tokenIn)
                amountIn := resolve_amount(amountIn, tokenIn)

                // Compute amountOut on-chain (zfo=0 for ofz)
                let amountOut := v2_compute_amount_out(pair, amountIn, feeBps, 0)

                // Transfer tokenIn to pair, then swap
                transfer_token(tokenIn, pair, amountIn)
                swap_v2(sig, pair, amountOut, 0, address())
            }

            // ===== V3 SWAP (balanceOf fallback) =====
            function swap_uni_v3_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let token0 := shr(96, calldataload(add(offset, 4)))
                let token1 := shr(96, calldataload(add(offset, 24)))
                let pool := shr(96, calldataload(add(offset, 44)))
                let amount0 := shr(144, calldataload(add(offset, 64)))
                amount0 := resolve_amount(amount0, token0)
                swap_v3(sig, pool, address(), 1, amount0, add(min_sqrt_ratio(), 1), token0, token1, amount0)
            }
            function swap_uni_v3_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let token0 := shr(96, calldataload(add(offset, 4)))
                let token1 := shr(96, calldataload(add(offset, 24)))
                let pool := shr(96, calldataload(add(offset, 44)))
                let amount1 := shr(144, calldataload(add(offset, 64)))
                amount1 := resolve_amount(amount1, token1)
                swap_v3(sig, pool, address(), 0, amount1, sub(max_sqrt_ratio(), 1), token0, token1, amount1)
            }

            // ===== BALANCER V2 (balanceOf fallback) =====
            function swap_balancer_v2_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let vault := shr(96, calldataload(add(offset, 4)))
                let pool_id := calldataload(add(offset, 24))
                let token0 := shr(96, calldataload(add(offset, 56)))
                let token1 := shr(96, calldataload(add(offset, 76)))
                let amount0 := shr(144, calldataload(add(offset, 96)))
                amount0 := resolve_amount(amount0, token0)
                approve_token(token0, vault, amount0)
                swap_v2_balancer(sig, pool_id, token0, token1, amount0, vault)
            }
            function swap_balancer_v2_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let vault := shr(96, calldataload(add(offset, 4)))
                let pool_id := calldataload(add(offset, 24))
                let token0 := shr(96, calldataload(add(offset, 56)))
                let token1 := shr(96, calldataload(add(offset, 76)))
                let amount1 := shr(144, calldataload(add(offset, 96)))
                amount1 := resolve_amount(amount1, token1)
                approve_token(token1, vault, amount1)
                swap_v2_balancer(sig, pool_id, token1, token0, amount1, vault)
            }

            // ===== CURVE (balanceOf fallback) =====
            function swap_curve_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let data := calldataload(add(offset, 4))
                let pool := shr(96, data)
                let idx0 := and(shr(48, data), 0xFFFFFFFFFFFF)
                let idx1 := and(data, 0xFFFFFFFFFFFF)
                let token0 := shr(96, calldataload(add(offset, 36)))
                let amount0 := shr(144, calldataload(add(offset, 56)))
                amount0 := resolve_amount(amount0, token0)
                switch iszero(token0)
                case 1 {
                    swap_curve_eth_exec(sig, pool, idx0, idx1, amount0)
                }
                default {
                    safe_approve_token(token0, pool, amount0)
                    swap_curve_exec(sig, pool, idx0, idx1, amount0)
                }
            }
            function swap_curve_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let data := calldataload(add(offset, 4))
                let pool := shr(96, data)
                let idx0 := and(shr(48, data), 0xFFFFFFFFFFFF)
                let idx1 := and(data, 0xFFFFFFFFFFFF)
                let token1 := shr(96, calldataload(add(offset, 36)))
                let amount1 := shr(144, calldataload(add(offset, 56)))
                amount1 := resolve_amount(amount1, token1)
                switch iszero(token1)
                case 1 {
                    swap_curve_eth_exec(sig, pool, idx1, idx0, amount1)
                }
                default {
                    safe_approve_token(token1, pool, amount1)
                    swap_curve_exec(sig, pool, idx1, idx0, amount1)
                }
            }

            // ===== WRAP/UNWRAP WETH (adaptive: 0 -> selfbalance / balanceOf) =====
            // Layout: amount(14) = 14 bytes
            function wrap_weth_adaptive(offset) {
                let amount := shr(144, calldataload(offset))
                switch iszero(amount)
                case 1 { amount := selfbalance() }
                default {}
                deposit_weth(amount)
            }
            function unwrap_weth_adaptive(offset) {
                let amount := shr(144, calldataload(offset))
                switch iszero(amount)
                case 1 { amount := balance_of(weth(), address()) }
                default {}
                withdraw_weth(amount)
            }

            // ===== SWEEP (transfer entire balance of token to recipient) =====
            // Layout: token(20) + to(20) = 40
            function sweep(offset) {
                let token := shr(96, calldataload(offset))
                let to := shr(96, calldataload(add(offset, 20)))
                let bal := balance_of(token, address())
                if gt(bal, 0) {
                    transfer_token(token, to, bal)
                }
            }

            // ===== BRIBE =====
            function bribe(offset) {
                let amount := shr(184, calldataload(offset))
                if iszero(call(gas(), coinbase(), amount, 0, 0, 0, 0)) {
                    revert(0, 0)
                }
            }

            // ===== TRANSFER ETH =====
            function transfer_eth(offset) {
                let amount := shr(144, calldataload(offset))
                let account := shr(96, calldataload(add(offset, 14)))
                if iszero(call(gas(), account, amount, 0, 0, 0, 0)) {
                    revert(0, 0)
                }
            }

            // ===== TRANSFER ERC20 =====
            function transfer_erc20(offset) {
                let token := shr(96, calldataload(offset))
                let account := shr(96, calldataload(add(offset, 20)))
                let amount := shr(144, calldataload(add(offset, 40)))
                transfer_token(token, account, amount)
            }

            // ===== BALANCE CHECK =====
            function balance_check(offset) {
                let account := shr(96, calldataload(offset))
                let token := shr(96, calldataload(add(offset, 20)))
                let amount := shr(144, calldataload(add(offset, 40)))
                require(gte(balance_of(token, account), amount))
            }

            // ===== FLASH COMMANDS (unchanged from V1) =====
            function uni_v2_flash_z(offset) -> s {
                let sig := shr(224, calldataload(offset))
                let amount := shr(144, calldataload(add(offset, 4)))
                let pair := shr(96, calldataload(add(offset, 18)))
                let inner := shr(232, calldataload(add(offset, 38)))
                flash_v2_deep(sig, pair, amount, 0, add(offset, 41), inner)
                s := add(inner, 41)
            }
            function uni_v2_flash_o(offset) -> s {
                let sig := shr(224, calldataload(offset))
                let amount := shr(144, calldataload(add(offset, 4)))
                let pair := shr(96, calldataload(add(offset, 18)))
                let inner := shr(232, calldataload(add(offset, 38)))
                flash_v2_deep(sig, pair, 0, amount, add(offset, 41), inner)
                s := add(inner, 41)
            }
            function uni_v3_flash_swap_z(offset) -> s {
                let sig := shr(224, calldataload(offset))
                let amount := shr(144, calldataload(add(offset, 4)))
                let pool := shr(96, calldataload(add(offset, 18)))
                let inner := shr(232, calldataload(add(offset, 38)))
                flash_swap_v3_deep(sig, pool, 1, amount, add(min_sqrt_ratio(), 1), add(offset, 41), inner)
                s := add(inner, 41)
            }
            function uni_v3_flash_swap_o(offset) -> s {
                let sig := shr(224, calldataload(offset))
                let amount := shr(144, calldataload(add(offset, 4)))
                let pool := shr(96, calldataload(add(offset, 18)))
                let inner := shr(232, calldataload(add(offset, 38)))
                flash_swap_v3_deep(sig, pool, 0, amount, sub(max_sqrt_ratio(), 1), add(offset, 41), inner)
                s := add(inner, 41)
            }
            function flash_swap_v3_deep(sig, pool, zeroForOne, amount, priceLimit, cmdOffset, cmdLen) {
                mstore(0, shl(224, sig))
                mstore(4, address())
                mstore(36, zeroForOne)
                mstore(68, sub(0, amount)) // negate: exactOutput needs negative amountSpecified
                mstore(100, priceLimit)
                mstore(132, 160)
                mstore(164, cmdLen)
                calldatacopy(196, cmdOffset, cmdLen)
                let callLen := add(196, cmdLen)
                if iszero(call(gas(), pool, 0, 0, callLen, 0, 64)) {
                    revert(0, 0)
                }
            }
            function flash_v2_deep(sig, pair, amount0, amount1, offset, datalen) {
                mstore(0, shl(224, sig))
                mstore(4, amount0)
                mstore(36, amount1)
                mstore(68, address())
                mstore(100, 128)                // data offset (132-4)
                mstore(132, datalen)            // data length
                calldatacopy(164, offset, datalen)
                // Pad to 32-byte boundary for ABI compliance
                let padded := mul(div(add(datalen, 31), 32), 32)
                let d_len_t := add(164, padded)
                if iszero(call(gas(), pair, 0, 0, d_len_t, 0, 0)) {
                    revert(0, 0)
                }
            }
            function v2_flash_callback(offset) {
                let len := calldataload(sub(offset, 32))
                dispatcher(offset, add(offset, len))
            }
            function flash_loan_deep(sig, pool, amount0, amount1, offset, datalen) {
                mstore(0, shl(224, sig))
                mstore(4, address())
                mstore(36, amount0)
                mstore(68, amount1)
                mstore(100, 128)
                mstore(132, datalen)
                calldatacopy(164, offset, datalen)
                let d_len_t := add(164, datalen)
                if iszero(call(gas(), pool, 0, 0, d_len_t, 0, 0)) {
                    revert(0, 0)
                }
            }
            function flash_loan_callback(offset) {
                dispatcher(add(offset, 43), calldatasize())
            }
            function swap_v3_callback(offset) {
                let dataLen := calldataload(sub(offset, 32))
                switch eq(dataLen, 56)
                case 1 {
                    // normal V3 swap
                    let token0 := shr(96, calldataload(offset))
                    let token1 := shr(96, calldataload(add(offset, 20)))
                    let zeroForOne := byte(0, calldataload(add(offset, 40)))
                    let amount := shr(144, calldataload(add(offset, 41)))
                    switch zeroForOne
                    case 1 { transfer_token(token0, caller(), amount) }
                    case 0 { transfer_token(token1, caller(), amount) }
                }
                default {
                    // flash swap — data is dispatcher commands
                    dispatcher(offset, add(offset, dataLen))
                }
            }

            // ===== V4 COMMANDS =====
            function uni_v4_unlock(offset) -> s {
                let pm := shr(96, calldataload(offset))
                let inner := shr(232, calldataload(add(offset, 20)))
                v4_unlock_deep(pm, add(offset, 23), inner)
                s := add(inner, 23)
            }
            function v4_unlock_deep(pm, cmdOffset, cmdLen) {
                mstore(0, shl(224, 0x48c89491))
                mstore(4, 32)
                mstore(36, cmdLen)
                calldatacopy(68, cmdOffset, cmdLen)
                let callLen := add(68, cmdLen)
                if iszero(call(gas(), pm, 0, 0, callLen, 0, 0)) {
                    revert(0, 0)
                }
            }
            function v4_unlock_callback(offset) {
                let len := calldataload(sub(offset, 32))
                dispatcher(offset, add(offset, len))
            }
            function swap_uni_v4_zfo(offset) {
                let pm := shr(96, calldataload(offset))
                let currency0 := shr(96, calldataload(add(offset, 20)))
                let currency1 := shr(96, calldataload(add(offset, 40)))
                let fee := shr(232, calldataload(add(offset, 60)))
                let tickSpacing := signextend(2, shr(232, calldataload(add(offset, 63))))
                let hooks := shr(96, calldataload(add(offset, 66)))
                let amount := shr(144, calldataload(add(offset, 86)))
                // zfo: tokenIn = currency0. amount=0 → resolve
                amount := resolve_v4_amount(amount, currency0)
                v4_swap_exec(pm, currency0, currency1, fee, tickSpacing, hooks, 1, amount)
            }
            function swap_uni_v4_ofz(offset) {
                let pm := shr(96, calldataload(offset))
                let currency0 := shr(96, calldataload(add(offset, 20)))
                let currency1 := shr(96, calldataload(add(offset, 40)))
                let fee := shr(232, calldataload(add(offset, 60)))
                let tickSpacing := signextend(2, shr(232, calldataload(add(offset, 63))))
                let hooks := shr(96, calldataload(add(offset, 66)))
                let amount := shr(144, calldataload(add(offset, 86)))
                // ofz: tokenIn = currency1. amount=0 → resolve
                amount := resolve_v4_amount(amount, currency1)
                v4_swap_exec(pm, currency0, currency1, fee, tickSpacing, hooks, 0, amount)
            }
            // V4 amount resolution: amount=0 → balanceOf for ERC20, selfbalance for native ETH
            function resolve_v4_amount(amount, token) -> resolved {
                switch iszero(amount)
                case 1 {
                    switch iszero(token)
                    case 1 { resolved := selfbalance() }
                    default { resolved := balance_of(token, address()) }
                }
                default { resolved := amount }
            }
            function v4_swap_exec(pm, currency0, currency1, fee, tickSpacing, hooks, zeroForOne, amount) {
                mstore(0, shl(224, 0xf3cd914c))
                mstore(4, currency0)
                mstore(36, currency1)
                mstore(68, fee)
                mstore(100, tickSpacing)
                mstore(132, hooks)
                mstore(164, zeroForOne)
                mstore(196, sub(0, amount))
                switch zeroForOne
                case 1 { mstore(228, add(min_sqrt_ratio(), 1)) }
                case 0 { mstore(228, sub(max_sqrt_ratio(), 1)) }
                mstore(260, 288)
                mstore(292, 0)
                if iszero(call(gas(), pm, 0, 0, 324, 0, 32)) {
                    revert(0, 0)
                }
            }
            function v4_settle(offset) {
                let pm := shr(96, calldataload(offset))
                let token := shr(96, calldataload(add(offset, 20)))
                let amount := shr(144, calldataload(add(offset, 40)))
                switch iszero(token)
                case 1 {
                    // native ETH: amount=0 → selfbalance()
                    if iszero(amount) { amount := selfbalance() }
                    mstore(0, shl(224, 0x11da60b4))
                    if iszero(call(gas(), pm, amount, 0, 4, 0, 32)) { revert(0, 0) }
                }
                case 0 {
                    // ERC20: amount=0 → balanceOf(this, token)
                    amount := resolve_amount(amount, token)
                    mstore(0, shl(224, 0xa5841194))
                    mstore(4, token)
                    if iszero(call(gas(), pm, 0, 0, 36, 0, 0)) { revert(0, 0) }
                    transfer_token(token, pm, amount)
                    mstore(0, shl(224, 0x11da60b4))
                    if iszero(call(gas(), pm, 0, 0, 4, 0, 32)) { revert(0, 0) }
                }
            }
            function v4_take(offset) {
                let pm := shr(96, calldataload(offset))
                let token := shr(96, calldataload(add(offset, 20)))
                let amount := shr(144, calldataload(add(offset, 40)))
                mstore(0, shl(224, 0x0b0d9c09))
                mstore(4, token)
                mstore(36, address())
                mstore(68, amount)
                if iszero(call(gas(), pm, 0, 0, 100, 0, 0)) { revert(0, 0) }
            }

            // ===== BALANCER V1 (balanceOf fallback) =====
            function swap_bal_v1_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenIn := shr(96, calldataload(add(offset, 24)))
                let tokenOut := shr(96, calldataload(add(offset, 44)))
                let amount := shr(144, calldataload(add(offset, 64)))
                amount := resolve_amount(amount, tokenIn)
                safe_approve_token(tokenIn, pool, amount)
                swap_bal_v1_exec(sig, pool, tokenIn, amount, tokenOut)
            }
            function swap_bal_v1_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenOut := shr(96, calldataload(add(offset, 24)))
                let tokenIn := shr(96, calldataload(add(offset, 44)))
                let amount := shr(144, calldataload(add(offset, 64)))
                amount := resolve_amount(amount, tokenIn)
                safe_approve_token(tokenIn, pool, amount)
                swap_bal_v1_exec(sig, pool, tokenIn, amount, tokenOut)
            }
            function swap_bal_v1_exec(sig, pool, tokenIn, amount, tokenOut) {
                mstore(0, shl(224, sig))
                mstore(4, tokenIn)
                mstore(36, amount)
                mstore(68, tokenOut)
                mstore(100, 0)
                mstore(132, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
                if iszero(call(gas(), pool, 0, 0, 164, 0, 64)) {
                    revert(0, 0)
                }
            }

            // ===== FLUID DEX (balanceOf fallback) =====
            function swap_fluid_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenIn := shr(96, calldataload(add(offset, 24)))
                let amount := shr(144, calldataload(add(offset, 44)))
                amount := resolve_amount(amount, tokenIn)
                transfer_token(tokenIn, pool, amount)
                swap_fluid_exec(sig, pool, 1, amount)
            }
            function swap_fluid_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenIn := shr(96, calldataload(add(offset, 24)))
                let amount := shr(144, calldataload(add(offset, 44)))
                amount := resolve_amount(amount, tokenIn)
                transfer_token(tokenIn, pool, amount)
                swap_fluid_exec(sig, pool, 0, amount)
            }
            function swap_fluid_exec(sig, pool, zfo, amount) {
                mstore(0, shl(224, sig))
                mstore(4, zfo)
                mstore(36, amount)
                mstore(68, 0)
                mstore(100, address())
                if iszero(call(gas(), pool, 0, 0, 132, 0, 32)) {
                    revert(0, 0)
                }
            }

            // ===== DODO V2 (balanceOf fallback) =====
            function swap_dodo_zfo(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenIn := shr(96, calldataload(add(offset, 24)))
                let amount := shr(144, calldataload(add(offset, 44)))
                amount := resolve_amount(amount, tokenIn)
                transfer_token(tokenIn, pool, amount)
                swap_dodo_exec(sig, pool)
            }
            function swap_dodo_ofz(offset) {
                let sig := shr(224, calldataload(offset))
                let pool := shr(96, calldataload(add(offset, 4)))
                let tokenIn := shr(96, calldataload(add(offset, 24)))
                let amount := shr(144, calldataload(add(offset, 44)))
                amount := resolve_amount(amount, tokenIn)
                transfer_token(tokenIn, pool, amount)
                swap_dodo_exec(sig, pool)
            }
            function swap_dodo_exec(sig, pool) {
                mstore(0, shl(224, sig))
                mstore(4, address())
                if iszero(call(gas(), pool, 0, 0, 36, 0, 32)) {
                    revert(0, 0)
                }
            }

            // ===== HELPER FUNCTIONS =====
            function require(condition) {
                if iszero(condition) { revert(0, 0) }
            }
            function gte(a, b) -> r {
                r := iszero(lt(a, b))
            }
            function selector() -> s {
                s := div(calldataload(0), 0x100000000000000000000000000000000000000000000000000000000)
            }
            function transfer_token(token, account, amount) {
                mstore(0, shl(224, 0xa9059cbb))
                mstore(4, account)
                mstore(36, amount)
                if iszero(call(gas(), token, 0, 0, 68, 0, 32)) {
                    revert(0, 0)
                }
            }
            function approve_token(token, spender, amount) {
                mstore(0, shl(224, 0x095ea7b3))
                mstore(4, spender)
                mstore(36, amount)
                if iszero(call(gas(), token, 0, 0, 68, 0, 32)) {
                    revert(0, 0)
                }
            }
            function safe_approve_token(token, spender, amount) {
                mstore(0, shl(224, 0x095ea7b3))
                mstore(4, spender)
                mstore(36, 0)
                pop(call(gas(), token, 0, 0, 68, 0, 0))
                mstore(0, shl(224, 0x095ea7b3))
                mstore(4, spender)
                mstore(36, amount)
                if iszero(call(gas(), token, 0, 0, 68, 0, 0)) {
                    revert(0, 0)
                }
            }
            function swap_curve_exec(sig, pool, sellId, buyId, amount) {
                mstore(0, shl(224, sig))
                mstore(4, sellId)
                mstore(36, buyId)
                mstore(68, amount)
                mstore(100, 0)
                if iszero(call(gas(), pool, 0, 0, 132, 0, 32)) {
                    revert(0, 0)
                }
            }
            function swap_curve_eth_exec(sig, pool, sellId, buyId, amount) {
                mstore(0, shl(224, sig))
                mstore(4, sellId)
                mstore(36, buyId)
                mstore(68, amount)
                mstore(100, 0)
                if iszero(call(gas(), pool, amount, 0, 132, 0, 32)) {
                    revert(0, 0)
                }
            }
            function swap_v2_balancer(sig, poolId, assetIn, assetOut, amountIn, vault) {
                mstore(0, shl(224, sig))
                mstore(4, 224)
                mstore(36, address())
                mstore(68, 0)
                mstore(100, address())
                mstore(132, 0)
                mstore(164, 0)
                mstore(196, timestamp())
                mstore(228, poolId)
                mstore(260, 0)
                mstore(292, assetIn)
                mstore(324, assetOut)
                mstore(356, amountIn)
                mstore(388, 192)
                mstore(420, 0)
                if iszero(call(gas(), vault, 0, 0, 452, 0, 32)) {
                    revert(0, 0)
                }
            }
            function balance_of(token, account) -> b {
                mstore(0, shl(224, 0x70a08231))
                mstore(4, account)
                if iszero(staticcall(gas(), token, 0, 36, 0, 32)) {
                    revert(0, 0)
                }
                b := mload(0)
            }
            function swap_v3(sig, pool, account, zeroForOne, amount, priceLimit, token0, token1, amountIn) {
                mstore(0, shl(224, sig))
                mstore(4, account)
                mstore(36, zeroForOne)
                mstore(68, amount)
                mstore(100, priceLimit)
                mstore(132, 160)
                mstore(164, 56)
                mstore(196, shl(96, token0))
                mstore(216, shl(96, token1))
                mstore(236, shl(248, zeroForOne))
                mstore(237, shl(144, amountIn))
                if iszero(call(gas(), pool, 0, 0, 252, 0, 64)) {
                    revert(0, 0)
                }
            }
            function swap_v2(sig, pair, amount0, amount1, to) {
                mstore(0, shl(224, sig))
                mstore(4, amount0)
                mstore(36, amount1)
                mstore(68, to)
                mstore(100, 128)
                mstore(132, 0)
                if iszero(call(gas(), pair, 0, 0, 164, 0, 0)) {
                    revert(0, 0)
                }
            }
            function deposit_weth(amount) {
                mstore(0, shl(224, 0xd0e30db0))
                if iszero(call(gas(), weth(), amount, 0, 4, 0, 0)) {
                    revert(0, 0)
                }
            }
            function withdraw_weth(amount) {
                mstore(0, shl(224, 0x2e1a7d4d))
                mstore(4, amount)
                if iszero(call(gas(), weth(), 0, 0, 36, 0, 0)) {
                    revert(0, 0)
                }
            }
            function min_sqrt_ratio() -> m {
                m := 4295128739
            }
            function max_sqrt_ratio() -> m {
                m := 1461446703485210103287273052203988822378723970342
            }
            function weth() -> w {
                w := 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
            }
            // Multi-operator auth (same as V1)
            function check_operator() {
                let idx := and(sub(gasprice(), basefee()), 0xF)
                let expected
                switch idx
                // PLACEHOLDER values for operator addresses 0x0...01 .. 0x0...0B.
                // Regenerate via `node scripts/compute_op_hashes.js 0xYourOp0 0xYourOp1 ...` before any production deploy.
                case 0  { expected := 0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6 }
                case 1  { expected := 0x405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace }
                case 2  { expected := 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b }
                case 3  { expected := 0x8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b }
                case 4  { expected := 0x036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db0 }
                case 5  { expected := 0xf652222313e28459528d920b65115c16c04f3efc82aaedc97be59f3f377c0d3f }
                case 6  { expected := 0xa66cc928b5edb82af9bd49922954155ab7b0942694bea4ce44661d9a8736c688 }
                case 7  { expected := 0xf3f7a9fe364faab93b216da50a3214154f22a0a2b415b23a84c8169e8b636ee3 }
                case 8  { expected := 0x6e1540171b6c0c960b71a7020d9f60077f6af931a8bbf590da0223dacf75c7af }
                case 9  { expected := 0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a8 }
                case 10 { expected := 0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db9 }
                default { revert(0, 0) }
                mstore(0x00, origin())
                require(eq(keccak256(0x00, 0x20), expected))
            }
            function auth() {
                check_operator()
            }
        }
    }
}
