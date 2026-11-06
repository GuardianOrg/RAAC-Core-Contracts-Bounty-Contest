// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title MockGaugeStub
 * @notice Minimal stand-in for a gauge in GaugeController tests that only exercise
 *         registration, voting and weight accounting.
 * @dev GaugeController.addGauge probes IBaseGauge(gauge).isPaused(), so a plain EOA can no
 *      longer stand in for a gauge: the call into a codeless address reverts with no reason.
 */
contract MockGaugeStub {
    bool private _paused;

    function isPaused() external view returns (bool) {
        return _paused;
    }

    function setEmergencyPaused(bool paused) external {
        _paused = paused;
    }
}
