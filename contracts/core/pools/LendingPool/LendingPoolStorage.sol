// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

// OpenZeppelin libraries
import "../../../libraries/pools/ReserveLibrary.sol";
// Interface contracts
import "../../../interfaces/core/pools/LendingPool/ILendingPoolStorage.sol";
// External interfaces
import "../../../interfaces/core/vaults/IBaseVault.sol";
import "../../../interfaces/core/tokens/IDebtToken.sol";
import "../../../interfaces/core/tokens/IRToken.sol";

/**
 * @title LendingPoolStorage
 * @author RAAC Protocol Team
 * @notice RAAC lending protocol storage variables. 
 * @dev Used in common with proxy contracts.
 */
contract LendingPoolStorage is ILendingPoolStorage {

    // Reserve data, including liquidity, usage indices, and addresses
    ReserveLibrary.ReserveData public reserve;

    // Rate data, including interest rates and thresholds
    ReserveLibrary.ReserveRateData public rateData;

    // NFT Position tracking: user -> bytes32 (adapter, parameters): position
    mapping(address => mapping(bytes32 => CollateralPosition)) public positions;

    // Prime Rate Oracle
    address public primeRateOracle;

    // Stability Pool address
    address public stabilityPool;

    // Fee collector address
    address public feeCollector;

    // Vault rewards tracking
    VaultRewards public vaultRewards;

    // Liquidation base parameters
    uint256 public constant BASE_BORROW_THRESHOLD = 50_00; // 50% in basis points
    uint256 public constant BASE_LIQUIDATION_THRESHOLD = 80_00; // 80% in basis points
    uint256 public constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18; // Health factor threshold
    uint256 public constant BASE_LIQUIDATION_GRACE_PERIOD = 3 days;
    uint256 public constant MIN_BORROW_AMOUNT = 10e18; // 10 reserveAsset units

    // BaseVault interface for vaults (e.g. curve vault)
    IBaseVault public vault;

    /// @notice whitelist of supported adapters
    mapping(address => bool) public supportedAdapters;
    /// @notice list of supported adapter addresses
    address[] public adapters;

    // Roles
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant PROTOCOL_ROLE = keccak256("PROTOCOL_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // Mapping of whether user opened the value: one-time only
    mapping(address => bool) public vaultOpened;

    // Protocol parameters
    struct Parameters {
        bool canPaybackDebt;
        bool withdrawalsPaused;
        uint256 liquidationThreshold;
        uint256 liquidationGracePeriod;
        uint256 insuranceFee;
        uint256 depositFee;
        uint256 liquidityBufferRatio;
        uint256 supplyCap;
        uint256 borrowCap;
        uint256 vaultOpeningFee;
        uint256 borrowThreshold;
        uint256 minDepositAmount;
        uint256 primeRateChangeBps;
        uint256 minVaultRebalanceAmount;
    }
    Parameters public parameters;

    /// @notice track the block number when the user deposited
    mapping(address => uint256) public depositBlock;
}

