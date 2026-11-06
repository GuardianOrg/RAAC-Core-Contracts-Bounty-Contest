// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../../interfaces/core/pools/StabilityPool/IStabilityPool.sol";
import "../../../interfaces/core/pools/LendingPool/ILendingPool.sol";
import "../../../interfaces/core/tokens/IRToken.sol";
import "../../../interfaces/core/tokens/IDEToken.sol";
import "../../../interfaces/core/vaults/IBaseHybridVault.sol";
import "../../../interfaces/core/collectors/ITreasury.sol";

import "../../primitives/WithCompliance.sol";
import "../../../libraries/math/WadRayMath.sol";
import "./StabilityPoolStorage.sol";

/**
 * @title StabilityPool
 * @author RAAC Protocol Team
 * @notice The StabilityPool is a contract that allows users to deposit rToken and receive deToken. The stability pool uses the funds to cover the debt of the borrowers during liquidations.
 * @dev The liquidation strategy is a proxy contract: LiquidationStrategyProxy.sol
 * @dev RToken and DEToken are 1:1
 */
contract StabilityPool is StabilityPoolStorage, IStabilityPool, Initializable, ReentrancyGuardUpgradeable, OwnableUpgradeable, PausableUpgradeable, ERC721Holder, WithCompliance {
    using SafeERC20 for IERC20;
    using SafeERC20 for IRToken;
    using SafeERC20 for IDEToken;
    using WadRayMath for uint256;

    // Constructor
    /// @dev the compliance registry is immutable
    constructor(address _complianceRegistry) WithCompliance(_complianceRegistry) {
        _disableInitializers();
    }

    /**
     * @notice Initializes the StabilityPool contract.
     * @param _rToken Address of the RToken contract.
     * @param _deToken Address of the DEToken contract.
     */
    function initialize(
        address _rToken,
        address _deToken,
        address _crvUSDToken,
        address _lendingPool,
        address _treasury,
        address _liquidationStrategyProxy,
        address _initialOwner
    ) public initializer {
        if (_rToken == address(0) || _deToken == address(0) || _crvUSDToken == address(0) || _lendingPool == address(0) || _treasury == address(0) || _liquidationStrategyProxy == address(0)) revert InvalidAddress();
        __Ownable_init(_initialOwner);
        __Pausable_init();
        __ReentrancyGuard_init();
        rToken = IRToken(_rToken);
        deToken = IDEToken(_deToken);
        crvUSDToken = IERC20(_crvUSDToken);
        lendingPool = ILendingPool(_lendingPool);
        treasury = ITreasury(_treasury);
        liquidationStrategyProxy = _liquidationStrategyProxy;
        withdrawTimelockDuration = 30 minutes;
        withdrawTimelockDelay = 2 days;
    }

    // Modifiers
    modifier validAmount(uint256 amount) {
        if (amount == 0) revert InvalidAmount();
        _;
    }

    modifier onlyManager() {
        if (!isManager[msg.sender]) revert UnauthorizedAccess();
        _;
    }

    modifier onlyManagerOrOwner() {
        if (!isManager[msg.sender] && msg.sender != owner()) revert UnauthorizedAccess();
        _;
    }

    /* ========== PUBLIC FUNCTIONS ========== */
    /**
     * @notice Allows a user to deposit rToken and receive deToken.
     * @param scaledAmount Amount of rToken to deposit (scaled amount from RToken.balanceOf).
     */
    function deposit(uint256 scaledAmount) external nonReentrant whenNotPaused validAmount(scaledAmount) notBlacklisted(msg.sender) {
        // Update the LendingPool index to ensure the most up to date index is used
        ILendingPool(lendingPool).updateState();
        
        // user has enough balance to cover the scaled amount ?
        if (rToken.balanceOf(msg.sender) < scaledAmount){
            revert InsufficientBalance();
        }

        _deposit(scaledAmount);
    }

    function _deposit(uint256 scaledAmount) internal {
        // transfer scaled amount from user to this contract
        rToken.safeTransferFrom(msg.sender, address(this), scaledAmount);

        // mint deToken to the user (mint raw amount, balanceOf will return scaled amount)
        deToken.mint(msg.sender, scaledAmount);
        depositBlock[msg.sender] = block.number;

        // Cancel any pending withdrawal timelock when depositing
        // This prevents users from frontloading withdrawal requests before having balance
        if (withdrawTimelock[msg.sender].readyAt != 0) {
            delete withdrawTimelock[msg.sender];
            emit WithdrawCancelled(msg.sender);
        }

        emit Deposit(msg.sender, scaledAmount, scaledAmount);
    }

    /**
     * @notice Allows a user to request a withdraw of their rToken.
     * @param amount Amount of DeToken to withdraw.
     * @dev The withdraw timelock is used to prevent users from withdrawing their funds before the end of the withdraw timelock duration.
     * @dev This prevents panic withdraw at time of liquidation.
     * @dev If user wants to change the amount of withdraw, new request must be sent.
     * @dev If user wants to cancel the withdraw, 0 amount must be sent.
     * @dev The request becomes executable after the `withdrawTimelockDuration` cooldown, and stays executable for the
     *      `withdrawTimelockDelay` execution window that follows. After the window the request expires and must be re-queued.
     */
    function requestWithdraw(uint256 amount) external nonReentrant whenNotPaused notBlacklisted(msg.sender) {
        if (withdrawTimelockDuration == 0) revert TimelockDisabled();

        if (amount == 0) {
            // cancel the withdraw
            delete withdrawTimelock[msg.sender];
            emit WithdrawCancelled(msg.sender);
            return;
        }

        WithdrawTimelock storage timelock = withdrawTimelock[msg.sender];

        timelock.balanceAtRequest = deToken.balanceOf(msg.sender);
        timelock.amount = amount;
        timelock.userIndexAtRequest = deToken.getUserIndex(msg.sender);
        timelock.indexAtRequest = ILendingPool(lendingPool).getNormalizedIncome();
        
        timelock.readyAt = uint64(block.timestamp + withdrawTimelockDuration);
        timelock.expireAt = uint64(block.timestamp + withdrawTimelockDuration);

        emit WithdrawQueued(msg.sender, amount, timelock.readyAt);
    }

    /**
     * @notice Checks if the withdraw timelock is valid.
     * @param user Address of the user.
     * @param amount Amount of DeToken to withdraw.
     * @return scaledAmount The scaled amount to withdraw.
     */
    function _withdrawTimelockCheck(address user, uint256 amount) internal returns (uint256 scaledAmount) {
        if (withdrawTimelockDuration == 0) {
            delete withdrawTimelock[user];
            return amount == type(uint256).max ? deToken.balanceOf(user) : amount;
        }
        WithdrawTimelock storage userTimelock = withdrawTimelock[user];
        if (userTimelock.readyAt == 0) revert NoPendingWithdraw();
        if (userTimelock.readyAt > block.timestamp) revert WithdrawTimelockNotReady();
        if (userTimelock.readyAt + withdrawTimelockDelay <= block.timestamp) revert WithdrawTimelockExpired();
        if (userTimelock.amount != amount) revert WithdrawTimelockInvalid();

        uint256 currentIndex = ILendingPool(lendingPool).getNormalizedIncome();
        uint256 balanceWithInterestCappedAmount;

        if (userTimelock.indexAtRequest == 0 || currentIndex == userTimelock.indexAtRequest) {
            // max possible amount to cap is the balance by default
            balanceWithInterestCappedAmount = userTimelock.balanceAtRequest;
        } else {
            // raw * (usageIndex / positionIndex)
            uint256 indexMultiplier = currentIndex.rayDiv(userTimelock.indexAtRequest);
            balanceWithInterestCappedAmount = userTimelock.balanceAtRequest.rayMulDown(indexMultiplier);
        }

        // If not, user wants his amount + interest earned since the timelock
        scaledAmount = (amount == type(uint256).max) ? balanceWithInterestCappedAmount : amount;

        if(scaledAmount > balanceWithInterestCappedAmount) {
            // Prevent user to withdraw more than he had
            revert WithdrawAmountTooHigh();
        }
        // Prevent user to withdraw more than he has
        if(scaledAmount > deToken.balanceOf(user)) {
            scaledAmount = deToken.balanceOf(user);
        }
        
        delete withdrawTimelock[user];
    }

    /**
     * @notice Allows a user to withdraw their rToken.
     * @param deTokenAmount Amount of deToken to redeem (should equal RToken amount).
     * @dev The interest earned are from RToken itself, so we do not need to mint new deToken here as index do not change. 
     */
    function withdraw(uint256 deTokenAmount) external nonReentrant whenNotPaused validAmount(deTokenAmount) notBlacklisted(msg.sender) {
        if (isUserDepositInSameBlock(msg.sender)) revert CannotDepositAndWithdrawSameBlock();

        // Update the LendingPool index to ensure the most up to date index is used
        ILendingPool(lendingPool).updateState();
        
        uint256 scaledAmount = _withdrawTimelockCheck(msg.sender, deTokenAmount);

        // Burn raw amount of deToken from user
        deToken.burn(msg.sender, scaledAmount);
        
        // Allow to withdraw amount at timelock + its interest
        rToken.safeTransfer(msg.sender, scaledAmount);

        emit Withdraw(msg.sender, scaledAmount, scaledAmount);
    }

    /* ========== ADMIN & MANAGER FUNCTIONS ========== */
    /**
     * @notice Liquidates a borrower's position.
     * @param poolAdapter The address of the asset adapter in the lending pool for finalizing liquidation
     * @param vaultAdapter The address of the asset adapter in the vault for storing the asset.
     * @param user The address of the borrower to liquidate.
     * @param data Parameters to identify the asset (tokenId, amount, etc.). 
     * @custom:throws InvalidAmount If the user's debt is zero.
     * @custom:throws InsufficientBalance If the Stability Pool doesn't have enough crvUSD to cover the debt.
     * @custom:throws ApprovalFailed If the approval of crvUSD transfer to LendingPool fails.
     * @custom:emits BorrowerLiquidated when the liquidation is successful.
     * @dev the Data paramter for ERC20 is equivalent to the deposited balance
     */
    function liquidateBorrower(address poolAdapter, address vaultAdapter, address user, bytes calldata data, uint256 minSharesOut) external onlyManagerOrOwner nonReentrant {
        (bool success, bytes memory returndata) = liquidationStrategyProxy.delegatecall(
            abi.encodeWithSignature("liquidateBorrower(address,address,address,bytes,uint256)", poolAdapter, vaultAdapter, user, data, minSharesOut)
        );
        if (!success) {
            if (returndata.length == 0) revert();
            assembly {
                revert(add(32, returndata), mload(returndata))
            }
        }
    }

    /**
     * @notice Collects the dust from the stability pool
     * @param token Address of the token
     * @param recipient Address of the recipient
     * @param amount Amount of dust to collect
     */
    function collectDust(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (token == address(rToken)) {
            // can take out only the delta between the DEToken and RToken balance;
            uint256 delta;
            if (deToken.totalSupply() < rToken.balanceOf(address(this))) {
                delta = rToken.balanceOf(address(this)) - deToken.totalSupply();
            }
            if (delta > amount) {
                delta = amount;
            }
            rToken.safeTransfer(recipient, delta);
            emit DustCollected(token, recipient, delta);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
            emit DustCollected(token, recipient, amount);
        }
    }

    /**
     * @notice Sets the RWA Vault contract address.
     * @param _rwaVault Address of the new RWA Vault contract.
     */
    function setRWAVault(address _rwaVault) external onlyOwner {
        address oldRwaVault = address(rwaVault);
        rwaVault = IBaseHybridVault(_rwaVault);
        emit RWAVaultUpdated(oldRwaVault, _rwaVault);
    }
    
    /**
     * @notice Sets the address of the liquidation proxy
     * @dev Only callable by the contract owner
     * @param _liquidationProxy The address of the new liquidation proxy contract
     */
    function setLiquidationStrategyProxy(address _liquidationProxy) external onlyOwner {
        if (_liquidationProxy == address(0)) revert AddressCannotBeZero();
        if (_liquidationProxy == liquidationStrategyProxy) revert SameAddressNotAllowed();
        
        address oldLiquidationProxy = liquidationStrategyProxy;
        liquidationStrategyProxy = _liquidationProxy;
        
        emit LiquidationStrategyProxyUpdated(oldLiquidationProxy, _liquidationProxy);
    }

    /**
     * @notice Sets the liquidation vault token split
     * @param mintBps Basic percentage of minting fee
     * @param burnBps Basic percentage of burning fee
     * @param swapBps Basic percentage of swapping fee
     * @param liquidityBps Basic percentage of liquidity fee
     */
    function setLiquidationVaultTokenSplit(uint256 mintBps, uint256 burnBps, uint256 swapBps, uint256 liquidityBps) external onlyManagerOrOwner() {
        if (mintBps + burnBps + swapBps + liquidityBps != 100_00) revert("invalid percentages");
        liquidationSplit.mintPercentage = mintBps;
        liquidationSplit.burnPercentage = burnBps;
        liquidationSplit.swapPercentage = swapBps;
        liquidationSplit.liquidityPercentage = liquidityBps;
        emit LiquidationVaultTokenSplitUpdated(mintBps, burnBps, swapBps, liquidityBps);
    }

     /**
     * @notice Sets the swapper address
     * @param _liquidationSwap Address of contract that handles the swaps
     */
    function setLiquidationSwap(address _liquidationSwap) external onlyOwner {
        address oldLiquidationSwap = liquidationSwap;
        liquidationSwap = _liquidationSwap;
        emit LiquidationSwapUpdated(oldLiquidationSwap, _liquidationSwap);
    }

    /**
     * @notice Sets the fee collector address
     * @param _feeCollector Address of the new fee collector
     */
    function setFeeCollector(address _feeCollector) external onlyOwner {
        address oldFeeCollector = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(oldFeeCollector, _feeCollector);
    }

    /**
     * @notice Sets the withdraw timelock duration: the cooldown between `requestWithdraw` and the execution window opening
     * @dev A request becomes executable at `readyAt = block.timestamp + withdrawTimelockDuration`. Setting 0 disables the timelock,
     *      letting `withdraw` run without a request.
     * @param _withdrawTimelockDuration Cooldown in seconds before a requested withdrawal becomes executable
     */
    function setWithdrawTimelockDuration(uint256 _withdrawTimelockDuration) external onlyOwner {
        uint256 oldWithdrawTimelockDuration = withdrawTimelockDuration;
        withdrawTimelockDuration = _withdrawTimelockDuration;
        emit WithdrawTimelockDurationUpdated(oldWithdrawTimelockDuration, _withdrawTimelockDuration);
    }

    /**
     * @notice Sets the withdraw timelock delay: the execution window that opens once the cooldown has elapsed
     * @dev `withdraw` is only valid while `readyAt <= block.timestamp < readyAt + withdrawTimelockDelay`. Setting 0 makes every
     *      pending request expire, which freezes Stability Pool withdrawals as an emergency lever.
     * @param _withdrawTimelockDelay Length in seconds of the window in which a ready withdrawal can be executed
     */
    function setWithdrawTimelockDelay(uint256 _withdrawTimelockDelay) external onlyOwner {
        uint256 oldWithdrawTimelockDelay = withdrawTimelockDelay;
        withdrawTimelockDelay = _withdrawTimelockDelay;
        emit WithdrawTimelockDelayUpdated(oldWithdrawTimelockDelay, _withdrawTimelockDelay);
    }

    /**
     * @notice Adds a new manager.
     * @param manager Address of the manager to add.
     */
    function addManager(address manager) external onlyOwner {
        if (isManager[manager]) revert ManagerAlreadyExists();
        isManager[manager] = true;
        managerList.push(manager);
        emit ManagerAdded(manager);
    }

    /**
     * @notice Removes an existing manager.
     * @param manager Address of the manager to remove.
     */
    function removeManager(address manager) external onlyOwner {
        if (!isManager[manager]) revert ManagerNotFound();
        isManager[manager] = false;
        for (uint256 i = 0; i < managerList.length; i++) {
            if (managerList[i] == manager) {
                managerList[i] = managerList[managerList.length - 1];
                managerList.pop();
                break;
            }
        }
        emit ManagerRemoved(manager);
    }

    /**
     * @notice Pauses the contract.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Gets the list of managers.
     * @return List of manager addresses.
     */
    function getManagerList() external view returns (address[] memory) {
        return managerList;
    }

    /**
     * @notice Checks if an address is a manager.
     * @param manager Address to check.
     * @return True if the address is a manager, false otherwise.
     */
    function isAddressManager(address manager) external view returns (bool) {
        return isManager[manager];
    }

    /**
     * @notice Gets the deposit amount for a user.
     * @param user Address of the user.
     * @return Deposit amount.
     */
    function getUserDeposit(address user) external view returns (uint256) {
        return deToken.getUserDeposit(user);
    }

    /**
     * @notice Gets the total deposits in the pool.
     * @return Total deposits amount.
     */
    function getTotalDeposits() external view returns (uint256) {
        return deToken.totalSupply();
    }

    /**
     * @notice Gets the pool index.
     * @return Pool index.
     */
    function getPoolIndex() external view returns (uint256) {
        return ILendingPool(lendingPool).getNormalizedIncome();
    }

    /**
     * @notice Gets the scaled total supply of the pool.
     * @return Scaled total supply amount.
     */
    function getRawTotalDeposits() external view returns (uint256) {
        return deToken.getRawTotalDeposits();
    }

    /**
     * @notice Gets the user index for a user.
     * @param user Address of the user.
     * @return User index.
     */
    function getUserIndex(address user) external view returns (uint256) {
        return deToken.getUserIndex(user);
    }

    /**
     * @notice Gets the scaled deposit for a user.
     * @param user Address of the user.
     * @return Scaled deposit amount.
     */
    function getScaledDeposit(address user) public view returns (uint256) {
        uint256 userBalance = deToken.rawBalanceOf(user);
        uint256 currentIndex = ILendingPool(lendingPool).getNormalizedIncome();
        uint256 userIndex = deToken.getUserIndex(user);
        
        if (userIndex == 0 || userBalance == 0) {
            return userBalance;
        }
        
        // raw * (usageIndex / positionIndex)
        uint256 indexMultiplier = currentIndex.rayDiv(userIndex);
        return userBalance.rayMulDown(indexMultiplier);
    }

    /**
     * @notice Checks if a user deposited in the same block
     * @param user The address of the user
     * @return True if the user deposited in the same block, false otherwise
     */
    function isUserDepositInSameBlock(address user) public view returns (bool) {
        return depositBlock[user] == block.number;
    }
}
