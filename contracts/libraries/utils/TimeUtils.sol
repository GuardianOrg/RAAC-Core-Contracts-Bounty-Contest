// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title TimeUtils
 * @dev Library for time operations
 */
library TimeUtils {
    uint256 internal constant WEEK = 1 weeks;

    /**
     * @notice Internal function to calculate next Thursday 0:00 UTC
     * @param timestamp Current timestamp
     * @return Next Thursday 0:00 UTC timestamp
     */
    function getNextThursdayMidnight(uint256 timestamp) internal pure returns (uint256) {
        uint256 daysSinceEpoch = timestamp / 1 days; 

        uint256 daysSincePreviousThursday = daysSinceEpoch % 7; 

        if (daysSincePreviousThursday == 0 && (timestamp % 1 days) == 0) {
            return timestamp; // Already at Thursday midnight
        }

        uint256 daysUntilThursday = daysSincePreviousThursday == 0 ? 7 : 7 - daysSincePreviousThursday; 
        return (daysSinceEpoch + daysUntilThursday) * 1 days; 
    }

    /**
     * @notice Rounds a timestamp up to the next week boundary
     * @param timestamp Timestamp to round
     * @return nextWeek Next week boundary timestamp (or current if already at boundary)
     */
    function roundUpToNextWeek(uint256 timestamp) internal pure returns (uint256) {
        // If already at a week boundary, return as-is
        if (timestamp % WEEK == 0) {
            return timestamp;
        }
        // Otherwise, round up to next week
        return ((timestamp / WEEK) + 1) * WEEK;
    }

    /**
     * @notice Calculates the next week boundary or caps at a maximum time
     * @param currentTime Current timestamp
     * @param maxTime Maximum timestamp to cap at
     * @return Next week boundary or maxTime, whichever is sooner
     */
    function getNextWeekOrCap(uint256 currentTime, uint256 maxTime) internal pure returns (uint256) {
        uint256 nextWeek = ((currentTime / WEEK) + 1) * WEEK;
        return nextWeek > maxTime ? maxTime : nextWeek;
    }
} 