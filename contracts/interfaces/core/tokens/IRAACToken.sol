// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IRAACToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function setMinter(address minter) external;
    function minter() external view returns (address);

     // Events
    event MinterSet(address indexed minter);

    // Errors
    error OnlyMinterCanMint();
    error TransferAmountExceedsAllowance();
    error IncrementLimitExceedsBaseLimit();
    error InvalidAddress();
}