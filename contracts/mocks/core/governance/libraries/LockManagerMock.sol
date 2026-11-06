// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

// import "../../../libraries/governance/LockManager.sol";
import "../../../../libraries/governance/LockManager.sol";

// import "../../";

contract LockManagerMock {
    using LockManager for LockManager.LockState;

    LockManager.LockState private state;

    // Setup ---------------------------------------------------------------
    function setLockParams(uint40 epochDuration, uint40 maxLockEpochs) external {
        state.epochDuration = epochDuration;
        state.maxLockEpochs = maxLockEpochs;
    }

    function setTimePerBlock(uint256 timePerBlock) external {
        state.timePerBlock = timePerBlock;
    }

    // Mutations -----------------------------------------------------------
    function createLock(address user, uint256 amount, uint40 epochs) external returns (int128 uBias, int128 gBias, uint40 epochEnd) {
        (uBias, gBias, epochEnd) = state.createLock(user, amount, epochs);
    }

    function increaseLock(address user, uint256 additionalAmount, uint40 epochEnd) external returns (int128 uBias, int128 gBias) {
        (uBias, gBias) = state.increaseLock(user, additionalAmount, epochEnd);
    }

    function extendLock(address user, uint40 fromEpochEnd, uint40 addEpochs)
        external
        returns (uint40 newEpochEnd, uint256 amount, int128 uBias, int128 gBias)
    {
        (newEpochEnd, amount, uBias, gBias) = state.extendLock(user, fromEpochEnd, addEpochs);
    }

    function withdrawSpecificLock(address user, uint40 epochEnd) external returns (uint256 withdrawn) {
        return state.withdrawSpecificLock(user, epochEnd);
    }

    function withdrawExpired(address user) external returns (uint256 withdrawn, uint16 processed) {
        return state.withdrawExpired(user);
    }

    function emergencyWithdrawAll(address user) external returns (uint256 processedAmount, uint32 processed, int128 uBias, int128 gBias) {
        return state.emergencyWithdrawAll(user);
    }

    // Views ---------------------------------------------------------------
    function getUserTotalLocked(address user) external view returns (uint256) {
        return state.userLockState[user].totalLocked;
    }

    function getTotalLocked() external view returns (uint256) {
        return state.totalLocked;
    }

    function getUserLocksCount(address user) external view returns (uint256) {
        return state.userLockState[user].locks.length;
    }

    function getUserLockAt(address user, uint256 index) external view returns (uint112 amount, uint40 unlockTime) {
        IveRAACToken.LockedBalance storage lb = state.userLockState[user].locks[index];
        return (lb.amount, lb.unlockTime);
    }

    function findUserLockAmount(address user, uint32 unlockTime) external view returns (uint112) {
        LockManager.EpochLockState storage u = state.userLockState[user];
        for (uint256 i = u.nextUnlockIndex; i < u.locks.length; i++) {
            if (u.locks[i].unlockTime == unlockTime) {
                return u.locks[i].amount;
            }
        }
        return 0;
    }

    function getUserNextUnlockIndex(address user) external view returns (uint32) {
        return state.userLockState[user].nextUnlockIndex;
    }

    function getVotingPowerAtTime(address user, uint256 timestamp) external view returns (uint256) {
        return state.getVotingPowerAtTime(user, timestamp);
    }

    function getTotalVotingPowerAt(uint256 timestamp) external view returns (uint256) {
        return state.getTotalVotingPowerAt(timestamp);
    }

    function getVotingPowerAtBlock(address user, uint256 blockNumber) external view returns (uint256) {
        return state.getVotingPowerAtBlock(user, blockNumber);
    }

    // Helper: return the special frozen lock end timestamp (constant in library)
    function getFrozenLockEnd() external pure returns (uint40) {
        // Mirror LockManager.FROZEN_LOCK_END_WEEK value (09/24/2080 rounded up to week)
        return uint40(3494534400);
    }
}
