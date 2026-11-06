// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/core/vaults/IBaseHybridVault.sol";
import {ICrvUSDToUSDOracle} from "./CrvUSDToUSDOracle.sol";

/// @notice Minimal interface for oracle providing token prices in crvUSD (18 decimals)
interface IPriceOracle {
    /// @notice Returns the price of 1 unit of `token` in crvUSD (18-decimal)
    function getLatestPrice() external view returns (uint256);
}

/**
 * @title RWAIndexTokenOracle
 * @author RAAC Protocol Team
 * @notice Oracle for RWA index token prices in crvUSD (18 decimals). Converts the iRAAC price (USD) to crvUSD
 */
contract RWAIndexTokenOracle is IPriceOracle, Ownable {
    address public immutable rwaVault;
    address public crvusdToUSDOracle;

    uint8 public constant DECIMALS = 18;

    /// @notice Emitted when the crvUSD oracle address is updated
    event CrvUSDOracleUpdated(address indexed oldOracle, address indexed newOracle);

    error InvalidRWAVault(); // Emitted when the rwa vault address is invalid
    error InvalidAddress(); // Emitted when the address is invalid
    error SameOracleAddress(); // Emitted when the oracle address is the same as the current oracle address

    constructor(address _rwaVault, address _crvusdToUSDOracle, address _initialOwner) Ownable(_initialOwner) {
        if (_rwaVault == address(0) || _crvusdToUSDOracle == address(0)) revert InvalidRWAVault();
        rwaVault = _rwaVault;
        crvusdToUSDOracle = _crvusdToUSDOracle;
    }

    /**
     * @notice Returns the price of 1e18 unit of `token` in crvUSD (18-decimal)
     * @dev The index token is 18 decimals.
     * @return price The price of 1e18 unit of `token` in crvUSD (18-decimal)
     */
    function getLatestPrice() external view returns (uint256) {
        uint256 value = IBaseHybridVault(rwaVault).pricePerShare();
        return (value * 1e18) / ICrvUSDToUSDOracle(crvusdToUSDOracle).getPrice();
    }

    /**
     * @notice Returns the number of decimals of the index token
     * @return decimals The number of decimals of the index token
     */
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    /**
     * @notice Allows the owner to update the crvUSD to USD oracle address
     * @param _newOracle The address of the new oracle
     */
    function setCrvUSDOracle(address _newOracle) external onlyOwner {
        if (_newOracle == address(0)) revert InvalidAddress();
        if (_newOracle == crvusdToUSDOracle) revert SameOracleAddress();

        address oldOracle = crvusdToUSDOracle;
        crvusdToUSDOracle = _newOracle;

        emit CrvUSDOracleUpdated(oldOracle, _newOracle);
    }

}