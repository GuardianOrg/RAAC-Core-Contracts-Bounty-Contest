// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title ITokenBlender
 * @notice Interface for the TokenBlender contract
 */
interface ITokenBlender {
    function deposit(address token, uint256 amount, uint256 minAmountOut) external;
    function previewDeposit(address token, uint256 amount) external view returns (uint256);
    function withdraw(address token, uint256 amountOut, uint256 maxAmountBurned) external;
    function previewWithdraw(address token, uint256 amountOut) external view returns (uint256);
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external;
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function emergencyWithdraw(address token, uint256 amount, bool forceRemove) external;
    function getTokenRatio(address token) external view returns (uint256);
    function updateTokenRatio(address token, uint256 newRatio) external;
    function addSupportedToken(address token, uint256 ratio) external;
    function removeSupportedToken(address token) external;
    function getReserveBalance() external view returns (uint256);
    function getTokenReserveBalance(address token) external view returns (uint256);
    function getSupportedTokenCount() external view returns (uint256);
    function getSupportedTokens() external view returns (address[] memory);
    function pause() external;
    function unpause() external;


    error InvalidAddress();
    error ZeroAmount();
    error TokenNotSupported();
    error TokenAlreadySupported();
    error InvalidRatio();
    error InsufficientAmountOut();
    error SlippageExceeded();
    error InvalidDecimals();
    error InvalidToken();
    error TokenHasBalance();
    event TokenDeposited(address indexed token, uint256 amount, uint256 amountOut);
    event TokenWithdrawn(address indexed token, uint256 amountOut, uint256 amountBurned);
    event TokenAdded(address indexed token, uint256 ratio);
    event TokenRemoved(address indexed token);
    event TokenRatioUpdated(address indexed token, uint256 newRatio);
    event EmergencyWithdrawn(address indexed token, uint256 amount);
    event TokenSwapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
}

/**
 /**
 * @title TokenBlender – Transitional wrapper for discounted ION → audited Instruxi token
 * @notice The contract accepts multiple tokens and blends them into a single token.
 * @dev The contract uses token ratios based on a global token (such as Instruxi share token where 1 token is worth 1 XAU)
 * @dev The system is designed to run in a centralized, admin-controlled manner. Suggested to have it behind a multi-sig contract.
 * @dev Supports 18 decimals tokens only.
 * @dev Any dust produced by the contract rounding will benefit the contract than the user. It can be taken out using the emergencyWithdraw function.
  */

contract TokenBlender is ITokenBlender, Initializable, AccessControlUpgradeable, ERC20Upgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice Admin role - can update parameters
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Manager role - can manage deposit/withdraw/swap
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    /// @notice Emergency role - can perform emergency withdrawals
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /// @notice Ratio at which each token is blended
    /// @dev if a token has a ratio of 5 (5 * RATIO_PRECISION), then 1 TokenBlender token is worth 5 of the token
    /// @dev If a token is not supported, the ratio is 0
    mapping(address => uint256) public ratios;
    /// @notice list of supported tokens
    address[] public supportedTokens;
    /// @notice ration decimal precision
    uint256 public constant RATIO_PRECISION = 10 ** 18; // 18 decimals

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the TokenBlender contract
     * @param name The name of the token
     * @param symbol The symbol of the token
     * @param initialOwner The address that will be granted all roles (DEFAULT_ADMIN_ROLE, MANAGER_ROLE, EMERGENCY_ROLE)
     */
    function initialize(string memory name, string memory symbol, address initialOwner) public initializer {
        if (initialOwner == address(0)) revert InvalidAddress();
        
        __AccessControl_init();
        __ERC20_init(name, symbol);
        __Pausable_init();
        __ReentrancyGuard_init();

        // Grant all roles to initialOwner
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(ADMIN_ROLE, initialOwner);
        _grantRole(MANAGER_ROLE, initialOwner);
        _grantRole(EMERGENCY_ROLE, initialOwner);
    }

    /**
     * @notice Deposits tokens into the TokenBlender
     * @param token The address of the token to deposit
     * @param amount The amount of tokens to deposit
     * @param minAmountOut The minimum amount of tokens to receive
     * @dev To reduce rounding dust, it is ideal for the amountOut to be `amount % ratio == 0`
     */
    function deposit(address token, uint256 amount, uint256 minAmountOut) external override nonReentrant whenNotPaused onlyRole(MANAGER_ROLE) {
        uint256 amountOut = previewDeposit(token, amount);
        if (amountOut == 0) revert ZeroAmount();
        if (amountOut < minAmountOut) revert InsufficientAmountOut();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amountOut);
        emit TokenDeposited(token, amount, amountOut);
    }
    /**
     * @notice Previews the amount of tokens that will be minted for a given amount of tokens
     * @param token The address of the token to preview
     * @param amount The amount of tokens to preview
     * @return The amount of tokens that will be minted
     */
    function previewDeposit(address token, uint256 amount) public view returns (uint256) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        if (amount == 0) revert ZeroAmount();

        return amount * RATIO_PRECISION / ratios[token]; // round down
    }

    /**
     * @notice Withdraws tokens from the TokenBlender
     * @param token The address of the token to withdraw
     * @param amountOut The amount of tokens to withdraw
     * @param maxAmountBurned The maximum amount of tokens that can be burned
     * @dev To reduce rounding dust, it is ideal for the amountOut to be `amount % ratio == 0`
     */
    function withdraw(address token, uint256 amountOut, uint256 maxAmountBurned) external override nonReentrant whenNotPaused onlyRole(MANAGER_ROLE) {
        uint256 amountBurned = previewWithdraw(token, amountOut);
        if (amountBurned > maxAmountBurned) revert SlippageExceeded();
        _burn(msg.sender, amountBurned);
        IERC20(token).safeTransfer(msg.sender, amountOut);
        emit TokenWithdrawn(token, amountOut, amountBurned);
    }
    /**
     * @notice Previews the amount of TokenBlender tokens that will be burned to withdraw a given amount of underlying tokens.
     * @param token The address of the token to preview
     * @param amountOut The amount of tokens to preview
     * @return amountBurned The amount of tokens that will be burned
     */
    function previewWithdraw(address token, uint256 amountOut) public view returns (uint256 amountBurned) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        if (amountOut == 0) revert ZeroAmount();
        amountBurned = (amountOut * RATIO_PRECISION + ratios[token] - 1) / ratios[token]; // round up to avoid burning less than expected
        if (amountBurned == 0) revert ZeroAmount();
    }

    /**
     * @notice Swaps tokens based on the ratio
     * @param tokenIn The address of the token to swap
     * @param tokenOut The address of the token to swap
     * @param amountIn The amount of tokens to swap
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external override nonReentrant whenNotPaused onlyRole(MANAGER_ROLE) {
        uint256 amountOut = previewSwap(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert InsufficientAmountOut();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        emit TokenSwapped(tokenIn, tokenOut, amountIn, amountOut);
    }
    /**
     * @notice Previews the amount of tokens that will be swapped for a given amount of tokens
     * @param tokenIn The address of the token to swap
     * @param tokenOut The address of the token to swap
     * @param amountIn The amount of tokens to swap
     * @return amountOut The amount of tokens that will be swapped
     * @dev To reduce rounding dust, it is ideal for the amountOut to be `amountIn % ratio == 0`
     */
    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert InvalidAddress();
        if (tokenIn == tokenOut) revert InvalidToken();
        if (ratios[tokenIn] == 0) revert TokenNotSupported();
        if (ratios[tokenOut] == 0) revert TokenNotSupported();
        if (amountIn == 0) revert ZeroAmount();
        amountOut = amountIn * ratios[tokenOut] / ratios[tokenIn]; // round down
        if (amountOut == 0) revert ZeroAmount();
    }

    /**
     * @notice Emergency withdraws of tokens from the TokenBlender
     * @param token The address of the token to withdraw
     * @param amount The amount of tokens to withdraw
     * @param forceRemove Whether to force remove the token after withdraw
     * @dev To mitigate any 1 wei deposit which would prevent token removal after withdraw of dust, it is possible to force remove the token after withdraw.
     */
    function emergencyWithdraw(address token, uint256 amount, bool forceRemove) external override nonReentrant onlyRole(EMERGENCY_ROLE) {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(msg.sender, amount);
        if (forceRemove) _removeSupportedToken(token);
        emit EmergencyWithdrawn(token, amount);
    }

    /**
     * @notice Gets the ratio of a given token
     * @param token The address of the token to get the ratio
     * @return The ratio of the token
     */
    function getTokenRatio(address token) public view override returns (uint256) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        return ratios[token];
    }

    /**
     * @notice Updates the ratio of a given token
     * @param token The address of the token to update
     * @param newRatio The new ratio of the token
     * @dev The new ratio must be smaller than the current ratio. That would mean that the asset has increased in value. 
     * @dev Any excess of reserve can be taken out using the emergencyWithdraw function, to bring the reserve balance = total supply.
     */
    function updateTokenRatio(address token, uint256 newRatio) external override nonReentrant onlyRole(ADMIN_ROLE) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        if (newRatio < RATIO_PRECISION || newRatio >= ratios[token]) revert InvalidRatio();
        ratios[token] = newRatio;
        emit TokenRatioUpdated(token, newRatio);
    }

    /**
     * @notice Adds a supported token to the TokenBlender
     * @param token The address of the token to add
     */
    function addSupportedToken(address token, uint256 ratio) external override nonReentrant onlyRole(ADMIN_ROLE) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] != 0) revert TokenAlreadySupported();
        // no ratio is less than 1 (meaning it is worth more than 1 TokenBlender token)
        if (ratio < RATIO_PRECISION) revert InvalidRatio();
        if (IERC20Metadata(token).decimals() != 18) revert InvalidDecimals();
        ratios[token] = ratio;
        supportedTokens.push(token);
        emit TokenAdded(token, ratio);
    }
    /**
     * @notice Removes a supported token from the TokenBlender
     * @param token The address of the token to remove
     * @dev The token must have no balance in the contract. It must be fully swapped out or withdrawn.
     * @dev For forced removal with dust remaining, use emergencyWithdraw with forceRemove=true.
     */
    function removeSupportedToken(address token) external override nonReentrant onlyRole(ADMIN_ROLE) {
        if (IERC20(token).balanceOf(address(this)) > 0) revert TokenHasBalance();
        _removeSupportedToken(token);
    }

    /**
     * @notice Removes a supported token from the TokenBlender
     * @param token The address of the token to remove
     * @dev Internal function to remove a supported token from the TokenBlender
     * @dev Note: Balance check is intentionally omitted here to allow forced removal via emergencyWithdraw.
     * Any dust remaining will stay in the contract.
     */
    function _removeSupportedToken(address token) internal {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        delete ratios[token];
        for (uint256 i = 0; i < supportedTokens.length; i++) {
            if (supportedTokens[i] == token) {
                supportedTokens[i] = supportedTokens[supportedTokens.length - 1];
                supportedTokens.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    /**
     * @notice Gets the list of supported tokens
     * @return The list of supported tokens
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    /**
     * @notice Gets the number of supported tokens
     * @return The number of supported tokens
     */
    function getSupportedTokenCount() external view returns (uint256) {
        return supportedTokens.length;
    }

    /**
    /**
     * @notice Returns the total reserve balance, normalized to the TokenBlender aggregate precision.
     * @dev Sums all supported tokens' balances, converting each to the common TokenBlender value using its ratio.
     * This value can be compared to the total TB token supply. It is expected to be equal to or greater than the total supply (due to rounding or residual balances).
     * @return totalBalance The aggregate reserve balance denominated in TokenBlender units.
     */
    function getReserveBalance() external view returns (uint256 totalBalance) {
        for (uint256 i = 0; i < supportedTokens.length; i++) {
            totalBalance += IERC20(supportedTokens[i]).balanceOf(address(this)) * RATIO_PRECISION / ratios[supportedTokens[i]];
        }
    }

    /**
     /**
      * @notice Returns the worth of a specific token's balance in the reserve, converted to the equivalent value in TB tokens using its ratio.
      * @param token The address of the token to query.
      * @return The token's reserve balance represented in terms of TB token value.
      */
    function getTokenReserveBalance(address token) external view returns (uint256) {
        if (token == address(0)) revert InvalidAddress();
        if (ratios[token] == 0) revert TokenNotSupported();
        return IERC20(token).balanceOf(address(this)) * RATIO_PRECISION / ratios[token];
    }

    /**
     * @notice Pauses the contract
     * @dev Only callable by the admin
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract
     * @dev Only callable by the admin
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}