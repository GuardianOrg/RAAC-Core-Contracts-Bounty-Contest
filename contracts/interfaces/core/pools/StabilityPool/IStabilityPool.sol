// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IStabilityPool
 * @author RegnumAurumAcquisitionCorp
 * @notice Interface for the Stability Pool contract that manages deposits, withdrawals, and liquidations
 * @dev Handles user deposits of rToken, minting of deToken
 */
interface IStabilityPool {
    /* ========== CORE FUNCTIONS ========== */

    /**
     * @notice Allows users to deposit rToken and receive deToken
     * @param amount Amount of rToken to deposit
     */
    function deposit(uint256 amount) external;

    /**
     * @notice Allows users to withdraw their rToken 
     * @param deCRVUSDAmount Amount of deToken to redeem
     */
    function withdraw(uint256 deCRVUSDAmount) external;

    /**
     * @notice Liquidates a borrower's position
    * @param poolAdapter The address of the asset adapter in the lending pool for finalizing liquidation
     * @param vaultAdapter The address of the asset adapter in the vault for storing the asset.
     * @param user The address of the borrower to liquidate.
     * @param data Parameters to identify the asset (tokenId, amount, etc.)
     * @param minSharesOut Minimum amount of shares to receive
     */ 
    function liquidateBorrower(address poolAdapter, address vaultAdapter, address user, bytes calldata data, uint256 minSharesOut) external;

    /* ========== ADMIN & MANAGER FUNCTIONS ========== */

    /**
     * @notice Collects the dust from the stability pool
     * @param token Address of the token
     * @param recipient Address of the recipient
     * @param amount Amount of dust to collect
     */
    function collectDust(address token, address recipient, uint256 amount) external;

    /**
     * @notice Adds a new manager
     * @param manager Address of the manager to add
     */
    function addManager(address manager) external;

    /**
     * @notice Removes an existing manager
     * @param manager Address of the manager to remove
     */
    function removeManager(address manager) external;

    /**
     * @notice Pauses the contract
     */
    function pause() external;

    /**
     * @notice Unpauses the contract
     */
    function unpause() external;

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Checks if an address is a manager
     * @param manager Address to check
     * @return True if the address is a manager
     */
    function isAddressManager(address manager) external view returns (bool);

    /**
     * @notice Gets the list of all managers
     * @return Array of manager addresses
     */
    function getManagerList() external view returns (address[] memory);

    /**
     * @notice Gets the total deposits in the pool
     * @return Total deposits amount
     */
    function getTotalDeposits() external view returns (uint256);

    /**
     * @notice Gets the deposit amount for a user
     * @param user Address of the user
     * @return Deposit amount
     */
    function getUserDeposit(address user) external view returns (uint256);

    /**
     * @notice Gets the pool index
     * @return Pool index
     */
    function getPoolIndex() external view returns (uint256);

    /**
     * @notice Gets the user index
     * @param user Address of the user
     * @return User index
     */
    function getUserIndex(address user) external view returns (uint256);

    /**
     * @notice Gets the scaled deposit
     * @param user Address of the user
     * @return Scaled deposit
     */
    function getScaledDeposit(address user) external view returns (uint256);

    /**
     * @notice Gets the raw total deposits
     * @return Raw total deposits
     */
    function getRawTotalDeposits() external view returns (uint256);

    /**
     * @notice Checks if a user deposited in the same block
     * @param user The address of the user
     * @return True if the user deposited in the same block, false otherwise
     */
    function isUserDepositInSameBlock(address user) external view returns (bool);

    /* ========== EVENTS ========== */

    /**
     * @notice Emitted when a manager is added
     * @param manager Address of the added manager
     */
    event ManagerAdded(address indexed manager);

    /**
     * @notice Emitted when a manager is removed
     * @param manager Address of the removed manager
     */
    event ManagerRemoved(address indexed manager);

    /**
     * @notice Emitted when a manager's allocation is updated
     * @param manager Address of the manager
     * @param newAllocation New allocation amount
     */
    event AllocationUpdated(address indexed manager, uint256 newAllocation);

    /**
     * @notice Emitted when a user deposits tokens
     * @param user Address of the depositor
     * @param rcrvUSDAmount Amount of rToken deposited
     * @param deCRVUSDAmount Amount of deToken minted
     */
    event Deposit(address indexed user, uint256 rcrvUSDAmount, uint256 deCRVUSDAmount);

    /**
     * @notice Emitted when a user withdraws tokens
     * @param user Address of the withdrawer
     * @param rcrvUSDAmount Amount of rToken withdrawn
     * @param deCRVUSDAmount Amount of deToken burned
     */
    event Withdraw(address indexed user, uint256 rcrvUSDAmount, uint256 deCRVUSDAmount);

    /**
     * @notice Emitted when the liquidity pool address is set
     * @param liquidityPool Address of the new liquidity pool
     */
    event LiquidityPoolSet(address indexed liquidityPool);

    /**
     * @notice Emitted when RAAC tokens are deposited from the pool
     * @param liquidityPool Address of the liquidity pool
     * @param amount Amount of RAAC tokens deposited
     */
    event RAACDepositedFromPool(address indexed liquidityPool, uint256 amount);

    /**
     * @notice Emitted when a new market is added
     * @param market Address of the added market
     * @param allocation Initial allocation amount for the market
     */
    event MarketAdded(address indexed market, uint256 allocation);

    /**
     * @notice Emitted when a market is removed
     * @param market Address of the removed market
     */
    event MarketRemoved(address indexed market);

    /**
     * @notice Emitted when a market's allocation is updated
     * @param market Address of the market
     * @param newAllocation New allocation amount
     */
    event MarketAllocationUpdated(address indexed market, uint256 newAllocation);

    /**
     * @notice Emitted when a user deposits their NFT to the pool in exchange of index token
     * @param nft Address of the NFT
     * @param tokenId Token ID of the NFT
     */
    event NFTDeposited(address indexed nft, uint256 tokenId);
    
    /**
     * @notice Emitted when the RWA vault is updated
     * @param previous Address of the previous RWA vault
     * @param latest Address of the new RWA vault
     */
    event RWAVaultUpdated(address previous, address latest);

    /**
     * @notice Emitted when the liquidation proxy is updated
     * @param previous Address of the previous proxy
     * @param latest Address of the new proxy
     */
    event LiquidationStrategyProxyUpdated(address previous, address latest);

    /**
     * @notice Emitted when the liquidation vault token split is updated
     * @param mintPercentage Percentage of minting fee
     * @param burnPercentage Percentage of burning fee
     * @param swapPercentage Percentage of swapping fee
     * @param liquidityPercentage Percentage of liquidity fee
     */
    event LiquidationVaultTokenSplitUpdated(uint256 mintPercentage, uint256 burnPercentage, uint256 swapPercentage, uint256 liquidityPercentage);

    /**
     * @notice Emitted when the liquidation swap is updated
     * @param previous Address of the previous swap
     * @param latest Address of the new swap
     */
    event LiquidationSwapUpdated(address previous, address latest);

    /**
     * @notice Emitted when the fee collector is updated
     * @param previous Address of the previous fee collector
     * @param latest Address of the new fee collector
     */
    event FeeCollectorUpdated(address previous, address latest);

    /**
     * @notice Emitted when a user cancels a withdraw
     * @param user Address of the user
     */
    event WithdrawCancelled(address indexed user);
    
    /**
     * @notice Emitted when a user withdraws tokens
     * @param user Address of the withdrawer
     * @param amount Amount of rToken withdrawn
     * @param readyAt Unix timestamp when the withdraw is ready
     */
    event WithdrawQueued(address indexed user, uint256 amount, uint256 readyAt);

    /**
     * @notice Emitted when the withdraw timelock duration (cooldown before the execution window opens) is updated
     * @param previous Previous cooldown in seconds
     * @param latest New cooldown in seconds
     */
    event WithdrawTimelockDurationUpdated(uint256 previous, uint256 latest);

    /**
     * @notice Emitted when the withdraw timelock delay (execution window after the cooldown) is updated
     * @param previous Previous execution window in seconds
     * @param latest New execution window in seconds
     */
    event WithdrawTimelockDelayUpdated(uint256 previous, uint256 latest);

    /* ========== ERRORS ========== */

    /// @notice When caller is not authorized for the operation
    error UnauthorizedAccess();

    /// @notice When manager already exists
    error ManagerAlreadyExists();

    /// @notice When manager is not found
    error ManagerNotFound();

    /// @notice When market already exists
    error MarketAlreadyExists();

    /// @notice When transfer fails
    error TransferFailed();

    /// @notice When transfer is invalid
    error InvalidTransfer();

    /// @notice When deposit is invalid
    error InvalidDeposit();

    /// @notice When withdrawal is invalid
    error InvalidWithdraw();

    /// @notice When rewards calculation is invalid
    error InvalidRewards();

    /// @notice When the user is setting the same address
    error SameAddressNotAllowed();

    /// @notice When the user sets address 0
    error AddressCannotBeZero();

    /// @notice When the withdraw timelock is not ready
    error WithdrawTimelockNotReady();

    /// @notice When the withdraw timelock is expired
    error WithdrawTimelockExpired();

    /// @notice When the withdraw timelock is invalid
    error WithdrawTimelockInvalid();

    /// @notice When the withdraw amount is too high
    error WithdrawAmountTooHigh();

    /// @notice When the withdraw timelock is disabled
    error TimelockDisabled();

    /// @notice When the withdraw timelock is not expired
    error WithdrawTimelockNotExpired();

    /// @notice When the withdraw timelock is not ready
    error NoPendingWithdraw();

    /// @notice When the user cannot deposit and withdraw in the same block
    error CannotDepositAndWithdrawSameBlock();

    /**
     * @notice Emitted when the dust is collected
     * @param token Address of the token
     * @param recipient Address of the recipient
     * @param amount Amount of dust collected
     */
    event DustCollected(address indexed token, address indexed recipient, uint256 amount);
}