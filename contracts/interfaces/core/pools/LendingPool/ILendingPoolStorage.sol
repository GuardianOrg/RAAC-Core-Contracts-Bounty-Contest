// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILendingPoolStorage {
    // STRUCTS
    struct ReserveState {
        uint256 liquidityIndex;
        uint256 usageIndex;
        uint256 totalLiquidity;
        uint256 totalUsage;
    }

    // Collateral Position
    struct CollateralPosition {
        uint256 rawDebtBalance;    // Debt for this specific asset
        bool isUnderLiquidation;      // Liquidation state per asset
        uint256 liquidationStartTime;  // Liquidation timing per asset
        uint256 positionIndex;         // Usage position index per asset
        bool isInsured;               // Insurance state per asset
        uint256 rawInsuredBalance;    // Amount of insurance balance paid on asset
    }

    struct CollateralPositionView {
        uint256 rawDebtBalance;    // Debt for this specific asset
        uint256 scaledDebtBalance;    // Debt scaled up by usageIndex (only on view functions)
        uint256 healthFactor;      // Health factor per asset
        bool isUnderLiquidation;      // Liquidation state per asset
        uint256 liquidationStartTime;  // Liquidation timing per asset
        uint256 positionIndex;         // Usage position index per asset
        bool isInsured;               // Insurance state per asset
        address adapter;            // Address of the adapter
        address asset;              // Address of the underlying asset
    }

    // Vault rewards data
    struct VaultRewards {
        uint256 totalDeposits;
        uint256 unclaimedRewards;
        uint256 lastClaimTime;
        uint256 lastSharePrice;
        uint256 lastWithdrawalTime;
        uint256 lastDepositTime;
        uint256 totalShares;
    }

    /**
     * @notice Emitted when liquidation is initiated for an NFT position
     * @param liquidator The address of the liquidator
     * @param user The address of the user being liquidated
     * @param adapter Pool asset adapter 
     * @param data Asset identification data
     */ 
    event LiquidationInitiated(address indexed liquidator, address indexed user, address adapter, bytes data);

    /**
     * @notice Emitted when liquidation is closed for an NFT position
     * @param user The address of the user
     * @param adapter Pool asset adapter 
     * @param data Asset identification data
     */
    event LiquidationClosed(address indexed user, address adapter, bytes data);

    /**
     * @notice Emitted when a liquidation is finalized for an NFT position
     * @param liquidator The address of the liquidator
     * @param user The address of the user being liquidated
     * @param adapter Pool asset adapter 
     * @param data Asset identification data
     * @param debtRepaid The amount of debt repaid
     * @param collateralLiquidated The amount of collateral liquidated
     */
    event LiquidationFinalized(address indexed liquidator, address indexed user, address adapter, bytes data, uint256 debtRepaid, uint256 collateralLiquidated);

    /**
     * @notice Emitted when yield is harvested from the vault
     * @param yieldAmount The amount of yield harvested
     */
    event YieldHarvested(uint256 yieldAmount);

    /**
     * @notice Emitted when the vault is fully withdrawn
     * @param totalWithdrawn The total amount of shares withdrawn
     * @param principalReturned The amount of principal returned
     * @param yieldReturned The amount of yield returned
     * @param remainingShares The remaining shares in the vault
     */
    event VaultFullyWithdrawn(uint256 totalWithdrawn, uint256 principalReturned, uint256 yieldReturned, uint256 remainingShares);

    error NotInsured();
    error NotUnderLiquidation();
    error GracePeriodExpired();
    error GracePeriodNotExpired();
    error DebtNotZero();
    error HealthFactorTooLow();
    error HealthFactorTooHigh();
    error UserAlreadyUnderLiquidation();

    // Adapters
    error AdapterAlreadySupported();
    error AdapterNotSupported();
    // Caps
    error SupplyCapReached();
    error BorrowCapReached();
    // Timelock
    error TimelockDisabled();
    error NoPendingWithdraw();
    error TimelockNotExpired();
    error AmountDifferentThanRequested();
    error CapZero();
    error CapExceedSupply();
    error SupplyCapBelowBorrowCap();
    error InvalidPercentage();
    error InvalidBoolean();
    error InvalidGracePeriod();
    error ApprovalFailed();
    error NotEnoughLiquidity();
    error InsufficientLiquidityAfterWithdrawal();

    error NoVaultSet();
}