// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../libraries/governance/RagequitLib.sol";

contract RagequitHarness {
    function cappedRemaining(uint40 unlockTime, uint40 nowTs, uint256 maxDuration) external pure returns (uint256) {
        return RagequitLib.cappedRemaining(unlockTime, nowTs, maxDuration);
    }

    function computeFeesForLock(
        uint256 amount,
        uint256 remainingTime,
        uint256 maxDuration,
        uint256 fixedExitFee,
        uint256 maxVariableExitFee,
        uint256 bpsDenominator
    ) external pure returns (uint256 fixedFee, uint256 variableFee) {
        return RagequitLib.computeFeesForLock(
            amount, remainingTime, maxDuration, fixedExitFee, maxVariableExitFee, bpsDenominator
        );
    }

    function splitVariable(uint256 variableFee) external pure returns (uint256 toTreasury, uint256 toStream) {
        return RagequitLib.splitVariable(variableFee);
    }
}

