// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Mock Collectable Underlying Contract
 * @notice Mock contract for testing underlying NFT collection functionality
 */
contract MockCollectableUnderlying is AccessControl, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant WITHDRAW_ROLE = keccak256("WITHDRAW_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    IERC20 public token;
    bool public shouldRevert;
    uint256 public withdrawnAmount;
    address public lastWithdrawer;
    address public lastToken;

    event WithdrawUnderlyingExecuted(address token, address to, uint256 amount);

    error InvalidAddress();
    error InsufficientBalance();

    constructor(address _token) Ownable(msg.sender) {
        if (_token == address(0)) revert InvalidAddress();
        
        token = IERC20(_token);
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(WITHDRAW_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function setShouldRevert(bool _shouldRevert) external onlyRole(ADMIN_ROLE) {
        shouldRevert = _shouldRevert;
    }

    /**
     * @notice Allow a user to burn wrapped tokens and withdraw the corresponding tokenIds of the underlying tokens.
     * @dev Only callable by WITHDRAW_ROLE
     * @param tokenAddress The address of the token to withdraw
     * @param to The address to withdraw the tokens to
     * @param amount The amount of tokens to withdraw
     * @return True if the tokens were withdrawn successfully, false otherwise
     */
    function withdrawUnderlying(address tokenAddress, address to, uint256 amount) external onlyRole(WITHDRAW_ROLE) nonReentrant returns (bool) {
        if (shouldRevert) {
            revert("MockCollectableUnderlying: withdrawUnderlying reverted");
        }

        if (tokenAddress == address(0)) revert InvalidAddress();
        
        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance();

        // Record the withdrawal details
        withdrawnAmount = amount;
        lastWithdrawer = to;
        lastToken = tokenAddress;

        // Transfer the tokens
        IERC20(tokenAddress).safeTransfer(to, amount);

        emit WithdrawUnderlyingExecuted(tokenAddress, to, amount);
        return true;
    }

    function getLastWithdrawal() external view returns (uint256 amount, address withdrawer, address tokenAddress) {
        return (withdrawnAmount, lastWithdrawer, lastToken);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
} 