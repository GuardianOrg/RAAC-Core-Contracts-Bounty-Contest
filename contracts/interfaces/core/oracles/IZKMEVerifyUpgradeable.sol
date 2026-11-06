// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IZKMEVerifyUpgradeable
 * @author RAAC Protocol Team
 * @notice Interface for the ZKMEVerifyUpgradeable contract used to verify the KYC for a user for KYC-based actions within protocol.
 */
interface IZKMEVerifyUpgradeable {
    /**
     * @dev verify of ZkMe contract to get to know if user has authorized by cooperator
     */
    function hasApproved(address cooperator, address user) external view returns (bool);

    /**
     * @dev verify of ZkMe contract to get if the user is KYCs
     */
    function verify(address cooperator, address user) external view returns (bool);
}