// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Minimal mock of DODO V2 DVM pool that supports sellBase() and sellQuote()
/// Transfer-first pattern: caller must transfer tokenIn to pool before calling
contract MockDodoPool {
    address public _BASE_TOKEN_;
    address public _QUOTE_TOKEN_;
    uint256 private _lastBaseBalance;
    uint256 private _lastQuoteBalance;

    constructor(address baseToken, address quoteToken) {
        _BASE_TOKEN_ = baseToken;
        _QUOTE_TOKEN_ = quoteToken;
        _lastBaseBalance = 0;
        _lastQuoteBalance = 0;
    }

    /// @dev Initialize with current balances (call after funding pool)
    function sync() external {
        _lastBaseBalance = IERC20(_BASE_TOKEN_).balanceOf(address(this));
        _lastQuoteBalance = IERC20(_QUOTE_TOKEN_).balanceOf(address(this));
    }

    /// @dev sellBase(address to) — sell base token for quote token
    /// selector: 0xbd6015b4
    function sellBase(address to) external returns (uint256 receiveQuoteAmount) {
        uint256 currentBase = IERC20(_BASE_TOKEN_).balanceOf(address(this));
        uint256 amountIn = currentBase - _lastBaseBalance;
        receiveQuoteAmount = amountIn * 997 / 1000;

        _lastBaseBalance = currentBase;
        _lastQuoteBalance = IERC20(_QUOTE_TOKEN_).balanceOf(address(this)) - receiveQuoteAmount;

        IERC20(_QUOTE_TOKEN_).transfer(to, receiveQuoteAmount);
    }

    /// @dev sellQuote(address to) — sell quote token for base token
    /// selector: 0xdd93f59a
    function sellQuote(address to) external returns (uint256 receiveBaseAmount) {
        uint256 currentQuote = IERC20(_QUOTE_TOKEN_).balanceOf(address(this));
        uint256 amountIn = currentQuote - _lastQuoteBalance;
        receiveBaseAmount = amountIn * 997 / 1000;

        _lastQuoteBalance = currentQuote;
        _lastBaseBalance = IERC20(_BASE_TOKEN_).balanceOf(address(this)) - receiveBaseAmount;

        IERC20(_BASE_TOKEN_).transfer(to, receiveBaseAmount);
    }
}
