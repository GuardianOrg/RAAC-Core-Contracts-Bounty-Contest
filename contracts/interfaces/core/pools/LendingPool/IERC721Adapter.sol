// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;


/// @title IERC721AssetAdapter
/// @notice Adapter for ERC721 collateral, prices in crvUSD (18 decimals)
/// @dev Only the registered LendingPool may invoke deposit/withdraw
interface IERC721Adapter {
  
    /// @notice Returns the list of tokenIds deposited by a user
    /// @param user User address
    /// @return tokenIds Array of deposited tokenIds
    function getDepositedTokens(address user) external returns (uint256[] memory tokenIds);

    /// @notice Returns the depositor (owner) of a given tokenId
    /// @param tokenId The NFT tokenId
    /// @return owner Address of the user who deposited this tokenId
    function getDepositor(uint256 tokenId) external returns (address owner);

    /// @notice Return the deposited NFT tokenId for `user` at position `index`
    /// @param user Address of the user who deposited this tokenId 
    /// @param index The requested index of the tokenId for the depositor
    /// @return tokenId The NFT tokenId 
    /// @dev reverts if index ≥ deposited array length 
    function tokenOfOwnerByIndex(address user, uint256 index) external view returns (uint256 tokenId);
}
