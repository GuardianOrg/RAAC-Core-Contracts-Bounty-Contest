// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IERC721VaultAdapter
 * @author RAAC Protocol Team
 * @notice Interface for the ERC721VaultAdapter contract.
 */
interface IERC721VaultAdapter {
    function getDepositedTokens() external view returns (uint256[] memory);
    function getDepositedTokensCount() external view returns (uint256);
    function getDepositedTokenAtIndex(uint256 index) external view returns (uint256);
}