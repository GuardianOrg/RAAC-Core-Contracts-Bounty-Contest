// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ILendingPoolStorage.sol";
    
/**
 * @title ILendingPool
 * @notice Interface for the LendingPool contract in the RAAC lending protocol.
 * @dev Defines the main functions for depositing, borrowing, repaying, and liquidating in the lending pool.
 */
interface ILendingPool is ILendingPoolStorage {
    /**
     * @notice Deposits reserve assets into the lending pool
     * @param amount The amount to deposit
     */
    function deposit(uint256 amount) external;

    /**
     * @notice Withdraws reserve assets from the lending pool
     * @param amount The amount to withdraw
     */
    function withdraw(uint256 amount) external;

    /**
     * @notice Allows a user to deposit an asset
     * @param adapter Address of the asset adapter in usage
     * @param data Data to be given
     */
    function depositAsset(address adapter, bytes calldata data) external;

    /**
     * @notice Allows a user to withdraw an asset
     * @param adapter Address of the asset adapter in usage
     * @param data Data to be given
     */
    function withdrawAsset(address adapter, bytes calldata data) external;

    /**
     * @notice Borrows reserve assets from the lending pool for a specific NFT position
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount of the reserve assets to borrow
     */
    function borrow(address adapter, bytes calldata data, uint256 amount) external;

    /**
     * @notice Repays borrowed reserve assets for a specific NFT position
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount to repay
     */
    function repay(address adapter, bytes calldata data,  uint256 amount) external;

    /**
     * @notice Repays borrowed reserve assets for a specific NFT position on behalf of another user
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount to repay
     * @param onBehalfOf The address of the user whose debt is being repaid
     */
    function repayOnBehalf(address adapter, bytes calldata data, uint256 amount, address onBehalfOf) external;

    /**
     * @notice Updates the state of the lending pool
     */
    function updateState() external;

     /**
     * @notice Rebalance Lending Pool liquidity in the configured vault (only callable by Stability Pool)
     */
    function rebalanceLiquidity() external;

    /**
     * @notice Initiates liquidation for a specific NFT position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     */
    function initiateLiquidation(address adapter, address user, bytes calldata data) external;

    /**
     * @notice Allows a user to close their NFT position liquidation by repaying debt
     * @param adapter Address of the asset adapter
     * @param data Data for identifying 
     */
    function closeLiquidation(address adapter, bytes calldata data) external;

    /**
     * @notice Finalizes a liquidation after grace period expires
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     */
    function finalizeLiquidation(address adapter, address user, bytes calldata data) external;

    /**
     * @notice Calculates the health factor for a specific NFT position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The position's health factor
     */
    function calculateHealthFactor(address adapter, address user, bytes calldata data) external view returns (uint256);

    /**
     * @notice Gets the total collateral value for a user
     * @param user The address of the user
     * @return The total value of the user's collateral
     */
    function getUserCollateralValue(address user) external view returns (uint256);

    /**
     * @notice Gets the debt for a specific NFT position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The debt for the NFT position
     */
    function getPositionDebt(address adapter, address user, bytes calldata data) external view returns (uint256);

    function getPosition(address adapter, address user, bytes calldata data) external view returns (CollateralPosition memory);

    function getPositionData(address adapter, address user, bytes calldata data) external view returns (uint256, uint256);

    function getPositionScaledDebt(address adapter, address user, bytes calldata data) external view returns (uint256);

    /**
     * @notice Gets the price of an NFT
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The price of the NFT
     */
    function getAssetValue(address adapter, address user, bytes calldata data) external view returns (uint256);

    /**
     * @notice Gets the normalized income of the reserve
     * @return The normalized income
     */
    function getNormalizedIncome() external view returns (uint256);

    /**
     * @notice Gets the protocol fee owed to the fee collector, in underlying units
     * @dev Banked scaled by the liquidity index, so this grows while unclaimed
     * @return The pending protocol fee in underlying asset units
     */
    function getPendingProtocolFee() external view returns (uint256);

    /**
     * @notice Gets the normalized debt of the reserve
     * @return The normalized debt
     */
    function getNormalizedDebt() external view returns (uint256);

    function supportedAdapter(address _adapter) external returns (bool);
    /**
     * @notice Parameter types that can be set by owner
     */
    enum OwnerParameter {
        LiquidationThreshold,
        LiquidationGracePeriod,
        LiquidityBufferRatio,
        WithdrawalStatus,
        CanPaybackDebt,
        InsuranceFee,
        ProtocolFeeRate,
        LendingPoolDepositFee,
        LendingPoolSupplyCap,
        LendingPoolBorrowCap,
        VaultOpeningFee,
        BorrowThreshold,
        MaxRate, // in RAY
        MinDepositAmount,
        OptimalUtilizationRate,
        PrimeRateChangeBPS,
        MinVaultRebalanceAmount
    }

    /**
     * @notice Sets a parameter value
     * @param param The parameter to update
     * @param newValue The new value to set
     */
    function setParameter(OwnerParameter param, uint256 newValue) external;

    /**
     * @notice Sets the prime rate of the reserve
     * @param newPrimeRate The new prime rate
     */
    function setPrimeRate(uint256 newPrimeRate) external;

    /**
     * @notice Sets the stability pool address
     * @param newStabilityPool The new stability pool address
     */
    function setStabilityPool(address newStabilityPool) external;

    /**
     * @notice Claims rewards for the caller
     */
    function claimCollectorRewards() external returns (address, uint256);

    function getPositionsScaledDebt(address userAddress) external view returns (uint256);

    /**
     * @notice Checks if a user deposited in the same block
     * @param user The address of the user
     * @return True if the user deposited in the same block, false otherwise
     */
    function isUserDepositInSameBlock(address user) external view returns (bool);

    function openVaultPosition() external;

    // EVENTS
    /**
     * @notice Emitted when a user deposits assets
     * @param user The address of the user
     * @param amount The amount deposited
     * @param mintedAmount The amount of RTokens minted
     */
    event Deposit(address indexed user, uint256 amount, uint256 mintedAmount);

    /**
     * @notice Emitted when a user withdraws assets
     * @param user The address of the user
     * @param amount The amount withdrawn
     */
    event Withdraw(address indexed user, uint256 amount);

    /**
     * @notice Emitted when a user borrows assets
     * @param user The address of the user
     * @param adapter The address of the asset adapter backing the collateral position
     * @param data Data identifying the asset position used as collateral
     * @param amount The amount borrowed
     */
    event Borrow(address indexed user, address indexed adapter, bytes data, uint256 amount);

    /**
     * @notice Emitted when a user repays borrowed assets
     * @param user The address of the user calling the repay function
     * @param adapter The address of the asset adapter backing the collateral position
     * @param onBehalfOf The address of the user being repaid on behalf of
     * @param data Data identifying the asset position whose debt is repaid
     * @param amount The amount repaid
     */
    event Repay(address indexed user, address indexed adapter, address indexed onBehalfOf, bytes data, uint256 amount);

    /**
     * @notice Emitted when a user deposits an NFT as collateral
     * @param user The address of the user
     * @param tokenId The token ID of the NFT
     */
    event NFTDeposited(address indexed user, uint256 tokenId);

    /**
     * @notice Emitted when a user withdraws an NFT
     * @param user The address of the user
     * @param tokenId The token ID of the NFT
     */
    event NFTWithdrawn(address indexed user, uint256 tokenId);

    /**
     * @notice Emitted when a liquidation occurs
     * @param liquidator The address of the liquidator
     * @param user The address of the user being liquidated
     * @param debtRepaid The amount of debt repaid
     * @param collateralLiquidated The amount of collateral liquidated
     */
    event Liquidation(address indexed liquidator, address indexed user, uint256 debtRepaid, uint256 collateralLiquidated);

    /**
     * @notice Emitted when the Stability Pool address is updated
     * @param oldStabilityPool The old address of the Stability Pool
     * @param newStabilityPool The new address of the Stability Pool
     */
    event StabilityPoolUpdated(address indexed oldStabilityPool, address indexed newStabilityPool);

    /**
     * @notice Emitted when the liquidation proxy address is updated
     * @param oldLiquidationProxy The old address of the liquidation proxy
     * @param newLiquidationProxy The new address of the liquidation proxy
     */
    event LiquidationProxyUpdated(address indexed oldLiquidationProxy, address indexed newLiquidationProxy);

    /**
     * @notice Emitted when the repay on behalf status changes
     * @param enabled True if repay on behalf is enabled, false otherwise
     */
    event CanPaybackDebtChanged(bool enabled);

    /**
     * @notice Emitted when the NFT insurnace fee is updated
     * @param oldInsuranceFee The old insurance
     * @param newInsuranceFee The new insurance fee
     */
    event InsuranceFeeUpdated(uint256 oldInsuranceFee, uint256 newInsuranceFee);

    /**
     * @notice Emitted when liquidity is rebalanced
     * @param bufferAmount The reserve asset balance held by the RToken after the rebalance
     * @param vaultAmount The tracked principal deposited in the vault (vaultRewards.totalDeposits), excluding unharvested yield
     */
    event LiquidityRebalanced(uint256 bufferAmount, uint256 vaultAmount);

    /**
     * @notice Emitted when the vault is updated
     * @param oldVault The old address of the vault
     * @param newVault The new address of the vault
     */
    event VaultUpdated(address indexed oldVault, address indexed newVault);

    /**
     * @notice Emitted when the liquidity buffer ratio is updated
     * @param oldRatio The old liquidity buffer ratio
     * @param newRatio The new liquidity buffer ratio
     */
    /**
     * @notice Emitted when the deposit fee is updated
     * @param oldDepositFee The old deposit fee
     * @param newDepositFee The new deposit fee
     */
    event DepositFeeUpdated(uint256 oldDepositFee, uint256 newDepositFee);

    /**
     * @notice Emitted when the withdrawal fee is updated
     * @param oldWithdrawalFee The old withdrawal fee
     * @param newWithdrawalFee The new withdrawal fee
     */
    event WithdrawFeeUpdated(uint256 oldWithdrawalFee, uint256 newWithdrawalFee);
   
    event LiquidityBufferRatioUpdated(uint256 oldRatio, uint256 newRatio);

    event SupplyCapUpdated(uint256 oldalue, uint256 newValue);

    event BorrowCapUpdated(uint256 oldalue, uint256 newValue);

    event VaultOpeningFeeUpdated(uint256 oldalue, uint256 newValue);

    event ParameterChanged(OwnerParameter parameter, uint256 oldalue, uint256 newValue);

    /**
     * @notice Emitted when withdrawal functionality is paused or unpaused
     * @param isPaused True if withdrawal functionality is paused, false otherwise
     */
    event WithdrawalsPauseStatusChanged(bool isPaused);

    /**
     * @notice Emitted when a reward token is added
     * @param token The address of the reward token
     * @param rewardRate The reward rate
     * @param duration The duration of the reward
     */
    event RewardTokenAdded(address indexed token, uint256 rewardRate, uint256 duration);

    /**
     * @notice Emitted when a reward token's parameters are updated
     * @param token The address of the reward token
     * @param rewardRate The new reward rate
     * @param duration The new duration of the reward
     */
    event RewardParametersUpdated(address indexed token, uint256 rewardRate, uint256 duration);

    /**
     * @notice Emitted when a reward token is claimed
     * @param user The address of the user
     * @param token The address of the reward token
     * @param amount The amount of reward tokens claimed
     */
    event RewardClaimed(address indexed user, address indexed token, uint256 amount);

    /**
     * @notice Emitted when the fee collector address is updated
     * @param oldFeeCollector The old address of the fee collector
     * @param newFeeCollector The new address of the fee collector
     */
    event FeeCollectorUpdated(address indexed oldFeeCollector, address indexed newFeeCollector);

    /**
     * @notice Emitted when the fee collector is not the caller
     */
    event NotFeeCollector();

    /**
     * @notice Emitted when there are insufficient protocol fees
     */
    event InsufficientFees();

    /**
     * @notice Emitted when the prime rate oracle is updated
     * @param newOracle The new prime rate oracle address
     */
    event PrimeRateOracleUpdated(address indexed newOracle);

    event VaultRewardsClaimed(uint256 amount);
    event InsuredAsset(address indexed asset, address user, bytes data, uint256 amount);
    event ProtocolFeeRateUpdated(uint256 oldValue, uint256 newValue);
    event WithdrawQueued(address indexed user, uint256 amount, uint256 readyAt);
    event WithdrawCancelled(address indexed user);
    event WithdrawTimelockDurationUpdated(uint256 oldValue, uint256 newValue);
    event VaultOpeningFeePaid(address user, uint256 fee);

    // ERRORS
    error NotOwnerOfNFT();
    error NFTNotDeposited();
    error WithdrawalWouldLeaveUserUnderCollateralized();
    error NoCollateral();
    error InsufficientAllowanceForFees();
    error InsufficientBalance();
    error TransferFailed();
    error NotEnoughCollateralToBorrow();
    error SameAddressNotAllowed();
    error AddressCannotBeZero();
    error InvalidInterestRateMode();
    error InvalidParameter();
    error InvalidNFTPrice();
    error Unauthorized();
    error InvalidAmount();
    error CannotWithdrawUnderLiquidation();
    error CannotBorrowUnderLiquidation();
    error CannotRepayUnderLiquidationWithoutInsurance();
    error StalePrice();
    error PaybackDebtDisabled();
    error WithdrawalsArePaused();
    error NoActiveRewardToken();
    error RewardTokenAlreadySet();
    error NoDeposits();
    error InvalidVaultAsset();
    error AccessDenied();
    error VaultPositionNotOpened();
    error VaultPositionAlreadyOpened();
    error RepaymentBelowMinimumThreshold();
    error CannotDepositWhenUnderLiquidation();
    error BorrowThresholdTooHigh();
    error LiquidationThresholdTooLow();
    error CannotWithdrawInSameBlock();
    error TimelockExpired();
    error InvalidBorrowAmount();
    error ResidualCannotBeRepaid();
    error MinDepositAmountRequired();
}

