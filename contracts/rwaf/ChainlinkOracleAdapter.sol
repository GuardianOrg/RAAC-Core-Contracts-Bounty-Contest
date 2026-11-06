// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title IChainlinkOracleAdapter
 * @notice Interface for Chainlink oracle adapter
 */
interface IRWACoordinator {
    function getPrice() external view returns (bool isValid, uint256 price, uint256 minUnsafePrice, uint256 maxUnsafePrice);
    function getSharePrice() external view returns (bool isValid, uint256 sharePrice);
}

/**
 * @title ChainlinkOracleAdapter
 * @author RAAC Protocol Team
 * @notice Adapter contract that wraps Chainlink price to match Insruxi RWA Coordinator Interface for the rwF(x) 
 * @dev Validates price freshness and provides safety bounds for price usage
 * @dev This contract will be replaced later by the RWACoordintator contract by Instruxi that implements the IRWACoodinator interface.
 */
contract ChainlinkOracleAdapter is IRWACoordinator, Ownable {
    /// @notice The Chainlink aggregator price feed
    AggregatorV3Interface public priceFeed;

    /// @notice Maximum staleness time for the price (in seconds)
    /// @dev If the price is older than this, it's considered invalid
    uint256 public maxStaleTime;

    /// @notice Emergency price to use when Chainlink returns invalid answer (8 decimals)
    /// @dev If 0, will revert when answer is invalid
    uint256 public emergencyPrice;

    /// @notice Price tolerance to use when Chainlink returns invalid answer (in BPS)
    uint256 public priceTolerance;

    /// @notice Decimals of the price (normalized to 8)
    uint8 public constant DECIMALS = 8;

    /// @notice BPS precision
    uint256 public constant BPS_PRECISION = 100_00;

    /// @notice Emitted when the price feed is updated
    event PriceFeedUpdated(address indexed newPriceFeed);

    /// @notice Emitted when the max stale time is updated
    event MaxStaleTimeUpdated(uint256 newMaxStaleTime);

    /// @notice Emitted when the emergency price is updated
    event EmergencyPriceUpdated(uint256 newEmergencyPrice);

    /// @notice Emitted when the price tolerance is updated
    event PriceToleranceUpdated(uint256 newPriceTolerance);

    /// @notice Emitted when an invalid address is provided
    error InvalidAddress();

    /// @notice Emitted when emergency price is not set and answer is invalid
    error EmergencyPriceNotSet();

    /// @notice Emitted when a zero value is provided
    error ZeroValue();

    /// @notice Emitted when a price tolerance is greater than BPS precision
    error InvalidPriceTolerance();

    /**
     * @notice Constructor
     * @param _priceFeed The address of the Chainlink aggregator price feed
     * @param _maxStaleTime Maximum staleness time in seconds
     * @param _emergencyPrice Emergency price to use when Chainlink returns invalid answer (8 decimals)
     * @param _initialOwner The initial owner of the contract
     */
    constructor(address _priceFeed, uint256 _maxStaleTime, uint256 _emergencyPrice, uint256 _priceTolerance, address _initialOwner) Ownable(_initialOwner) {
        if (_priceFeed == address(0)) revert InvalidAddress();
        if (_maxStaleTime == 0 || _priceTolerance == 0 || _emergencyPrice == 0) revert ZeroValue();
        priceFeed = AggregatorV3Interface(_priceFeed);
        maxStaleTime = _maxStaleTime;
        emergencyPrice = _emergencyPrice;
        priceTolerance = _priceTolerance;
    }

    /**
     * @notice Returns the price with validity and safety bounds
     * @return isValid Whether the price is valid based on factors like staleness, emergency price, and price tolerance
     * @return price The current price from Chainlink (8 decimals)
     * @return minUnsafePrice The minimum unsafe price threshold (8 decimals)
     * @return maxUnsafePrice The maximum unsafe price threshold (8 decimals)
     */
    function getPrice() external view override returns (bool isValid, uint256 price, uint256 minUnsafePrice, uint256 maxUnsafePrice) {
        uint256 safePrice;

        try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) {
                if (emergencyPrice == 0) revert EmergencyPriceNotSet();
                safePrice = emergencyPrice;
                isValid = false;
            } else {
                uint8 feedDecimals = priceFeed.decimals();
                uint256 chainlinkPrice = _normalizeTo8Decimals(uint256(answer), feedDecimals);

                uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
                if (age > maxStaleTime) {
                    if (emergencyPrice == 0) revert EmergencyPriceNotSet();
                    safePrice = emergencyPrice;
                    isValid = false;
                } else {
                    safePrice = chainlinkPrice;
                    isValid = true;
                }
            }
        } catch {
            if (emergencyPrice == 0) revert EmergencyPriceNotSet();
            safePrice = emergencyPrice;
            isValid = false;
        }

        price = safePrice;

        uint256 priceToleranceValue = safePrice * priceTolerance / BPS_PRECISION;
        minUnsafePrice = safePrice > priceToleranceValue ? safePrice - priceToleranceValue : 0;
        maxUnsafePrice = safePrice + priceToleranceValue;
    }

    /**
     * @notice Returns the share price with validity check
     * @return isValid Whether the price is valid based on staleness
     * @return sharePrice The share price (8 decimals)
     */
    function getSharePrice() external view override returns (bool isValid, uint256 sharePrice) {
        (isValid, sharePrice,,) = this.getPrice();
    }

    /**
     * @notice Normalizes the price to 8 decimals
     * @param price The price to normalize
     * @param _decimals The decimals of the price
     * @return The price normalized to 8 decimals
     */
    function _normalizeTo8Decimals(uint256 price, uint8 _decimals) internal pure returns (uint256) {
        if (_decimals == DECIMALS) return price;
        if (_decimals > DECIMALS) return price / (10 ** (_decimals - DECIMALS));
        return price * (10 ** (DECIMALS - _decimals));
    }

    /**
     * @notice Sets the price feed address
     * @param _priceFeed The address of the Chainlink aggregator price feed
     */
    function setPriceFeed(address _priceFeed) external onlyOwner {
        if (_priceFeed == address(0) || address(priceFeed) == _priceFeed) revert InvalidAddress();
        priceFeed = AggregatorV3Interface(_priceFeed);
        emit PriceFeedUpdated(_priceFeed);
    }

    /**
     * @notice Sets the maximum staleness time
     * @param _maxStaleTime Maximum staleness time in seconds
     */
    function setMaxStaleTime(uint256 _maxStaleTime) external onlyOwner {
        if (_maxStaleTime == 0) revert ZeroValue();
        maxStaleTime = _maxStaleTime;
        emit MaxStaleTimeUpdated(_maxStaleTime);
    }

    /**
     * @notice Sets the price tolerance
     * @param _priceTolerance Price tolerance in BPS
     */
    function setPriceTolerance(uint256 _priceTolerance) external onlyOwner {
        if (_priceTolerance == 0) revert ZeroValue();
        if (_priceTolerance > BPS_PRECISION) revert InvalidPriceTolerance();
        priceTolerance = _priceTolerance;
        emit PriceToleranceUpdated(_priceTolerance);
    }

    /**
     * @notice Sets the emergency price
     * @param _emergencyPrice Emergency price to use when Chainlink returns invalid answer (8 decimals)
     */
    function setEmergencyPrice(uint256 _emergencyPrice) external onlyOwner {
        if (_emergencyPrice == 0) revert ZeroValue();
        emergencyPrice = _emergencyPrice;
        emit EmergencyPriceUpdated(_emergencyPrice);
    }
}

