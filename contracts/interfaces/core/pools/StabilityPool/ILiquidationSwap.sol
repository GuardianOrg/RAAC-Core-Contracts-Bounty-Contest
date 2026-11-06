// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title ILiquidationSwap
 * @author RAAC Protocol Team
 * @notice This interface is used to swap the index token for the crvUSD token in the Curve pool.
 * @dev This interface is used to swap the index token for the crvUSD token in the LP pool.
 */
interface ILiquidationSwap {
    function swap(uint256 amount) external;

    event Swapped(address caller, uint256 vaultTokenAmount, uint256 swapTokenAmount);
    event LiquidityPoolSet(address indexed liquidityPool, uint256 slippageProtectionBps, uint256 iIn, uint256 iOut);
    event StabilityPoolSet(address indexed stabilityPool);
    event CrvusdToUSDOracleSet(address indexed oracle);
    event SlippageProtectionEnabled(bool enabled);

    error ApprovalFailed();
    error InvalidAddress();
    error ZeroAmount();
    error Unauthorized();
    error InvalidExchange();
    error InvalidSlippageProtection();
    error InvalidIndex();
}
