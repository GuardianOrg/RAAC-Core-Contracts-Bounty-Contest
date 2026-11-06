// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../../interfaces/core/pools/ILiquidityPool.sol";
import "../../../libraries/math/WadRayMath.sol";
import "../../../libraries/math/PercentageMath.sol";

/**
 * @title MockLiquidityPool
 * @dev A "simplified" mock of a Curve-like pool for ERC20 to ERC20 swaps
 */
contract MockLiquidityPool is ILiquidityPool, ERC20, Ownable {
    using SafeERC20 for IERC20;
    using WadRayMath for uint256;
    using PercentageMath for uint256;

    uint256 public constant N_COINS = 2;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant A_PRECISION = 100;
    uint256 public constant FEE_DENOMINATOR = 1000000;
    uint256 public constant ADMIN_FEE = 5000000000;
    uint256 public constant MAX_ADMIN_FEE = 10 * 10**9;
    uint256 public constant MAX_FEE = 5 * 10**9;
    uint256 public constant MAX_A = 10**6;
    
    IERC20[N_COINS] private _coins;
    uint256[N_COINS] private _balances;
    uint256 private _fee;  
    uint256 private _initial_A;
    uint256 private _future_A;
    uint256 private _initial_A_time;
    uint256 private _future_A_time;
    uint256[N_COINS] private _rate_multipliers;
    
    event TokenExchange(
        address indexed buyer,
        int128 sold_id,
        uint256 tokens_sold,
        int128 bought_id,
        uint256 tokens_bought
    );
    
    event AddLiquidity(
        address indexed provider,
        uint256[N_COINS] token_amounts,
        uint256[N_COINS] fees,
        uint256 invariant,
        uint256 token_supply
    );
    
    event RemoveLiquidity(
        address indexed provider,
        uint256[N_COINS] token_amounts,
        uint256[N_COINS] fees,
        uint256 token_supply
    );

    event RemoveLiquidityOne(
        address indexed provider,
        uint256 token_amount,
        uint256 coin_amount,
        uint256 token_supply
    );

    constructor(
        address[N_COINS] memory coinAddresses,
        uint256[N_COINS] memory rateMultipliers,
        uint256 ampParameter,
        uint256 feeParameter,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) Ownable(msg.sender) {
        for (uint256 i = 0; i < N_COINS; i++) {
            require(coinAddresses[i] != address(0), "Invalid coin address");
            _coins[i] = IERC20(coinAddresses[i]);
            _rate_multipliers[i] = rateMultipliers[i];
        }
        
        _initial_A = ampParameter * A_PRECISION;
        _future_A = ampParameter * A_PRECISION;
        _fee = feeParameter;
    }

    function A() public pure override returns (uint256) {
        return 100;
    }

    function A_precise() public view returns (uint256) {
        return _A();
    }

    function _A() internal view returns (uint256) {
        uint256 t1 = _future_A_time;
        uint256 A1 = _future_A;

        if (block.timestamp < t1) {
            uint256 A0 = _initial_A;
            uint256 t0 = _initial_A_time;
            if (A1 > A0) {
                return A0 + (A1 - A0) * (block.timestamp - t0) / (t1 - t0);
            } else {
                return A0 - (A0 - A1) * (block.timestamp - t0) / (t1 - t0);
            }
        } else {
            return A1;
        }
    }

    function add_liquidity(uint256[2] memory amounts, uint256, address receiver) external override returns (uint256) {
        require(amounts.length == N_COINS, "Invalid array length");
        
        for (uint256 i = 0; i < N_COINS; i++) {
            if (amounts[i] > 0) {
                _coins[i].safeTransferFrom(msg.sender, address(this), amounts[i]);
                _balances[i] += amounts[i];
            }
        }
        
        uint256 mintAmount = amounts[0] + amounts[1];
        _mint(receiver, mintAmount);
        return mintAmount;
    }

    function remove_liquidity(uint256 _amount, uint256[2] memory min_amounts, address receiver) external override returns (uint256[2] memory) {
        uint256[N_COINS] memory amounts;
        uint256 total_supply = totalSupply();
        
        for (uint256 i = 0; i < N_COINS; i++) {
            uint256 value = _balances[i] * _amount / total_supply;
            require(value >= min_amounts[i], "Withdrawal resulted in fewer coins than expected");
            _balances[i] -= value;
            amounts[i] = value;
            _coins[i].safeTransfer(receiver, value);
        }
        
        _burn(msg.sender, _amount);
        return amounts;
    }

    function remove_liquidity_one_coin(uint256 _token_amount, uint256 i, uint256 min_amount, address receiver) external override returns (uint256) {
        require(uint256(uint128(i)) < N_COINS, "Invalid coin index");
        uint256 amount = _balances[uint256(uint128(i))] * _token_amount / totalSupply();
        require(amount >= min_amount, "Insufficient output amount");
        
        _balances[uint256(uint128(i))] -= amount;
        _burn(msg.sender, _token_amount);
        _coins[uint256(uint128(i))].safeTransfer(receiver, amount);
        
        return amount;
    }

    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver) external override returns (uint256) {
        require(uint256(uint128(i)) < N_COINS && uint256(uint128(j)) < N_COINS, "Invalid indices");
        require(i != j, "Same coin");
        require(dx > 0, "Invalid input amount");
        // Transfer tokens from sender to pool using SafeERC20
        _coins[uint256(uint128(i))].safeTransferFrom(msg.sender, address(this), dx);
        _balances[uint256(uint128(i))] += dx;

        // Calculate output amount
        uint256 dy = (dx * (10000 - _fee)) / 10000;
        
        require(dy >= min_dy, "Exchange resulted in fewer coins than expected");
        require(dy <= _balances[uint256(uint128(j))], "Insufficient liquidity");

        _balances[uint256(uint128(j))] -= dy;
        _coins[uint256(uint128(j))].safeTransfer(receiver, dy);

        return dy;
    }

    function get_dy(uint256 i, uint256 j, uint256 dx) external view override returns (uint256) {
        require(uint256(uint128(i)) < N_COINS && uint256(uint128(j)) < N_COINS, "Invalid indices");
        require(i != j, "Same coin");
        return (dx * (10000 - _fee)) / 10000;
    }

    function getExchangeRate(address _pairedToken) external view override returns (uint256 raacPerPaired, uint256 pairedPerRaac) {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        if (_balances[0] == 0 || _balances[1] == 0) return (0, 0);
        raacPerPaired = (_balances[0] * PRECISION) / _balances[1];
        pairedPerRaac = (_balances[1] * PRECISION) / _balances[0];
    }

    function getTotalLiquidity(address _pairedToken) external view override returns (uint256 raacLiquidity, uint256 pairedLiquidity) {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        raacLiquidity = _balances[0];
        pairedLiquidity = _balances[1];
    }

    function getUserLiquidity(address _pairedToken, address _user) external view override returns (uint256 raacLiquidity, uint256 pairedLiquidity, uint256 lpAmount) {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        lpAmount = balanceOf(_user);
        uint256 totalSupply = totalSupply();
        if (totalSupply > 0 && lpAmount > 0) {
            raacLiquidity = (_balances[0] * lpAmount) / totalSupply;
            pairedLiquidity = (_balances[1] * lpAmount) / totalSupply;
        }
    }

    function getTotalValueLocked() external view override returns (uint256) {
        return _balances[0] + _balances[1];
    }

    function coins(uint256 i) external view override returns (address) {
        require(i < N_COINS, "Invalid index");
        return address(_coins[i]);
    }

    function balances(uint256 i) external view override returns (uint256) {
        require(i < N_COINS, "Invalid index");
        return _balances[i];
    }

    function fee() external view override returns (uint256) {
        return _fee;
    }
} 