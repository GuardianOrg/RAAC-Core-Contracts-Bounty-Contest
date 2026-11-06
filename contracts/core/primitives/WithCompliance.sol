// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../interfaces/IComplianceRegistry.sol";

/// @title WithCompliance
/// @author RAAC Protocol Team
/// @notice Base contract that enforces a global blacklist check
abstract contract WithCompliance {
    /// @notice Address of the central ComplianceRegistry
    IComplianceRegistry public immutable complianceRegistry;

    /// @param _complianceRegistry the deployed registry’s address
    constructor(address _complianceRegistry) {
        require(address(_complianceRegistry) != address(0), "Zero registry");
        complianceRegistry = IComplianceRegistry(_complianceRegistry);
    }

    /// @dev Revert if `msg.sender` is on the blacklist
    modifier notBlacklisted(address user) {
        if (IComplianceRegistry(complianceRegistry).isBlacklisted(user)) revert IComplianceRegistry.BlacklistedAddress();
        _;
    }
}