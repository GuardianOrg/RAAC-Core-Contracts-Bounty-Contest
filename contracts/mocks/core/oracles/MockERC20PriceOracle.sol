// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../interfaces/core/oracles/IERC20PriceOracle.sol";

contract MockERC20PriceOracle is IERC20PriceOracle {
    uint256 private _value;
    uint256 private _lastUpdate;

    function getLatestPrice() external view override returns (uint256) {
        return _value;
    }

    function setLatestPrice(uint256 _updatedValue) external {
        _value = _updatedValue;
        _lastUpdate = block.timestamp;
    }
}