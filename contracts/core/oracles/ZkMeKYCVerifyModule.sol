// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../interfaces/core/oracles/IZKMEVerifyUpgradeable.sol";
import "./KYCVerifyModule.sol";

/**
 * @title ZKMEKYCVerifyModule
 * @author RAAC Protocol Team
 * @notice Contract for the ZKME KYC verify module.
 * @dev This contract is used to verify the KYC of a user using the ZKME system.
 * @dev https://github.com/zkMeLabs/zkme-contracts/blob/main/solidity/contracts/ZKMEVerifyUpgradeable.sol
 * @dev https://docs.zk.me/zkme-dochub/verify-with-zkme-protocol/integration-checklist/zkme-protocol-smart-contract
 */
contract ZKMEKYCVerifyModule is KYCVerifyModule {
    /**
     * @notice Address of the ZKME verify contract
     */
    address public zkmeVerify;
    /**
     * @notice Address of the ZKME cooperator
     */
    address public zkmeCooperator;

    /**
     * @notice Constructor
     * @param _zkmeVerify The address of the ZKME verify contract
     * @param _zkmeCooperator The address of the ZKME cooperator
     * @param _initialOwner The address of the initial owner
     */
    constructor(address _zkmeVerify, address _zkmeCooperator, address _initialOwner) Ownable(_initialOwner) {
        if (_zkmeVerify == address(0) || _zkmeCooperator == address(0) || _initialOwner == address(0)) revert InvalidAddress();
        zkmeVerify = _zkmeVerify;
        zkmeCooperator = _zkmeCooperator;
    }

    /**
     * @notice Verify the KYC of a user
     * @param user The address of the user to verify
     * @return True if the user is KYC, false otherwise
     */
    function verifyKYC(address user) external view override returns (bool) {
        return IZKMEVerifyUpgradeable(zkmeVerify).hasApproved(zkmeCooperator, user) && IZKMEVerifyUpgradeable(zkmeVerify).verify(zkmeCooperator, user);
    }

    /**
     * @notice Set the ZKME verify contract address
     * @param _zkmeVerify The new ZKME verify contract address
     * @dev The address of the ZKME verify contract on the chain (e.g. Ethereum: )
     */
    function setZKMEVerify(address _zkmeVerify) external onlyOwner {
        if (_zkmeVerify == address(0)) revert InvalidAddress();
        if (_zkmeVerify == zkmeVerify) revert SameAddress();
        zkmeVerify = _zkmeVerify;
        emit ZKMEVerifyUpdated(_zkmeVerify);
    }

    /**
     * @notice Set the ZKME cooperator address
     * @param _zkmeCooperator The new ZKME cooperator address
     * @dev The ZKME cooperator is attached to each project initialized on ZKME
     */
    function setZKMECooperator(address _zkmeCooperator) external onlyOwner {
        if (_zkmeCooperator == address(0)) revert InvalidAddress();
        if (_zkmeCooperator == zkmeCooperator) revert SameAddress();
        zkmeCooperator = _zkmeCooperator;
        emit ZKMECooperatorUpdated(zkmeCooperator);
    }

    event ZKMEVerifyUpdated(address newZKMEVerify);
    event ZKMECooperatorUpdated(address newZKMECooperator);

    error InvalidAddress();
    error SameAddress();
}