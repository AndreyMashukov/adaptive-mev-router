// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

/// @dev ERC20 with configurable transfer tax — recipient receives (amount - tax).
///      Tax is burned (deducted from totalSupply). Used to test fee-on-transfer flash paths.
contract MockFeeOnTransferERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    uint16 public taxBps; // e.g. 500 = 5%

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint16 _taxBps) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        taxBps = _taxBps;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }

        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        uint256 tax = amount * taxBps / 10000;
        uint256 received = amount - tax;
        balanceOf[from] -= amount;
        balanceOf[to] += received;
        totalSupply -= tax; // burn the tax
        emit Transfer(from, to, received);
        return true;
    }
}
