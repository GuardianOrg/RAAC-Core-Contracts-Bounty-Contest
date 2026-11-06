// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../libraries/math/WadRayMath.sol";

import "../../interfaces/core/pools/LendingPool/ILendingPool.sol";
import "../../interfaces/core/tokens/IRToken.sol";
import "../primitives/WithCompliance.sol";

/**
 * @title RToken
 * @notice Implementation of the interest-bearing token for the RAAC lending protocol.
 *         Users receive RToken when they deposit assets into the Reserve Pool.
 *         RToken balances increase over time due to interest accrual, represented by the liquidity index.
 * @dev This contract aligns with Aave's AToken implementation, scaling balances by the liquidity index.
 */
contract RToken is ERC20, ERC20Permit, IRToken, Ownable, WithCompliance {
    using WadRayMath for uint256;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // Address of the Lending Pool contract
    address private _lendingPool;

    // Address of the reserve asset (e.g., crvUSD)
    address public _assetAddress;

    // Track raw total deposited amount (not including interest)
    uint256 private _rawTotalDeposits;

    // Destination addresses that are not subject to same block check (e.g. Stability pool)
    mapping(address => bool) private _sameBlockExempt;

    struct UserState {
        uint128 index;
    }

    mapping(address => UserState) private _userState;
 

    // MODIFIERS

    /**
     * @dev Ensures that only the Reserve Pool can call the function
     */
    modifier onlyLendingPool() {
        if (msg.sender != _lendingPool) revert OnlyLendingPool();
        _;
    }

    // CONSTRUCTOR

    /**
     * @dev Initializes the RToken contract with the given parameters
     * @param name The name of the token
     * @param symbol The symbol of the token
     * @param initialOwner The address of the initial owner
     * @param assetAddress The address of the underlying asset
     */
    constructor(
        string memory name,
        string memory symbol,
        address initialOwner,
        address assetAddress,
        address complianceRegistry
    ) ERC20(name, symbol) ERC20Permit(name) Ownable(initialOwner) WithCompliance(complianceRegistry) {
        if (initialOwner == address(0) || assetAddress == address(0)) revert InvalidAddress();
        _assetAddress = assetAddress;
    }

    // EXTERNAL FUNCTIONS

    /**
     * @notice Sets the Lending Pool address
     * @param newLendingPool The address of the Lending Pool
     */
    function setLendingPool(address newLendingPool) external onlyOwner {
        if (newLendingPool == address(0)) revert InvalidAddress();
        address oldLendingPool = _lendingPool;
        _lendingPool = newLendingPool;
        emit LendingPoolUpdated(oldLendingPool, newLendingPool);
    }

    /**
     * @notice Mints RToken to a user
     * @param caller The address initiating the mint
     * @param onBehalfOf The recipient of the minted tokens
     * @param amount The amount of tokens to mint (in underlying asset units)
     * @param index The liquidity index at the time of minting
     * @return A tuple containing:
     *         - uint256: The amount of tokens minted
     *         - uint256: The new total supply after minting
     *         - uint256: The amount of underlying tokens minted
     */
    function mint(
        address caller,
        address onBehalfOf,
        uint256 amount,
        uint256 index
    ) external override onlyLendingPool returns (uint256, uint256, uint256) {
         if (caller == address(0) || onBehalfOf == address(0)) revert InvalidAddress();
        if (amount == 0) {
            return (0, totalSupply(), 0);
        }

        // Will update user index
        uint256 userIncrease = _mintUserInterest(onBehalfOf, index);

        _rawTotalDeposits += amount.rayDiv(index);

        _mint(onBehalfOf, amount.toUint128());

        emit Mint(caller, onBehalfOf, amount + userIncrease, index);

        return (amount, totalSupply(), amount);
    }

    /**
     * @notice Burns RToken from a user and transfers underlying asset
     * @param from The address from which tokens are burned
     * @param receiverOfUnderlying The address receiving the underlying asset
     * @param amount The amount to burn (in underlying asset units)
     * @param index The liquidity index at the time of burning
     * @return A tuple containing:
     *         - uint256: The amount of scaled tokens burned
     *         - uint256: The new total supply after burning
     *         - uint256: The amount of underlying asset transferred
     */
    function burn(
        address from,
        address receiverOfUnderlying,
        uint256 amount,
        uint256 index
    ) external override onlyLendingPool returns (uint256, uint256, uint256) {
        if (from == address(0) || receiverOfUnderlying == address(0)) revert InvalidAddress();
        if (amount == 0) {
            return (0, totalSupply(), 0);
        }

        _mintUserInterest(from, index);

        uint256 rawAmount = amount.rayDiv(index);
        if(rawAmount > _rawTotalDeposits) {
            _rawTotalDeposits = 0;
        } else {
            _rawTotalDeposits -= rawAmount;
        }

        _burn(from, amount.toUint128());


        if (receiverOfUnderlying != address(this)) {
            IERC20(_assetAddress).safeTransfer(receiverOfUnderlying, amount);
        }

        emit Burn(from, receiverOfUnderlying, amount, index);

        return (amount, totalSupply(), amount);
    }
    
    // VIEW FUNCTIONS

    /**
     * @notice Returns the scaled balance of the user
     * @param account The address of the user
     * @return The user's balance (scaled by the liquidity index)
     */
    function balanceOf(address account) public view override(ERC20, IERC20) returns (uint256) {
        uint256 rawBalance = super.balanceOf(account);
        uint256 liquidityIndex = ILendingPool(_lendingPool).getNormalizedIncome();

        // No balance, return raw balance 
        if (_userState[account].index == 0 || rawBalance == 0) {
            return rawBalance;
        }

        // raw * (usageIndex / positionIndex)
        uint256 indexMultiplier = liquidityIndex.rayDiv(_userState[account].index);
        return rawBalance.rayMulDown(indexMultiplier);
    }

    /**
     * @notice Returns the scaled total supply
     * @return The total supply (scaled by the liquidity index)
     * @dev We normalize the raw deposit amount by the current liquidity index
     *      to get the correct total supply including accrued interest
     */
    function totalSupply() public view override(ERC20, IERC20) returns (uint256) {
        return _rawTotalDeposits.rayMul(ILendingPool(_lendingPool).getNormalizedIncome());
    }

    /**
     * @dev Overrides the ERC20 transfer function to use scaled amounts
     * @param recipient The recipient address
     * @param amount The amount to transfer (in underlying asset units)
     */
    function transfer(address recipient, uint256 amount) public override(ERC20, IERC20) returns (bool) {
        return super.transfer(recipient, amount);
    }

    /**
     * @dev Overrides the ERC20 transferFrom function to use scaled amounts
     * @param sender The sender address
     * @param recipient The recipient address
     * @param amount The amount to transfer (in underlying asset units)
     */
    function transferFrom(address sender, address recipient, uint256 amount) public override(ERC20, IERC20) returns (bool) {
        return super.transferFrom(sender, recipient, amount);
    }

    /**
     * @notice Returns the Lending Pool address
     * @return The Lending Pool address
     */
    function getLendingPool() external view returns (address) { 
        return _lendingPool;
    }

    /**
     * @notice Returns the non-scaled balance of the user
     * @param user The address of the user
     * @return The user's non-scaled balance
     */
    function rawBalanceOf(address user) external view returns (uint256) {
        return super.balanceOf(user);
    }

    /**
     * @notice Returns the non-scaled total supply
     * @return The non-scaled total supply
     */
    function rawTotalSupply() external view returns (uint256) {
        return super.totalSupply();
    }
    
    /**
     * @notice Returns the raw total deposits (not including interest)
     * @return The raw total deposits
     */
    function getRawTotalDeposits() external view returns (uint256) {
        return _rawTotalDeposits;
    }

    /**
     * @notice Returns the asset address
     * @return The asset address
     */
    function getAssetAddress() external view returns (address) {
        return _assetAddress;
    }

    /**
     * @notice Check whether the address is same block exempt
     * @param user Address of the user
     * @return Whether exempt or not
     */
    function isSameBlockExempt(address user) external view returns (bool) {
        return _sameBlockExempt[user];
    }

    /**
     * @notice Update the same block exempt destination
     * @param user Address of the user
     * @param value Whether set or not
     */
    function setSameBlockExempt(address user, bool value) external onlyOwner {
        if (user == address(0)) revert InvalidAddress();
        _sameBlockExempt[user] = value;
        emit SameBlockExemptUpdated(user, value);
    }

    /**
     * @notice Transfers the underlying asset to the specified user
     * @param user The address of the user to receive the asset
     * @param amount The amount of the asset to transfer
     */
    function transferAsset(address user, uint256 amount) external override onlyLendingPool {
        IERC20(_assetAddress).safeTransfer(user, amount);
    }

     /**
     * @notice Calculates and mints accrued interest for a user
     * @param user The address of the user
     * @param currentPoolIndex The current pool index
     */
    function _mintUserInterest(address user, uint256 currentPoolIndex) internal returns (uint256 userIncrease) {
        uint256 userBalance = super.balanceOf(user);
        
        // If user has no balance, just update index
        // Will also be called for first interaction ever (deposit would be zero)
        if (userBalance == 0) {
            _userState[user].index = currentPoolIndex.toUint128();
            return 0;
        }
        // raw * (usageIndex / positionIndex)
        uint256 indexMultiplier = currentPoolIndex.rayDiv(_userState[user].index);
        uint256 scaledBalance = userBalance.rayMulDown(indexMultiplier);
        
        // Update user index for sender to current liquidity index to prevent interest exploitation
        _userState[user].index = currentPoolIndex.toUint128();

        // If scaled balance is greater than user balance, mint the difference
        if (scaledBalance > userBalance) {
            userIncrease = scaledBalance - userBalance;
            _mint(user, userIncrease);
        }
    }

    /**
     * @dev Internal function to handle token transfers, mints, and burns
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount of tokens
     * @dev If `to` is marked exempt, the same-block restriction is not applied.
     * @dev Only the `to` side is checked, not the `from` side.
     */
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            if (complianceRegistry.isBlacklisted(from) || complianceRegistry.isBlacklisted(to)) {
                revert IComplianceRegistry.BlacklistedAddress();
            }
        }
        
        if (ILendingPool(_lendingPool).isUserDepositInSameBlock(from) && !_sameBlockExempt[to]) revert CannotDepositAndTransferInSameBlock();
        uint256 currentLiquidityIndex = ILendingPool(_lendingPool).getNormalizedIncome();
        
        bool isMinting = from == address(0);
        bool isBurning = to == address(0);


        if(!isMinting) {
            _mintUserInterest(from, currentLiquidityIndex);
        }

        if(!isBurning) {
            _mintUserInterest(to, currentLiquidityIndex);
        }
        
        super._update(from, to, amount);
    }

    /**
     * @notice Calculate the dust amount in the contract
     * @return The amount of dust in the contract
     */
    function calculateDustAmount() public view returns (uint256) {
        // Get the actual balance of the underlying asset held by this contract
        uint256 contractBalance = IERC20(_assetAddress).balanceOf(address(this));

        // Get the total supply (already normalized)
        uint256 currentTotalSupply = totalSupply();

        // Compare direct values without additional normalization
        return contractBalance <= currentTotalSupply ? 0 : contractBalance - currentTotalSupply;
    }

    /**
     * @notice Rescue tokens mistakenly sent to this contract
     * @dev Cannot rescue the main asset.
     * @param tokenAddress The address of the ERC20 token
     * @param recipient The address to send the rescued tokens to
     * @param amount The amount of tokens to rescue
     */
    function rescueToken(address tokenAddress, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        if (tokenAddress == _assetAddress) revert CannotRescueMainAsset();
        IERC20(tokenAddress).safeTransfer(recipient, amount);
    }

    /**
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals.
     */
    function decimals() public view virtual override(ERC20, IRToken) returns (uint8) {
        return IERC20Metadata(_assetAddress).decimals();
    }

    /**
     * @notice Returns the user index for a user.
     * @param user Address of the user.
     * @return User index.
     */ 
    function getUserIndex(address user) external view returns (uint128){
        return _userState[user].index;
    }
}
