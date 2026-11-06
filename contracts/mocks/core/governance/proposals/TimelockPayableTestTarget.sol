// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

contract TimelockPayableTestTarget {
    uint256 public value;
    uint256 public receivedEth;

    function setValue(uint256 newValue) external payable {
        value = newValue;
        receivedEth = msg.value;
    }

    // Function to check received ETH
    function getReceivedEth() external view returns (uint256) {
        return receivedEth;
    }

    // Allow contract to receive ETH
    receive() external payable {}
} 