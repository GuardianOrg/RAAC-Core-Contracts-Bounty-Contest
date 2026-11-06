// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../interfaces/core/pools/LendingPool/ILendingPool.sol";
import "../../../interfaces/core/tokens/IRToken.sol";
import "../../../interfaces/core/tokens/IDEToken.sol";
import "../../../interfaces/core/vaults/IBaseHybridVault.sol";
import "../../../interfaces/core/collectors/ITreasury.sol";
import "../../../interfaces/core/pools/StabilityPool/IStabilityPoolStorage.sol";

contract StabilityPoolStorage is IStabilityPoolStorage  {
    // State variables
    IRToken public rToken;
    IDEToken public deToken;
    ILendingPool public lendingPool;
    IERC20 public crvUSDToken;
    address public feeCollector;
    address public liquidationSwap;

    // vault that holds the rwaIndexToken and NFTs
    IBaseHybridVault public rwaVault;
    ITreasury public treasury;

    // Manager list (manager can call for liquidate on behalf of the stability pool)
    mapping(address => bool) public isManager;
    address[] public managerList;
    
    struct LiquidationVaultTokenSplit {
        uint256 mintPercentage;
        uint256 burnPercentage;
        uint256 swapPercentage;
        uint256 liquidityPercentage;
    }
    LiquidationVaultTokenSplit public liquidationSplit;

    // Withdrawal timelock
    struct WithdrawTimelock {
        uint256 amount;      // requested underlying amount
        uint256 indexAtRequest; // pool index at the time of request
        uint256 balanceAtRequest; // balance at the time of request
        uint256 userIndexAtRequest; // user index at the time of request
        uint256 readyAt;     // unix timestamp when executable
        uint256 expireAt;    // unix timestamp when expired
    }
    mapping(address => WithdrawTimelock) public withdrawTimelock;

    // Parameters
    uint256 public withdrawTimelockDuration;
    uint256 public withdrawTimelockDelay;

    // Flash loan protection (depositBlock)
    mapping(address => uint256) public depositBlock;

    address public liquidationStrategyProxy;

    uint256[50] __gap;
}