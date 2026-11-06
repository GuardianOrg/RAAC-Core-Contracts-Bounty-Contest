// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface IRAACHousePriceOracle {
    function isPendingRequest(uint256 _tokenId) external view returns(bool);
}