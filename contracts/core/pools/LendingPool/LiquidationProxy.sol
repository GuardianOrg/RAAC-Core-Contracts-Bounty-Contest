// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


import "./LendingPoolStorage.sol";
import "../../../interfaces/core/pools/LendingPool/ILendingPool.sol";
import "../../../interfaces/core/pools/LendingPool/IAssetAdapter.sol";

/**
 * @title LiquidationProxy
 * @author RAAC Protocol Team
 * @notice This contract is used to proxy calls to the liquidation functions in the LendingPool.
 * @dev This contract is used to proxy calls to the liquidation functions in the LendingPool.
 * @dev Access control is enforced by the lending pool delegatecall.
 */
contract LiquidationProxy is LendingPoolStorage {
    using SafeERC20 for IERC20;
    address private immutable __self;

    constructor() {
        __self = address(this);
    }

    // Modifier that prevents direct calls to the liquidation methods
    modifier onlyProxy() {
        require(address(this) != __self, "Direct calls not allowed");
        _;
    }

    function calculateHealthFactorProxy(address adapter, address user, bytes calldata data) internal view returns (uint256) {
        // When delegatecalled, address(this) is the LendingPool.
        return ILendingPool(address(this)).calculateHealthFactor(adapter, user, data);
    }

    function getPositionScaledDebtProxy(address adapter, address user, bytes calldata data) internal view returns (uint256) {
        return ILendingPool(address(this)).getPositionScaledDebt(adapter, user, data); 
    }

    // LIQUIDATION FUNCTIONS
    /**
     * @notice Allows anyone to initiate the liquidation process if a position's health factor is below threshold
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     */
    function initiateLiquidation(address adapter, address user, bytes calldata data) external onlyProxy {
        bytes32 positionKey = IAssetAdapter(adapter).getPositionKey(data);
        CollateralPosition storage position = positions[user][positionKey];
        if (position.isUnderLiquidation) revert UserAlreadyUnderLiquidation();

        IAssetAdapter(adapter).validate(user, data);

        // update state
        ReserveLibrary.updateReserveState(reserve, rateData);

        uint256 healthFactor = calculateHealthFactorProxy(adapter, user, data);

        if (healthFactor >= HEALTH_FACTOR_LIQUIDATION_THRESHOLD) revert HealthFactorTooHigh();

        position.isUnderLiquidation = true;
        position.liquidationStartTime = block.timestamp;

        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);

        emit LiquidationInitiated(msg.sender, user, adapter, data);
    }

    /**
     * @notice Allows a user to repay their debt and close the liquidation within the grace period
     * @param adapter Address of the asset adapter
     * @param data Data for identifying 
     * @dev the proxy ensures that if the user had repaid the debt, they can close the liquidation even after the grace period and non-insured positions.
     */
    function closeLiquidation(address adapter, bytes calldata data) external onlyProxy {
        address userAddress = msg.sender;
        bytes32 positionKey = IAssetAdapter(adapter).getPositionKey(data);
        CollateralPosition storage position = positions[userAddress][positionKey];

        if (!position.isUnderLiquidation) revert NotUnderLiquidation();

        IAssetAdapter(adapter).validate(msg.sender, data);

        uint256 positionDebt = getPositionScaledDebtProxy(adapter, userAddress, data);
        if (block.timestamp > position.liquidationStartTime + parameters.liquidationGracePeriod && positionDebt > 0) {
            revert GracePeriodExpired();
        }

        // The liquidation can be closed onyl if the asset is insured. Since repay is blocked, this will be automatically, but just in case.
        if (!position.isInsured && positionDebt > 0) revert NotInsured();

        // update state
        ReserveLibrary.updateReserveState(reserve, rateData);
        if (positionDebt > 0) revert DebtNotZero();

        position.isUnderLiquidation = false;
        position.liquidationStartTime = 0;
        // Reset at selling point since the asset is gone. Reset.
        position.rawInsuredBalance = 0;
        position.isInsured = false;

        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);
        emit LiquidationClosed(userAddress, adapter, data);
    }

    /**
     * @notice Allows the Stability Pool to finalize the liquidation after the grace period has expired
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @dev Stability Pool is the only entity that can finalize the liquidation. 
     */
    function finalizeLiquidation(address adapter, address user, bytes calldata data) external onlyProxy {
        bytes32 positionKey = IAssetAdapter(adapter).getPositionKey(data);
        CollateralPosition storage position = positions[user][positionKey];
        if (!position.isUnderLiquidation) revert NotUnderLiquidation();

        IAssetAdapter(adapter).validate(user, data);

        // update state
        ReserveLibrary.updateReserveState(reserve, rateData);

        if (position.isInsured && block.timestamp <= position.liquidationStartTime + parameters.liquidationGracePeriod) {
            revert GracePeriodNotExpired();
        }

        uint256 positionDebt = getPositionScaledDebtProxy(adapter, user, data);
        
        position.isUnderLiquidation = false;
        position.liquidationStartTime = 0;
        position.isInsured = false;

        // Read before the transfer, which zeroes the ERC20 adapter balance
        uint256 collateralLiquidated = IAssetAdapter(adapter).getAssetValue(user, data);

        // Transfer asset to Stability Pool
        IAssetAdapter(adapter).transferAsset(user, data, stabilityPool);

        // Burn DebtTokens from the user
        (uint256 amountScaled, uint256 newTotalSupply, uint256 amountBurned, uint256 balanceIncrease) = 
            IDebtToken(reserve.reserveDebtTokenAddress).burn(user, positionDebt, reserve.usageIndex, abi.encode(adapter, data));

        // We need to update the position index of the user
        position.positionIndex = reserve.usageIndex;

        // Update position's scaled debt balance
        position.rawDebtBalance = 0;
        position.rawInsuredBalance = 0;

        // Update liquidity and interest rates
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, amountScaled, 0);
        emit LiquidationFinalized(stabilityPool, user, adapter, data, positionDebt, collateralLiquidated);
    }
}