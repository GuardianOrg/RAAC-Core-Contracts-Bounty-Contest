// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../libraries/governance/PowerCheckpoint.sol";
import "../../../libraries/governance/LockManager.sol";

contract PowerCheckpointMock {
    using PowerCheckpoint for PowerCheckpoint.CheckpointState;
    using LockManager for LockManager.LockState;

    PowerCheckpoint.CheckpointState private _state;
    LockManager.LockState private _lockState;

    // Configuration for LockManager state used by block-based fallbacks
    function setLockParams(uint40 epochDuration, uint40 maxLockEpochs) external {
        _lockState.epochDuration = epochDuration;
        _lockState.maxLockEpochs = maxLockEpochs;
    }

    function setTimePerBlock(uint256 timePerBlock) external {
        _lockState.timePerBlock = timePerBlock;
    }

    function writeCheckpoint(address user, uint256 power) external {
        _state.writeCheckpoint(user, power);
    }

    function setProposalSnapshot(uint256 proposalId, uint256 blockNumber) external {
        _state.setProposalSnapshot(proposalId, blockNumber);
    }

    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256, uint256) {
        return PowerCheckpoint.getPastTotalSupply(_state, _lockState, blockNumber);
    }

    // ----- Helpers to populate internal LockManager state for fallback checks -----
    function createLock(address user, uint256 amount, uint40 epochs) external returns (int128 uBias, int128 gBias, uint40 epochEnd) {
        return _lockState.createLock(user, amount, epochs);
    }

    function increaseLock(address user, uint256 amountToAdd, uint40 epochEnd) external returns (int128 uBias, int128 gBias) {
        return _lockState.increaseLock(user, amountToAdd, epochEnd);
    }

    function extendLock(address user, uint40 fromEpochEnd, uint40 addEpochs)
        external
        returns (uint40 newEpochEnd, uint256 amount, int128 uBias, int128 gBias)
    {
        return _lockState.extendLock(user, fromEpochEnd, addEpochs);
    }

    function withdrawExpired(address user) external returns (uint256 withdrawn, uint16 processed) {
        return _lockState.withdrawExpired(user);
    }

    function emergencyWithdrawAll(address user) external returns (uint256 processedAmount, uint32 processed, int128 uBias, int128 gBias) {
        return _lockState.emergencyWithdrawAll(user);
    }

    // Helper function for tests to get checkpoint block numbers
    function getCheckpointBlock(uint256 index) external view returns (uint256) {
        PowerCheckpoint.Checkpoint[] storage checkpoints = _state.userCheckpoints[msg.sender];
        require(index < checkpoints.length, "Index out of bounds");
        return checkpoints[index].fromBlock;
    }

    // Helper function to get checkpoint count
    function getCheckpointCount(address user) external view returns (uint256) {
        return _state.userCheckpoints[user].length;
    }

    // Helper function to get current block number
    function getCurrentBlockNumber() external view returns (uint256) {
        return block.number;
    }

    // Helper function to get checkpoint value
    function getCheckpointValue(address user, uint256 index) external view returns (uint256) {
        PowerCheckpoint.Checkpoint[] storage checkpoints = _state.userCheckpoints[user];
        require(index < checkpoints.length, "Index out of bounds");
        return uint256(checkpoints[index].value);
    }

    // Expose index finder for tests
    function findIndex(address user, uint256 blockNumber) external view returns (uint256) {
        PowerCheckpoint.Checkpoint[] storage checkpoints = _state.userCheckpoints[user];
        return PowerCheckpoint.findCheckpointIndex(checkpoints, blockNumber);
    }
}