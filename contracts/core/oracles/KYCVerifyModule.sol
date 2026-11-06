// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IKYCVerifyModule
 * @author RAAC Protocol Team
 * @notice Interface for the KYC verify module.
 * @dev This contract is used to verify the KYC of a user.
 */
interface IKYCVerifyModule {
    /**
     * @notice Verify the KYC of a user
     * @param user The address of the user to verify
     * @return True if the user is KYC, false otherwise
     */
    function verifyKYC(address user) external view returns (bool);

    /**
     * @notice Error when the KYC is not verified
     */
    error KYCNotVerified();
}

/**
 * @title KYCVerifyModule
 * @author RAAC Protocol Team
 * @notice Abstract contract for the KYC verify module.
 * @dev This contract is used to verify the KYC of a user.
 */
abstract contract KYCVerifyModule is IKYCVerifyModule, Ownable {
    /**
     * @notice Verify the KYC of a user
     * @param user The address of the user to verify
     * @return True if the user is KYC, false otherwise
     */
    function verifyKYC(address user) external view virtual override returns (bool);
}