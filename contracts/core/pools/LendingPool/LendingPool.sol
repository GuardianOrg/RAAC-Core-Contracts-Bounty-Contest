// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

// OpenZeppelin libraries
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../../../libraries/math/PercentageMath.sol";
import "../../../libraries/math/WadRayMath.sol";
import "../../../libraries/pools/ReserveLibrary.sol";
// Interface contracts
import "../../../interfaces/core/pools/LendingPool/ILendingPool.sol";

import "../../../interfaces/core/pools/LendingPool/IAssetAdapter.sol";
// External interfaces
import "../../../interfaces/core/vaults/IBaseVault.sol";
import "../../../interfaces/core/tokens/IDebtToken.sol";
import "../../../interfaces/core/tokens/IRToken.sol";

import "./LendingPoolStorage.sol";
import "../../primitives/WithCompliance.sol";

import "../../../libraries/pools/LendingPoolFeeLibrary.sol";
/**
 * @title LendingPool
 * @author RAAC Protocol Team
 * @notice Main contract for the RAAC lending protocol. Users can deposit assets, borrow, repay, and more.
 * @dev This contract manages interactions with RTokens, DebtTokens, and handles the main logic for asset lending.
 */
contract LendingPool is ILendingPool, LendingPoolStorage, ReentrancyGuard, Pausable, AccessControl, WithCompliance {
    using PercentageMath for uint256;
    using WadRayMath for uint256;
    using SafeERC20 for IERC20;

    using ReserveLibrary for ReserveLibrary.ReserveData;
    using ReserveLibrary for ReserveLibrary.ReserveRateData;

    address public liquidationProxy;
    address public vaultProxy;

    // MODIFIERS

    modifier onlyValidAmount(uint256 amount) {
        if (amount == 0) revert InvalidAmount();
        _;
    }

    modifier onlyStabilityPool() {
        if (msg.sender != stabilityPool) revert Unauthorized();
        _;
    }

    modifier onlyPrimeRateOracle() {
        if (msg.sender != primeRateOracle) revert Unauthorized();
        _;
    }

    modifier onlyFeeCollector() {
        if (msg.sender != feeCollector) revert Unauthorized();
        _;
    }

    /**
     * @notice Sets a parameters value
     * @dev Gated per parameter: risk parameters by `PROTOCOL_ROLE`, fee parameters by `GOVERNANCE_ROLE`
     * @param param The parameters to update
     * @param newValue The new value to set
     */
    function setParameter(OwnerParameter param, uint256 newValue) external override {
        // Update the interests before updating the parameter
        ReserveLibrary.updateReserveState(reserve, rateData);

        bool isProtocol =
            param == OwnerParameter.LendingPoolBorrowCap                ||
            param == OwnerParameter.LendingPoolSupplyCap                ||
            param == OwnerParameter.BorrowThreshold                     ||
            param == OwnerParameter.LiquidationThreshold                ||
            param == OwnerParameter.LiquidationGracePeriod              ||
            param == OwnerParameter.LiquidityBufferRatio                ||
            param == OwnerParameter.WithdrawalStatus                    ||
            param == OwnerParameter.CanPaybackDebt                      ||
            param == OwnerParameter.MaxRate                             ||
            param == OwnerParameter.MinDepositAmount                    ||
            param == OwnerParameter.OptimalUtilizationRate              ||
            param == OwnerParameter.PrimeRateChangeBPS                  ||
            param == OwnerParameter.MinVaultRebalanceAmount;
        bool isGovernance =
            param == OwnerParameter.InsuranceFee          ||
            param == OwnerParameter.ProtocolFeeRate       ||
            param == OwnerParameter.LendingPoolDepositFee ||
            param == OwnerParameter.VaultOpeningFee;

        if (isProtocol) {
            if (!hasRole(PROTOCOL_ROLE, msg.sender)) revert AccessDenied();
        } else if (isGovernance) {
            if (!hasRole(GOVERNANCE_ROLE, msg.sender)) revert AccessDenied();
        } else {
            revert InvalidParameter();
        }

        uint256 oldValue;
        if (param == OwnerParameter.LendingPoolBorrowCap) {
            if (newValue == 0) revert CapZero();
            if (newValue > parameters.supplyCap) revert CapExceedSupply();
            oldValue = parameters.borrowCap;
            parameters.borrowCap = newValue;
        } else if (param == OwnerParameter.LendingPoolSupplyCap) {
            if (newValue == 0) revert CapZero();
            if (newValue < parameters.borrowCap) revert SupplyCapBelowBorrowCap();
            oldValue = parameters.supplyCap;
            parameters.supplyCap = newValue;
        } else if (param == OwnerParameter.BorrowThreshold) {
            if (newValue >= parameters.liquidationThreshold) revert BorrowThresholdTooHigh();
            oldValue = parameters.borrowThreshold;
            parameters.borrowThreshold = newValue;
        }else if (param == OwnerParameter.LiquidationThreshold) {
            if (newValue <= parameters.borrowThreshold) revert LiquidationThresholdTooLow();
            oldValue = parameters.liquidationThreshold;
            parameters.liquidationThreshold = newValue;
        } else if (param == OwnerParameter.LiquidationGracePeriod) {
            if (newValue < 1 days || newValue > 7 days) revert InvalidGracePeriod();
            oldValue = parameters.liquidationGracePeriod;
            parameters.liquidationGracePeriod = newValue;
        } else if (param == OwnerParameter.LiquidityBufferRatio) {
            if (newValue > PercentageMath.PERCENTAGE_FACTOR) revert InvalidPercentage();
            oldValue = parameters.liquidityBufferRatio;
            parameters.liquidityBufferRatio = newValue;
        } else if (param == OwnerParameter.WithdrawalStatus) {
            if (newValue > 1) revert InvalidBoolean();
            parameters.withdrawalsPaused = newValue == 1;
        } else if (param == OwnerParameter.CanPaybackDebt) {
            if (newValue > 1) revert InvalidBoolean();
            parameters.canPaybackDebt = newValue == 1;
        } else if (param == OwnerParameter.InsuranceFee) {
            if (newValue > PercentageMath.PERCENTAGE_FACTOR) revert InvalidPercentage();
            oldValue = parameters.insuranceFee;
            parameters.insuranceFee = newValue;
        } else if (param == OwnerParameter.ProtocolFeeRate) {
            // Value is in RAY
            if (newValue > WadRayMath.RAY) revert InvalidPercentage();
            oldValue = rateData.protocolFeeRate;
            rateData.protocolFeeRate = newValue;
        } else if (param == OwnerParameter.LendingPoolDepositFee){
             // Value is in BPS
            if (newValue > PercentageMath.PERCENTAGE_FACTOR) revert InvalidPercentage();
            oldValue = parameters.depositFee;
            parameters.depositFee = newValue;
        } else if (param == OwnerParameter.VaultOpeningFee) {
            oldValue = parameters.vaultOpeningFee;
            parameters.vaultOpeningFee = newValue;
        } else if (param == OwnerParameter.MaxRate) {
            // Value is in RAY
            oldValue = rateData.maxRate;
            rateData.maxRate = newValue;
        } else if (param == OwnerParameter.MinDepositAmount) {
            if (newValue == 0) revert InvalidAmount();
            oldValue = parameters.minDepositAmount;
            parameters.minDepositAmount = newValue;
        }  else if (param == OwnerParameter.OptimalUtilizationRate) {
            // Value is in RAY
            oldValue = rateData.optimalUtilizationRate;
            rateData.optimalUtilizationRate = newValue;
        } else if (param == OwnerParameter.PrimeRateChangeBPS) {
            // in BPS
            oldValue = parameters.primeRateChangeBps;
            parameters.primeRateChangeBps = newValue;
        } else if (param == OwnerParameter.MinVaultRebalanceAmount) {
            oldValue = parameters.minVaultRebalanceAmount;
            parameters.minVaultRebalanceAmount = newValue;
        }

        // Ensure update of rates and liquidity data
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);
        
        emit ParameterChanged(param, oldValue, newValue);
    }

    // CONSTRUCTOR
    /**
     * @dev Constructor
     * @param _reserveAssetAddress The address of the reserve asset (e.g., crvUSD)
     * @param _rTokenAddress The address of the RToken contract
     * @param _debtTokenAddress The address of the DebtToken contract
     * @param _initialPrimeRate The initial prime rate
     */     
    constructor(
        address _reserveAssetAddress,
        address _rTokenAddress,
        address _debtTokenAddress,
        address _liquidationProxyAddress,
        address _vaultProxy,
        address _complianceRegistry,
        uint256 _initialPrimeRate,
        address _admin

    ) WithCompliance(_complianceRegistry) {
        liquidationProxy = _liquidationProxyAddress;
        vaultProxy = _vaultProxy;

        // Initialize reserve data
        reserve.liquidityIndex = uint128(WadRayMath.RAY); // 1e27
        reserve.usageIndex = uint128(WadRayMath.RAY);

        reserve.lastUpdateTimestamp = uint40(block.timestamp);

        // Addresses
        reserve.reserveRTokenAddress = address(_rTokenAddress);
        reserve.reserveAssetAddress = address(_reserveAssetAddress);
        reserve.reserveDebtTokenAddress = address(_debtTokenAddress);

        // Prime Rate
        rateData.primeRate = uint256(_initialPrimeRate);
        rateData.baseRate = rateData.primeRate.percentMul(25_00); // 25% of prime rate
        rateData.optimalRate = rateData.primeRate.percentMul(50_00); // 50% of prime rate
        rateData.maxRate = WadRayMath.RAY.percentMul(83_63); // 83.63% in RAY (27 decimals) based on 7.00% US Prime Rate
        rateData.optimalUtilizationRate = WadRayMath.RAY.percentMul(80_00); // 80% in RAY (27 decimals)
        rateData.protocolFeeRate = WadRayMath.RAY.percentMul(10_00); // 10% in RAY (27 decimals)

        rateData.currentUtilizationRate = 0;
        rateData.currentLiquidityRate = 0;
        rateData.currentUsageRate = 0;

        // Initialize liquidation parameters
        parameters.borrowThreshold = BASE_BORROW_THRESHOLD;
        parameters.liquidationThreshold = BASE_LIQUIDATION_THRESHOLD;
        parameters.liquidationGracePeriod = BASE_LIQUIDATION_GRACE_PERIOD;
        // Caps start at zero so deposits and borrows revert until the launch parameters are written
        parameters.supplyCap = 0;
        parameters.borrowCap = 0;
        parameters.liquidityBufferRatio = 100_00;
        parameters.insuranceFee = 3_00;
        parameters.canPaybackDebt = true;
        parameters.vaultOpeningFee = 100 * 10 ** IERC20Metadata(reserve.reserveAssetAddress).decimals();
        parameters.minDepositAmount = 10 * 10 ** IERC20Metadata(reserve.reserveAssetAddress).decimals();
        parameters.primeRateChangeBps = 2_00;
        parameters.minVaultRebalanceAmount = 100 * 10 ** IERC20Metadata(reserve.reserveAssetAddress).decimals();
        // Roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);  
        _grantRole(GOVERNANCE_ROLE, _admin);  
        _grantRole(PROTOCOL_ROLE, _admin);
        _grantRole(EMERGENCY_ROLE, _admin);
    }

    // ADAPTER REGISTRATION

    /// @notice Emitted when a new adapter is registered
    event AdapterRegistered(address adapter);
    /// @notice Emitted when an adapter is removed
    event AdapterRemoved(address adapter);

    /// @notice Register a new collateral adapter
    /// @dev Only callable by `PROTOCOL_ROLE`
    function registerAdapter(address adapter) external onlyRole(PROTOCOL_ROLE) {
        if (supportedAdapters[adapter]) revert AdapterAlreadySupported();
        supportedAdapters[adapter] = true;
        adapters.push(adapter);
        emit AdapterRegistered(adapter);
    }

    /// @notice Remove an existing collateral adapter
    /// @dev Only callable by `PROTOCOL_ROLE`
    function unregisterAdapter(address adapter) external onlyRole(PROTOCOL_ROLE) {
        if (!supportedAdapters[adapter]) revert AdapterNotSupported();
        supportedAdapters[adapter] = false;
        // Remove from adapters array
        for (uint256 i = 0; i < adapters.length; i++) {
            if (adapters[i] == adapter) {
                adapters[i] = adapters[adapters.length - 1];
                adapters.pop();
                break;
            }
        }
        emit AdapterRemoved(adapter);
    }

    /// @notice Returns the list of all registered adapters
    function getAdapters() external view returns (address[] memory) {
        return adapters;
    }

    function supportedAdapter(address adapter) external view returns (bool) {
        return supportedAdapters[adapter];
    }

    /// @notice modifier to make sure adapter is supported
    modifier onlySupportedAdapter(address adapter) {
        if (!supportedAdapters[adapter]) revert AdapterNotSupported();
        _;
    }

    // CORE FUNCTIONS
    /**
     * @notice Allows a user to deposit reserve assets and receive RTokens
     * @param amount The amount of reserve assets to deposit
     */
    function deposit(uint256 amount) external nonReentrant onlyValidAmount(amount) notBlacklisted(msg.sender) {      
        // allow stability pool to bypass the contract pause for liquidations  
        if (msg.sender != stabilityPool && paused()) revert EnforcedPause();
        ReserveLibrary.updateReserveState(reserve, rateData);

        // Calculate the deposit fee. bypass if stability pool is calling
        uint256 depositFeeAmount = (feeCollector == address(0) || msg.sender == stabilityPool) ? 0 : amount.percentMul(parameters.depositFee);
        uint256 depositAmount = amount - depositFeeAmount;
        _validateDeposit(depositAmount);

        // Perform the deposit through ReserveLibrary
        uint256 mintedAmount = ReserveLibrary.deposit(reserve, rateData, depositAmount, msg.sender);

        // Rebalance vault liquidity after deposit
        if (msg.sender != stabilityPool) _rebalanceLiquidity();

        // Transfer the deposit fee to the fee collector
        if(depositFeeAmount > 0) _collectFee(depositFeeAmount, keccak256("LENDING_FEE"));

        if (msg.sender != stabilityPool) depositBlock[msg.sender] = block.number;

        emit Deposit(msg.sender, depositAmount, mintedAmount);
    }

    function _validateDeposit(uint256 amount) internal view {
        // if the sender is the stability pool, we do not need to check the supply cap
        if (msg.sender == stabilityPool) return;

        // Validate that user is depositing the minimum amount (after any fee)
        if (amount < parameters.minDepositAmount) revert MinDepositAmountRequired();
        
        // total supply includes interest
        if (IRToken(reserve.reserveRTokenAddress).totalSupply() + amount > parameters.supplyCap) revert SupplyCapReached();
    }

    /**
     * @notice Allows a user to withdraw reserve assets by burning RTokens
     * @param amount The amount of reserve assets to withdraw
     */
    function withdraw(uint256 amount) external nonReentrant onlyValidAmount(amount) notBlacklisted(msg.sender) {
        // allow stability pool to bypass the contract pause for liquidations 
        if (msg.sender != stabilityPool && paused()) revert EnforcedPause();
        if (msg.sender != stabilityPool && parameters.withdrawalsPaused) revert WithdrawalsArePaused();

        // Update the reserve state before the withdrawal
        ReserveLibrary.updateReserveState(reserve, rateData);

        uint256 scaledAmount = (amount == type(uint256).max) ? IERC20(reserve.reserveRTokenAddress).balanceOf(msg.sender) : amount;

        // Although burn reverts if amount greater than actual, this allows to spend less gas
        if (scaledAmount > IERC20(reserve.reserveRTokenAddress).balanceOf(msg.sender)) revert InsufficientBalance();
        
        // Ensure sufficient liquidity is available
        _ensureLiquidity(scaledAmount);

        // Perform the withdrawal through ReserveLibrary
        (uint256 amountWithdrawn, , ) = ReserveLibrary.withdraw(
            reserve,   // ReserveData storage
            rateData,  // ReserveRateData storage
            scaledAmount,    // Amount to withdraw
            msg.sender // Recipient
        );

        // Rebalance liquidity after withdrawal
        if (msg.sender != stabilityPool) _rebalanceLiquidity();

        emit Withdraw(msg.sender, amountWithdrawn);
    }

    /**
     * @notice Allows a user to deposit an asset
     * @param adapter Address of the asset adapter in usage
     * @param data Data to be given
     */
    function depositAsset(address adapter, bytes calldata data) external nonReentrant whenNotPaused onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        CollateralPosition memory position = getPosition(adapter, msg.sender, data);
        if (position.isUnderLiquidation) revert CannotDepositWhenUnderLiquidation();
        if (!vaultOpened[msg.sender]) revert VaultPositionNotOpened();
        // update state
        ReserveLibrary.updateReserveState(reserve, rateData);
        IAssetAdapter(adapter).deposit(msg.sender, data);
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);
    }
    

    function openVaultPosition() external notBlacklisted(msg.sender) {
        if (vaultOpened[msg.sender]) revert VaultPositionAlreadyOpened();
        vaultOpened[msg.sender] = true;
        if (parameters.vaultOpeningFee > 0) _collectFee(parameters.vaultOpeningFee, keccak256("LENDING_FEE"));
        emit VaultOpeningFeePaid(msg.sender, parameters.vaultOpeningFee);
    }

    /**
     * @notice Allows a user to withdraw an asset
     * @param adapter Address of the asset adapter in usage
     * @param data Data to be given
     */
    function withdrawAsset(address adapter, bytes calldata data) external nonReentrant whenNotPaused onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        CollateralPosition memory position = getPosition(adapter, msg.sender, data);
        if (position.isUnderLiquidation) revert CannotWithdrawUnderLiquidation();

        // update state
        ReserveLibrary.updateReserveState(reserve, rateData);

        uint256 positionDebt = getPositionScaledDebt(adapter, msg.sender, data);
        if (positionDebt > 0) {
            uint256 depositedValue = IAssetAdapter(adapter).getAssetValue(msg.sender, data);
            uint256 withdrawalValue = IAssetAdapter(adapter).getWithdrawValue(msg.sender, data);
            uint256 newCollateralValue = depositedValue - withdrawalValue;
            uint256 newHealthFactor;
            if (positionDebt < 1) newHealthFactor = WadRayMath.RAY;
            else {
                uint256 collateralThreshold = newCollateralValue.percentMul(parameters.borrowThreshold);
                newHealthFactor = (collateralThreshold * 1e18) / positionDebt;
            }
            if (newHealthFactor < HEALTH_FACTOR_LIQUIDATION_THRESHOLD) {
                revert WithdrawalWouldLeaveUserUnderCollateralized();
            }
        }

        IAssetAdapter(adapter).withdraw(msg.sender, data);
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);
    }

    /**
     * @notice Borrows reserve assets from the lending pool for a specific asset position
     * @param adapter Address of the asset adapter
     * @param data Data related to the asset
     * @param amount The amount of the reserve assets to borrow
     */
    function borrow(address adapter, bytes calldata data, uint256 amount) external nonReentrant whenNotPaused onlyValidAmount(amount) onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        _borrow(adapter, data, amount);
        CollateralPosition storage position = positions[msg.sender][IAssetAdapter(adapter).getPositionKey(data)];

        if (position.isInsured) {
            // We take the insurance and reset
            position.isInsured = false;
            position.rawInsuredBalance = 0;
        }
    }

    /**
     * @notice Allows a user to borrow reserve assets using their asset position as collateral
     * @param adapter Address of the asset adapter
     * @param data Data related to the asset
     * @param amount The amount of reserve assets to borrow
     */
    function _borrow(address adapter, bytes calldata data, uint256 amount) internal {
        CollateralPosition storage position = positions[msg.sender][IAssetAdapter(adapter).getPositionKey(data)];
        if (position.isUnderLiquidation) revert CannotBorrowUnderLiquidation();

        // Update reserve state before borrowing
        ReserveLibrary.updateReserveState(reserve, rateData);

        // Will revert if the user does not have enough collateral for the borrow
        _validateBorrow(adapter, data, amount);

        // Ensure sufficient liquidity is available in the pool (will withdraw from vault if needed) 
        _ensureLiquidity(amount);

        // Mint DebtTokens to the user (scaled amount)
       (, uint256 underlyingAmount, uint256 userIncrease, ) = IDebtToken(reserve.reserveDebtTokenAddress).mint(msg.sender, msg.sender, amount, reserve.usageIndex, abi.encode(adapter, data));

        // We need to update the position index of the user
        position.positionIndex = reserve.usageIndex;

        // Transfer borrowed amount to user
        IRToken(reserve.reserveRTokenAddress).transferAsset(msg.sender, amount);

        position.rawDebtBalance += underlyingAmount + userIncrease;

        // Update liquidity and interest rates
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, amount);

        // Rebalance liquidity after borrowing
        _rebalanceLiquidity();

        emit Borrow(msg.sender, adapter, data, amount);
    } 

    /**
     * @notice Allows a user to borrow reserve assets using their asset position as collateral with insurance
     * @dev The fees goes to fee Collector, type INSURANCE_FEE
     * @param adapter Address of the asset adapter
     * @param data Data related to the asset
     * @param amount The amount of reserve assets to borrow
     */
    function borrowWithInsurance(address adapter, bytes calldata data, uint256 amount) external nonReentrant whenNotPaused onlyValidAmount(amount) onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        CollateralPosition storage position = positions[msg.sender][IAssetAdapter(adapter).getPositionKey(data)];
        // doing this before so that we do not mess up after the borrow state updates
        uint256 uninsuredBalance = getUninsuredBalance(adapter, msg.sender, data);
        uint256 insuranceFeeAmount = calculateInsuranceFee(adapter, msg.sender, data, amount);

        // check the user allowance to the lending pool
        if (IERC20(reserve.reserveAssetAddress).allowance(msg.sender, address(this)) < insuranceFeeAmount) revert InsufficientAllowanceForFees();

        _borrow(adapter, data, amount);

        if (IERC20(reserve.reserveAssetAddress).balanceOf(msg.sender) < insuranceFeeAmount) revert InsufficientBalance();

        // Transfer insurance fee to fee collector
        if (insuranceFeeAmount > 0) _collectFee(insuranceFeeAmount, keccak256("INSURANCE_FEE"));
        position.isInsured = true;
        position.rawInsuredBalance += uninsuredBalance + amount;

        emit InsuredAsset(IAssetAdapter(adapter).getAssetToken(), msg.sender, data, uninsuredBalance + amount);
    }

    /**
     * @notice Get the uninsured balance of the user asset
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The uninsured balance of the user asset
     */
    function getUninsuredBalance(address adapter, address user, bytes calldata data) public view returns (uint256) {
        CollateralPosition memory position = getPosition(adapter, user, data);
        return position.rawDebtBalance - position.rawInsuredBalance;
    }

    /**
     * @notice Calculate the insurance fee for the user asset. The fees also includes the previous uninsured balance
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @param amount The amount of reserve assets to borrow
     * @return The insurance fee for the user asset
     * @dev If the user borrows without insurance but now wants to insure, they will pay on entire borrow amount.
     */
    function calculateInsuranceFee(address adapter, address user, bytes calldata data, uint256 amount) public view returns (uint256) {
        uint256 uninsuredBalance = getUninsuredBalance(adapter, user, data);
        return (uninsuredBalance + amount).percentMul(parameters.insuranceFee);
    }

     /**
     * @notice Allows a user to repay their own borrowed reserve assets for a specific asset position
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount to repay
     */
    function repay(address adapter, bytes calldata data,  uint256 amount) external nonReentrant whenNotPaused onlyValidAmount(amount) onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        _repay(adapter, data, amount, msg.sender);
    }

    /**
     * @notice Allows a user to repay borrowed reserve assets on behalf of another user for a specific asset position
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount to repay
     * @param onBehalfOf The address of the user whose debt is being repaid
     */
    function repayOnBehalf(address adapter, bytes calldata data, uint256 amount, address onBehalfOf) external nonReentrant whenNotPaused onlyValidAmount(amount) onlySupportedAdapter(adapter) notBlacklisted(msg.sender) notBlacklisted(onBehalfOf) {
        if (!parameters.canPaybackDebt) revert PaybackDebtDisabled();
        if (onBehalfOf == address(0)) revert AddressCannotBeZero();
        
        // Check if the repayment meets the minimum threshold (1% of the scaled debt)
        // This prevents malicious users from making tiny repayments to force interest capitalization
        uint256 positionScaledDebt = getPositionScaledDebt(adapter, onBehalfOf, data);
        if (positionScaledDebt != 0 && msg.sender != onBehalfOf) {
            uint256 minRepaymentAmount = positionScaledDebt.percentMul(100); // 1% = 100 in PercentageMath (basis points)
            if (amount < minRepaymentAmount) {
                revert RepaymentBelowMinimumThreshold();
            }
        }
        
        _repay(adapter, data, amount, onBehalfOf);
    }

    /**
     * @notice Internal function to repay borrowed reserve assets for a specific asset position
     * @param adapter Address of the asset adapter
     * @param data data related to the asset
     * @param amount The amount to repay
     * @param onBehalfOf The address of the user whose debt is being repaid
     */
    function _repay(address adapter, bytes calldata data, uint256 amount, address onBehalfOf) internal {
        if (amount == 0) revert InvalidAmount();
        if (onBehalfOf == address(0)) revert AddressCannotBeZero();

        IAssetAdapter(adapter).validate(onBehalfOf, data);

        // Update reserve state before repayment
        ReserveLibrary.updateReserveState(reserve, rateData);

        CollateralPosition storage position = positions[onBehalfOf][IAssetAdapter(adapter).getPositionKey(data)];

        // If the user is under liquidation and position is not insured, they cannot repay.
        if (position.isUnderLiquidation && !position.isInsured) revert CannotRepayUnderLiquidationWithoutInsurance();

        // If the position is under lqiodation and the grace period has expired, the user cannot repay.
        if (position.isUnderLiquidation && block.timestamp > position.liquidationStartTime + parameters.liquidationGracePeriod) revert GracePeriodExpired();


        // Calculate the position's debt including any accrued interest
        uint256 positionScaledDebt = getPositionScaledDebt(adapter, onBehalfOf, data);
        // If amount is greater than positionDebt, cap it at positionDebt
        uint256 actualRepayAmount = (amount == type(uint256).max) ? positionScaledDebt : amount;

        // Burn DebtTokens from the user whose debt is being repaid (onBehalfOf)
        (, , uint256 normalizedAmountBurned, uint256 balanceIncrease) = 
            IDebtToken(reserve.reserveDebtTokenAddress).burn(onBehalfOf, actualRepayAmount, this.getNormalizedDebt(), abi.encode(adapter, data));

         

        // We need to update the position index of the user
        position.positionIndex = reserve.usageIndex; 

        // Transfer reserve assets from the caller (msg.sender) to the reserve
        IERC20(reserve.reserveAssetAddress).safeTransferFrom(msg.sender, reserve.reserveRTokenAddress, actualRepayAmount);
     
        // Update position's scaled debt balance
        if (balanceIncrease > 0) {
            position.rawDebtBalance += balanceIncrease;
        }

        position.rawDebtBalance = position.rawDebtBalance - normalizedAmountBurned;

        // Update the insurance
        // If the user repaid value which is more than insured, so that there is more insured value than the debt, then the insurance value is the debt.
        // This will make sure that if the user takes a loan again, the insurance will be reset and the user will have to insure again.
        if (position.rawInsuredBalance > position.rawDebtBalance) {
            position.rawInsuredBalance = position.rawDebtBalance;
        }
        if (position.rawDebtBalance == 0) { 
            position.rawInsuredBalance = 0;
            position.isInsured = false;
        }
        
        // Update liquidity and interest rates
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, actualRepayAmount, 0);

        // if the debt is less than MIN_BORROW_AMOUNT, then revert saying that the residual cannot be repaid
        if (position.rawDebtBalance > 0 && getPositionScaledDebt(adapter, onBehalfOf, data) < MIN_BORROW_AMOUNT) {
            revert ResidualCannotBeRepaid();
        }

        _rebalanceLiquidity();

        emit Repay(msg.sender, adapter, onBehalfOf, data, actualRepayAmount);
    }
    
    /**
    * @notice Updates the state of the lending pool
    * @dev This function updates the reserve state, including liquidity and usage indices.
    *      The Stability Pool bypasses the pause so liquidations can be finalized while paused.
    */
    function updateState() external {
        if (msg.sender != stabilityPool && paused()) revert EnforcedPause();
        ReserveLibrary.updateReserveState(reserve, rateData);
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, 0);
    }

    // LIQUIDATION FUNCTIONS
    /**
     * @notice Allows anyone to initiate the liquidation process if a position's health factor is below threshold
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     */
    function initiateLiquidation(address adapter, address user, bytes calldata data) external nonReentrant whenNotPaused onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        (bool success, bytes memory returndata) = liquidationProxy.delegatecall(
            abi.encodeWithSignature("initiateLiquidation(address,address,bytes)", adapter, user, data)
        );
        _handleProxyError(success, returndata);
    }

    /**
     * @notice Allows a user to repay their debt and close the liquidation within the grace period
     * @param adapter Address of the asset adapter
     * @param data Data for identifying 
     */
    function closeLiquidation(address adapter, bytes calldata data) external nonReentrant whenNotPaused onlySupportedAdapter(adapter) notBlacklisted(msg.sender) {
        (bool success, bytes memory returndata) = liquidationProxy.delegatecall(
            abi.encodeWithSignature("closeLiquidation(address,bytes)", adapter, data)
        );
        _handleProxyError(success, returndata);
    }

    /**
     * @notice Allows the Stability Pool to finalize the liquidation after the grace period has expired
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     */
    function finalizeLiquidation(address adapter, address user, bytes calldata data) external nonReentrant onlyStabilityPool onlySupportedAdapter(adapter) {
        (bool success, bytes memory returndata) = liquidationProxy.delegatecall(
            abi.encodeWithSignature("finalizeLiquidation(address,address,bytes)", adapter, user, data)
        );
        _handleProxyError(success, returndata);
    }

     function rebalanceLiquidity() external onlyStabilityPool {
     _rebalanceLiquidity();
 }

    // VIEW FUNCTIONS
    /**
     * @notice Returns the raw balance of the user's deposits in the RToken
     * @param user The address of the user
     * @return The raw balance of the user's deposits
     */
    function getUserDeposits(address user) public view returns (uint256) {
        return IRToken(reserve.reserveRTokenAddress).rawBalanceOf(user);
    }

    /**
     * @notice Returns the raw balance of the user's deposits in the Stability Pool
     * @param user The address of the user
     * @return The raw balance of the user's deposits
     */
    function getUserDepositsInStabilityPool(address user) public view returns (uint256) {
        // Request userDeposits from StabilityPool using low-level staticcall
        // Only if the stability pool is set
        if (address(stabilityPool) == address(0)) return 0;
        (, bytes memory data) = stabilityPool.staticcall(
            abi.encodeWithSignature("getUserDeposit(address)", user)
        );
        return abi.decode(data, (uint256));
    }

    /**
     * @notice Returns the total raw balance of the user's deposits in the RToken and Stability Pool
     * @param user The address of the user
     * @return The total raw balance of the user's deposits
     */
    function getEligibleUserDeposits(address user) public view returns (uint256) {
        uint256 userDeposits = getUserDeposits(user);
        uint256 userDepositsPool = getUserDepositsInStabilityPool(user);
        return userDeposits + userDepositsPool;
    }

    // POSITION VIEWS

    /**
     * @notice Calculates the health factor for a specific asset position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The position's health factor 
     */
    function calculateHealthFactor(address adapter, address user, bytes calldata data) public view onlySupportedAdapter(adapter) returns (uint256) {
        uint256 collateralValue = IAssetAdapter(adapter).getAssetValue(user, data);
        uint256 positionScaledDebt = getPositionScaledDebt(adapter, user, data);

        return _previewHealthFactor(collateralValue, positionScaledDebt);
    }
    

    function _previewHealthFactor(uint256 collateralValue, uint256 scaledDebtValue) internal view returns (uint256) {
        if (scaledDebtValue < 1) return WadRayMath.RAY;

        uint256 collateralThreshold = collateralValue.percentMul(parameters.liquidationThreshold);

        return (collateralThreshold * 1e18) / scaledDebtValue;
    }

    // NOTE: this method is not used in smart contracts. Do we need it? This is expensive call if user has many assets.
    /**
     * @notice Gets the total collateral value of a user across all asset positions
     * @param user The address of the user
     * @return totalValue The total collateral value
     */
    function getUserCollateralValue(address user) public view returns (uint256 totalValue) {
        for (uint256 i = 0; i < adapters.length; i++) {
            totalValue += IAssetAdapter(adapters[i]).getTotalAssetValue(user);
        }
        return totalValue;
    }

    /**
     * @notice Gets the debt for a specific asset position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The debt for the asset position
     */
    function getPositionDebt(address adapter, address user, bytes calldata data) public view onlySupportedAdapter(adapter) returns (uint256) {
        CollateralPosition memory position = getPosition(adapter, user, data);
        return position.rawDebtBalance;
    }

    /**
     * @notice Gets the scaled debt for a specific asset position
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The scaled debt for the asset position
     */
    function getPositionScaledDebt(address adapter, address user, bytes calldata data) public view onlySupportedAdapter(adapter) returns (uint256) {
        CollateralPosition memory position = getPosition(adapter, user, data);
        return _positionScaledDebt(position);
    }

    /**
     * @notice Calculates the scaled debt for a specific asset position
     * @param position The position data
     * @return The scaled debt for the asset position
     */
    function _positionScaledDebt(CollateralPosition memory position) internal view returns (uint256) {
        uint256 usageIndex = ReserveLibrary.getUsageIndex(reserve, rateData);
        
        if (position.positionIndex == 0 || position.rawDebtBalance == 0) {
            return position.rawDebtBalance;
        }
        
        // All scaling uses :  raw * (usageIndex / positionIndex)
        uint256 indexMultiplier = usageIndex.rayDiv(position.positionIndex);
        return position.rawDebtBalance.rayMul(indexMultiplier);
    }

    /**
     * @notice Gets the user's total debt including interest across all asset positions
     * @param user The address of the user
     * @return totalDebt The user's total debt
     */
    function getPositionsScaledDebt(address user) public view returns (uint256 totalDebt) {
        for (uint256 i = 0; i < adapters.length; i++) {
            bytes32[] memory userPositionKeys = IAssetAdapter(adapters[i]).getPositionKeys(user);
            for (uint256 j = 0; j < userPositionKeys.length; j++) {
                CollateralPosition memory position = positions[user][userPositionKeys[j]];
                totalDebt += _positionScaledDebt(position);
            }
        }

        return totalDebt;
    }

    /**
     * @notice Checks if a user deposited in the same block
     * @param user The address of the user
     * @return True if the user deposited in the same block, false otherwise
     */
    function isUserDepositInSameBlock(address user) public view returns (bool) {
        return depositBlock[user] == block.number;
    }

    /**
     * @notice Gets the current price of an asset from the oracle
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The price of the NFT
     */
    function getAssetValue(address adapter, address user, bytes calldata data) public view returns (uint256) {
        return IAssetAdapter(adapter).getAssetValue(user, data);
    }

    /**
     * @notice Gets the pending protocol fee
     * @return The pending protocol fee
     */
    function getPendingProtocolFee() external view returns (uint256) {
        return ReserveLibrary.getPendingProtocolFee(reserve, rateData);
    }

    /**
     * @notice Gets the reserve's normalized income
     * @return The normalized income (liquidity index)
     */
    function getNormalizedIncome() external view returns (uint256) {
        return ReserveLibrary.getLiquidityIndex(reserve, rateData);
    }

    /**
     * @notice Gets the reserve's normalized debt
     * @return The normalized debt (usage index)
     */
    function getNormalizedDebt() external view returns (uint256) {
        return ReserveLibrary.getUsageIndex(reserve, rateData);
    }

    /**
     * @notice Gets the reserve's prime rate
     * @return The prime rate
     */
    function getPrimeRate() external view returns (uint256) {
        return rateData.primeRate;
    }

    /**
     * @notice Gets the reserve state
     * @return The reserve state
     */
    function getReserveState() external view returns (ReserveLibrary.ReserveData memory) {
        return reserve;
    }


    /**
     * @notice Gets the reserve rate data
     * @return The reserve rate data
     */
    function getReserveRateData() external view returns (ReserveLibrary.ReserveRateData memory) {
        return rateData;
    }

    /**
     * @notice Gets the asset position data for a specific user and token
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The CollateralPosition struct containing position data
     */
    function getPosition(address adapter, address user, bytes calldata data) public view onlySupportedAdapter(adapter) returns (CollateralPosition memory) {
        return positions[user][IAssetAdapter(adapter).getPositionKey(data)];
    }

    /**
     * @notice Gets the position data for a specific user and token
     * @param adapter Address of the asset adapter
     * @param user The address of the user
     * @param data data related to the asset
     * @return The position data
     */
    function getPositionData(address adapter, address user, bytes calldata data) external view onlySupportedAdapter(adapter) returns (uint256, uint256) {
        CollateralPosition memory position = getPosition(adapter, user, data);
        return (position.positionIndex, position.rawDebtBalance);
    }

    function getPositionView(address adapter, address user, bytes calldata data) external view onlySupportedAdapter(adapter) returns (CollateralPositionView memory) {
        CollateralPositionView memory positionView;
        CollateralPosition memory position = getPosition(adapter, user, data);
        positionView.isUnderLiquidation = position.isUnderLiquidation;
        positionView.liquidationStartTime = position.liquidationStartTime;
        positionView.rawDebtBalance = position.rawDebtBalance;
        positionView.isInsured = position.isInsured;

        positionView.scaledDebtBalance = getPositionScaledDebt(adapter, user, data);
        positionView.healthFactor = calculateHealthFactor(adapter, user, data);
        positionView.positionIndex = position.positionIndex;
        positionView.adapter = adapter;
        positionView.asset = IAssetAdapter(adapter).getAssetToken();

        return positionView;
    }
   
    // ADMIN FUNCTIONS

    /**
     * @notice Pauses the contract functions under `whenNotPaused`
     * @dev Only callable by `EMERGENCY_ROLE`
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract functions under `whenNotPaused`
     * @dev Only callable by `PROTOCOL_ROLE`: halting is broader than resuming
     */
    function unpause() external onlyRole(PROTOCOL_ROLE) {
        _unpause();
    }
    /**
     * @notice Sets the prime rate of the reserve
     * @param newPrimeRate The new prime rate (in RAY)
     */
    function setPrimeRate(uint256 newPrimeRate) external onlyPrimeRateOracle {
        ReserveLibrary.setPrimeRate(reserve, rateData, newPrimeRate, parameters.primeRateChangeBps);
    }

    /**
     * @notice Sets the address of the price oracle
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param newOracle The new price oracle address
     */
    function setPrimeRateOracle(address newOracle) external onlyRole(PROTOCOL_ROLE) {
        primeRateOracle = newOracle;
        emit PrimeRateOracleUpdated(newOracle);
    }
 
    /**
     * @notice Sets the address of the Stability Pool
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param newStabilityPool The address of the new Stability Pool
     */
    function setStabilityPool(address newStabilityPool) external onlyRole(PROTOCOL_ROLE) {
        if (newStabilityPool == address(0)) revert AddressCannotBeZero();
        
        address oldStabilityPool = stabilityPool;
        stabilityPool = newStabilityPool;
        
        emit StabilityPoolUpdated(oldStabilityPool, newStabilityPool);
    }

    /**
     * @notice Sets the address of the liquidation proxy
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param _liquidationProxy The address of the new liquidation proxy contract
     */
    function setLiquidationProxy(address _liquidationProxy) external onlyRole(PROTOCOL_ROLE) {
        if (_liquidationProxy == address(0)) revert AddressCannotBeZero();
        
        address oldLiquidationProxy = liquidationProxy;
        liquidationProxy = _liquidationProxy;
        
        emit LiquidationProxyUpdated(oldLiquidationProxy, _liquidationProxy);
    }
    /**
     * @notice Rescue tokens mistakenly sent to this contract
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param tokenAddress The address of the ERC20 token
     * @param recipient The address to send the rescued tokens to
     * @param amount The amount of tokens to rescue
     */
    function rescueToken(address tokenAddress, address recipient, uint256 amount) external onlyRole(PROTOCOL_ROLE) {
        LendingPoolFeeLibrary.rescueToken(reserve, vaultRewards, address(vault), tokenAddress, recipient, amount);
    }
    
    /**
     * @notice Internal function to validate a borrow
     * @param adapter The address of the asset adapter
     * @param data The data related to the asset
     * @param amount The amount to borrow
     */
    function _validateBorrow(address adapter, bytes calldata data, uint256 amount) internal view {
        IAssetAdapter(adapter).validate(msg.sender, data);

        // Minimum amount to borrow
        if (amount < MIN_BORROW_AMOUNT) revert InvalidBorrowAmount();
        // check that the amount does not exceed borrow
        // totalSupply is the normalized debt (with accrued interest)
        if (IDebtToken(reserve.reserveDebtTokenAddress).totalSupply() + amount > parameters.borrowCap) revert BorrowCapReached();
        // For the borrow, we need to ensure that the user has enough collateral to cover the new debt
        uint256 collateralValue = IAssetAdapter(adapter).getAssetValue(msg.sender, data);
        if (collateralValue == 0) revert NoCollateral();

        // We calculate the max debt that the user can have (based on the collateral value and the borrow threshold)
        uint256 maxDebt = collateralValue.percentMul(parameters.borrowThreshold);

        // We ensure that the position has enough collateral to cover the new debt or revert
        if (maxDebt < getPositionScaledDebt(adapter, msg.sender, data) + amount) {
            revert NotEnoughCollateralToBorrow();
        }
    }

    /**
     * @notice Internal function to ensure sufficient liquidity is available for withdrawals or borrowing
     * @param amount The amount required
     */
    function _ensureLiquidity(uint256 amount) internal {
        (bool success, bytes memory returndata) = vaultProxy.delegatecall(
            abi.encodeWithSignature("ensureLiquidity(uint256)", amount)
        );
        _handleProxyError(success, returndata);
    }

    // Vault Rewards and Fee Collector
    /**
     * @notice Sets the address of the vault
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param newVault The address of the new vault contract
     */
    function setVault(address newVault) external onlyRole(PROTOCOL_ROLE) {
        // If we change the vault, we need to claim all rewards from the old vault
        if (address(vault) != address(newVault) && address(vault) != address(0)) { 
            (bool success, bytes memory returndata) = vaultProxy.delegatecall(
                abi.encodeWithSignature("withdrawAll()")
            );
            _handleProxyError(success, returndata);
        }
        // Allow address(0) to be set to remove the vault
        address oldVault = address(vault);
        vault = IBaseVault(newVault);
        
        // Verify vault asset matches our reserve asset
        if (newVault != address(0) && vault.asset() != reserve.reserveAssetAddress) revert InvalidVaultAsset();
        
        emit VaultUpdated(oldVault, newVault);
    }

    /**
     * @notice Internal function to handle errors from the proxy
     * @param success The success flag
     * @param returndata The return data
     */
    function _handleProxyError(bool success, bytes memory returndata) internal pure {
        if (!success) {
            if (returndata.length == 0) revert();
            assembly {
                revert(add(32, returndata), mload(returndata))
            }
        }
    }

     /**
     * @notice Rebalances liquidity between the buffer and the Curve vault to maintain the desired buffer ratio
     */
    function _rebalanceLiquidity() internal {
        (bool success, bytes memory returndata) = vaultProxy.delegatecall(
            abi.encodeWithSignature("rebalanceLiquidity()")
        );
        _handleProxyError(success, returndata);
    }

    /**
     * @notice Sets the fee collector address
     * @dev Only callable by `PROTOCOL_ROLE`
     * @param newFeeCollector The new fee collector address
     */
    function setFeeCollector(address newFeeCollector) external onlyRole(PROTOCOL_ROLE) {
        if (newFeeCollector == address(0)) revert AddressCannotBeZero();
        address oldFeeCollector = feeCollector;
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(oldFeeCollector, newFeeCollector);
    }

    /**
     * @notice Claims rewards from the vault and updates tracking
     * @dev Only callable by the fee collector
     * @return tokenAddress The address of the token claimed
     * @return claimableAmount Amount of reserve asset rewards claimed
     */
    function claimCollectorRewards() external onlyFeeCollector returns (address tokenAddress, uint256 claimableAmount) {
        tokenAddress = reserve.reserveAssetAddress;
        claimableAmount = LendingPoolFeeLibrary.claimVaultRewards(vaultRewards, tokenAddress, feeCollector);

        emit VaultRewardsClaimed(claimableAmount);
        return (tokenAddress, claimableAmount);
    }

    /**
     * @notice Claims accrued protocol fees to the configured fee collector
     * @dev Only callable by `PROTOCOL_ROLE`
     */
    function claimProtocolFees() external onlyRole(PROTOCOL_ROLE) {
        ReserveLibrary.updateReserveState(reserve, rateData);
        uint256 liquidityIndex = reserve.liquidityIndex;
        _ensureLiquidity(reserve.scaledPendingProtocolFee.rayMul(liquidityIndex));
        (, uint256 claimedAmount) = LendingPoolFeeLibrary.claimProtocolFees(reserve, feeCollector, liquidityIndex);
        ReserveLibrary.updateInterestRatesAndLiquidity(reserve, rateData, 0, claimedAmount);
        _rebalanceLiquidity();
    }
    /**
     * @notice Collects a fee from the user
     * @param amount The amount of fee to collect
     * @param feeType The type of fee to collect
     */
    function _collectFee(uint256 amount, bytes32 feeType) internal {
        LendingPoolFeeLibrary.collectFee(reserve.reserveAssetAddress, amount, feeType, feeCollector);
    }
}
