// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IDebtToken
 * @dev Interface for the DebtToken contract in the RAAC lending protocol.
 */
interface IDebtToken is IERC20 {
    /**
     * @notice Sets the Lending Pool address
     * @param newLendingPool The address of the Lending Pool
     */
    function setLendingPool(address newLendingPool) external;

    /**
     * @notice Mints debt tokens to a user
     * @param caller The address initiating the mint
     * @param onBehalfOf The recipient of the debt tokens
     * @param amount The amount to mint (in underlying asset units)
     * @param index The usage index at the time of minting
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
        uint256 index,
        bytes calldata asset
    ) external returns (bool, uint256, uint256, uint256);


    /**
     * @notice Burns debt tokens from a user
     * @param from The address from which tokens are burned
     * @param amount The amount to burn (in underlying asset units)
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
    ) external returns (uint256, uint256, uint256, uint256);

    /**
     * @notice Returns the Lending Pool address
     * @return The Lending Pool address
     */
    function getLendingPool() external view returns (address);

    /**
     * @notice Returns the non-scaled balance of the user
     * @param user The address of the user
     * @return The user's non-scaled balance
     */
    function rawBalanceOf(address user) external view returns (uint256);

    /**
     * @notice Returns the non-scaled total supply
     * @return The non-scaled total supply
     */
    function rawTotalSupply() external view returns (uint256);

    /**
     * @notice Returns the raw total borrows (not including interest)
     * @return The raw total borrows
     */
    function getRawTotalBorrows() external view returns (uint256);

    /**
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals.
     */
    function decimals() external view returns (uint8);



    // EVENTS

    /**
     * @notice Emitted when the Lending Pool address is updated
     * @param oldLendingPool The old Lending Pool address
     * @param newLendingPool The new Lending Pool address
     */
    event LendingPoolUpdated(address indexed oldLendingPool, address indexed newLendingPool);

    /**
     * @notice Emitted when debt tokens are minted
     * @param caller The address initiating the mint
     * @param onBehalfOf The recipient of the debt tokens
     * @param amount The amount minted (in underlying asset units)
     * @param balanceIncrease The increase in the user's debt balance
     * @param index The usage index at the time of minting
     * @param positionIndex The index of the user's position
     */
    event Mint(address indexed caller, address indexed onBehalfOf, uint256 amount, uint256 balanceIncrease,uint256 index, uint256 positionIndex);

    /**
     * @notice Emitted when debt tokens are burned
     * @param from The address from which tokens are burned
     * @param amount The amount burned (in underlying asset units)
     * @param index The usage index at the time of burning
     * @param positionIndex The index of the user's position
     */
    event Burn(address indexed from, uint256 amount, uint256 index, uint256 positionIndex);

    // CUSTOM ERRORS

    error OnlyLendingPool();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientBalance();
    error TransfersNotAllowed();
}