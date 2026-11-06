// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferToken
 * @notice Mock ERC20 token that takes a fee on every transfer
 * @dev The fee is burned, reducing the amount received by the recipient
 */
contract MockFeeOnTransferToken is ERC20 {
    uint256 public feeBps; 
    
    constructor(
        string memory name, 
        string memory symbol,
        uint256 _feeBps
    ) ERC20(name, symbol) {
        feeBps = _feeBps;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setFeeBps(uint256 _feeBps) external {
        feeBps = _feeBps;
    }

    function _update(address from, address to, uint256 amount) internal virtual override {
        // not mints or burns
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (amount * feeBps) / 10000;
            uint256 amountAfterFee = amount - fee;
            
            super._update(from, address(0), fee); // burn
            super._update(from, to, amountAfterFee);
        } else {
            super._update(from, to, amount);
        }
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}
