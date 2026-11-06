// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Interface for the crvUSD to USD oracle
interface ICrvUSDToUSDOracle {
    /// @notice Returns the price of crvUSD in USD (18 decimals) - must not return 0 or revert
    function getLatestPrice() external view returns (uint256 price, uint256 timestamp, uint256 fallbackLevel);
    /// @notice Return the price of crvUSD in USD - must not return 0 or revert
    function getPrice() external view returns (uint256 price);
    /// @notice Returns the decimals of the price
    function decimals() external view returns (uint8);
}

/// @notice Interface for the curve oracle (TriCRV)
interface ICrvUsdCurveOracle {
    /// @notice Returns the oracle price of the coin at index `k` w.r.t the coin at index 0
    function price_oracle(uint256 k) external view returns (uint256);
}

/**
 * @title CrvUSDToUSDOracle
 * @author RAAC Protocol Team
 * @notice Contract for managing the price of crvUSD in USD.
 * @dev This contract allows an oracle to update prices and provides functions to retrieve the latest prices.
 * @dev The contract is centralized and uses several oracles together to get the latest price.
 * @dev Initially, the oracles can be non-set. In this case, fallback is used.
 */
contract CrvUSDToUSDOracle is ICrvUSDToUSDOracle, Ownable {
    /// @notice The address of the data feed (crvUSD/USD)
    AggregatorV3Interface public crvUSDDataFeed;

    /// @notice The address of the ETH data feed (ETH/USD)
    AggregatorV3Interface public ethDataFeed;

    /// @notice The address of the fallback data feed (ETH/crvUSD)
    ICrvUsdCurveOracle public curveOracle;

    /// @notice Max stall time for Chainlink
    uint256 public maxStableStaleTime = 1 days + 1 hours;

    /// @notice Max unstable stall time for Chainlink
    uint256 public maxUnstableStaleTime = 1 hours + 10 minutes;

    /// @notice Fallback price in USD
    uint256 public fallbackPriceInUSD = 1e18;

    /// @notice Time when the last fallback was updated
    uint256 public lastFallbackUpdateTimestamp;

    /// @notice Decimals of the price
    uint8 public constant DECIMALS = 18;

    // Circuit breaker configuration
    /// @notice Whether the circuit breaker is enabled
    bool public circuitBreakerEnabled = true;

    /// @notice Minimum price threshold (18 decimals)
    uint256 public minPriceThreshold = 0.9e18;
    
    /// @notice Maximum price threshold (18 decimals)
    uint256 public maxPriceThreshold = 1.1e18;

    /// @notice Value K from the curve oracle which represents the index at which the price is provided
    uint256 public K;

    constructor(address initialOwner, uint256 _K) Ownable(initialOwner) {
        K = _K;
        fallbackPriceInUSD = 1e18;
        lastFallbackUpdateTimestamp = block.timestamp;
    }

    /**
     * @notice Returns the latest price of crvUSD in USD
     * @return price The price of crvUSD in USD
     * @return timestamp The timestamp of the price
     * @return fallbackLevel The fallback level
     */
    function getLatestPrice() external view returns (uint256 price, uint256 timestamp, uint256 fallbackLevel) {
        return _crvUSDPriceInUSD();
    }

    /**
     * @notice Returns the price of crvUSD in USD
     * @dev Get the price and ignore the levels and fallback
     * @return price The price of crvUSD in USD
     */
    function getPrice() external view returns (uint256 price) {
        (uint256 crvUSDPriceInUSD,,) = _crvUSDPriceInUSD();
        return crvUSDPriceInUSD;
    }

    /**
     * @notice Returns the decimals of the price returned by the oracle 
     * @return decimals The decimals of the oracle price
     */
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    /**
     * @notice Returns the price of crvUSD in USD
     * @return crvUSDPriceInUSD The price of crvUSD in USD
     * @return lastUpdateTimestamp The timestamp of the last update
     * @return fallbackLevel The fallback level (0: on‐chain crvUSD/USD feed, 1: ETH/USD + ETH→crvUSD curve, 2: hard‑coded fallback)
     */
    function _crvUSDPriceInUSD() internal view returns (uint256, uint256, uint256) {
        // first try using chainlink
        if (address(crvUSDDataFeed) != address(0)) {
            (, int256 answer, , uint256 updatedAt, ) = crvUSDDataFeed.latestRoundData();
            if (answer > 0 && block.timestamp - updatedAt <= maxStableStaleTime) {
                // convert to 18 decimals
                return (_clampCircuitBreaker(_normalizeTo18Decimals(uint256(answer), crvUSDDataFeed.decimals())), updatedAt, 0);
            }
        }
        // if stall, use chainlink ETH/USD + curve ETH/crvUSD
        if (address(curveOracle) != address(0) && address(ethDataFeed) != address(0)) {
            (uint256 crvUSDPriceInUSD, uint256 lastUpdateTimestamp, bool success) = _crvUSDPriceInUSDFromCurve();
            if (success) return (_clampCircuitBreaker(crvUSDPriceInUSD), lastUpdateTimestamp, 1);
        }
        // if that does not work, use fallback
        return (_clampCircuitBreaker(fallbackPriceInUSD), lastFallbackUpdateTimestamp, 2);
    }

    /**
     * @notice Returns the price of crvUSD in USD from the curve
     * @return crvUSDPriceInUSD The price of crvUSD in USD
     * @return lastUpdateTimestamp The timestamp of the last update
     * @return success Whether the price was successfully retrieved
     */
    function _crvUSDPriceInUSDFromCurve() internal view returns (uint256 crvUSDPriceInUSD, uint256 lastUpdateTimestamp, bool success) {
        (, int256 answer, , uint256 updatedAt, ) = ethDataFeed.latestRoundData();
        if (answer <= 0) return (10 ** DECIMALS, 0, false);
        if (block.timestamp - updatedAt >= maxUnstableStaleTime) return (10 ** DECIMALS, 0, false);
        
        uint256 ethPriceInUSD = _normalizeTo18Decimals(uint256(answer), ethDataFeed.decimals());
        uint256 ETHPriceInCrvUSD = curveOracle.price_oracle(K);

        if (ETHPriceInCrvUSD == 0) return (10 ** DECIMALS, 0, false);
        crvUSDPriceInUSD = (ethPriceInUSD * 10 ** DECIMALS) / ETHPriceInCrvUSD;

        lastUpdateTimestamp = updatedAt;
        success = true;
    }

    /// @notice The price is provided in normalized 18 decimals.
    /// @dev If the circuit breaker is enabled, the price is clamped between the min and max thresholds.
    /// @dev If the circuit breaker is disabled, the price is returned as is.
    function _clampCircuitBreaker(uint256 price) internal view returns (uint256) {
        if (!circuitBreakerEnabled) return price;

        if (price < minPriceThreshold) return minPriceThreshold;
        if (price > maxPriceThreshold) return maxPriceThreshold;
        return price;
    }

    /**
     * @notice Normalizes the price to 18 decimals
     * @param price The price to normalize
     * @param _decimals The decimals of the price
     * @return The price normalized to 18 decimals
     */
    function _normalizeTo18Decimals(uint256 price, uint8 _decimals) internal pure returns (uint256) {
        if (_decimals == DECIMALS) return price;
        if (_decimals > DECIMALS) return price / (10 ** (_decimals - DECIMALS));
        return price * (10 ** (DECIMALS - _decimals));
    }

    /**
     * @notice Allows the owner to set the data feed address
     * @param _crvUSDDataFeed The address of the data feed
     */
    function setCrvUSDDataFeed(address _crvUSDDataFeed) external onlyOwner {
        crvUSDDataFeed = AggregatorV3Interface(_crvUSDDataFeed);
        emit CrvUSDDataFeedUpdated(_crvUSDDataFeed);
    }

    /**
     * @notice Allows the owner to set the ETH data feed address
     * @param _ethDataFeed The address of the ETH data feed
     */
    function setEthDataFeed(address _ethDataFeed) external onlyOwner {
        ethDataFeed = AggregatorV3Interface(_ethDataFeed);
        emit EthDataFeedUpdated(_ethDataFeed);
    }

    /**
     * @notice Allows the owner to set the curve oracle address
     * @param _curveOracle The address of the curve oracle
     */
    function setCurveOracle(address _curveOracle) external onlyOwner {
        curveOracle = ICrvUsdCurveOracle(_curveOracle);
        emit CurveOracleUpdated(_curveOracle);
    }
    /**
     * @notice Allows the owner to set the max stall time
     * @param _maxStableStaleTime The max stall time
     */
    function setMaxStableStaleTime(uint256 _maxStableStaleTime) external onlyOwner {
        maxStableStaleTime = _maxStableStaleTime;
        emit MaxStableStaleTimeUpdated(_maxStableStaleTime);
    }

    /**
     * @notice Allows the owner to set the max unstable stall time
     * @param _maxUnstableStaleTime The max unstable stall time
     */
    function setMaxUnstableStaleTime(uint256 _maxUnstableStaleTime) external onlyOwner {
        maxUnstableStaleTime = _maxUnstableStaleTime;
        emit MaxUnstableStaleTimeUpdated(_maxUnstableStaleTime);
    }

    /**
     * @notice Allows the owner to set the fallback price in USD
     * @param _fallbackPriceInUSD The fallback price in USD
     */
    function setFallbackPriceInUSD(uint256 _fallbackPriceInUSD) external onlyOwner {
        if (_fallbackPriceInUSD == 0) revert InvalidFallbackPrice();
        fallbackPriceInUSD = _fallbackPriceInUSD;
        lastFallbackUpdateTimestamp = block.timestamp;
        emit FallbackPriceInUSDUpdated(_fallbackPriceInUSD);
    }

    /**
     * @notice Allows the owner to set the circuit breaker configuration
     * @param _enabled Whether the circuit breaker is enabled
     * @param _minThreshold The minimum price threshold
     * @param _maxThreshold The maximum price threshold
     */
    function setCircuitBreakerConfig(bool _enabled, uint256 _minThreshold, uint256 _maxThreshold) external onlyOwner {
        if (_minThreshold == 0) revert MinThresholdMustBePositive();
        if (_minThreshold >= _maxThreshold) revert InvalidThresholds();
        circuitBreakerEnabled = _enabled;
        minPriceThreshold = _minThreshold;
        maxPriceThreshold = _maxThreshold;
        emit CircuitBreakerConfigUpdated(_enabled, _minThreshold, _maxThreshold);
    }

    /**
     * @notice Allows the owner to set the K value
     * @param _K The K value
     */
    function setK(uint256 _K) external onlyOwner {
        K = _K;
        emit KUpdated(_K);
    }

    /// @notice Emitted when the crvUSD data feed is updated
    event CrvUSDDataFeedUpdated(address newCrvUSDDataFeed);

    /// @notice Emitted when the ETH data feed is updated (used for the curve oracle)
    event EthDataFeedUpdated(address newEthDataFeed);

    /// @notice Emitted when the curve oracle is updated
    event CurveOracleUpdated(address newCurveOracle);

    /// @notice Emitted when the max stable stall time is updated
    event MaxStableStaleTimeUpdated(uint256 newMaxStableStaleTime);

    /// @notice Emitted when the max unstable stall time is updated
    event MaxUnstableStaleTimeUpdated(uint256 newMaxUnstableStaleTime);

    /// @notice Emitted when the fallback price in USD is updated
    event FallbackPriceInUSDUpdated(uint256 newFallbackPriceInUSD);

    /// @notice Emitted when circuit breaker configuration is updated
    event CircuitBreakerConfigUpdated(bool enabled, uint256 minThreshold, uint256 maxThreshold);

    /// @notice Emitted when the K value is updated
    event KUpdated(uint256 newK);

    /// @notice Emitted when the fallback price is invalid
    error InvalidFallbackPrice();

    /// @notice Emitted when invalid thresholds are provided
    error InvalidThresholds();

    /// @notice Emitted when minimum threshold is zero
    error MinThresholdMustBePositive();
}