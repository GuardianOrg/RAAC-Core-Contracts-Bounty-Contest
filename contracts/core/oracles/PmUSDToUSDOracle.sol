// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "./CrvUSDToUSDOracle.sol";

/**
 * @title PmUSDToUSDOracle
 * @author RAAC Protocol Team
 * @notice pmUSD/USD price oracle. Inherits CrvUSDToUSDOracle for the same multi-tier fallback logic.
 */
contract PmUSDToUSDOracle is CrvUSDToUSDOracle {
    constructor(address _owner, uint256 _k) CrvUSDToUSDOracle(_owner, _k) {}
}
