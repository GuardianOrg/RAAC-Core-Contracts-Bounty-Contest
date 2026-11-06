// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStabilityPoolStorage {
     /**
     * @notice Emitted when a borrower is liquidated
     * @param user Address of the liquidated borrower
     * @param assetAddress Address of the asset being liquidated
     * @param data Identification data of the asset (e.g. tokenId for ERC721 and amount for ERC20)
     * @param amount Amount of debt liquidated
     */
    event BorrowerLiquidated(address indexed user, address assetAddress, bytes data, uint256 amount);
    
    /// @notice When amount is invalid (zero)
    error InvalidAmount();

    /// @notice When the data amount and the collateral do not match in liquidation
    error CollateralAndParamterDataMismatch();

    /// @notice Underlying asset in the adapters do not match
    error AdaptersAssetMismatch();

    /// @notice When user has insufficient balance
    error InsufficientBalance();

    /// @notice When token approval fails
    error ApprovalFailed();

    /// @notice Address is insvalid
    error InvalidAddress();
}