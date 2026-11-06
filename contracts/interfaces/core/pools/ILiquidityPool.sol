// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface ILiquidityPool {
    // Core Curve-like functions
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver) external returns (uint256);
    function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256);
    function add_liquidity(uint256[2] memory amounts, uint256 min_mint_amount, address receiver) external returns (uint256);
    function remove_liquidity(uint256 _amount, uint256[2] memory min_amounts, address receiver) external returns (uint256[2] memory);
    function remove_liquidity_one_coin(uint256 token_amount, uint256 i, uint256 min_amount, address receiver) external returns (uint256);
    
    function getExchangeRate(address _pairedToken) external view returns (uint256 raacPerPaired, uint256 pairedPerRaac);
    function getTotalLiquidity(address _pairedToken) external view returns (uint256 raacLiquidity, uint256 pairedLiquidity);
    function getUserLiquidity(address _pairedToken, address _user) external view returns (uint256 raacLiquidity, uint256 pairedLiquidity, uint256 lpAmount);
    function getTotalValueLocked() external view returns (uint256 tvl);

    function A() external view returns (uint256);
    function fee() external view returns (uint256);
    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
}