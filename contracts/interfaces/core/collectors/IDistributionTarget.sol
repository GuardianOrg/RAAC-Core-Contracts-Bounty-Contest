// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IDistributionTarget Interface
 * @notice Interface for contracts that can receive fee distributions via distributeRewards method
 * @dev Contracts implementing this interface should also implement ERC165 to advertise support
 */
interface IDistributionTarget is IERC165 {
    /**
     * @notice Receives and processes fee distributions
     * @dev This method is called by the FeeCollector when distributing fees
     * @param token The token being distributed
     * @param amount The amount of tokens being distributed
     * @return success True if the distribution was processed successfully
     */
    function distributeRewards(address token, uint256 amount) external returns (bool);
} 