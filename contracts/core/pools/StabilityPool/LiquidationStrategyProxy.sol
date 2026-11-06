// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../interfaces/core/vaults/IVaultAssetAdapter.sol";
import "../../../interfaces/core/pools/LendingPool/IAssetAdapter.sol";
import "../../../interfaces/core/pools/StabilityPool/ILiquidationSwap.sol";

import "./StabilityPoolStorage.sol";
import "../../../interfaces/core/collectors/IFeeCollector.sol";

/**
 * @title Liquidation Strategy Proxy
 * @author RAAC Protocol Team
 * @notice This contract is used to proxy the liquidation strategy to the stability pool.
 * @dev The borrow position is repaid by unwrapping rToken, and the shares is swapped, burnt, collected.
 */
contract LiquidationStrategyProxy is StabilityPoolStorage {
    address private immutable __self;
    using SafeERC20 for IERC20;

    constructor() {
        __self = address(this);
    }

    // Modifier that prevents direct calls to the liquidation methods
    modifier onlyProxy() {
        require(address(this) != __self, "Direct calls not allowed");
        _;
    }

    /* ========== ADMIN & MANAGER FUNCTIONS ========== */
    /**
     * @notice Liquidates a borrower's position.
     * @param poolAdapter The address of the asset adapter in the lending pool for finalizing liquidation
     * @param vaultAdapter The address of the asset adapter in the vault for storing the asset.
     * @param user The address of the borrower to liquidate.
     * @param data Parameters to identify the asset (tokenId, amount, etc.). 
     * @custom:throws InvalidAmount If the user's debt is zero.
     * @custom:throws InsufficientBalance If the Stability Pool doesn't have enough crvUSD to cover the debt.
     * @custom:throws ApprovalFailed If the approval of crvUSD transfer to LendingPool fails.
     * @custom:emits BorrowerLiquidated when the liquidation is successful.
     * @dev the Data parameter for ERC20 is equivalent to the deposited balance
     */
    function liquidateBorrower(address poolAdapter, address vaultAdapter, address user, bytes calldata data, uint256 minSharesOut) external onlyProxy {
        require(lendingPool.supportedAdapter(poolAdapter), "StabilityPool: Pool Adapter not supported");
        // the vaultAdapter can be anything in case the asset being liquidated is the vault token
        require(rwaVault.supportedAdapter(vaultAdapter) || IAssetAdapter(poolAdapter).getAssetToken() == rwaVault.underlyingVaultToken(), "StabilityPool: Vault Adapter not supported");

        // Update lending pool state before liquidation
        lendingPool.updateState();

        // Get the user's debt from the LendingPool.
        if (lendingPool.getPositionDebt(poolAdapter, user, data) == 0) revert InvalidAmount();

        // If the token that is being liquidated is not the vault token, and does not match an adapter in the system, do not liquidate
        if (IAssetAdapter(poolAdapter).getAssetToken() != rwaVault.underlyingVaultToken() && IAssetAdapter(poolAdapter).getAssetToken() != IVaultAssetAdapter(vaultAdapter).getAssetToken()) revert AdaptersAssetMismatch();
        // Check if the adapters are supported.

        // If the user data parameter is wrong, especially in ERC20 amount where amount !== collateral value
        if (!IAssetAdapter(poolAdapter).validateLiquidationData(user, data)) revert CollateralAndParamterDataMismatch();

        uint256 scaledPositionDebt = lendingPool.getPositionScaledDebt(poolAdapter, user, data);

        lendingPool.finalizeLiquidation(poolAdapter, user, data);
        _handleLiquidation(poolAdapter, vaultAdapter, data, minSharesOut);

        uint256 initialCRVUSDBalance = crvUSDToken.balanceOf(address(this));
        uint256 availableRTokens = rToken.balanceOf(address(this));

        // We need to get the amount of rToken that is needed to cover the debt, or 0 if the debt is covered
        uint256 rTokenAmountRequired = initialCRVUSDBalance >= scaledPositionDebt ? 0 : scaledPositionDebt - initialCRVUSDBalance;
        if (availableRTokens < rTokenAmountRequired) revert InsufficientBalance();

        // We unwind the position
        if (rTokenAmountRequired > 0) {
            lendingPool.withdraw(rTokenAmountRequired);
        }

        crvUSDToken.safeTransfer(address(rToken), scaledPositionDebt);

        // Deposit crvUSD back to get rTokens (including the excess)
        // Get the final crvUSD balance after the exchange
        uint256 finalCRVUSDBalance = crvUSDToken.balanceOf(address(this));
        if (finalCRVUSDBalance > 0) {
            // Approve lending pool to take crvUSD for deposit
            bool approveCRVUSDDeposit = crvUSDToken.approve(address(lendingPool), finalCRVUSDBalance);
            if (!approveCRVUSDDeposit) revert ApprovalFailed();
            lendingPool.deposit(finalCRVUSDBalance);
        }
        lendingPool.rebalanceLiquidity();
        emit BorrowerLiquidated(user, IAssetAdapter(poolAdapter).getAssetToken(), data, scaledPositionDebt);    
    }

    /**
     * @notice Handles the liquidation of an NFT position.
     * @param poolAdapter The address of the asset adapter in the lending pool for finalizing liquidation
     * @param vaultAdapter The address of the asset adapter in the vault for storing the asset.
     * @param data Parameters to identify the asset (tokenId, amount, etc.)
     */
    function _handleLiquidation(address poolAdapter, address vaultAdapter, bytes calldata data, uint256 minSharesOut) internal {
        address underlyingVaultToken = rwaVault.underlyingVaultToken();
        // check if the adapter asset token is the underlying Vault token. if so, skip the deposit part and proceed with liquidation right away
        if (IAssetAdapter(poolAdapter).getAssetToken() != underlyingVaultToken) {
            // Take the asset and transfer to the RWA Vault: we might require approval method in the adapter.
            // @dev We are using delegatecall because we are abstracting the approval method in the adapter. If we call directly, the context is adapter (approving stability pool from adapter which is insuficient balance)
            (bool success, bytes memory returndata) = vaultAdapter.delegatecall(
                abi.encodeWithSignature("approve(address,bytes)", vaultAdapter, data)
            );
            if (!success) {
                if (returndata.length == 0) revert();
                assembly {
                    revert(add(32, returndata), mload(returndata))
                }
            }
            // address(this) beacuase when we finalized liquidation, we received the asset.
            rwaVault.poolDepositAsset(vaultAdapter, data, address(this), minSharesOut);
        }        

        // calculate the profit split
        uint256 indexTokenBalance = IERC20(underlyingVaultToken).balanceOf(address(this));
        if (liquidationSplit.mintPercentage + liquidationSplit.burnPercentage + liquidationSplit.swapPercentage + liquidationSplit.liquidityPercentage != 100_00) revert("invalid percentages");
        uint256 mintingFee = (indexTokenBalance * liquidationSplit.mintPercentage) / 100_00;
        uint256 burnAmount = (indexTokenBalance * liquidationSplit.burnPercentage) / 100_00;
        uint256 swapAmount = (indexTokenBalance * liquidationSplit.swapPercentage) / 100_00;
        uint256 liquidityAmount = (indexTokenBalance * liquidationSplit.liquidityPercentage) / 100_00;

        // handle the balances
        if (mintingFee > 0) _handleTreasuryFee(mintingFee);
        if (burnAmount > 0) rwaVault.burnVaultToken(address(this), burnAmount);
        if (swapAmount > 0) _handleSwap(swapAmount);
        if (liquidityAmount > 0) _handleLiquidityRewards(liquidityAmount);
    }

    /**
     * @notice Handles the swap of the index token.
     * @param amount The amount of index token to swap.
     */
    function _handleSwap(uint256 amount) internal {
        if (liquidationSwap == address(0)) revert("liquidation swap not set");
        address underlyingVaultToken = rwaVault.underlyingVaultToken();
        // Allow the liquidity pool to transfer the index token
        bool approveSuccessIndexToken = IERC20(underlyingVaultToken).approve(liquidationSwap, amount);
        if (!approveSuccessIndexToken) revert ApprovalFailed();
        ILiquidationSwap(liquidationSwap).swap(amount);
    }

    /**
     * @notice Handles the liquidity rewards of the index token.
     * @param amount The amount of index token to deposit into the fee collector
     */
    function _handleLiquidityRewards(uint256 amount) internal {
        if (feeCollector == address(0)) revert("fee collector not set");
        address underlyingVaultToken = rwaVault.underlyingVaultToken();

        bool approveSuccessIndexToken = IERC20(underlyingVaultToken).approve(feeCollector, amount);
        if (!approveSuccessIndexToken) revert ApprovalFailed();
        IFeeCollector(feeCollector).collectFee(underlyingVaultToken, address(this), amount, keccak256("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS"));
    }

    /**
     * @notice Handles the treasury fee of the index token.
     * @param amount The amount of index token to deposit into the treasury.
     */
    function _handleTreasuryFee(uint256 amount) internal {
        address underlyingVaultToken = rwaVault.underlyingVaultToken();
        if (address(treasury) == address(0)) revert("treasury not set");
        if (amount > 0) {
            bool approval = IERC20(underlyingVaultToken).approve(address(treasury), amount);
            if (!approval) revert ApprovalFailed();
            treasury.deposit(underlyingVaultToken, amount);
        }
    }
}
