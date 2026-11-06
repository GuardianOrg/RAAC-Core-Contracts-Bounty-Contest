// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @title standard
/// @notice Solidity interface for Curve Finance's LiquidityGaugeV5 (vyper) contract
/// @dev Derived from Curve's Vyper implementation: [https://github.com/curvefi/curve-dao-contracts/blob/master/contracts/gauges/LiquidityGaugeV5.vy](https://github.com/curvefi/curve-dao-contracts/blob/master/contracts/gauges/LiquidityGaugeV5.vy)
interface ICurveLiquidityGaugeV5 {
    // --- ERC20 standard ---
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    // --- EIP-2612 permit ---
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bool);

    // --- Gauge-specific views ---
    function LP_TOKEN() external view returns (address);
    function integrate_checkpoint() external view returns (uint256);
    function claimable_tokens(address addr) external returns (uint256);
    function claimed_reward(address _user, address _token) external view returns (uint256);
    function claimable_reward(address _user, address _reward_token) external view returns (uint256);

    // --- User actions ---
    function user_checkpoint(address addr) external returns (bool);
    function set_rewards_receiver(address _receiver) external;
    function deposit(uint256 _value, address _addr, bool _claim_rewards) external;
    function deposit(uint256 _value) external;
    function withdraw(uint256 _value, bool _claim_rewards) external;
    function withdraw(uint256 _value) external;
    function claim_rewards(address _addr, address _receiver) external;
    function claim_rewards(address _addr) external;
    function kick(address addr) external;

    // --- Reward management ---
    function reward_count() external view returns (uint256);
    function reward_tokens(uint256 index) external view returns (address);
    function reward_data(address token) external view returns (
        address distributor,
        uint256 period_finish,
        uint256 rate,
        uint256 last_update,
        uint256 integral
    );
    function deposit_reward_token(address _reward_token, uint256 _amount) external;

    // --- Admin functions ---
    function admin() external view returns (address);
    function future_admin() external view returns (address);
    function is_killed() external view returns (bool);
    function commit_ownership(address _admin) external;
    function apply_ownership() external;
    function set_killed(bool _is_killed) external;
}
