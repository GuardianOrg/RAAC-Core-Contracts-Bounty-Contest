// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "./IBaseCollector.sol";
/**
 * @title IFeeCollector Interface
 * @notice Interface for the FeeCollector contract that manages protocol fee collection and distribution
 * @dev Defines core functionality for fee management, distribution, and reward calculations
 */
interface IFeeCollector is IBaseCollector {
    /**
     * @notice Fee distribution parameters for each fee type
     * @dev All shares are in basis points (100% = 10000)
     * @param feeType The type of fee
     * @param treasuryShare Percentage share for treasury
     * @param repairFundShare Percentage share for repair fund
     * @param burnShare Percentage share for token burning
     * @param veRAACTokenShare Percentage share for veRAACToken
     * @param raacCorp Percentage share for raacCorp
     * @param otherShare Percentage share for other purposes
     */
    struct FeeType {
        bytes32 feeType;
        uint256 treasuryShare;      // Basis points
        uint256 repairFundShare;    // Basis points
        uint256 burnShare;          // Basis points
        uint256 veRAACTokenShare;   // Basis points
        uint256 raacCorpShare;   // Basis points
        uint256 otherShare;         // Basis points
    }

    struct CollectedFeeForType {
        uint256 treasuryAmount;
        uint256 repairFundAmount;
        uint256 burnAmount;
        uint256 veRAACTokenAmount;
        uint256 raacCorpAmount;
        uint256 otherAmount;
    }

    /**
     * @notice Token management functions
     */
    function addClaimableToken(address token) external;
    function removeClaimableToken(address token) external;
    function isTokenSupported(address token) external view returns (bool);

    /**
     * @notice Core fee management functions
     */
    function collectFee(address token, address target, uint256 amount, bytes32 feeType) external returns (bool);
    function claimCollectorRewards(address token, address target, bytes32 feeType) external returns (bool);
    function getCollectedFees(address token, bytes32 feeType) external view returns (CollectedFeeForType memory);

    /**
     * @notice Fee type management functions
     */
    function addFeeType(bytes32 feeType, uint256 treasuryShare, uint256 repairFundShare, uint256 burnShare, uint256 veRAACTokenShare, uint256 raacCorpShare, uint256 otherShare) external returns (bool);
    function updateFeeType(bytes32 feeType, FeeType memory newFee) external;
    function removeFeeType(bytes32 feeType) external;
    function getFeeType(bytes32 feeType) external view returns (FeeType memory);
    function getFeeTypes() external view returns (FeeType[] memory);

    /**
     * @notice Target address management functions
     */
    function getTargetAddress(bytes32 target) external view returns (address);
    function getTargetAmount(bytes32 feeType, bytes32 target, address token) external view returns (uint256);
    function setTargetAddress(bytes32 target, address newAddress) external;

    /**
     * @notice Target fee type management functions
     */
    function setTargetFeeType(address target, bytes32 feeType) external;
    function removeTargetFeeType(address target) external;

    /**
     * @notice Emergency functions
     */
    function emergencyWithdraw(address token, address recipient) external;
    function pause() external;
    function unpause() external;

    /**
     * @notice Fee distribution functions
     */
    function distributeFees(bytes32 feeType, bytes32 target, address token) external;

    /**
     * @notice Events
     */
    /**
     * @dev Emitted when fees are collected
     * @param token Address of the token collected
     * @param target Address of the target
     * @param feeType Type of fee collected
     * @param requestedAmount Amount of tokens requested to be collected
     * @param actualAmount Amount of tokens actually collected (if fee-on-transfer happened)
     */
    event FeeCollected(address indexed token, address indexed target, bytes32 indexed feeType, uint256 requestedAmount, uint256 actualAmount);

    /**
     * @dev Emitted when fees are distributed
     * @param feeType Type of fee distributed
     * @param target Target address
     * @param token Address of the token
     * @param amount Amount of tokens distributed
     */
    event FeeDistributed(bytes32 indexed feeType, bytes32 indexed target, address indexed token, uint256 amount);

    /**
     * @dev Emitted when a token is added to supported tokens
     * @param token Address of the added token
     */
    event TokenAdded(address indexed token);

    /**
     * @dev Emitted when a token is removed from supported tokens
     * @param token Address of the removed token
     */
    event TokenRemoved(address indexed token);

    /**
     * @dev Emitted when a fee type is added
     * @param feeType Type of the added fee
     */
    event FeeTypeAdded(bytes32 feeType);

    /**
     * @dev Emitted when a fee type is updated
     * @param feeType Type of the updated fee
     * @param newFee New fee type data
     */
    event FeeTypeUpdated(bytes32 indexed feeType, FeeType newFee);

    /**
     * @dev Emitted when a target address is updated
     * @param target Type of the updated target
     * @param newAddress New target address
     */
    event TargetAddressUpdated(bytes32 target, address indexed newAddress);

    /**
     * @dev Emitted when an emergency withdrawal occurs
     * @param token Address of the token withdrawn
     * @param amount Amount of tokens withdrawn
     */
    event EmergencyWithdrawal(address indexed token, uint256 amount);

    /**
     * @dev Emitted when a collector rewards are claimed
     * @param token Address of the token
     * @param target Address of the target
     * @param requestedAmount Amount of tokens requested to be claimed
     * @param actualAmount Amount of tokens actually claimed (if fee-on-transfer happened)
     */
    event CollectorRewardsClaimed(address indexed token, address indexed target, uint256 requestedAmount, uint256 actualAmount);

    /**
     * @dev Emitted when a collector underlying are claimed
     * @param token Address of the token
     * @param target Address of the target
     * @param requestedAmount Amount of tokens requested to be claimed
     * @param actualAmount Amount of tokens actually claimed (if fee-on-transfer happened)
     */
    event CollectorUnderlyingClaimed(address indexed token, address indexed target, uint256 requestedAmount, uint256 actualAmount);

    /**
     * @dev Emitted when a fee type is removed
     * @param feeType Type of the removed fee
     */
    event FeeTypeRemoved(bytes32 feeType);

    /**
     * @notice Custom errors
     */

    /**
     * @dev When fee type already exists
     */
    error FeeTypeAlreadyExists();

    /**
     * @dev When fee type does not exist
     */
    error FeeTypeDoesNotExist();
    
    /**
     * @dev When fee type is invalid
     */
    error InvalidFeeType();

    /**
     * @dev When fee amount is zero or exceeds maximum
     */
    error InvalidFeeAmount();
    error InvalidAddress();

    /**
     * @dev When amount exceeds allowed maximum
     */
    error ExcessiveAmount();

    /**
     * @dev When claiming is temporarily disabled
     */
    error ClaimingDisabled();

    /**
     * @dev When contract is paused for emergency
     */
    error EmergencyPaused();

    /**
     * @dev When distribution parameters are invalid
     */
    error InvalidDistributionParams();

    /**
     * @dev When total weight is zero
     */
    error ZeroTotalWeight();

    /**
     * @dev When division by zero occurs
     */
    error DivisionByZero();

    /**
     * @dev When token is already supported
     */
    error TokenAlreadySupported();

    /**
     * @dev When token is not supported
     */
    error TokenNotSupported();

    /**
     * @dev When insufficient balance
     */
    error InsufficientBalance();

    /**
     * @dev When distribution fails
     */
    error DistributionFailed();

    /**
     * @dev When claim collector rewards fails
     */
    error ClaimCollectorRewardsFailed();

    /**
     * @dev When address type is invalid
     */
    error InvalidAddressType();

    /**
     * @dev When claim collector underlying fails
     */
    error ClaimCollectorUnderlyingFailed();
    /**
     * @dev When target is already whitelisted
     */
    error TargetAlreadyWhitelisted();

    /**
     * @dev When target is not whitelisted
     */
    error TargetNotWhitelisted();

    /**
     * @dev When target fee type does not match
     */
    error TargetFeeTypeMismatch();

    /**
     * @dev Emitted when a target is whitelisted
     * @param target Address of the whitelisted target
     */
    event TargetWhitelisted(address indexed target);

    /**
     * @dev Emitted when a target is removed from whitelist
     * @param target Address of the removed target
     */
    event TargetRemovedFromWhitelist(address indexed target);

    /**
     * @dev Emitted when a target fee type is set
     * @param target Address of the target
     * @param feeType Type of the fee
     */
    event TargetFeeTypeSet(address indexed target, bytes32 feeType);

    /**
     * @dev Emitted when a target fee type is removed
     * @param target Address of the target
     */
    event TargetFeeTypeRemoved(address indexed target);

    /**
     * @dev Emitted when a token is invalid
     * @param requiredToken Address of the required token
     * @param actualToken Address of the actual token
     */
    error InvalidToken(address requiredToken, address actualToken);
}