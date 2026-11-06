// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../../interfaces/core/pools/ILiquidityPool.sol";
import "../../../interfaces/core/pools/StabilityPool/ILiquidationSwap.sol";
import "../../../interfaces/core/vaults/IBaseHybridVault.sol";
import {ICrvUSDToUSDOracle} from "../../oracles/CrvUSDToUSDOracle.sol";

/**
 * @title LiquidationSwap
 * @author RAAC Protocol Team
 * @notice This contract is used to swap the index token for the crvUSD token in the Curve pool.
 * @dev If the swap fee is implemented in the liquidity pool (e.g. Curve), the slippage protection can be disabled, but a small 0.5-1% is recommended.
 */
contract LiquidationSwap is ILiquidationSwap, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ILiquidityPool public liquidityPool;
    uint256 public slippageProtectionBps = 50; // bps, max 10000
    address public vaultToken; // e.g. RWAIndexToken
    address public swapToken; // e.g. crvUSD
    address public stabilityPool;
    address public rwaVault;
    address public crvusdToUSDOracle;
    bool public enableSlippageProtection = false;
    uint256 public iIn; // index of the vault token in the liquidity pool
    uint256 public iOut; // index of the swap token in the liquidity pool

    modifier onlyStabilityPool() {
        if (msg.sender != stabilityPool) revert Unauthorized();
        _;
    }

    /**
     * @notice Constructor
     * @param _vaultToken The address of the vault token
     * @param _swapToken The address of the swap token
     * @param _rwaVault The address of the rwa vault
     * @param _crvusdToUSDOracle The address of the crvusd to usd oracle
     * @param _initialOwner The address of the initial owner
     */
    constructor(address _vaultToken, address _swapToken,  address _rwaVault, address _crvusdToUSDOracle, address _initialOwner) Ownable(_initialOwner) {
        if (_vaultToken == address(0) || _swapToken == address(0) || _rwaVault == address(0) || _crvusdToUSDOracle == address(0)) revert InvalidAddress();
        vaultToken = _vaultToken;
        swapToken = _swapToken;
        rwaVault = _rwaVault;
        crvusdToUSDOracle = _crvusdToUSDOracle;
    }

    /**
     * @notice Swap the tokens sent by the sender and send them back
     * @dev Requires prior approval from sender
     * @param sender The address of the sender
     * @param amount The amount of the index token to swap
     */
    function _swap(address sender, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (address(liquidityPool) == address(0)) revert InvalidAddress();
        // bring the tokens in this contract
        IERC20(vaultToken).safeTransferFrom(sender, address(this), amount);
        // approve the tokens to the liquidity pool
        bool approveSuccessIndexToken = IERC20(vaultToken).approve(address(liquidityPool), amount);
        if (!approveSuccessIndexToken) revert ApprovalFailed();
        // Calculate minimum expected output (accounting for fee)
        // Price per share returns 1e18 price of the iRAAC in USD (crvUSD converted to USD using the oracle)
        uint256 expectedDy = (IBaseHybridVault(rwaVault).pricePerShare() * amount) / ICrvUSDToUSDOracle(crvusdToUSDOracle).getPrice();
        if (expectedDy == 0) revert InvalidExchange();
        uint256 minDy = enableSlippageProtection ? (expectedDy * (10000 - slippageProtectionBps)) / 10000 : 0; 
        // Exchange index token for crvUSD
        liquidityPool.exchange(iIn, iOut, amount, minDy, address(this));

        // send the swapToken back to the user
        uint256 swappedAmount = IERC20(swapToken).balanceOf(address(this));
        IERC20(swapToken).safeTransfer(sender, swappedAmount);

        emit Swapped(sender, amount, swappedAmount);
    }

    /**
     * @notice swap the tokens by amount
     * @param amount The amount of the index token to swap
     */
    function swap(uint256 amount) external nonReentrant onlyStabilityPool {
        _swap(msg.sender, amount);
    }

    /**
     * @notice Sets the liquidity pool address and and slippage protection.
     * @param _liquidityPool Address of the new liquidity pool.
     * @param _slippageProtectionBps Slippage protection percentage (e.g., 0 no slippage allowance).
     * @param _in Index token input.
     * @param _out Index token output.
     */
    function setLiquidityPool(address _liquidityPool, uint256 _slippageProtectionBps, uint256 _in, uint256 _out) external onlyOwner {
        if (_liquidityPool == address(0)) revert InvalidAddress();
        if (_slippageProtectionBps > 10000) revert InvalidSlippageProtection();
        if (_in == _out) revert InvalidIndex();
        liquidityPool = ILiquidityPool(_liquidityPool);
        if (liquidityPool.coins(_in) != vaultToken || liquidityPool.coins(_out) != swapToken) revert InvalidIndex();
        slippageProtectionBps = _slippageProtectionBps;
        iIn = _in;
        iOut = _out;
        emit LiquidityPoolSet(_liquidityPool, _slippageProtectionBps, _in, _out);
    }
    

    /**
     * @notice Sets the stability pool address.
     * @param _sp Address of the new stability pool.
     */
    function setStabilityPool(address _sp) external onlyOwner {
        if (_sp == address(0)) revert InvalidAddress();
        stabilityPool = _sp;
        emit StabilityPoolSet(_sp);
    }

    /**
     * @notice Sets the crvusd/usd oracle  address.
     * @param _oracle Address of the new Oracle
     */
    function setCrvusdToUSDOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidAddress();
        crvusdToUSDOracle = _oracle;
        emit CrvusdToUSDOracleSet(_oracle);
    }

    /**
     * @notice Sets the slippage protection flag.
     * @param _enable Whether to enable slippage protection.
     */
    function setEnableSlippageProtection(bool _enable) external onlyOwner {
        enableSlippageProtection = _enable;
        emit SlippageProtectionEnabled(_enable);
    }
}
