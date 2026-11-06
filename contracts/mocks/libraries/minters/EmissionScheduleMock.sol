// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../../../libraries/minters/EmissionSchedule.sol";

contract EmissionScheduleMock is ReentrancyGuard {
    using EmissionSchedule for uint256;

    function getEmissionPerSecondForWeek(uint256 weekNumber) public pure returns (uint256) {
        return EmissionSchedule.getEmissionPerSecondForWeek(weekNumber);
    }

    function getMintingWeekForTimestamp(uint256 activationTimestamp, uint256 timestamp) public pure returns (uint256) {
        return EmissionSchedule.getMintingWeekForTimestamp(activationTimestamp, timestamp);
    }

    function computeWeeklyEmissions(uint256 activationTimestamp, uint256 startTime, uint256 endTime) public pure returns (EmissionSchedule.WeeklyEmission[] memory) {
        return EmissionSchedule.computeWeeklyEmissions(activationTimestamp, startTime, endTime);
    }

    function calculateScheduledMintableAmount(uint256 activationTimestamp, uint256 startTime, uint256 endTime) public pure returns (uint256) {
        return EmissionSchedule.calculateScheduledMintableAmount(activationTimestamp, startTime, endTime);
    }
}