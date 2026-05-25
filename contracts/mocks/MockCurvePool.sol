// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @dev Minimal mock of a Curve pool that supports exchange() and exchange_underlying()
contract MockCurvePool {
    address[] public coins;

    constructor(address[] memory _coins) {
        coins = _coins;
    }

    /// @dev Curve V2 exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
    /// selector: 0x3df02124
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256) {
        return _doExchange(uint256(int256(i)), uint256(int256(j)), dx);
    }

    /// @dev Curve V3 exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
    /// selector: 0x5b41b908
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256) {
        return _doExchange(i, j, dx);
    }

    /// @dev get_dx(int128 i, int128 j, uint256 dy) — selector 0x67df02ca
    /// Reverse of exchange(): given desired output dy, compute required input dx
    function get_dx(int128, int128, uint256 dy) external pure returns (uint256) {
        return (dy * 1000 + 996) / 997; // ceil div, inverse of 997/1000 fee
    }

    function _doExchange(uint256 i, uint256 j, uint256 dx) internal returns (uint256) {
        uint256 dy = dx * 997 / 1000; // simple fee

        IERC20(coins[i]).transferFrom(msg.sender, address(this), dx);
        IERC20(coins[j]).transfer(msg.sender, dy);

        return dy;
    }
}
