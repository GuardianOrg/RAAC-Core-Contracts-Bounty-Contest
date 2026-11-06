// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../../../libraries/pools/ReserveLibrary.sol";
import "../../../libraries/math/PercentageMath.sol";
import "../../../libraries/math/WadRayMath.sol";

contract ReserveLibraryMock is ReentrancyGuard {
    using ReserveLibrary for ReserveLibrary.ReserveData;
    using WadRayMath for uint256;
    using PercentageMath for uint256;
    
    ReserveLibrary.ReserveData internal reserveData;
    ReserveLibrary.ReserveRateData internal rateData;

    constructor(address debtTokenAddress, address rTokenAddress) {
        reserveData.reserveDebtTokenAddress = debtTokenAddress;
        reserveData.reserveRTokenAddress = rTokenAddress;
        // Initialize indices
        reserveData.liquidityIndex = uint128(WadRayMath.RAY);
        reserveData.usageIndex = uint128(WadRayMath.RAY);
        reserveData.lastUpdateTimestamp = uint40(block.timestamp);
        
        // Set interest rate parameters
        rateData.baseRate = WadRayMath.RAY / 20;              // 5%
        rateData.primeRate = WadRayMath.RAY / 10;             // 10%
        rateData.optimalRate = (WadRayMath.RAY * 15) / 100;   // 15%
        rateData.maxRate = WadRayMath.RAY;                    // 100%
        rateData.optimalUtilizationRate = WadRayMath.RAY / 2; // 50%
        rateData.protocolFeeRate = WadRayMath.RAY / 10;       // 10%
        
        // Initialize current rates
        rateData.currentLiquidityRate = rateData.baseRate;
        rateData.currentUsageRate = rateData.baseRate;
    }

    function deposit(uint256 amount) external nonReentrant returns (uint256) {
        if (amount == 0) revert ReserveLibrary.InvalidAmount();
        
        ReserveLibrary.updateInterestRatesAndLiquidity(
            reserveData,
            rateData,
            amount,
            0
        );
        
        return amount;
    }

    function withdraw(uint256 amount) external nonReentrant returns (uint256) {
        if (amount == 0) revert ReserveLibrary.InvalidAmount();
        if (amount > reserveData.totalLiquidity) revert ReserveLibrary.InsufficientLiquidity();
        
        ReserveLibrary.updateInterestRatesAndLiquidity(
            reserveData,
            rateData,
            0,
            amount
        );
        
        return amount;
    }

    function setPrimeRate(uint256 newPrimeRate) external {
        ReserveLibrary.setPrimeRate(reserveData, rateData, newPrimeRate, 2_00);
    }

    function calculateUtilizationRate() external view returns (uint256) {
        if (reserveData.totalLiquidity == 0 && reserveData.totalUsage == 0) {
            return 0; // Return 0 when both liquidity and usage are 0
        }
        return ReserveLibrary.calculateUtilizationRate(
            reserveData.totalLiquidity,
            reserveData.totalUsage
        );
    }

    function calculateBorrowRate() external view returns (uint256) {
        return ReserveLibrary.calculateBorrowRate(
            rateData.primeRate,
            rateData.baseRate,
            rateData.optimalRate,
            rateData.maxRate,
            rateData.optimalUtilizationRate,
            ReserveLibrary.calculateUtilizationRate(
                reserveData.totalLiquidity,
                reserveData.totalUsage
            )
        );
    }

    function getReserveData() external view returns (
        uint256 totalLiquidity,
        uint256 totalUsage,
        uint256 liquidityIndex,
        uint256 usageIndex,
        uint256 lastUpdateTimestamp
    ) {
        return (
            reserveData.totalLiquidity,
            reserveData.totalUsage,
            reserveData.liquidityIndex,
            reserveData.usageIndex,
            reserveData.lastUpdateTimestamp
        );
    }

    function getRateData() external view returns (
        uint256 currentLiquidityRate,
        uint256 currentUsageRate,
        uint256 primeRate,
        uint256 baseRate,
        uint256 optimalRate,
        uint256 maxRate,
        uint256 optimalUtilizationRate,
        uint256 protocolFeeRate
    ) {
        return (
            rateData.currentLiquidityRate,
            rateData.currentUsageRate,
            rateData.primeRate,
            rateData.baseRate,
            rateData.optimalRate,
            rateData.maxRate,
            rateData.optimalUtilizationRate,
            rateData.protocolFeeRate
        );
    }

    // Helper function to simulate time passing (for testing)
    function setLastUpdateTimestamp(uint40 timestamp) external {
        reserveData.lastUpdateTimestamp = timestamp;
    }

    // Helper function to set all rate parameters at once (for testing)
    function setRateParameters(
        uint256 baseRate_,
        uint256 primeRate_,
        uint256 optimalRate_,
        uint256 maxRate_,
        uint256 optimalUtilizationRate_
    ) external {
        rateData.baseRate = baseRate_;
        rateData.primeRate = primeRate_;
        rateData.optimalRate = optimalRate_;
        rateData.maxRate = maxRate_;
        rateData.optimalUtilizationRate = optimalUtilizationRate_;
    }

    function calculateCompoundedInterest(uint256 rate, uint256 timeDelta) external pure returns (uint256) {
        if (timeDelta < 1) {
            return WadRayMath.RAY;
        }

        uint256 ratePerSecond = rate.rayDiv(ReserveLibrary.SECONDS_PER_YEAR);
        uint256 exponent = ratePerSecond.rayMul(timeDelta);

        // Taylor series expansion for e^x
        uint256 interestFactor = WadRayMath.RAY + exponent + 
            (exponent.rayMul(exponent)) / 2 + 
            (exponent.rayMul(exponent).rayMul(exponent)) / 6 +
            (exponent.rayMul(exponent).rayMul(exponent).rayMul(exponent)) / 24 + 
            (exponent.rayMul(exponent).rayMul(exponent).rayMul(exponent).rayMul(exponent)) / 120;

        return interestFactor;
    }
}