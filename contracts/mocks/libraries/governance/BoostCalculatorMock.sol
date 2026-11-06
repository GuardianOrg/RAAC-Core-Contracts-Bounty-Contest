// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../libraries/governance/BoostCalculator.sol";

contract BoostCalculatorMock {
    using BoostCalculator for BoostCalculator.BoostState;

    BoostCalculator.BoostState private _state;

    constructor() {
        _state.maxBoost = 25000;  // 2.5x
        _state.minBoost = 10000;  // 1.0x
        _state.boostWindow = 7 days;
        _state.totalStaked = 0;
        _state.userStaked = 0;
    }

    function calculateBoost(
        uint256 veBalance,
        uint256 totalVeSupply,
        uint256 totalStaked,
        uint256 userStaked
    ) external view returns (uint256) {
        BoostCalculator.BoostParameters memory params = BoostCalculator.BoostParameters({
            maxBoost: _state.maxBoost,
            minBoost: _state.minBoost,
            boostWindow: _state.boostWindow,
            totalStaked: totalStaked,
            userStaked: userStaked,
            votingPower: 0  // Not used in calculation
        });

        return BoostCalculator.calculateBoost(
            veBalance,
            totalVeSupply,
            params
        );
    }

    function updateUserBalance(address user, uint256 newBalance) external {
        _state.updateUserBalance(user, newBalance);
    }

    function updateBoostPeriod() external {
        _state.updateBoostPeriod();
    }

    function calculateTimeWeightedBoostView(
        uint256 userBalance,
        uint256 totalSupply,
        uint256 amount
    ) external view returns (uint256 boostBasisPoints, uint256 boostedAmount) {
        return calculateTimeWeightedBoost(userBalance, totalSupply, amount);
    }

    function calculateTimeWeightedBoost(
        uint256 userBalance,
        uint256 totalSupply,
        uint256 amount
    ) public view returns (uint256 boostBasisPoints, uint256 boostedAmount) {
        BoostCalculator.BoostParameters memory params = BoostCalculator.BoostParameters({
            maxBoost: _state.maxBoost,
            minBoost: _state.minBoost,
            boostWindow: _state.boostWindow,
            totalStaked: _state.totalStaked,
            userStaked: userBalance,
            votingPower: 0  // Not used in calculation
        });

        uint256 boost = BoostCalculator.calculateBoost(
            userBalance,
            totalSupply,
            params
        );

        boostBasisPoints = boost;
        boostedAmount = (amount * boost) / 10000;
        return (boostBasisPoints, boostedAmount);
    }

    function setBoostParameters(
        uint256 maxBoost,
        uint256 minBoost,
        uint256 boostWindow,
        uint256 baseWeight,
        uint256 totalVotingPower,
        uint256 totalWeight
    ) external {
        _state.maxBoost = maxBoost;
        _state.minBoost = minBoost;
        _state.boostWindow = boostWindow;
        _state.baseWeight = baseWeight;
        _state.votingPower = totalVotingPower;
        _state.totalStaked = totalWeight;
    }

    function setTotalVotingPower(uint256 totalVotingPower) external {
        _state.votingPower = totalVotingPower;
    }

    function setTotalWeight(uint256 totalWeight) external {
        _state.totalStaked = totalWeight;
    }

    function setVotingPower(uint256 votingPower) external {
        _state.votingPower = votingPower;
    }

    function maxBoost() external view returns (uint256) {
        return _state.maxBoost;
    }

    function minBoost() external view returns (uint256) {
        return _state.minBoost;
    }

    function boostWindow() external view returns (uint256) {
        return _state.boostWindow;
    }

    function totalStaked() external view returns (uint256) {
        return _state.totalStaked;
    }

    function userStaked() external view returns (uint256) {
        return _state.userStaked;
    }
}
