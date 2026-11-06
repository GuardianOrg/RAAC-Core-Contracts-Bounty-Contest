// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IDEToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function transferAsset(address user, uint256 amount) external;

    function rawBalanceOf(address user) external view returns (uint256);

    function getUserDeposit(address user) external view returns (uint256);
    function setUserIndex(address user, uint256 index) external;
    function getUserIndex(address user) external view returns (uint256);

    function getRawTotalDeposits() external view returns (uint256);
    /**
     * @notice Returns the number of decimals used to get its user representation.
     * @return The number of decimals.
     */
    function decimals() external view returns (uint8);

      /**
     * @notice Emitted when the Stability Pool address is updated
     * @param oldStabilityPool The previous Stability Pool address
     * @param newStabilityPool The new Stability Pool address
     */
    event StabilityPoolUpdated(address indexed oldStabilityPool, address indexed newStabilityPool);

    /**
     * @notice Emitted when new DETokens are minted
     * @param to The address receiving the minted tokens
     * @param amount The amount of tokens minted
     * @dev the amount does not contain interest
     */
    event Mint(address indexed to, uint256 amount);

    /**
     * @notice Emitted when DETokens are burned
     * @param from The address from which tokens are burned
     * @param amount The amount of tokens burned
     */
    event Burn(address indexed from, uint256 amount);

    /**
     * @notice Emitted when DETokens mints interest to the user
     * @param to The address to which interest are minted
     * @param interestAmount The amount of interest minted
     */
    event MintInterest(address indexed to, uint256 interestAmount);

    /// @notice Thrown when a function is called by an address other than the Stability Pool
    error OnlyStabilityPool();

    /// @notice Thrown when an invalid address (e.g., zero address) is provided
    error InvalidAddress();

    /// @notice Thrown when an invalid amount (e.g., zero) is provided
    error InvalidAmount();

    /// @notice Thrown when user tries to deposit and transfer in the same block
    error CannotDepositAndTransferInSameBlock();

    /**
     * @notice Emitted when the same block exempt is updated
     * @param user The address of the destination
     * @param value The new value (in bool)
     */
    event SameBlockExemptUpdated(address indexed user, bool value);
}
