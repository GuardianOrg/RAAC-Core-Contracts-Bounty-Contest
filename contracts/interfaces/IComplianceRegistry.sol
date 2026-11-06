// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IComplianceRegistry
/// @author RAAC Protocol Team
/// @notice Interface for querying blacklisted addresses.
interface IComplianceRegistry is IERC165 {
    /// @notice Returns whether an address is blacklisted.
    /// @param user The address to check.
    /// @return True if the address is blacklisted, false otherwise.
    function isBlacklisted(address user) external view returns (bool);

    /// @notice Emitted when an address is added to the blacklist.
    /// @param user The address that was blacklisted.
    event Blacklisted(address indexed user);

    /// @notice Emitted when an address is removed from the blacklist.
    /// @param user The address that was unblacklisted.
    event UnBlacklisted(address indexed user);

    /// @notice user already blacklisted
    error AlreadyBlacklisted();

    /// @notice user is not blacklisted
    error NotBlacklisted();

    /// @notice throw error if invalid address
    error InvalidAddress();

    /// @notice throw error if blacklisted
    error BlacklistedAddress();
}