// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface IPriceOracle {
    /// @notice Returns the price of 1 unit of `token` in crvUSD (18-decimal)
    function getLatestPrice() external view returns (uint256);
}

/**
 * @title crvUSDPriceOracle
 * @author RAAC Protocol Team
 * @notice Oracle for crvUSD prices in crvUSD (18 decimals)
 */
contract crvUSDPriceOracle is IPriceOracle {
    uint8 public constant DECIMALS = 18;

    /**
     * @notice Returns the price of 1 unit of `token` in crvUSD (18-decimal)
     * @dev The index token is 18 decimals.
     * @return price The price of 1e18 unit of `token` in crvUSD (18-decimal)
     */
    function getLatestPrice() external pure returns (uint256) {
        return 10 ** DECIMALS;
    }

    /**
     * @notice Returns the number of decimals of the index token
     * @return decimals The number of decimals of the index token
     */
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }
}