// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "../../libraries/math/PercentageMath.sol";
import "../../libraries/math/WadRayMath.sol";

import "../../interfaces/core/tokens/IDebtToken.sol";
import "../../interfaces/core/tokens/IRToken.sol";

/**
 * @title ReserveLibrary
 * @author RAAC Protocol Team
 * @notice Library for managing reserve operations in the RAAC lending protocol.
 * @dev Provides functions to update reserve interests, calculate rates, and handle deposits and withdrawals.
 */
library ReserveLibrary {
    using WadRayMath for uint256;
    using WadRayMath for uint128;
    using PercentageMath for uint256;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    // Constants
    uint256 internal constant SECONDS_PER_YEAR = 31536000;

    // Structs

    /**
     * @notice Struct to hold reserve data.
     */
    struct ReserveData {
        address reserveRTokenAddress;
        address reserveAssetAddress;
        address reserveDebtTokenAddress;

        uint256 totalLiquidity;
        uint256 totalUsage;

        uint128 liquidityIndex;
        uint128 usageIndex;

        uint40 lastUpdateTimestamp;
        uint256 scaledPendingProtocolFee;
    }

    /**
     * @notice Struct to hold reserve rate parameters.
     * @dev All values are stored in RAY (27 decimal) precision.
     */
    struct ReserveRateData {
        uint256 currentLiquidityRate;
        uint256 currentUsageRate;

        uint256 primeRate;
        uint256 baseRate;
        uint256 optimalRate;
        uint256 maxRate;
        uint256 optimalUtilizationRate;
        
        uint256 protocolFeeRate;
        uint256 currentProtocolFeeRate;
        uint256 currentUtilizationRate;
    }

    // Events

    /**
     * @notice Emitted when a deposit operation occurs.
     * @param user The address of the user making the deposit.
     * @param amount The amount deposited.
     * @param liquidityMinted The amount of liquidity tokens minted.
     */
    event Deposit(address indexed user, uint256 amount, uint256 liquidityMinted);

    /**
     * @notice Emitted when a withdraw operation occurs.
     * @param user The address of the user withdrawing.
     * @param amount The amount withdrawn.
     * @param liquidityBurned The amount of liquidity tokens burned.
     */
    event Withdraw(address indexed user, uint256 amount, uint256 liquidityBurned);

    /**
     * @notice Emitted when reserve interests are updated.
     * @param liquidityIndex The new liquidity index.
     * @param usageIndex The new usage index.
     */
    event ReserveInterestsUpdated(uint256 liquidityIndex, uint256 usageIndex);

    /**
     * @notice Emitted when interest rates are updated.
     * @param liquidityRate The new liquidity rate.
     * @param usageRate The new usage rate.
     */
    event InterestRatesUpdated(uint256 liquidityRate, uint256 usageRate);

    /**
     * @notice Emitted when the prime rate is updated.
     * @param oldPrimeRate The old prime rate.
     * @param newPrimeRate The new prime rate.
     */
    event PrimeRateUpdated(uint256 oldPrimeRate, uint256 newPrimeRate);

    // Custom Errors

    error LiquidityIndexIsZero();
    error InvalidAmount();
    error PrimeRateMustBePositive();
    error PrimeRateChangeExceedsLimit();
    error InsufficientLiquidity();
    error InvalidInterestRateParameters();

    // Functions

    /**
     * @notice Updates the liquidity and usage indices of the reserve.
     * @dev Should be called before any operation that changes the state of the reserve.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     */
    function updateReserveInterests(ReserveData storage reserve,ReserveRateData storage rateData) internal {
        uint256 timeDelta = block.timestamp - uint256(reserve.lastUpdateTimestamp);
        if (timeDelta < 1) {
            return;
        }

        uint256 oldLiquidityIndex = reserve.liquidityIndex;
        if (oldLiquidityIndex < 1) revert LiquidityIndexIsZero();
        uint256 oldUsageIndex = reserve.usageIndex;

        // Update liquidity index using linear interest
        reserve.liquidityIndex = calculateLiquidityIndex(
            rateData.currentLiquidityRate,
            timeDelta,
            oldLiquidityIndex
        );

        // Update usage index (debt index) using compounded interest
        reserve.usageIndex = calculateUsageIndex(
            rateData.currentUsageRate,
            timeDelta,
            oldUsageIndex
        );

        // Update the last update timestamp
        reserve.lastUpdateTimestamp = uint40(block.timestamp);

        // Update the pending protocol fee
        uint256 rawDebt = IDebtToken(reserve.reserveDebtTokenAddress).getRawTotalBorrows();
        uint256 borrowerInterest = rawDebt.rayMul(reserve.usageIndex) - rawDebt.rayMul(oldUsageIndex);
        uint256 feeAmount = borrowerInterest.rayMul(rateData.protocolFeeRate);
        if (feeAmount > 0) {
            reserve.scaledPendingProtocolFee += feeAmount.rayDiv(reserve.liquidityIndex);
        }

        emit ReserveInterestsUpdated(reserve.liquidityIndex, reserve.usageIndex);
    }

    /**
     * @notice Returns the protocol fee owed, in underlying asset units.
     * @dev The fee is banked scaled by the liquidity index; this re-values it at the
     *      current index, so it grows for as long as it goes unclaimed.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @return The pending protocol fee in underlying asset units.
     */
    function getPendingProtocolFee(ReserveData storage reserve, ReserveRateData storage rateData) internal view returns (uint256) {
        return reserve.scaledPendingProtocolFee.rayMul(getLiquidityIndex(reserve, rateData));
    }

    /**
    * @notice Calculates the linear interest over the elapsed period.
     * @param rate The current liquidity rate (in RAY). 
     * @param timeDelta The time since the last update (in seconds).
     * @return The linear interest over the elapsed period. 
     */
   function calculateLinearInterest(uint256 rate, uint256 timeDelta) internal pure returns (uint256) {
        uint256 cumulatedInterest = rate * timeDelta;
        cumulatedInterest = cumulatedInterest / SECONDS_PER_YEAR;
        return WadRayMath.RAY + cumulatedInterest;
    }

    function calculateLiquidityIndex(uint256 rate, uint256 timeDelta, uint256 lastIndex) internal pure returns (uint128) {
        uint256 cumulatedInterest = calculateLinearInterest(rate, timeDelta);
        return cumulatedInterest.rayMul(lastIndex).toUint128();
    }

    /**
     * @notice Calculates the compounded interest over a period.
     * @param rate The usage rate (in RAY).
     * @param timeDelta The time since the last update (in seconds).
     * @return The interest factor (in RAY).
     */
    function calculateCompoundedInterest(uint256 rate,uint256 timeDelta) internal pure returns (uint256) {
         if (timeDelta < 1) {
            return WadRayMath.RAY;
        }
        uint256 ratePerSecond = rate.rayDiv(SECONDS_PER_YEAR);
        uint256 exponent = ratePerSecond.rayMul(timeDelta);
   
        // Will use a taylor series expansion (7 terms)
        return WadRayMath.rayExp(exponent);
    }

    function calculateUsageIndex(uint256 rate, uint256 timeDelta ,uint256 lastIndex) internal pure returns (uint128) {
        uint256 interestFactor = calculateCompoundedInterest(rate, timeDelta);
        return lastIndex.rayMul(interestFactor).toUint128();
    }

    /**
     * @notice Updates the interest rates and liquidity based on the latest reserve state.
     * @dev Should be called after any operation that changes the liquidity or debt of the reserve.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @param liquidityAdded The amount of liquidity added (in underlying asset units).
     * @param liquidityTaken The amount of liquidity taken (in underlying asset units).
     */
    function updateInterestRatesAndLiquidity(ReserveData storage reserve,ReserveRateData storage rateData,uint256 liquidityAdded,uint256 liquidityTaken) internal {
        // Update total liquidity
        if (liquidityAdded > 0) {
            reserve.totalLiquidity = reserve.totalLiquidity + liquidityAdded.toUint128();
        }
        if (liquidityTaken > 0) {
            if (reserve.totalLiquidity < liquidityTaken) revert InsufficientLiquidity();
            reserve.totalLiquidity = reserve.totalLiquidity - liquidityTaken.toUint128();
        }
        // Update total usage with the amount of debt taken
        reserve.totalUsage = IDebtToken(reserve.reserveDebtTokenAddress).totalSupply();

        // Calculate utilization rate
        uint256 utilizationRate = calculateUtilizationRate(reserve.totalLiquidity, reserve.totalUsage);
        rateData.currentUtilizationRate = utilizationRate;

        // Update current usage rate (borrow rate)
        rateData.currentUsageRate = calculateBorrowRate(
            rateData.primeRate,
            rateData.baseRate,
            rateData.optimalRate,
            rateData.maxRate,
            rateData.optimalUtilizationRate,
            utilizationRate
        );

        // Update current liquidity rate
        (uint256 calculatedLiquidityRate, uint256 calculatedProtocolFeeRate) = calculateLiquidityRate(
            utilizationRate,
            rateData.currentUsageRate,
            rateData.protocolFeeRate,
            reserve.totalUsage
        );
        
        rateData.currentLiquidityRate = calculatedLiquidityRate;
        rateData.currentProtocolFeeRate = calculatedProtocolFeeRate;

        // Update the reserve interests
        updateReserveInterests(reserve, rateData);

        emit InterestRatesUpdated(rateData.currentLiquidityRate, rateData.currentUsageRate);
    }

    /**
     * @notice Calculates the liquidity rate based on utilization and usage rate.
     * @dev The supply APR (Rs) is calculated from the borrow interest paid by borrowers, minus a reserve factor which constitutes a protocol fee.
     * Formula: Rs = Rb * U * (1-RF)
     * where:
     * - Rs: supply rate
     * - Rb: borrow rate
     * - U: Utilization
     * - RF: Reserve Factor (protocol fee rate)
     * @param utilizationRate The current utilization rate (in RAY).
     * @param usageRate The current usage rate (in RAY).
     * @param protocolFeeRate The protocol fee rate (or reserve factor) (in RAY).
     * @return The liquidity rate (in RAY).
     * @return The protocol fee rate (in RAY).
     */
    function calculateLiquidityRate(uint256 utilizationRate, uint256 usageRate, uint256 protocolFeeRate, uint256 totalDebt) internal pure returns (uint256, uint256) {
        if (totalDebt < 1) {
            return (0, 0);
        }

        // U * Rb
        uint256 grossLiquidityRate = utilizationRate.rayMul(usageRate);
        // RF * (U * Rb)
        uint256 netProtocolFeeRate = grossLiquidityRate.rayMul(protocolFeeRate);
        // (U * Rb) - (RF * (U * Rb))
        uint256 netLiquidityRate = grossLiquidityRate - netProtocolFeeRate;

        return (netLiquidityRate, netProtocolFeeRate);
    }

    /**
     * @notice Calculates the borrow rate based on utilization, adjusting for prime rate between the maxRate and optimal rate when utilization rate > 0
     * @dev RAAC utilizes a soft peg interest rate model which tracks the US Prime Rate. Below the target rate, borrowers pay half of the US Prime Rate.
     * Above the utilization rate target, a penalty interest is introduced which scales linearly with the distance to the target utilization.
     * Formula: Rb = Rbtarget + max(u * (U - UT), 0)
     * where:
     * - Rb: borrow rate
     * - Rbtarget: target borrow rate (½ US Prime Rate)
     * - U: Utilization
     * - UT: Target Utilization
     * - u: utilization penalty factor
     * @param primeRate The prime rate of the reserve (in RAY).
     * @param baseRate The base rate (in RAY).
     * @param optimalRate The optimal rate (in RAY).
     * @param maxRate The maximum rate (in RAY).
     * @param optimalUtilizationRate The optimal utilization rate (in RAY).
     * @param utilizationRate The current utilization rate (in RAY).
     * @return The calculated borrow rate (in RAY).
     */
    function calculateBorrowRate(
        uint256 primeRate,
        uint256 baseRate,
        uint256 optimalRate,
        uint256 maxRate,
        uint256 optimalUtilizationRate,
        uint256 utilizationRate
    ) internal pure returns (uint256) {
        if (primeRate <= baseRate || primeRate >= maxRate || optimalRate <= baseRate || optimalRate >= maxRate) {
            revert InvalidInterestRateParameters();
        }

        uint256 rate;
        if (utilizationRate == 0) {
            rate = 0;
        } else if (utilizationRate <= optimalUtilizationRate) {
            rate = optimalRate;
        } else {
            uint256 excessUtilization = utilizationRate - optimalUtilizationRate;
            uint256 maxExcessUtilization = WadRayMath.RAY - optimalUtilizationRate;
            uint256 rateSlope = maxRate - optimalRate; // u = utilization penalty factor
            uint256 rateIncrease = excessUtilization.rayMul(rateSlope).rayDiv(maxExcessUtilization);
            rate = optimalRate + rateIncrease;
            rate = rate > maxRate ? maxRate : rate;
        }
        return rate;
    }

    /**
     * @notice Calculates the utilization rate of the reserve.
     * @param totalLiquidity The total liquidity in the reserve (in underlying asset units).
     * @param totalDebt The total debt in the reserve (in underlying asset units).
     * @return The utilization rate (in RAY).
     */
    function calculateUtilizationRate(uint256 totalLiquidity, uint256 totalDebt) internal pure returns (uint256) {
        if (totalDebt < 1) {
            return 0;
        }
        if (totalLiquidity < 1) {
            return WadRayMath.RAY; // 100% utilization if no liquidity
        }
        uint256 utilizationRate = totalDebt.rayDiv(totalLiquidity + totalDebt).toUint128();
        return utilizationRate;
    }

    /**
     * @notice Handles deposit operation into the reserve.
     * @dev Transfers the underlying asset from the depositor to the reserve, and mints RTokens to the depositor. 
     *      This function assumes interactions with ERC20 before updating the reserve state (you send before we update how much you sent).
     *      A untrusted ERC20's modified mint function calling back into this library will cause incorrect reserve state updates.
     *      Implementing contracts need to ensure reentrancy guards are in place when interacting with this library.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @param amount The amount to deposit.
     * @param depositor The address of the depositor.
     * @return amountMinted The amount of RTokens minted.
     */
    function deposit(ReserveData storage reserve, ReserveRateData storage rateData, uint256 amount, address depositor) internal returns (uint256 amountMinted) {
        if (amount < 1) revert InvalidAmount();

        // Update reserve interests
        updateReserveInterests(reserve, rateData);

        // Transfer asset from caller to the RToken contract
        IERC20(reserve.reserveAssetAddress).safeTransferFrom(
            depositor,                    // from
            reserve.reserveRTokenAddress,  // to
            amount                         // amount
        );

        // Mint RToken to the depositor (scaling handled inside RToken)
        (uint256 amountMinted, uint256 newTotalSupply, uint256 amountUnderlying) = IRToken(reserve.reserveRTokenAddress).mint(
            address(this),         // caller
            depositor,             // onBehalfOf
            amount,                // amount
            reserve.liquidityIndex // index
        );

        // Update the total liquidity and interest rates
        updateInterestRatesAndLiquidity(reserve, rateData, amount, 0);

        emit Deposit(depositor, amount, amountMinted);

        return amountMinted;
    }

    /**
     * @notice Handles withdrawal operation from the reserve.
     * @dev Burns RTokens from the user and transfers the underlying asset.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @param amount The amount to withdraw.
     * @param recipient The address receiving the underlying asset.
     * @return amountWithdrawn The amount withdrawn.
     * @return amountScaled The scaled amount of RTokens burned.
     * @return amountUnderlying The amount of underlying asset transferred.
     */
    function withdraw(
        ReserveData storage reserve,
        ReserveRateData storage rateData,
        uint256 amount,
        address recipient
    ) internal returns (uint256 amountWithdrawn, uint256 amountScaled, uint256 amountUnderlying) {
        if (amount < 1) revert InvalidAmount();

        // Update the reserve interests
        updateReserveInterests(reserve, rateData);

        // Burn RToken from the recipient - will send underlying asset to the recipient
        (uint256 burnedScaledAmount, uint256 newTotalSupply, uint256 amountUnderlying) = IRToken(reserve.reserveRTokenAddress).burn(
            recipient,              // from
            recipient,              // receiverOfUnderlying
            amount,                 // amount
            reserve.liquidityIndex  // index
        );
        amountWithdrawn = burnedScaledAmount;
        
        // Update the total liquidity and interest rates
        updateInterestRatesAndLiquidity(reserve, rateData, 0, amountUnderlying);

        emit Withdraw(recipient, amountUnderlying, burnedScaledAmount);

        return (amountUnderlying, burnedScaledAmount, amountUnderlying);
    }

    /**
     * @notice Sets a new prime rate for the reserve.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @param newPrimeRate The new prime rate (in RAY).
     */
    function setPrimeRate( ReserveData storage reserve, ReserveRateData storage rateData, uint256 newPrimeRate, uint256 maxChangeBPS) internal {
        if (newPrimeRate < 1) revert PrimeRateMustBePositive();
        
        // Ensure prime rate doesn't exceed 100% (1 RAY)
        if (newPrimeRate > WadRayMath.RAY) revert PrimeRateChangeExceedsLimit();

        uint256 oldPrimeRate = rateData.primeRate;

        if (oldPrimeRate > 0) {
            uint256 maxIncrease = oldPrimeRate + WadRayMath.RAY.percentMul(maxChangeBPS); // Max bps increase
            uint256 maxDecrease = oldPrimeRate < WadRayMath.RAY.percentMul(maxChangeBPS) ? 0 : oldPrimeRate - WadRayMath.RAY.percentMul(maxChangeBPS); // Max bps decrease
            
            if (newPrimeRate > maxIncrease || newPrimeRate < maxDecrease) {
                revert PrimeRateChangeExceedsLimit();
            }
        }

        // Update reserve interests with old rates before changing them
        updateReserveInterests(reserve, rateData);

        rateData.primeRate = newPrimeRate;
        rateData.baseRate = rateData.primeRate.percentMul(25_00); // 25% of prime rate
        rateData.optimalRate = rateData.primeRate.percentMul(50_00); // 50% of prime rate
        // NOTE: max rate updated separately by the protocol

        // Recalculate rates with new prime rate
        updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);

        emit PrimeRateUpdated(oldPrimeRate, newPrimeRate);
    }

    /**
     * @notice Updates the reserve state by updating the reserve interests.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     */
    function updateReserveState(ReserveData storage reserve,ReserveRateData storage rateData) internal {
        updateReserveInterests(reserve, rateData);
    }

    /**
     * @notice Gets the up-to-date usage index of the reserve.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @return The usage index (in RAY).
     */
    function getUsageIndex(ReserveData storage reserve, ReserveRateData storage rateData) internal view returns (uint256) {
        uint256 timeDelta = block.timestamp - uint256(reserve.lastUpdateTimestamp);
        if(timeDelta < 1) {
            return reserve.usageIndex;
        }

        return calculateUsageIndex(
            calculateBorrowRate(rateData.primeRate, rateData.baseRate, rateData.optimalRate, rateData.maxRate, rateData.optimalUtilizationRate, rateData.currentUtilizationRate),
            timeDelta,
            reserve.usageIndex
        );
    }

    /**
     * @notice Gets the up-to-date liquidity index of the reserve.
     * @param reserve The reserve data.
     * @param rateData The reserve rate parameters.
     * @return The liquidity index (in RAY).
     */
    function getLiquidityIndex(ReserveData storage reserve, ReserveRateData storage rateData) internal view returns (uint256) {
        uint256 timeDelta = block.timestamp - uint256(reserve.lastUpdateTimestamp);
        if(timeDelta < 1) {
            return reserve.liquidityIndex;
        }

        (uint256 calculatedLiquidityRate,) = calculateLiquidityRate(rateData.currentUtilizationRate, rateData.currentUsageRate, rateData.protocolFeeRate, reserve.totalUsage);
        return calculateLiquidityIndex(
            calculatedLiquidityRate,
            timeDelta,
            reserve.liquidityIndex
        );
    }
}