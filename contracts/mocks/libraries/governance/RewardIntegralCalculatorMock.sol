// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../libraries/governance/RewardIntegralCalculator.sol";

/**
 * @title MockRewardIntegralCalculator
 * @notice Mock contract to expose library functions for testing
 */
contract MockRewardIntegralCalculator {
    using RewardIntegralCalculator for uint256;

    function calculateWorkingBalance(uint256 balance, uint256 userWeight, uint256 maxBoost) external view returns (uint256) {
        return RewardIntegralCalculator.calculateWorkingBalance(balance, userWeight, maxBoost);
    }

    function calculatePeriodIndexFromTime(uint256 time, uint256 gaugeInitialStartTime, uint256 periodDuration) external pure returns (uint256) {
        return RewardIntegralCalculator.calculatePeriodIndexFromTime(time, gaugeInitialStartTime, periodDuration);
    }

    function calculatePeriodBoundariesFromTime(uint256 time, uint256 gaugeInitialStartTime, uint256 periodDuration) external pure returns (uint256 periodStartTime, uint256 periodEndTime) {
        return RewardIntegralCalculator.calculatePeriodBoundariesFromTime(time, gaugeInitialStartTime, periodDuration);
    }

    function calculatePeriodBoundariesFromIndex(uint256 periodIndex, uint256 gaugeInitialStartTime, uint256 periodDuration) external pure returns (uint256 periodStartTime, uint256 periodEndTime) {
        return RewardIntegralCalculator.calculatePeriodBoundariesFromIndex(periodIndex, gaugeInitialStartTime, periodDuration);
    }

    function calculateRate(uint256 amount, uint256 duration) external pure returns (uint256) {
        return RewardIntegralCalculator.calculateRate(amount, duration);
    }

    function calculateGaugeIntegral(uint256 currentIntegral,uint256 rate,uint256 timeDelta,uint256 workingSupply) external pure returns (uint256) {
        return RewardIntegralCalculator.calculateGaugeIntegral(
            currentIntegral,
            rate,
            timeDelta,
            workingSupply
        );
    }

    function calculateUserIntegral(uint256 userWorkingBalance, uint256 gaugeIntegral, uint256 userLastGaugeIntegral, uint256 userIntegral) external pure returns (uint256 newUserIntegral, uint256 claimableRewards) {
        return RewardIntegralCalculator.calculateUserIntegral(userWorkingBalance, gaugeIntegral, userLastGaugeIntegral, userIntegral);
    }

    function recalculateRate(uint256 currentRate, uint256 oldWorkingSupply, uint256 newWorkingSupply, uint256 remainingTime, uint256 lastUpdateTime, uint256 currentTime) external pure returns (uint256 newRate, uint256 accruedRewards) {
        return RewardIntegralCalculator.recalculateRate(currentRate, oldWorkingSupply, newWorkingSupply, remainingTime, lastUpdateTime, currentTime);
    }

}