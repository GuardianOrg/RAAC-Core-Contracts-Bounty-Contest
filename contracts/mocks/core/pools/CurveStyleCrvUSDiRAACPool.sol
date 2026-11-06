// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../../../interfaces/core/pools/ILiquidityPool.sol";
import "../../../interfaces/core/vaults/IBaseHybridVault.sol";
import "../../../libraries/math/WadRayMath.sol";
import "../../../libraries/math/PercentageMath.sol";

/**
 * @title CurveStyleCrvUSDiRAACPool
 * @dev A Curve-style AMM for swapping crvUSD and iRAAC with proper bonding curves
 * @notice Uses StableSwap invariant with RWAVault price as peg target
 * @dev Coin index 0 = crvUSD, Coin index 1 = iRAAC
 */
contract CurveStyleCrvUSDiRAACPool is ILiquidityPool, ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using WadRayMath for uint256;
    using PercentageMath for uint256;

    uint256 public constant N_COINS = 2;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant FEE_DENOMINATOR = 10000;
    uint256 public constant A_PRECISION = 100;
    uint256 public constant MAX_A = 10**6;
    uint256 public constant MAX_A_CHANGE = 10;
    uint256 public constant MIN_RAMP_TIME = 86400; // 1 day
    
    // Tokens: [0] = crvUSD, [1] = iRAAC  
    IERC20[N_COINS] private _coins;
    uint256[N_COINS] private _balances;
    uint256 private _fee = 0; // 0.3% fee in basis points
    uint256 private _admin_fee = 5000000000; // 50% of fees to admin
    
    // Amplification coefficient for StableSwap curve
    uint256 private _initial_A;
    uint256 private _future_A;
    uint256 private _initial_A_time;
    uint256 private _future_A_time;
    
    // RWA Vault for price reference (not direct conversion)
    IBaseHybridVault public immutable rwaVault;
    
    // Rate multipliers to normalize tokens to 18 decimals (1 = no scaling for 18-dec tokens).
    // Using 1 avoids unnecessary 1e18 factor which caused overflow in invariant calculations.
    uint256[N_COINS] private _rate_multipliers = [1, 1];
    
    // Admin balances for fee collection
    uint256[N_COINS] private _admin_balances;
    
    // Events
    event TokenExchange(
        address indexed buyer,
        uint256 sold_id,
        uint256 tokens_sold,
        uint256 bought_id,
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

    event RampA(uint256 old_A, uint256 new_A, uint256 initial_time, uint256 future_time);

    error InvalidCoinIndex();
    error SameCoin();
    error InvalidAmount();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error InvalidArrayLength();
    error InvalidAmplification();
    error RampTooFast();

    constructor(
        address _crvUSD,
        address _iRAAC,
        address _rwaVault,
        uint256 _A,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) Ownable(msg.sender) {
        require(_crvUSD != address(0) && _iRAAC != address(0) && _rwaVault != address(0), "Zero address");
        require(_A > 0 && _A < MAX_A, "Invalid A");
        
        _coins[0] = IERC20(_crvUSD);  // crvUSD
        _coins[1] = IERC20(_iRAAC);   // iRAAC
        rwaVault = IBaseHybridVault(_rwaVault);
        
        _initial_A = _A * A_PRECISION;
        _future_A = _A * A_PRECISION;
        _initial_A_time = block.timestamp;
        _future_A_time = block.timestamp;
    }

    /**
     * @notice Get current amplification coefficient
     * @return Current A value
     */
    function A() public view override returns (uint256) {
        return _A() / A_PRECISION;
    }

    /**
     * @notice Get precise amplification coefficient
     * @return Current A value with precision
     */
    function A_precise() public view returns (uint256) {
        return _A();
    }

    /**
     * @notice Internal function to get current A with ramping
     * @return Current A value
     */
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

    /**
     * @notice Calculate the StableSwap invariant D
     * @param xp Normalized balances
     * @param amp Amplification coefficient
     * @return D The invariant
     */
    function get_D(uint256[N_COINS] memory xp, uint256 amp) internal pure returns (uint256) {
        uint256 S = 0;
        for (uint256 i = 0; i < N_COINS; i++) {
            S += xp[i];
        }
        if (S == 0) return 0;

        uint256 Dprev = 0;
        uint256 D = S;
        uint256 Ann = amp * N_COINS;
        
        for (uint256 i = 0; i < 255; i++) {
            uint256 D_P = D;
            for (uint256 j = 0; j < N_COINS; j++) {
                D_P = D_P * D / (xp[j] * N_COINS);
            }
            Dprev = D;
            D = (Ann * S + D_P * N_COINS) * D / ((Ann - 1) * D + (N_COINS + 1) * D_P);
            
            if (D > Dprev) {
                if (D - Dprev <= 1) break;
            } else {
                if (Dprev - D <= 1) break;
            }
        }
        return D;
    }

    /**
     * @notice Calculate token amount for withdrawal
     * @param token_amount LP tokens to burn
     * @param i Index of token to withdraw
     * @return Token amount to receive
     */
    function calc_withdraw_one_coin(uint256 token_amount, uint256 i) public view returns (uint256) {
        if (uint256(uint128(i)) >= N_COINS) revert InvalidCoinIndex();
        
        uint256[N_COINS] memory xp = _xp();
        uint256 D0 = get_D(xp, _A());
        uint256 total_supply = totalSupply();
        uint256 D1 = D0 - (token_amount * D0 / total_supply);
        
        uint256 new_y = get_y_D(_A(), uint256(uint128(i)), xp, D1);
        uint256 dy_0 = (xp[uint256(uint128(i))] - new_y) / _rate_multipliers[uint256(uint128(i))];
        
        // Apply fee
        uint256 dy = dy_0 - (_fee * dy_0 / FEE_DENOMINATOR);
        
        return dy;
    }

    /**
     * @notice Calculate y given other parameters
     * @param amp Amplification coefficient
     * @param i Index of token
     * @param xp Normalized balances
     * @param D Target invariant
     * @return y The calculated balance
     */
    function get_y_D(uint256 amp, uint256 i, uint256[N_COINS] memory xp, uint256 D) 
        internal pure returns (uint256) 
    {
        uint256 Ann = amp * N_COINS;
        uint256 c = D;
        uint256 S = 0;
        
        for (uint256 j = 0; j < N_COINS; j++) {
            if (j != i) {
                S += xp[j];
                c = c * D / (xp[j] * N_COINS);
            }
        }
        c = c * D / (Ann * N_COINS);
        uint256 b = S + D / Ann;
        
        uint256 y_prev = 0;
        uint256 y = D;
        
        for (uint256 k = 0; k < 255; k++) {
            y_prev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > y_prev) {
                if (y - y_prev <= 1) break;
            } else {
                if (y_prev - y <= 1) break;
            }
        }
        return y;
    }

    /**
     * @notice Get normalized balances  
     * @return xp Normalized balances array
     */
    function _xp() internal view returns (uint256[N_COINS] memory xp) {
        for (uint256 i = 0; i < N_COINS; i++) {
            xp[i] = _balances[i] * _rate_multipliers[i];
        }
    }

    /**
     * @notice Calculate output amount for exchange
     * @param i Input token index
     * @param j Output token index  
     * @param dx Input amount
     * @return dy Output amount
     */
    function get_dy(uint256 i, uint256 j, uint256 dx) external view override returns (uint256) {
        if (uint256(uint128(i)) >= N_COINS || uint256(uint128(j)) >= N_COINS) revert InvalidCoinIndex();
        if (i == j) revert SameCoin();
        
        uint256[N_COINS] memory xp = _xp();
        uint256 x = xp[uint256(uint128(i))] + (dx * _rate_multipliers[uint256(uint128(i))]);
        uint256 y = get_y(uint256(uint128(i)), uint256(uint128(j)), x, xp);
        uint256 dy = (xp[uint256(uint128(j))] - y - 1) / _rate_multipliers[uint256(uint128(j))];
        
        // Apply fee
        uint256 fee_amount = _fee * dy / FEE_DENOMINATOR;
        return dy - fee_amount;
    }

    /**
     * @notice Calculate y given x
     * @param i Input token index
     * @param j Output token index
     * @param x New input balance
     * @param xp Current normalized balances
     * @return y New output balance
     */
    function get_y(uint256 i, uint256 j, uint256 x, uint256[N_COINS] memory xp) 
        internal view returns (uint256) 
    {
        if (i == j) revert SameCoin();
        if (i >= N_COINS || j >= N_COINS) revert InvalidCoinIndex();
        
        uint256 amp = _A();
        uint256 D = get_D(xp, amp);
        uint256 Ann = amp * N_COINS;
        uint256 c = D;
        uint256 S = 0;
        
        for (uint256 k = 0; k < N_COINS; k++) {
            if (k == i) {
                S += x;
                c = c * D / (x * N_COINS);
            } else if (k != j) {
                S += xp[k];
                c = c * D / (xp[k] * N_COINS);
            }
        }
        c = c * D / (Ann * N_COINS);
        uint256 b = S + D / Ann;
        
        uint256 y_prev = 0;
        uint256 y = D;
        
        for (uint256 k = 0; k < 255; k++) {
            y_prev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > y_prev) {
                if (y - y_prev <= 1) break;
            } else {
                if (y_prev - y <= 1) break;
            }
        }
        return y;
    }

    /**
     * @notice Exchange tokens using StableSwap curve
     * @param i Input token index
     * @param j Output token index
     * @param dx Input amount
     * @param min_dy Minimum output amount
     * @return dy Actual output amount
     */
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver) 
        external 
        nonReentrant 
        returns (uint256) 
    {
        if (uint256(uint128(i)) >= N_COINS || uint256(uint128(j)) >= N_COINS) revert InvalidCoinIndex();
        if (i == j) revert SameCoin();
        if (dx == 0) revert InvalidAmount();
        
        uint256 input_index = uint256(uint128(i));
        uint256 output_index = uint256(uint128(j));
        
        uint256[N_COINS] memory old_balances = _balances;
        uint256[N_COINS] memory xp = _xp();
        
        // Transfer input tokens
        _coins[input_index].safeTransferFrom(msg.sender, address(this), dx);
        
        uint256 x = xp[input_index] + dx * _rate_multipliers[input_index];
        uint256 y = get_y(input_index, output_index, x, xp);
        uint256 dy = xp[output_index] - y - 1;  // -1 for rounding errors
        dy = dy / _rate_multipliers[output_index];
        
        // Apply fees
        uint256 fee_amount = _fee * dy / FEE_DENOMINATOR;
        uint256 admin_fee_amount = _admin_fee * fee_amount / FEE_DENOMINATOR;
        dy = dy - fee_amount;
        
        if (dy < min_dy) revert SlippageExceeded();
        if (dy > _balances[output_index]) revert InsufficientLiquidity();
        
        // Update balances
        _balances[input_index] += dx;
        _balances[output_index] -= dy;
        _admin_balances[output_index] += admin_fee_amount;
        
        // Transfer output tokens
        _coins[output_index].safeTransfer(receiver, dy);
        
        emit TokenExchange(receiver, i, dx, j, dy);
        return dy;
    }

    /**
     * @notice Add liquidity to pool
     * @param amounts Token amounts to add [crvUSD, iRAAC]
     * @param min_mint_amount Minimum LP tokens to mint
     * @return Amount of LP tokens minted
     */
    function add_liquidity(uint256[2] memory amounts, uint256 min_mint_amount, address receiver) 
        external 
        nonReentrant 
        returns (uint256) 
    {
        if (amounts.length != N_COINS) revert InvalidArrayLength();
        
        uint256[N_COINS] memory old_balances = _balances;
        uint256[N_COINS] memory new_balances = _balances;
        uint256 amp = _A();
        uint256 D0 = 0;
        
        if (totalSupply() > 0) {
            D0 = get_D(_xp(), amp);
        }
        
        for (uint256 i = 0; i < N_COINS; i++) {
            if (amounts[i] > 0) {
                _coins[i].safeTransferFrom(msg.sender, address(this), amounts[i]);
                new_balances[i] += amounts[i];
            }
        }
        
        // Calculate new D
        uint256[N_COINS] memory xp;
        for (uint256 i = 0; i < N_COINS; i++) {
            xp[i] = new_balances[i] * _rate_multipliers[i];
        }
        uint256 D1 = get_D(xp, amp);
        
        uint256 token_amount;
        if (D0 == 0) {
            token_amount = D1;
        } else {
            token_amount = totalSupply() * (D1 - D0) / D0;
        }
        
        if (token_amount < min_mint_amount) revert SlippageExceeded();
        
        // Update balances
        _balances = new_balances;
        
        // Mint LP tokens
        _mint(receiver, token_amount);
        
        uint256[N_COINS] memory fees; // Zero fees for add_liquidity
        emit AddLiquidity(receiver, amounts, fees, D1, totalSupply());
        
        return token_amount;
    }

    /**
     * @notice Remove liquidity from pool
     * @param _amount LP tokens to burn
     * @param min_amounts Minimum token amounts to receive
     * @return amounts Token amounts received
     */
    function remove_liquidity(uint256 _amount, uint256[2] memory min_amounts, address receiver) 
        external 
        nonReentrant 
        returns (uint256[2] memory amounts) 
    {
        uint256 total_supply = totalSupply();
        if (total_supply == 0) revert InsufficientLiquidity();
        
        for (uint256 i = 0; i < N_COINS; i++) {
            amounts[i] = _balances[i] * _amount / total_supply;
            if (amounts[i] < min_amounts[i]) revert SlippageExceeded();
            
            _balances[i] -= amounts[i];
            _coins[i].safeTransfer(receiver, amounts[i]);
        }
        
        _burn(msg.sender, _amount);
        
        uint256[N_COINS] memory fees; // Zero fees for remove_liquidity
        emit RemoveLiquidity(receiver, amounts, fees, totalSupply());
        
        return amounts;
    }

    /**
     * @notice Remove liquidity in one coin
     * @param _token_amount LP tokens to burn
     * @param i Coin index to receive
     * @param min_amount Minimum amount to receive
     * @return Amount received
     */
    function remove_liquidity_one_coin(uint256 _token_amount, uint256 i, uint256 min_amount, address receiver) 
        external 
        nonReentrant 
        returns (uint256) 
    {
        if (uint256(uint128(i)) >= N_COINS) revert InvalidCoinIndex();
        
        uint256 dy = calc_withdraw_one_coin(_token_amount, i);
        if (dy < min_amount) revert SlippageExceeded();
        
        uint256 coin_index = uint256(uint128(i));
        _balances[coin_index] -= dy;
        _burn(msg.sender, _token_amount);
        _coins[coin_index].safeTransfer(receiver, dy);
        
        emit RemoveLiquidityOne(receiver, _token_amount, dy, totalSupply());
        return dy;
    }

    /**
     * @notice Get current iRAAC price from RWA Vault (for reference)
     * @return Price of 1e18 iRAAC in crvUSD terms
     */
    function getIRAACPrice() public view returns (uint256) {
        return rwaVault.pricePerShare();
    }

    /**
     * @notice Get exchange rates based on current pool state
     * @param _pairedToken Address of paired token (should be iRAAC)
     * @return raacPerPaired Current pool rate for iRAAC per paired token
     * @return pairedPerRaac Current pool rate for paired token per iRAAC
     */
    function getExchangeRate(address _pairedToken) 
        external 
        view 
        override 
        returns (uint256 raacPerPaired, uint256 pairedPerRaac) 
    {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        
        if (_balances[0] == 0 || _balances[1] == 0) {
            // Return oracle price if no liquidity
            uint256 oracle_price = getIRAACPrice();
            raacPerPaired = PRECISION;
            pairedPerRaac = oracle_price;
            return (raacPerPaired, pairedPerRaac);
        }
        
        // Calculate marginal rates from the curve
        uint256 small_amount = 1e15; // 0.001 tokens
        
        // Rate for 1 crvUSD -> iRAAC
        try this.get_dy(0, 1, small_amount) returns (uint256 iraac_out) {
            raacPerPaired = (iraac_out * PRECISION) / small_amount;
        } catch {
            raacPerPaired = PRECISION;
        }
        
        // Rate for 1 iRAAC -> crvUSD  
        try this.get_dy(1, 0, small_amount) returns (uint256 crvusd_out) {
            pairedPerRaac = (crvusd_out * PRECISION) / small_amount;
        } catch {
            pairedPerRaac = getIRAACPrice();
        }
    }

    /**
     * @notice Get total liquidity in pool
     * @param _pairedToken Address of paired token (should be iRAAC)
     * @return raacLiquidity Amount of iRAAC in pool
     * @return pairedLiquidity Amount of crvUSD in pool
     */
    function getTotalLiquidity(address _pairedToken) 
        external 
        view 
        override 
        returns (uint256 raacLiquidity, uint256 pairedLiquidity) 
    {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        pairedLiquidity = _balances[0]; // crvUSD
        raacLiquidity = _balances[1];   // iRAAC
    }

    /**
     * @notice Get user liquidity position
     * @param _pairedToken Address of paired token (should be iRAAC) 
     * @param _user User address
     * @return raacLiquidity User's share of iRAAC
     * @return pairedLiquidity User's share of crvUSD
     * @return lpAmount User's LP token balance
     */
    function getUserLiquidity(address _pairedToken, address _user) 
        external 
        view 
        override 
        returns (uint256 raacLiquidity, uint256 pairedLiquidity, uint256 lpAmount) 
    {
        require(_pairedToken == address(_coins[1]), "Invalid paired token");
        
        lpAmount = balanceOf(_user);
        uint256 total_supply = totalSupply();
        
        if (total_supply > 0 && lpAmount > 0) {
            pairedLiquidity = (_balances[0] * lpAmount) / total_supply;
            raacLiquidity = (_balances[1] * lpAmount) / total_supply;
        }
    }

    /**
     * @notice Get total value locked (using current pool rates, not oracle)
     * @return Total value in crvUSD terms based on pool composition
     */
    function getTotalValueLocked() public view override returns (uint256) {
        if (_balances[0] == 0 && _balances[1] == 0) return 0;
        
        // Use pool's own rate calculation for TVL
        uint256 crvusd_value = _balances[0];
        
        // Convert iRAAC to crvUSD using pool rate
        if (_balances[1] > 0) {
            try this.get_dy(1, 0, _balances[1]) returns (uint256 iraac_as_crvusd) {
                return crvusd_value + iraac_as_crvusd;
            } catch {
                // Fallback to oracle price
                uint256 iraac_value = (_balances[1] * getIRAACPrice()) / PRECISION;
                return crvusd_value + iraac_value;
            }
        }
        
        return crvusd_value;
    }

    // View functions required by interface
    function fee() external view override returns (uint256) {
        return _fee;
    }

    function coins(uint256 i) external view override returns (address) {
        if (i >= N_COINS) revert InvalidCoinIndex();
        return address(_coins[i]);
    }

    function balances(uint256 i) external view override returns (uint256) {
        if (i >= N_COINS) revert InvalidCoinIndex();
        return _balances[i];
    }

    // Admin functions
    function setFee(uint256 new_fee) external onlyOwner {
        require(new_fee <= 100, "Fee too high"); // Max 1%
        _fee = new_fee;
    }

    function setAdminFee(uint256 new_admin_fee) external onlyOwner {
        require(new_admin_fee <= FEE_DENOMINATOR, "Admin fee too high");
        _admin_fee = new_admin_fee;
    }

    /**
     * @notice Ramp amplification coefficient
     * @param _future_A Future A value
     * @param _future_time Future timestamp
     */
    function ramp_A(uint256 _future_A, uint256 _future_time) external onlyOwner {
        if (_future_time < block.timestamp + MIN_RAMP_TIME) revert RampTooFast();
        if (_future_A == 0 || _future_A > MAX_A) revert InvalidAmplification();
        
        uint256 _initial_A = _A();
        if (_future_A > _initial_A) {
            if (_future_A > _initial_A * MAX_A_CHANGE) revert RampTooFast();
        } else {
            if (_future_A * MAX_A_CHANGE < _initial_A) revert RampTooFast();
        }
        
        _initial_A = _initial_A;
        _future_A = _future_A * A_PRECISION;
        _initial_A_time = block.timestamp;
        _future_A_time = _future_time;
        
        emit RampA(_initial_A, _future_A, _initial_A_time, _future_time);
    }

    /**
     * @notice Withdraw admin fees
     * @param i Token index to withdraw
     */
    function withdraw_admin_fees(uint256 i) external onlyOwner {
        if (i >= N_COINS) revert InvalidCoinIndex();
        uint256 amount = _admin_balances[i];
        _admin_balances[i] = 0;
        _coins[i].safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Emergency withdrawal for owner
     * @param token Token to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
} 
