// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


import "./LendingPoolStorage.sol";
import "../../../interfaces/core/collectors/IFeeCollector.sol";
import "../../../interfaces/core/collectors/ITreasury.sol";
import "../../../interfaces/curve/ICurveCrvUSDVault.sol";

contract VaultProxy is LendingPoolStorage {
    using PercentageMath for uint256;
    using SafeERC20 for IERC20;
    address private immutable __self;
    
    /// @dev Manually appending ICurveCrvUSDVault interface. This contract can be upgrades in case new vault comes in. 
    /// @dev For new vaults, we will implement LendingVault contract that will be based on IBaseVault and will map to the specific vault interface.
    function _getPricePerShare() internal view returns (uint256) {
        return ICurveCrvUSDVault(address(vault)).pricePerShare();
    }

    function _previewWithdraw(uint256 assets) internal view returns (uint256 shares) {
        return ICurveCrvUSDVault(address(vault)).previewWithdraw(assets);
    }

    function _previewDeposit(uint256 assets) internal view returns (uint256 shares) {
        return ICurveCrvUSDVault(address(vault)).previewDeposit(assets);
    }

    function _maxWithdraw(address owner) internal view returns (uint256) {
        return ICurveCrvUSDVault(address(vault)).maxWithdraw(owner, 0, new address[](0));
    }

    function _maxDeposit(address receiver) internal view returns (uint256) {
        return ICurveCrvUSDVault(address(vault)).maxDeposit(receiver);
    }

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        return ICurveCrvUSDVault(address(vault)).deposit(assets, receiver);
    }

    function _withdraw(uint256 assets, address receiver, address owner) internal returns (uint256 shares) {
        return ICurveCrvUSDVault(address(vault)).withdraw(assets, receiver, owner, 0, new address[](0));
    }

    function _previewRedeem(uint256 shares) internal view returns (uint256 assets) {
        return ICurveCrvUSDVault(address(vault)).previewRedeem(shares);
    }

    function _redeem(uint256 shares, address receiver, address owner) internal returns (uint256 assets) {
        return ICurveCrvUSDVault(address(vault)).redeem(shares, receiver, owner, 0, new address[](0));
    }

    function _maxRedeem(address owner) internal view returns (uint256) {
        return ICurveCrvUSDVault(address(vault)).maxRedeem(owner, 0, new address[](0));
    }

    constructor() {
        __self = address(this);
    }

    // Modifier that prevents direct calls to the liquidation methods
    modifier onlyProxy() {
        require(address(this) != __self, "Direct calls not allowed");
        _;
    }

    // We will withdraw the entire amount of shares that the system has. We will consider max withdrawable amount.
    // We will withdraw everything, including deposits and yield.
    // We will check that entire deposit has been withdrawn. if not, we will revert.
    // We will reset all the state.
    // if there are still shares remaining, we will send them to the treasury.
    /**
     * @notice Withdraw all the shares from the vault
     * @dev This function is used to withdraw all the shares from the vault
     * @dev This function is called when the vault needs to be closed/changed.
     */
    function withdrawAll() external onlyProxy {
        // if the balance is 0, then just reset the state
        if (IERC20(address(vault)).balanceOf(address(this)) == 0) {
            vaultRewards.totalDeposits = 0;
            vaultRewards.lastSharePrice = 0;
            vaultRewards.lastDepositTime = 0;
            vaultRewards.totalShares = 0;
            return;
        }

        // Harvest any remaining yield first
        _harvestYield();

        uint256 maxWithdrawable = _maxWithdraw(address(this));

        if (maxWithdrawable < vaultRewards.totalDeposits) {
            revert("Not enough withdrawable amount to withdraw all");
        }

        // withdraw everything from the vault
        uint256 amountBefore = IERC20(reserve.reserveAssetAddress).balanceOf(address(this));
        _withdraw(maxWithdrawable, address(this), address(this));
        uint256 amountAfter = IERC20(reserve.reserveAssetAddress).balanceOf(address(this));
        uint256 totalWithdrawn = amountAfter - amountBefore;

        if (totalWithdrawn < vaultRewards.totalDeposits) {
            revert("Not enough withdrawable amount to withdraw all");
        }

        // Send the total deposit amount to the RToken. It will fail if the withdraw amount is not enough.
        IERC20(reserve.reserveAssetAddress).safeTransfer(reserve.reserveRTokenAddress, vaultRewards.totalDeposits);

        // Calculate any remaining yield (should be minimal after _harvestYield call)
        uint256 totalYield = totalWithdrawn - vaultRewards.totalDeposits;
        if (totalYield > 0) {
            vaultRewards.unclaimedRewards += totalYield;
        }

        // If there are remaining shares, send them to the receiver.
        uint256 remainingShares = IERC20(address(vault)).balanceOf(address(this));
        if (remainingShares > 0) {
            address treasury = IFeeCollector(feeCollector).getTargetAddress(keccak256("TREASURY"));
            if (treasury == address(0)) revert("Treasury not set");
            // approve the tokens to treasury
            IERC20(address(vault)).forceApprove(treasury, remainingShares);
            ITreasury(treasury).deposit(address(vault), remainingShares);
        }

        emit VaultFullyWithdrawn(totalWithdrawn, vaultRewards.totalDeposits, totalYield, remainingShares);
        // reset all the state
        vaultRewards.totalDeposits = 0;
        vaultRewards.lastSharePrice = 0; 
        vaultRewards.lastDepositTime = 0;
        vaultRewards.totalShares = 0;
        vaultRewards.lastWithdrawalTime = block.timestamp; 
    }

    /**
     * @notice Internal function to harvest yield from the vault
     * @dev This function uses a share-based approach to calculate and harvest yield while preserving principal
     * @dev The key principle: calculate shares needed to preserve totalDeposits, then redeem excess shares as yield
     */
    function _harvestYield() internal {
        // If no shares, nothing to harvest
        if (vaultRewards.totalShares == 0 || vaultRewards.totalDeposits == 0) {
            return;
        }

        // Calculate shares needed to preserve the principal (totalDeposits)
        // Using previewWithdraw which rounds up shares, ensuring we keep enough to cover principal
        uint256 sharesToKeep = _previewWithdraw(vaultRewards.totalDeposits);

        // If we don't have enough shares to cover principal, no yield to harvest
        if (vaultRewards.totalShares <= sharesToKeep) {
            return;
        }

        // Calculate yield shares (shares in excess of what's needed for principal)
        uint256 yieldShares = vaultRewards.totalShares - sharesToKeep;

        // Check max redeemable shares
        uint256 maxRedeemable = _maxRedeem(address(this));
        uint256 yieldSharesToBurn = yieldShares > maxRedeemable ? maxRedeemable : yieldShares;

        // If no yield shares to burn, return
        if (yieldSharesToBurn == 0) {
            return;
        }

        // Preview how many assets we'll get for safety check
        uint256 expectedAssets = _previewRedeem(yieldSharesToBurn);
        if (expectedAssets == 0) {
            return;
        }

        // Redeem yield shares for assets
        uint256 balanceBefore = IERC20(reserve.reserveAssetAddress).balanceOf(address(this));
        _redeem(yieldSharesToBurn, address(this), address(this));
        uint256 yieldHarvested = IERC20(reserve.reserveAssetAddress).balanceOf(address(this)) - balanceBefore;

        // Add harvested yield to unclaimed rewards
        vaultRewards.unclaimedRewards += yieldHarvested;

        // Update total shares after burning yield shares
        vaultRewards.totalShares -= yieldSharesToBurn;

        emit YieldHarvested(yieldHarvested);
    }

   /**
     * @notice Internal function to deposit liquidity into the Curve vault
     * @param amount The amount to deposit
     */
    function depositIntoVault(uint256 amount) internal {
        if (amount == 0) return;

        // Harvest any accumulated yield before depositing
        // This ensures yield is properly separated from new principal
        _harvestYield();

        // Check maximum deposit limit before proceeding
        uint256 maxDeposit = _maxDeposit(address(this));
        if (amount > maxDeposit) {
            amount = maxDeposit;
        }

        uint256 expectedShares = _previewDeposit(amount);
        if (expectedShares == 0) return;

        // First transfer the tokens from RToken to this contract
        IRToken(reserve.reserveRTokenAddress).transferAsset(address(this), amount);

        // Then approve and deposit into the vault and get shares in return
        IERC20(reserve.reserveAssetAddress).approve(address(vault), amount);
        uint256 shares = _deposit(amount, address(this));
        if (shares == 0) return;

        // Update state: track the raw deposit amount as principal
        // Note: We intentionally use 'amount' (not previewRedeem) to maintain the original principal
        // This creates a conservative bound for yield harvesting
        vaultRewards.totalShares += shares;
        // Note: Calibrate the totalDeposits based on the current shares (current shares are only for pricipal since the yield has been harvested)
        vaultRewards.totalDeposits = _previewRedeem(vaultRewards.totalShares);
        vaultRewards.lastDepositTime = block.timestamp;
    }

    /**
     * @notice Internal function to withdraw liquidity from the Curve vault
     * @dev The withdrawable limit is re-read after harvesting yield, since redeeming yield shares lowers it
     * @param amount The amount to withdraw
     * @param strict If true, reverts when `amount` exceeds the post-harvest limit (exact payouts);
     *        if false, caps the withdrawal to that limit (best-effort buffer rebalancing)
     */
    function _withdrawFromVault(uint256 amount, bool strict) internal {
        if (amount == 0) return;

        uint256 maxWithdrawable = _maxWithdraw(address(this));
        if (maxWithdrawable == 0) return;

        // Harvest any accumulated yield first
        // This reduces maxWithdrawable, so we recheck after harvest later
        _harvestYield();

        // Recheck maxWithdrawable after yield harvest
        maxWithdrawable = _maxWithdraw(address(this));
        if (maxWithdrawable < amount) {
            if (strict) revert("Not enough liquidity to fulfill the withdrawal");
            amount = maxWithdrawable;
            if (amount == 0) return;
        }

        uint256 withdrawAmount = amount;

        // Withdraw the principal amount from vault
        uint256 balanceBefore = IERC20(reserve.reserveAssetAddress).balanceOf(address(this));
        uint256 sharesBurned = _withdraw(withdrawAmount, address(this), address(this));
        uint256 actualWithdrawn = IERC20(reserve.reserveAssetAddress).balanceOf(address(this)) - balanceBefore;

        // Transfer the withdrawn principal to RToken
        IERC20(reserve.reserveAssetAddress).safeTransfer(reserve.reserveRTokenAddress, actualWithdrawn);

        // Update share tracking after withdrawal
        if (sharesBurned >= vaultRewards.totalShares) {
            vaultRewards.totalShares = 0;
        } else {
            vaultRewards.totalShares -= sharesBurned;
        }

        // Update principal tracking
        // Note: Calibrate the totalDeposits based on the current shares (current shares are only for pricipal since the yield has been harvested)
        vaultRewards.totalDeposits = _previewRedeem(vaultRewards.totalShares);
        vaultRewards.lastWithdrawalTime = block.timestamp;
    }

    /**
     * @notice Rebalances liquidity between the buffer and the Curve vault to maintain the desired buffer ratio
     * @dev Includes minimum threshold check to prevent griefing attacks via dust amounts
     */
    function rebalanceLiquidity() external onlyProxy {
        // if vault is not set, do nothing as this can be desired to disable vault
        if (address(vault) == address(0)) {
            return;
        }

        uint256 totalDeposits = reserve.totalLiquidity; // Total liquidity in the system
        uint256 desiredBuffer = totalDeposits.percentMul(parameters.liquidityBufferRatio);
        uint256 currentBuffer = IERC20(reserve.reserveAssetAddress).balanceOf(reserve.reserveRTokenAddress);

        // Only deposit excess into vault if we're not in the middle of a withdrawal
        if (currentBuffer > desiredBuffer) {
            uint256 excess = currentBuffer - desiredBuffer;
            // Only rebalance if excess exceeds minimum threshold (prevents griefing)
            if (excess >= parameters.minVaultRebalanceAmount) {
                // Deposit excess into the vault
                depositIntoVault(excess);
            }
        } else if (currentBuffer < desiredBuffer) {
            uint256 shortage = desiredBuffer - currentBuffer;
            // Only rebalance if shortage exceeds minimum threshold (prevents griefing)
            if (shortage >= parameters.minVaultRebalanceAmount) {
                // Withdraw what we can from the vault, capped to the post-harvest limit
                _withdrawFromVault(shortage, false);
            }
        }

        emit LiquidityRebalanced(IERC20(reserve.reserveAssetAddress).balanceOf(reserve.reserveRTokenAddress), vaultRewards.totalDeposits);
    }

    /**
     * @notice Ensure sufficient liquidity is available for withdrawals or borrowing
     * @param amount The amount required
     */
    function ensureLiquidity(uint256 amount) external onlyProxy() {
        // if vault is not set, do nothing
        uint256 availableLiquidity = IERC20(reserve.reserveAssetAddress).balanceOf(reserve.reserveRTokenAddress);
        
        if (address(vault) == address(0)) {            
            if (availableLiquidity < amount) {
                revert("Insufficient liquidity in the pool");
            }
            return;
        }
        // if we do not have enought, then we need to withdraw from the vault
        if (availableLiquidity < amount) {
            uint256 requiredAmountToWithdraw = amount - availableLiquidity;
           
            // We've already verified we can withdraw the required amount
            if (requiredAmountToWithdraw > 0) {
                _withdrawFromVault(requiredAmountToWithdraw, true);
            }
            
            // Verify we have enough after withdrawal
            availableLiquidity = IERC20(reserve.reserveAssetAddress).balanceOf(reserve.reserveRTokenAddress);
            
            if (availableLiquidity < amount) {
                revert("Insufficient liquidity after vault withdrawal");
            }
        }
    }

    /**
     * @notice Emitted when liquidity is rebalanced
     * @param bufferAmount The reserve asset balance held by the RToken after the rebalance
     * @param vaultAmount The tracked principal deposited in the vault (vaultRewards.totalDeposits), excluding unharvested yield
     */
    event LiquidityRebalanced(uint256 bufferAmount, uint256 vaultAmount);
}