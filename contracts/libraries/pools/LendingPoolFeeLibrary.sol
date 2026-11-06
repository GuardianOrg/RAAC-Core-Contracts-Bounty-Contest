// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../interfaces/core/pools/LendingPool/ILendingPoolStorage.sol";
import "../../interfaces/core/collectors/IBaseCollector.sol";
import "../../interfaces/core/tokens/IRToken.sol";
import "../../libraries/pools/ReserveLibrary.sol";
import "../../libraries/math/WadRayMath.sol";

library LendingPoolFeeLibrary {
    using SafeERC20 for IERC20;
    using WadRayMath for uint256;
    using ReserveLibrary for ReserveLibrary.ReserveData;

    error AddressCannotBeZero();
    error InvalidAmount();
    error ApprovalFailed();

    /**
     * @notice Claims protocol fees from the lending pool
     * @param reserve The reserve data
     * @param feeCollector The fee collector address
     * @return tokenAddress The token address
     * @return claimedAmount The amount claimed
     */
    function claimProtocolFees(ReserveLibrary.ReserveData storage reserve, address feeCollector, uint256 liquidityIndex) external returns (address tokenAddress, uint256 claimedAmount) {
        if (address(feeCollector) == address(0)) revert AddressCannotBeZero();

        uint256 pendingAmount = reserve.scaledPendingProtocolFee.rayMul(liquidityIndex);
        address reserveAssetAddress = reserve.reserveAssetAddress;
        address reserveRTokenAddress = reserve.reserveRTokenAddress;
        if(pendingAmount == 0) return (reserveAssetAddress, 0);

        tokenAddress = reserveAssetAddress;
        claimedAmount = pendingAmount;

        reserve.scaledPendingProtocolFee = 0;

        IRToken(reserveRTokenAddress).transferAsset(address(this), pendingAmount);
        bool approved = IERC20(reserveAssetAddress).approve(feeCollector, pendingAmount);
        if (!approved) revert ApprovalFailed();
        IBaseCollector(feeCollector).collectFee(reserveAssetAddress, address(this), pendingAmount, keccak256("PROTOCOL_FEE"));    
    }

    /**
     * @notice Claims vault rewards from the lending pool
     * @param vaultRewards The vault rewards data
     * @param reserveAssetAddress The reserve asset address
     * @param feeCollector The fee collector address
     * @return claimedAmount The amount claimed
     */
    function claimVaultRewards(ILendingPoolStorage.VaultRewards storage vaultRewards, address reserveAssetAddress, address feeCollector) external returns (uint256 claimedAmount) {
        claimedAmount = vaultRewards.unclaimedRewards;
        if(claimedAmount == 0) return 0;

        vaultRewards.lastClaimTime = block.timestamp;
        vaultRewards.unclaimedRewards = 0;

        IERC20(reserveAssetAddress).safeTransfer(feeCollector, claimedAmount);
    }

    /**
     * @notice Collects a fee from the user
     * @param reserveAssetAddress The reserve asset address
     * @param amount The fee amount
     * @param feeType The fee type
     * @param feeCollector The fee collector address
     */
    function collectFee(address reserveAssetAddress, uint256 amount, bytes32 feeType, address feeCollector) external {
        if (address(feeCollector) == address(0)) revert AddressCannotBeZero();
        if (amount == 0) revert InvalidAmount();

        IERC20(reserveAssetAddress).safeTransferFrom(msg.sender, address(this), amount);
        bool approved = IERC20(reserveAssetAddress).approve(feeCollector, amount);
        if (!approved) revert ApprovalFailed();
        IBaseCollector(feeCollector).collectFee(reserveAssetAddress, address(this), amount, feeType);
    }

    /**
     * @notice Rescues tokens mistakenly sent to the lending pool
     * @param reserve The reserve data
     * @param vaultRewards The vault rewards data
     * @param vault The vault address
     * @param tokenAddress The address of the ERC20 token
     * @param recipient The address to send the rescued tokens to
     * @param amount The amount of tokens to rescue
     */
    function rescueToken(ReserveLibrary.ReserveData storage reserve, ILendingPoolStorage.VaultRewards storage vaultRewards, address vault, address tokenAddress, address recipient, uint256 amount) external {
        require(tokenAddress != vault, "Cannot rescue vault token");
        if (tokenAddress == reserve.reserveAssetAddress && amount > IERC20(reserve.reserveAssetAddress).balanceOf(address(this)) - vaultRewards.unclaimedRewards) amount = IERC20(reserve.reserveAssetAddress).balanceOf(address(this)) - vaultRewards.unclaimedRewards;
        IERC20(tokenAddress).safeTransfer(recipient, amount);
    }
}
