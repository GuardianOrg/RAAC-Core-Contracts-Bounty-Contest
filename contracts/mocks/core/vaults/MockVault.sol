// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../../interfaces/core/vaults/IBaseVault.sol";

/**
 * @title MockVault
 * @notice Mock implementation of IBaseVault using OpenZeppelin's ERC4626
 */
contract MockVault is IBaseVault, ERC20 {
    using SafeERC20 for IERC20;

    // Constants
    uint256 private constant DEAD_SHARES = 1000;
    uint256 private constant MIN_ASSETS = 10000;

    // State variables
    bool public initialized;
    uint256 private _accRewardPerShare;  // Accumulated rewards per share, scaled by 1e18
    IERC20 private immutable _asset;
    uint256 private immutable PRECISION;
    uint256 private _lastSharePrice;  // Track last share price for yield calculations

    // Events
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event RewardsDeposited(uint256 amount);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        require(address(asset_) != address(0), "Invalid asset address");
        _asset = asset_;
        PRECISION = 10**(18 - ERC20(address(asset_)).decimals());
        _lastSharePrice = 1e18;  // Initialize at 1:1
    }

    function initialize(address asset_) external {
        require(!initialized, "Already initialized");
        require(asset_ == address(_asset), "Asset mismatch");
        initialized = true;

        // Initialize with DEAD_SHARES to prevent inflation attacks
        _mint(address(1), DEAD_SHARES);
    }

    function _totalAssets() internal view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function depositRewards(uint256 amount) external {
        require(amount > 0, "Cannot deposit 0 rewards");
        uint256 supply = totalSupply();
        require(supply > 0, "No shares");
        
        // Transfer rewards to vault
        _asset.safeTransferFrom(msg.sender, address(this), amount);
        
        // Update share price
        _lastSharePrice = this.pricePerShare(true);
        
        emit RewardsDeposited(amount);
    }

    function _convertToShares(uint256 assets, bool isFloor) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return assets;
        }

        uint256 numerator = (supply + DEAD_SHARES) * assets * PRECISION;
        uint256 denominator = (_totalAssets() * PRECISION + 1);
        
        if (isFloor) {
            return numerator / denominator;
        } else {
            return (numerator + denominator - 1) / denominator;
        }
    }

    function _convertToAssets(uint256 shares, bool isFloor) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return shares;
        }

        uint256 numerator = shares * (_totalAssets() * PRECISION + 1);
        uint256 denominator = (supply + DEAD_SHARES) * PRECISION;

        if (isFloor) {
            return numerator / denominator;
        } else {
            return (numerator + denominator - 1) / denominator;
        }
    }

    function pricePerShare(bool isFloor) external view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return 10**18;
        }

        uint256 assets = _totalAssets();
        if (assets == 0) {
            return 10**18;
        }

        uint256 price = (assets * 1e18) / supply;
        
        if (isFloor) {
            return price;
        } else {
            return (price * 1001) / 1000; // Add 0.1% buffer for ceiling
        }
    }

    function deposit(uint256 assets, address receiver) external override returns (uint256) {
        require(initialized, "Not initialized");
        require(assets + _totalAssets() >= MIN_ASSETS, "Need more assets");
        
        uint256 shares = _convertToShares(assets, true);
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
        return shares;
    }

    function maxDeposit(address) external view override returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view override returns (uint256) {
        return _convertToAssets(balanceOf(owner), true);
    }

    function withdraw(uint256 assets, address receiver, address owner) external override returns (uint256) {
        require(initialized, "Not initialized");
        require(assets > 0, "Cannot withdraw 0");
        
        uint256 shares = _convertToShares(assets, false);
        require(shares <= balanceOf(owner), "Not enough shares");

        if (owner != msg.sender) {
            uint256 currentAllowance = allowance(owner, msg.sender);
            require(currentAllowance >= shares, "Not enough allowance");
            _approve(owner, msg.sender, currentAllowance - shares);
        }

        _burn(owner, shares);
        _asset.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        return shares;
    }

    function previewDeposit(uint256 assets) external view override returns (uint256) {
        return _convertToShares(assets, true);
    }

    function previewWithdraw(uint256 assets) external view override returns (uint256) {
        return _convertToShares(assets, false);
    }

    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    function asset() external view override returns (address) {
        return address(_asset);
    }
}