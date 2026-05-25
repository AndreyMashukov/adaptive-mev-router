// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Vault — Secure capital management for MEV operations.
/// @notice Holds ETH + WETH. Operators call execute() to fund bot + run commands.
///         Owner key NEVER on server — hardware wallet only.
///         Auth: keccak256(abi.encodePacked(address)) checked against 11 hardcoded hashes.
///         execute() uses msg.value = operator index for auth.
///         refill() caller passes operator addresses — contract validates hash before sending ETH.
contract Vault {
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 private constant NUM_OPERATORS = 11;

    address private immutable _owner;

    // Operator hashes: keccak256(abi.encodePacked(operatorAddress, uint256(index)))
    // Computed in constructor, stored as immutable (bytecode, no SLOAD).
    bytes32 private immutable OP_HASH_0;
    bytes32 private immutable OP_HASH_1;
    bytes32 private immutable OP_HASH_2;
    bytes32 private immutable OP_HASH_3;
    bytes32 private immutable OP_HASH_4;
    bytes32 private immutable OP_HASH_5;
    bytes32 private immutable OP_HASH_6;
    bytes32 private immutable OP_HASH_7;
    bytes32 private immutable OP_HASH_8;
    bytes32 private immutable OP_HASH_9;
    bytes32 private immutable OP_HASH_10;

    /// @notice Maximum ETH balance per operator. Refill tops up to this limit.
    uint256 public maxBalance;

    error Unauthorized();
    error NotOwner();
    error TransferFailed();
    error InvalidOperator();

    event Received(address indexed from, uint256 amount);
    event Refilled(address indexed operator, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event MaxBalanceSet(uint256 oldMax, uint256 newMax);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

    constructor(uint256 maxBalance_) payable {
        _owner = msg.sender;
        maxBalance = maxBalance_;

        // PLACEHOLDER operator addresses. Regenerate before production deploy.
        // See README §Authorization and scripts/compute_op_hashes.js.
        OP_HASH_0  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000001), uint256(0)));
        OP_HASH_1  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000002), uint256(1)));
        OP_HASH_2  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000003), uint256(2)));
        OP_HASH_3  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000004), uint256(3)));
        OP_HASH_4  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000005), uint256(4)));
        OP_HASH_5  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000006), uint256(5)));
        OP_HASH_6  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000007), uint256(6)));
        OP_HASH_7  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000008), uint256(7)));
        OP_HASH_8  = keccak256(abi.encodePacked(address(0x0000000000000000000000000000000000000009), uint256(8)));
        OP_HASH_9  = keccak256(abi.encodePacked(address(0x000000000000000000000000000000000000000A), uint256(9)));
        OP_HASH_10 = keccak256(abi.encodePacked(address(0x000000000000000000000000000000000000000b), uint256(10)));
    }

    /// @notice Accept ETH deposits (from bot profits, manual sends, etc.)
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    // ─── Owner Management ───────────────────────────────────────────────

    /// @notice Set maximum ETH balance per operator. Owner only.
    function setMaxBalance(uint256 newMax) external {
        if (msg.sender != _owner) revert NotOwner();
        uint256 oldMax = maxBalance;
        maxBalance = newMax;
        emit MaxBalanceSet(oldMax, newMax);
    }

    /// @notice Withdraw ETH to specified address. Owner only.
    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != _owner) revert NotOwner();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Transfer ERC20 tokens out. Owner only.
    function sweepToken(address token, address to, uint256 amount) external {
        if (msg.sender != _owner) revert NotOwner();
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), to)
            mstore(add(ptr, 36), amount)
            let ok := call(gas(), token, 0, ptr, 68, ptr, 32)
            if iszero(ok) {
                mstore(0x00, 0x90b8ec18) // TransferFailed()
                revert(0x1c, 0x04)
            }
            if returndatasize() {
                if iszero(mload(ptr)) {
                    mstore(0x00, 0x90b8ec18) // TransferFailed()
                    revert(0x1c, 0x04)
                }
            }
        }
        emit TokenSwept(token, to, amount);
    }

    // ─── Refill ─────────────────────────────────────────────────────────

    /// @notice Refill operators from msg.value. Tops each up to maxBalance.
    ///         Caller passes operator addresses — contract validates hash before sending.
    ///         Owner only.
    function refill(address[] calldata ops) external payable {
        if (msg.sender != _owner) revert NotOwner();
        _fundOperators(ops);
    }

    /// @notice Refill operators from vault's WETH balance. Unwraps WETH to ETH first.
    ///         Caller passes operator addresses — contract validates hash before sending.
    ///         Owner only.
    function refillFromWeth(address[] calldata ops, uint256 wethAmount) external {
        if (msg.sender != _owner) revert NotOwner();

        // WETH.withdraw(wethAmount) — unwrap to ETH
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x2e1a7d4d00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), wethAmount)
            let ok := call(gas(), 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, 0, ptr, 36, 0, 0)
            if iszero(ok) {
                mstore(0x00, 0x90b8ec18) // TransferFailed()
                revert(0x1c, 0x04)
            }
        }

        _fundOperators(ops);
    }

    /// @dev Validate each address against operator hashes, then send ETH deficit.
    function _fundOperators(address[] calldata ops) internal {
        uint256 max = maxBalance;
        for (uint256 i; i < ops.length; ++i) {
            address op = ops[i];
            if (!_isValidOperator(op)) revert InvalidOperator();

            uint256 bal = op.balance;
            if (bal < max) {
                uint256 deficit = max - bal;
                (bool ok,) = op.call{value: deficit}("");
                if (!ok) revert TransferFailed();
                emit Refilled(op, deficit);
            }
        }
    }

    /// @dev Check if address matches any of the 11 operator hashes.
    ///      Tries keccak256(abi.encodePacked(addr, uint256(i))) for i in 0..10.
    function _isValidOperator(address addr) internal view returns (bool) {
        for (uint256 i; i < NUM_OPERATORS; ++i) {
            bytes32 hash = keccak256(abi.encodePacked(addr, i));
            if (hash == getHash(i)) return true;
        }
        return false;
    }

    // ─── Execute (sandwich) ─────────────────────────────────────────────

    /// @notice Execute sandwich via bot. Transfers WETH to bot, calls bot with commands.
    /// @param amount WETH amount to transfer to bot
    /// @param bot MEV bot contract address
    /// @param commands packed MEV dispatcher calldata
    function execute(uint112 amount, address bot, bytes calldata commands) external payable {
        bytes32 hash = keccak256(abi.encodePacked(msg.sender, msg.value));
        if (hash != getHash(msg.value)) revert Unauthorized();

        // Transfer WETH to bot (assembly for gas optimization)
        assembly {
            // IERC20(WETH).transfer(bot, amount)
            let ptr := mload(0x40)
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), bot)
            mstore(add(ptr, 36), amount)
            let ok := call(gas(), 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, 0, ptr, 68, ptr, 32)
            if iszero(ok) {
                mstore(0x00, 0x90b8ec18) // TransferFailed()
                revert(0x1c, 0x04)
            }
            if returndatasize() {
                if iszero(mload(ptr)) {
                    mstore(0x00, 0x90b8ec18) // TransferFailed()
                    revert(0x1c, 0x04)
                }
            }
        }

        // Call bot: value = commands.length (bot dispatcher uses callvalue as byte length)
        assembly {
            let ptr := mload(0x40)
            calldatacopy(ptr, commands.offset, commands.length)
            let ok := call(gas(), bot, commands.length, ptr, commands.length, 0, 0)
            if iszero(ok) {
                // Bubble up revert from bot
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
        }
    }

    // ─── Internal ───────────────────────────────────────────────────────

    function getHash(uint256 idx) internal view returns(bytes32) {
        if (idx == 0) {
            return OP_HASH_0;
        } else if (idx == 1) {
            return OP_HASH_1;
        } else if (idx == 2) {
            return OP_HASH_2;
        } else if (idx == 3) {
            return OP_HASH_3;
        } else if (idx == 4) {
            return OP_HASH_4;
        } else if (idx == 5) {
            return OP_HASH_5;
        } else if (idx == 6) {
            return OP_HASH_6;
        } else if (idx == 7) {
            return OP_HASH_7;
        } else if (idx == 8) {
            return OP_HASH_8;
        } else if (idx == 9) {
            return OP_HASH_9;
        } else if (idx == 10) {
            return OP_HASH_10;
        } else {
            revert('H');
        }
    }

    /// @notice Get contract owner.
    function owner() external view returns (address) { return _owner; }
}
