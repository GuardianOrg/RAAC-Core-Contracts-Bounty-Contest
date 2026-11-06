// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;


interface ICrvUsdCurveOracle {
    /// @notice Returns the oracle price of the coin at index `k` w.r.t the coin at index 0
    function price_oracle(uint256 k) external view returns (uint256);
}

contract MockCurveEMA is ICrvUsdCurveOracle {
    uint256 public price;
    uint256 public lastUpdated;

    constructor(uint256 _price) {
        price = _price;
        lastUpdated = block.timestamp;
    }

    function price_oracle(uint256 k) external view returns (uint256) {
        return price;
    }   

    function setPrice(uint256 _price) external {
        price = _price;
        lastUpdated = block.timestamp;
    }

    function setLastUpdated(uint256 _lastUpdated) external {
        lastUpdated = _lastUpdated;
    }

    function setPriceWithTime(uint256 _price, uint256 _lastUpdated) external {
        price = _price;
        lastUpdated = _lastUpdated;
    }
}