// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../libraries/utils/TimeUtils.sol";

/**
 * @title MockTimeUtils
 * @dev Mock contract for testing TimeUtils library functions
 */
contract MockTimeUtils {
    using TimeUtils for uint256;

    /**
     * @notice Wrapper function to test getNextThursdayMidnight
     * @param timestamp The timestamp from which to get the next Thursday midnight
     * @return The converted uint256
     */
    function getNextThursdayMidnight(uint256 timestamp) external pure returns (uint256) {
        return TimeUtils.getNextThursdayMidnight(timestamp);
    }

    function roundUpToNextWeek(uint256 timestamp) external pure returns (uint256) {
        return TimeUtils.roundUpToNextWeek(timestamp);
    }

    function getNextWeekOrCap(uint256 currentTime, uint256 maxTime) external pure returns (uint256) {
        return TimeUtils.getNextWeekOrCap(currentTime, maxTime);
    }
} 