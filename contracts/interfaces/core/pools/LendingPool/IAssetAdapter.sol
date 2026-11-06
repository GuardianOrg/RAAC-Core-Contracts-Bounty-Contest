// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @title IAsssetAdapter
/// @notice Interface that all asset adapters must implement
interface IAssetAdapter {
    /// @notice Deposits asset on behalf of the user
    /// @param user The user depositing the asset
    /// @param data Encoded data (e.g., amount for ERC20, tokenId for ERC721) of amount (uint256)
    function deposit(address user, bytes calldata data) external;

    /// @notice Withdraws asset from the user's position
    /// @param user The user withdrawing the asset
    /// @param data Encoded data representing what to withdraw
    function withdraw(address user, bytes calldata data) external;

    /// @notice Move all collateral from `user` to `to` for the given `data` (ERC20 amount agnostic)
    /// @dev Callable by privileged modules (pool, governance, emergency, etc.)
    function transferAsset(address user, bytes calldata data, address to) external;

    /// @notice Returns the current USD value of asset user deposited for the given data
    /// @param user The address of the user
    /// @param data Encoded asset specifier (e.g., tokenId or amount)
    /// @return usdValue Asset value in N decimals (like crvUSD or USDC)
    function getAssetValue(address user, bytes calldata data) external view returns (uint256);

    /// @notice Returns the USD value of the asset the user is attempting to withdraw
    /// @param user The user attempting to withdraw
    /// @param data Encoded withdrawal target
    /// @return usdValue Value of the to-be-withdrawn asset
    function getWithdrawValue(address user, bytes calldata data) external view returns (uint256);

    /// @notice Returns a stable position key used for mapping user positions in LendingPool
    ///         This must ignore dynamic values like amount and only reflect asset identity.
    /// @param data Encoded data to identify the asset uniquely
    /// @return positionKey A unique identifier per user per asset position
    function getPositionKey(bytes calldata data) external view returns (bytes32 positionKey);

    /// @notice Whether this adapter allows partial withdrawals
    /// @return True if partial withdrawals are supported
    function supportsPartialWithdraw() external pure returns (bool);

    /// @notice Returns the type of asset handled by this adapter (optional, but helpful for UX)
    /// @return Enum value indicating the asset type
    function getAssetType() external pure returns (string memory);

    /// @notice Returns the underlying asset token address (ERC20, ERC721, etc.)
    /// @return The address of the asset contract this adapter wraps
    function getAssetToken() external view returns (address);

    /// @notice Enumerate all position-keys this adapter holds for `user`
    /// @return keys Array of bytes32 positionKeys
    function getPositionKeys(address user) external view returns (bytes32[] memory keys);

    /// @notice Returns the total USD value (in 18‑decimals crvUSD) of everything this adapter holds for `user`
    /// @return total value of the assets in crvUSD
    function getTotalAssetValue(address user) external view returns (uint256);

    /// @notice Returns whether the data field is appropriate for validation.
    /// @return boolean whether the arguments are correct
    function validateLiquidationData(address user, bytes calldata data) external view returns(bool);

    /// @notice Sanity check for the user provided fields: ERC721 (check ownership), ERC20 (nothing)
    function validate(address user, bytes calldata data) external view;

    /// @notice allow the owner to update the oracle contract
    /// @dev owner only
    function setPriceOracle(address _oracle) external;
}
