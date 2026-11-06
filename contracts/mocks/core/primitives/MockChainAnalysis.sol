// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface SanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

contract MockChainAnalysis is SanctionsList {
    mapping(address => bool) private _isSanctioned;

    function setSanctioned(address addr, bool _sanctioned) external {
        _isSanctioned[addr] = _sanctioned;
    }

    function isSanctioned(address addr) external view override returns (bool) {
        return _isSanctioned[addr];
    }
}