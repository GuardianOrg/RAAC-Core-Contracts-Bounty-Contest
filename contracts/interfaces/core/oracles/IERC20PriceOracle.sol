// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IERC20PriceOracle
 * @author RAAC Protocol Team
 * @notice Interface for ERC20 token price oracle
 */
interface IERC20PriceOracle {
    /// @notice Returns the price in crvUSD (18-decimal) for the given 1 unit of token
    /// @return price The price of 1 unit of token in crvUSD (18-decimal)
    function getLatestPrice() external view returns (uint256);
}
