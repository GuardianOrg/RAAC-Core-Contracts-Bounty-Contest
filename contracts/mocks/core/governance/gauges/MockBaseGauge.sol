// // SPDX-License-Identifier: BUSL-1.1
// pragma solidity ^0.8.19;

// import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// import "../../../../core/governance/gauges/BaseGauge.sol";

// contract MockBaseGauge is BaseGauge {
//     using SafeERC20 for IERC20;
//     using TimeWeightedAverage for TimeWeightedAverage.Period;

//     event RewardNotified(uint256 reward, uint256 oldRewardRate, uint256 newRewardRate);
//     event PeriodUpdated(uint256 timestamp);

//     uint256 private mockWeight;
//     uint256 public constant WEEK = 7 days;

//     constructor(
//         address _rewardToken,
//         address _stakingToken,
//         address _controller,
//         uint256 _maxEmission,
//         uint256 _periodDuration
//     ) BaseGauge(
//         _rewardToken,
//         _stakingToken,
//         _controller,
//         _maxEmission,
//         _periodDuration
//     ) {
//         mockWeight = WEIGHT_PRECISION; // Default weight
//     }

//     // function setInitialWeight(uint256 weight) override external {
//     //     mockWeight = weight;
        
//     //     // Get current time and align to next period boundary with buffer
//     //     uint256 currentTime = block.timestamp;
//     //     uint256 duration = getPeriodDuration();
//     //     uint256 nextPeriodStart = ((currentTime / duration) + 2) * duration; // Add 2 periods for buffer
        
//     //     TimeWeightedAverage.createPeriod(
//     //         weightPeriod,
//     //         nextPeriodStart,
//     //         duration,
//     //         weight,
//     //         WEIGHT_PRECISION
//     //     );
//     // }

//     // Override for testing
//     function _getBaseWeight(address) internal view override returns (uint256) {
//         return mockWeight;
//     }

//     // function updatePeriod() external override onlyController {
//     //     uint256 periodDuration = getPeriodDuration();
//     //     if (block.timestamp < weightPeriod.startTime + periodDuration) {
//     //         revert PeriodNotElapsed();
//     //     }

//     //     uint256 avgWeight = getTimeWeightedWeight();
//     //     _updateWeights(avgWeight);

//     //     emit PeriodUpdated(block.timestamp);
//     // }

//     // Test helper function
//     function testValidateRewardRate(uint256 rate) external pure returns (bool) {
//         if (rate > MAX_REWARD_RATE) revert ExcessiveRewardRate();
//         return true;
//     }

//     // Override boost calculation for testing
//     function _applyBoost(address account, uint256 baseWeight) internal view override returns (uint256) {
//         return baseWeight; // Return base weight without boost for testing
//     }

//     function mockCheckpoint(address account) external {
//         for (uint256 i = 0; i < rewardTokens.length; i++) {
//             _updateReward(rewardTokens[i], account);
//         }
//         emit Checkpoint(account, block.timestamp);
//     }

//     // function notifyRewardAmount(uint256 amount) external override onlyController updateReward(address(0)) {
//     //     if (amount > distributionCap) revert ExcessiveRewardRate();
        
//     //     uint256 duration = getPeriodDuration();
//     //     uint256 oldRewardRate = rewardRate;
//     //     uint256 newRewardRate = amount / duration;
        
//     //     if (newRewardRate > MAX_REWARD_RATE) revert ExcessiveRewardRate();
        
//     //     rewardRate = newRewardRate;
//     //     lastUpdateTime = block.timestamp;

//     //     emit RewardNotified(amount, oldRewardRate, newRewardRate);
//     // }

//     function initializeBoostState(uint256 maxBoost, uint256 minBoost, uint256 boostWindow) external {
//         boostState.maxBoost = maxBoost;
//         boostState.minBoost = minBoost;
//         boostState.boostWindow = boostWindow;
//     }

//     /**
//      * @notice Gets duration of reward period
//      * @return Period duration in seconds
//      */
//     function getPeriodDuration() public view override returns (uint256) {
//         return WEEK;
//     }

//     /**
//      * @notice Gets total weight of gauge
//      * @return Total gauge weight
//      */
//     function getTotalWeight() external view override returns (uint256) {
//         return totalSupply();
//     }

//     /**
//      * @notice Gets reward for a specific token
//      * @param token Address of the reward token
//      */
//     function claimRewardToken(address token) public override {
//         _updateReward(token, msg.sender);
//         _claimReward(msg.sender, token);
//     }

//     /**
//      * @notice Stakes tokens for a user
//      * @param amount Amount to stake
//      */
//     function _stake(address user, uint256 amount) internal override {
//         stakingToken.safeTransferFrom(user, address(this), amount);
//         _totalSupply = _totalSupply + amount;
//         _balances[user] = _balances[user] + amount;
//     }

//     /**
//      * @notice Withdraws tokens for a user
//      * @param user Address of the user
//      * @param amount Amount to withdraw
//      */
//     function _withdraw(address user, uint256 amount) internal override {
//         _totalSupply = _totalSupply - amount;
//         _balances[user] = _balances[user] - amount;
//         stakingToken.safeTransfer(user, amount);
//     }

//     /**
//      * @notice Gets reward tokens for the gauge
//      * @return Array of reward token addresses
//      */
//     function getRewardTokens() external view override returns (address[] memory) {
//         return rewardTokens;
//     }

//     /**
//      * @notice Updates reward for an account
//      * @param account Address to update rewards for
//      */
//     modifier updateReward(address account) override {
//         for (uint256 i = 0; i < rewardTokens.length; i++) {
//             _updateReward(rewardTokens[i], account);
//         }
//         _;
//     }
// }