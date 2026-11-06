// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @notice Minimal interface for the Gauge reward deposit function
interface ILiquidityGauge {
    function deposit_reward_token(address _reward_token, uint256 _amount) external;
}

/// @title Mock Gauge for testing deposit_reward_token
contract CurveLiquidityGaugeV5Mock is ILiquidityGauge {
    /// @notice Emitted when deposit_reward_token is called
    event RewardDeposited(address indexed token, uint256 amount);

    /// @dev Tracks total deposited per reward token
    mapping(address => uint256) public depositedRewards;

    /// @notice Mimics the Gauge's deposit_reward_token behaviour
    /// @param _reward_token The ERC-20 reward token address
    /// @param _amount The amount to deposit
    function deposit_reward_token(address _reward_token, uint256 _amount) external override {
        depositedRewards[_reward_token] += _amount;
        emit RewardDeposited(_reward_token, _amount);
    }
}
