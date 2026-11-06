// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../primitives/MockContractWithConfig.sol";
import "../../../interfaces/core/tokens/IRToken.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockLendingPoolCollector is MockContractWithConfig {
    using SafeERC20 for IERC20;

    // Vault rewards data matching LendingPool implementation
    struct VaultRewards {
        uint256 totalDeposits;
        uint256 unclaimedRewards;
        uint256 lastClaimTime;
        uint256 lastSharePrice;
        uint256 lastWithdrawalTime;
        uint256 lastDepositTime;
        uint256 totalShares;
    }

    VaultRewards public vaultRewards;
    IERC20 public reserveAsset;
    address public feeCollector;

    // Mock share price for testing
    uint256 public constant INITIAL_SHARE_PRICE = 1e18;
    uint256 public currentSharePrice = INITIAL_SHARE_PRICE;

    constructor(address _reserveAsset) {
        reserveAsset = IERC20(_reserveAsset);
    }

    function setFeeCollector(address _feeCollector) external {
        feeCollector = _feeCollector;
    }

    function claimCollectorRewards() external returns (address, uint256) {
        require(msg.sender == feeCollector, "Only fee collector can claim rewards");
        require(vaultRewards.unclaimedRewards > 0, "No rewards to claim");

        uint256 claimableAmount = vaultRewards.unclaimedRewards;
        vaultRewards.unclaimedRewards = 0;
        vaultRewards.lastClaimTime = block.timestamp;

        // Transfer rewards to fee collector
        reserveAsset.safeTransfer(feeCollector, claimableAmount);

        emit VaultRewardsClaimed(claimableAmount);
        return (address(reserveAsset), claimableAmount);
    }

    function depositToVault(uint256 amount) external {
        require(amount > 0, "Amount must be greater than 0");
        
        // Transfer tokens from sender to this contract
        uint256 balanceBefore = reserveAsset.balanceOf(address(this));
        reserveAsset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = reserveAsset.balanceOf(address(this));
        uint256 actualAmount = balanceAfter - balanceBefore;
        
        vaultRewards.totalDeposits += actualAmount;
        vaultRewards.totalShares += actualAmount;

        vaultRewards.unclaimedRewards += actualAmount;
        
        // Update vault rewards data
        vaultRewards.lastDepositTime = block.timestamp;
        vaultRewards.lastSharePrice = currentSharePrice;

        emit Deposited(msg.sender, actualAmount);
    }

    // Mock function to simulate share price changes
    function setSharePrice(uint256 newSharePrice) external {
        currentSharePrice = newSharePrice;
    }

    // Events
    event VaultRewardsClaimed(uint256 amount);
    event Deposited(address indexed depositor, uint256 amount);
}