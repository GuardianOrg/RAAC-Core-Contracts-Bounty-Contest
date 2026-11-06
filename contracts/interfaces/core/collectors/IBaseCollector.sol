// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IBaseCollector Interface
 * @notice Interface for the BaseCollector
 * @dev Defines the lowest minimal interface for core functionality for fee collections
 */
interface IBaseCollector {
    function collectFee(address token, address target, uint256 amount, bytes32 feeType) external returns (bool);
}