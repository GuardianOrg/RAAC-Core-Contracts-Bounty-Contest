// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MockRAACNFTVaultAdapterNAVOracle is Ownable {
    uint256 private navValue;

    bool public shouldRevert;

    string public revertMessage;

    uint8 public decimals;

    uint256 public timestamp;

    event NAVUpdated(uint256 previousValue, uint256 newValue, address indexed updatedBy);

    event RevertBehaviorChanged(bool shouldRevert, string message);

    constructor(uint256 _initialNAV, uint8 _decimals) Ownable(msg.sender) {
        navValue = _initialNAV;
        decimals = _decimals;
        timestamp = block.timestamp;
        revertMessage = "Mock oracle failure";
    }

    function getNAV() external view returns (uint8, uint256, uint256) {
        if (shouldRevert) {
            revert(revertMessage);
        }
        return (decimals, navValue, timestamp);
    }

    function setNAV(uint256 _newNAV) external onlyOwner {
        uint256 previousValue = navValue;
        navValue = _newNAV;
        timestamp = block.timestamp;
        emit NAVUpdated(previousValue, _newNAV, msg.sender);
    }

    function setRevertBehavior(bool _shouldRevert, string calldata _revertMessage) external onlyOwner {
        shouldRevert = _shouldRevert;
        revertMessage = _revertMessage;
        emit RevertBehaviorChanged(_shouldRevert, _revertMessage);
    }

    function simulateTemporaryFailure(uint256 _duration) external onlyOwner {
        uint256 recoveryBlock = block.number + _duration;

        shouldRevert = true;
        revertMessage = string(abi.encodePacked("Temporary failure until block ", toString(recoveryBlock)));
        
        emit RevertBehaviorChanged(true, revertMessage);
    }

    function recover() external onlyOwner {
        shouldRevert = false;
        revertMessage = "Mock oracle failure";
        emit RevertBehaviorChanged(false, revertMessage);
    }

    function getOracleStatus() external view returns (uint256 currentNAV, bool willRevert, string memory message) {
        return (navValue, shouldRevert, revertMessage);
    }

    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}