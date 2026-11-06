// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

contract MockGaugeController {
    function getGaugeWeight(address) external pure returns (uint256) {
        return 1000;
    }
}
