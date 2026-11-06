// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IRToken
 * @notice Interface for the RToken contract
 * @dev Extends the IERC20 interface and includes minting and burning functionalities restricted to designated roles.
 */
interface IRToken is IERC20 {

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
    ) external returns (uint256, uint256, uint256);

    /**
     * @notice Burns RToken from a user and transfers underlying asset
     * @param from The address from which tokens are burned
     * @param receiverOfUnderlying The address receiving the underlying asset
     * @param amount The amount to burn (in underlying asset units)
     * @param index The liquidity index at the time of burning
     * @return A tuple containing:
     *         - uint256: The amount of tokens burned
     *         - uint256: The new total supply after burning
     *         - uint256: The amount of underlying asset burned
     */
    function burn(
        address from,
        address receiverOfUnderlying,
        uint256 amount,
        uint256 index
    ) external returns (uint256, uint256, uint256);

    /**
     * @notice Sets the lending pool address. Only callable by the contract owner.
     * @param _lendingPool The address of the lending pool
     */
    function setLendingPool(address _lendingPool) external;

    /**
     * @notice Transfers the underlying asset to the specified user
     * @param user The address of the user to receive the asset
     * @param amount The amount of the asset to transfer
     */
    function transferAsset(address user, uint256 amount) external;

    /**
     * @notice Returns the non-scaled balance of a user
     * @param user The address of the user
     * @return The non-scaled balance of the user
     */
    function rawBalanceOf(address user) external view returns (uint256);

    /**
     * @notice Returns the non-scaled total supply
     * @return The non-scaled total supply
     */
    function rawTotalSupply() external view returns (uint256);

    /**
     * @notice Returns the address of the lending pool
     * @return The address of the lending pool
     */
    function getLendingPool() external view returns (address);

    /**
     * @notice Returns the address of the underlying asset
     * @return The address of the underlying asset
     */
    function getAssetAddress() external view returns (address);

    /**
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals.
     */
    function decimals() external view returns (uint8);

    /**
     * @notice Returns the user index for a user.
     * @param user Address of the user.
     * @return User index.
     */
    function getUserIndex(address user) external view returns (uint128);

    /**
     * @notice Calculate the dust amount in the contract
     * @return The amount of dust in the contract
     * @dev Dust is the difference between actual contract balance and total real obligations to token holders
     */
    function calculateDustAmount() external view returns (uint256);

    /**
     * @notice Returns the raw total deposits
     * @return The raw total deposits
     */
    function getRawTotalDeposits() external view returns (uint256);
    // EVENTS

    /**
     * @notice Emitted when the Lending Pool address is updated
     * @param oldLendingPool The old Lending Pool address
     * @param newLendingPool The new Lending Pool address
     */
    event LendingPoolUpdated(address indexed oldLendingPool, address indexed newLendingPool);

    /**
     * @notice Emitted when tokens are minted
     * @param caller The address initiating the mint
     * @param onBehalfOf The recipient of the minted tokens
     * @param amount The amount minted (in underlying asset units)
     * @param index The liquidity index at the time of minting
     */
    event Mint(address indexed caller, address indexed onBehalfOf, uint256 amount, uint256 index);

    /**
     * @notice Emitted when tokens are burned
     * @param from The address from which tokens are burned
     * @param receiverOfUnderlying The address receiving the underlying asset
     * @param amount The amount burned (in underlying asset units)
     * @param index The liquidity index at the time of burning
     */
    event Burn(address indexed from, address indexed receiverOfUnderlying, uint256 amount, uint256 index);

    /**
     * @notice Emitted when the minter address is set
     * @param minter The address of the minter
     */
    event MinterSet(address indexed minter);
   
    /**
     * @notice Emitted when the only lending pool modifier is not met
     */
    error OnlyLendingPool();
    /**
     * @notice Emitted when the address is zero
     */
    error InvalidAddress();
    /**
     * @notice Emitted when the amount is zero or unexpected
     */
    error InvalidAmount();
    /**
     * @notice Emitted when the main asset is being rescued (cannot be rescued)
     */
    error CannotRescueMainAsset();
    /**
     * @notice Emitted when user tries to deposit and transfer in the same block
     */
    error CannotDepositAndTransferInSameBlock();

    /**
     * @notice Emitted when the same block exempt is updated
     * @param user The address of the destination
     * @param value The new value (in bool)
     */
    event SameBlockExemptUpdated(address indexed user, bool value);

    
}
