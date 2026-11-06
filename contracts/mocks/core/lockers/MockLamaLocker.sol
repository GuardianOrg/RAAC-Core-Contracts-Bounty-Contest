// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../interfaces/core/lockers/ILLamaLocker.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract MockLamaLocker  {
    using SafeERC20 for IERC20;

    mapping(address token => bool valid) private isValidRewardToken;
    mapping(address => uint256) public distributedAmounts;
    mapping(address token => uint256 rps) private rewardPerShares;
    uint256 private totalShares=1000000;

    error InvalidAction();
    error InvalidTokenCount();
    error InvalidLockOwner();
    error InvalidUnlockWindow();
    error InvalidRewardToken();
    error InvalidRewardAmount();
    error InvalidTotalShares();
    error InvalidRecipient();

    function distributeRewardToken(address token_, uint256 amount_) external {
        // skipping token check
        // if (!isValidRewardToken[token_]) revert InvalidRewardToken();
        if (amount_ == 0) revert InvalidRewardAmount();
        if (totalShares == 0) revert InvalidTotalShares();
        rewardPerShares[token_] += (amount_ * 1 ether) / totalShares;
        IERC20(token_).safeTransferFrom(msg.sender, address(this), amount_);
    }

    function getDistributedAmount(address token_) external view returns (uint256) {
        return distributedAmounts[token_];
    }
}
