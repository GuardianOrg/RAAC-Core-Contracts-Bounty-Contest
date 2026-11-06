// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract crvUSDTokenLimited is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public minter;

    uint256 public maxMintablePerAddress;
    mapping(address => bool) public whitelisted;
    mapping(address => uint256) public totalMinted;

    constructor(address initialOwner) ERC20("Curve USD", "crvUSD") Ownable(initialOwner) {
        minter = initialOwner;
        maxMintablePerAddress = 200_000e18; // 200,000 tokens
        whitelisted[initialOwner] = true;
    }

    function mint(address to, uint256 amount) external {
        if (whitelisted[msg.sender]) {
            _mint(to, amount);
            totalMinted[to] += amount;
            return;
        }
        // Check if address has already minted (unless whitelisted)
        if (totalMinted[to] > 0) {
            revert("Address has already minted");
        }
        
        uint256 mintAmount = maxMintablePerAddress;
        _mint(to, mintAmount);
        totalMinted[to] += mintAmount;
    }

    function whitelist(address account, bool isWhitelisted) external onlyOwner {
        whitelisted[account] = isWhitelisted;
    }

    function setMinter(address _minter) external onlyOwner {
        minter = _minter;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        uint256 currentAllowance = allowance(account, msg.sender);
        require(currentAllowance >= amount, "ERC20: burn amount exceeds allowance");
        unchecked {
            _approve(account, msg.sender, currentAllowance - amount);
        }
        _burn(account, amount);
    }
}