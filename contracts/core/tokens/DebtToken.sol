// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../libraries/math/WadRayMath.sol";
import "../../interfaces/core/tokens/IDebtToken.sol";
import "../../interfaces/core/pools/LendingPool/ILendingPool.sol";

/**
 * @title DebtToken
 * @notice Implementation of the debt token for the RAAC lending protocol.
 *         Users accumulate debt over time due to interest accrual, represented by the usage index.
 * @dev This contract aligns with Aave's VariableDebtToken implementation, scaling balances by the usage index.
 */
contract DebtToken is ERC20, IDebtToken, Ownable {
    using WadRayMath for uint256;
    using SafeCast for uint256;

    // Address of the lending Pool contract
    address private _lendingPool;

    // Address of the reserve asset (e.g., crvUSD)
    address public _assetAddress;
    
    // Track raw total borrowed amount (not including interest)
    uint256 private _rawTotalBorrows;

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
     * @dev Initializes the DebtToken contract with the given parameters
     * @param name The name of the token
     * @param symbol The symbol of the token
     */
   
    constructor(string memory name, string memory symbol, address initialOwner, address reserveAsset) ERC20(name, symbol) Ownable(initialOwner) {
        if (initialOwner == address(0) || reserveAsset == address(0)) revert InvalidAddress();
        _assetAddress = reserveAsset;
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
     * @notice Returns the raw total borrows (not including interest)
     * @return The raw total borrows
     */
    function getRawTotalBorrows() external view returns (uint256) {
        return _rawTotalBorrows;
    }
    // EXTERNAL FUNCTIONS

    /**
     * @notice Sets the Reserve Pool address
     * @param newLendingPool The address of the Reserve Pool
     */
    function setLendingPool(address newLendingPool) external onlyOwner {
        if (newLendingPool == address(0)) revert InvalidAddress();
        address oldLendingPool = _lendingPool;
        _lendingPool = newLendingPool;
        emit LendingPoolUpdated(oldLendingPool, newLendingPool);
    }


    /**
     * @notice Mints debt tokens to a user
     * @param caller The address initiating the mint
     * @param onBehalfOf The recipient of the debt tokens
     * @param amount The amount to mint (in underlying asset units)
     * @param poolUsageIndex The usage index at the time of minting
     * @param asset Byte encoded (adapter, data)
     * @return A tuple containing:
     *         - bool: True if the previous balance was zero
     *         - uint256: The amount of underlying tokens minted
     *         - uint256: The amount of interest minted
     *         - uint256: The new total supply after minting
     */
    function mint(
        address caller,
        address onBehalfOf,
        uint256 amount,
        uint256 poolUsageIndex,
        bytes calldata asset
    )  external onlyLendingPool returns (bool, uint256, uint256, uint256) {
        (address adapter, bytes memory data) = abi.decode(asset, (address, bytes));
        if (caller == address(0) || onBehalfOf == address(0) || adapter == address(0)) revert InvalidAddress();
        
        (uint256 positionIndex, ) = ILendingPool(_lendingPool).getPositionData(adapter, onBehalfOf, data);
        uint256 initialBalance = this.balanceOf(onBehalfOf);

        if (amount == 0) {
            return (initialBalance == 0, 0, 0, totalSupply());
        }
        // Update raw total borrows with only the new borrow amount (not the interest)
        uint256 userIncrease = _mintUserInterest(onBehalfOf, ILendingPool(_lendingPool).getPositionDebt(adapter, onBehalfOf, data), ILendingPool(_lendingPool).getPositionScaledDebt(adapter, onBehalfOf, data));
        _mint(onBehalfOf, amount.toUint128());
        
        _rawTotalBorrows += amount.rayDiv(
            ILendingPool(_lendingPool).getNormalizedDebt()
        );


        emit Mint(caller, onBehalfOf, amount, amount + userIncrease, poolUsageIndex, positionIndex);

        return (initialBalance == 0, amount, userIncrease, totalSupply());
    }

   /**
     * @notice Burns debt tokens from a user
     * @param from The address from which tokens are burned
     * @param amount The scaled amount to burn (in underlying asset units)
     * @param index The usage index at the time of burning
     * @param asset Byte encoded (adapter, data)
     * @return A tuple containing:
     *         - uint256: The amount of scaled tokens burned
     *         - uint256: The new total supply after burning
     *         - uint256: The amount of underlying tokens burned
     *         - uint256: The balance increase due to interest
     */
    function burn(
        address from,
        uint256 amount,
        uint256 index,
        bytes calldata asset
    ) external onlyLendingPool returns (uint256, uint256, uint256, uint256) {
        (address adapter, bytes memory data) = abi.decode(asset, (address, bytes));
        if (from == address(0) || adapter == address(0)) revert InvalidAddress();
        if (amount == 0) {
            return (0, totalSupply(), 0, 0);
        }
        uint256 scaledAmount = amount;

        if(scaledAmount > ILendingPool(_lendingPool).getPositionScaledDebt(adapter, from, data)) {
            revert InsufficientBalance();
        }

        (uint256 positionIndex, ) = ILendingPool(_lendingPool).getPositionData(adapter, from, data);
        uint256 userIncrease = _mintUserInterest(from, ILendingPool(_lendingPool).getPositionDebt(adapter, from, data), ILendingPool(_lendingPool).getPositionScaledDebt(adapter, from, data));
        // Burn raw amount of debt token from user (will get the mintInterest executed via update to == address(0))
        uint256 totalSupplyBeforeBurn = totalSupply();
        _burn(from, scaledAmount.toUint128());

        uint256 rawAmount = amount.rayDiv(index); 
        if(rawAmount > _rawTotalBorrows) {
            _rawTotalBorrows = 0;
        } else {
            _rawTotalBorrows -= rawAmount;
        }

        emit Burn(from, scaledAmount, index, positionIndex);

        return (scaledAmount, totalSupply(), scaledAmount, userIncrease);
    }

    // VIEW FUNCTIONS

    /**
     * @notice Returns the scaled debt balance of the user
     * @param account The address of the user
     * @return The user's debt balance (scaled by the usage index)
     */
    function balanceOf(address account) public view override(ERC20, IERC20) returns (uint256) {
        return ILendingPool(_lendingPool).getPositionsScaledDebt(account);
    }

    /**
     * @notice Returns the scaled total supply
     * @return The total supply (scaled by the usage index)
     * @dev We normalize the raw borrow amount by the current usage index
     *      to get the correct total supply including accrued interest
     */
    function totalSupply() public view override(ERC20, IERC20) returns (uint256) {
        return _rawTotalBorrows.rayMul(ILendingPool(_lendingPool).getNormalizedDebt());
    }

    /**
     * @notice Returns the Lending Pool address
     * @return The Lending Pool address
     */
    function getLendingPool() external view returns (address) {
        return _lendingPool;
    }

     /**
     * @notice Calculates and mints accrued interest for a user
     * @param user The address of the user
     */
    function _mintUserInterest(address user, uint256 rawPositionBalance, uint256 scaledPositionBalance) internal returns (uint256) {
        uint256 userIncrease = scaledPositionBalance > rawPositionBalance ? scaledPositionBalance - rawPositionBalance : 0;
        if(userIncrease > 0){
            _mint(user, userIncrease.toUint128());
        }
        return userIncrease;
    }
    
    /**
     * @notice Returns the debt token decimals (must match the underlying asset decimals) 
     * @return The debt token decimals 
     */
    function decimals() public view override(ERC20, IDebtToken) returns (uint8) {
        return IERC20Metadata(_assetAddress).decimals();
    }

    // INTERNAL FUNCTIONS

    function _update(address from, address to, uint256 amount) internal virtual override {
        if (from != address(0) && to != address(0)) {
            revert TransfersNotAllowed(); // Only allow minting and burning
        }

        super._update(from, to, amount);
    }


  
}