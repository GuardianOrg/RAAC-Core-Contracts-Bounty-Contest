// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../primitives/WithCompliance.sol";
import "../../interfaces/core/pools/StabilityPool/IStabilityPool.sol";
import "../../interfaces/core/tokens/IDEToken.sol";

import "../../libraries/math/WadRayMath.sol";

/**
 * @title DEToken
 * @notice Implementation of the Debitum Emptor token for the RAAC Stability Pool.
 *         Users receive DEToken when they deposit RTokens into the Stability Pool.
 *         DEToken is redeemable 1:1 with RToken.
 * @dev This contract inherits from ERC20, ERC20Permit, IDEToken, and Ownable.
 */
contract DEToken is ERC20, ERC20Permit, IDEToken, Ownable, WithCompliance {
    using WadRayMath for uint256;
    using SafeERC20 for IERC20;

    /// @notice Address of the Stability Pool contract
    address public stabilityPool;

    /// @notice Address of the RToken contract
    address public rTokenAddress;

    mapping(address => uint256) private _userDeposits;

   // Track raw total deposited amount (not including interest)
    uint256 private _rawTotalDeposits;

    mapping(address => uint256) private _userIndexes;

    // Destination addresses that are not subject to same block check (e.g. Stability pool)
    mapping(address => bool) private _sameBlockExempt;

    /**
     * @notice Modifier to restrict function access to only the Stability Pool
     */
    modifier onlyStabilityPool() {
        if (msg.sender != stabilityPool) revert OnlyStabilityPool();
        _;
    }

    /**
     * @notice Constructs the DEToken contract
     * @param name The name of the token
     * @param symbol The symbol of the token
     * @param initialOwner The address of the initial owner of the contract
     * @param _rTokenAddress The address of the RToken contract
     */
    constructor(
        string memory name,
        string memory symbol,
        address initialOwner,
        address _rTokenAddress,
        address _complianceRegistry
    ) ERC20(name, symbol) ERC20Permit(name) Ownable(initialOwner) WithCompliance(_complianceRegistry) {
        if (_rTokenAddress == address(0)) revert InvalidAddress();
        rTokenAddress = _rTokenAddress;
    }

    /**
     * @notice Sets the address of the Stability Pool
     * @param newStabilityPool The new Stability Pool address
     * @dev Can only be called by the contract owner
     */
    function setStabilityPool(address newStabilityPool) external onlyOwner {
        if (newStabilityPool == address(0)) revert InvalidAddress();
        address oldStabilityPool = stabilityPool;
        stabilityPool = newStabilityPool;
        emit StabilityPoolUpdated(oldStabilityPool, newStabilityPool);
    }

    /**
     * @notice Returns the user deposit
     * @param user The address of the user
     * @return The user deposit
     */
    function getUserDeposit(address user) external view returns (uint256) {
        return _userDeposits[user];
    }

    /**
     * @notice Sets the user index
     * @param user The address of the user
     * @param index The user index
     * @dev Can only be called by the Stability Pool
     */
    function setUserIndex(address user, uint256 index) external onlyStabilityPool {
        _userIndexes[user] = index;
    }

    /**
     * @notice Returns the user index
     * @param user The address of the user
     * @return The user index
     */
    function getUserIndex(address user) external view returns (uint256) {
        return _userIndexes[user];
    }

    /**
     * @notice Returns the scaled total supply of the token
     * @return The scaled total supply
     */
    function getRawTotalDeposits() external view returns (uint256) {
        return _rawTotalDeposits;
    }
    

    /**
     * @notice Mints new DETokens
     * @param to The address to receive the minted tokens
     * @param amount The amount of tokens to mint
     * @dev Can only be called by the Stability Pool
     */
    function mint(address to, uint256 amount) external override onlyStabilityPool {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 currentPoolIndex = IStabilityPool(stabilityPool).getPoolIndex();
        _rawTotalDeposits += amount.rayDiv(currentPoolIndex);

        _mint(to, amount);
        
        emit Mint(to, amount);
    }

    /**
     * @notice Burns DETokens
     * @param from The address from which to burn tokens
     * @param amount The amount of tokens to burn
     * @dev Can only be called by the Stability Pool
     */
    function burn(address from, uint256 amount) external override onlyStabilityPool {
        if (from == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        
        uint256 currentPoolIndex = IStabilityPool(stabilityPool).getPoolIndex();
        uint256 amountScaled = amount.rayDiv(currentPoolIndex);
        if(amountScaled > _rawTotalDeposits) {
            _rawTotalDeposits = 0;
        } else {
            _rawTotalDeposits -= amountScaled;
        }

        _burn(from, amount);
        
        emit Burn(from, amount);
    }

    /**
     * @notice Transfers RTokens to a user
     * @param user The address of the user to receive RTokens
     * @param amount The amount of RTokens to transfer
     * @dev Can only be called by the Stability Pool
     */
    function transferAsset(address user, uint256 amount) external onlyStabilityPool {
        IERC20(rTokenAddress).safeTransfer(user, amount);
    }

    /**
     * @notice Returns the raw balance of an account
     * @param account The address of the account
     * @return The raw balance
     */
    function rawBalanceOf(address account) public view returns (uint256) {
        return super.balanceOf(account);
    }

    /**
     * @notice Returns the raw total supply of the token
     * @return The raw total supply
     */
    function rawTotalSupply() public view returns (uint256) {
        return super.totalSupply();
    }

    /**
     * @notice Returns the total supply of the token
     * @return The total supply
     */
    function totalSupply() public view override(ERC20, IERC20) returns (uint256) {
        if(stabilityPool == address(0)) return super.totalSupply();
        uint256 currentIndex = IStabilityPool(stabilityPool).getPoolIndex();
        
        uint256 supplyWithInterest = _rawTotalDeposits.rayMul(currentIndex);
        return supplyWithInterest;
    }

    /**
     * @notice Returns the balance of an account
     * @param account The address of the account
     * @return The balance
     */
    function balanceOf(address account) public view override(ERC20, IERC20) returns (uint256) {
        if(account == address(0)) return super.balanceOf(account);
        return IStabilityPool(stabilityPool).getScaledDeposit(account);
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
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals.
     */
    function decimals() public view virtual override(ERC20, IDEToken) returns (uint8) {
        return IERC20Metadata(rTokenAddress).decimals();
    }

    /**
     * @notice Calculates and mints accrued interest for a user
     * @param user The address of the user
     * @param currentPoolIndex The current pool index
     */
    function _mintUserInterest(address user, uint256 currentPoolIndex) internal {
        uint256 userIndex = _userIndexes[user];
        uint256 userDeposit = _userDeposits[user];
        
        // user has no deposit, just update index
        // for first interaction ever (deposit is zero), set index to current
        if (userDeposit == 0) {
            _userIndexes[user] = currentPoolIndex;
            return;
        }
        
        // If same index, no interest to mint cut early
        if (userIndex >= currentPoolIndex) {
            return;
        }

        // raw * (usageIndex / positionIndex)
        uint256 indexMultiplier = currentPoolIndex.rayDiv(userIndex);
        uint256 scaledBalance = userDeposit.rayMulDown(indexMultiplier);
        // Set index to current
        _userIndexes[user] = currentPoolIndex;
        
        // Calculate the interest amount as the difference
        if (scaledBalance > userDeposit) {
            uint256 interestAmount = scaledBalance - userDeposit;
            
            if (interestAmount > 0) {
                _mint(user, interestAmount);
                emit MintInterest(user, interestAmount);
            }
        }
    }

    /**
     * @notice Updates the user deposit and call for interest minting - override of ERC20._update
     * @param from The address to transfer tokens from
     * @param to The address to transfer tokens to
     * @param amount The amount of tokens to transfer
     * @dev If `to` is marked exempt, the same-block restriction is not applied.
     * @dev Only the `to` side is checked, not the `from` side.
     */
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            if (complianceRegistry.isBlacklisted(from) || complianceRegistry.isBlacklisted(to)) {
                revert IComplianceRegistry.BlacklistedAddress();
            }
        }
        
        if (IStabilityPool(stabilityPool).isUserDepositInSameBlock(from) && !_sameBlockExempt[to]) revert CannotDepositAndTransferInSameBlock();

        uint256 currentPoolIndex = IStabilityPool(stabilityPool).getPoolIndex();

        bool isMinting = from == address(0);
        bool isBurning = to == address(0);

        // Mint interest for sender (if not minting - even if it's self-transfer)
        if(!isMinting) {
            _mintUserInterest(from, currentPoolIndex);

            if(amount > _userDeposits[from]) {
                _userDeposits[from] = 0;
            } else {
                _userDeposits[from] -= amount;
            }
        }
        
        // If transfer to someone else, mint interest (or create user index if it's new user)
        if(!isBurning) {
            _mintUserInterest(to, currentPoolIndex);
            _userDeposits[to] += amount;
        }

     
        super._update(from, to, amount);
    }
}
