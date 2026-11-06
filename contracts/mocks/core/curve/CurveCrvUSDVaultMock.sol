// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../interfaces/curve/ICurveCrvUSDVault.sol";

/// @title CurveCrvUSDVaultMock
/// @notice Mock implementation of the Curve crvUSD Vault for testing purposes
/// @dev This is a simplified mock that implements the ICurveCrvUSDVault interface
contract CurveCrvUSDVaultMock is ICurveCrvUSDVault, ERC20 {
    using SafeERC20 for IERC20;

    // State variables
    IERC20 public immutable assetToken;
    uint256 public totalIdleAssets;
    uint256 public totalDebtAssets;
    bool public shutdown;
    uint256 private _withdrawLimit;     
    
    // Constants
    uint256 public constant MAX_DEPOSIT = type(uint256).max;
    uint256 public constant PRECISION = 1e18;

    uint256 public _pricePerShare;

    /// @dev Set a hard upper-bound for maxWithdraw that is returned while running tests. Pass 0 to remove the limit.
    function setWithdrawLimit(uint256 limit) external {
        _withdrawLimit = limit;
    }

    constructor(address _asset, string memory _name, string memory _symbol) 
        ERC20(_name, _symbol) 
    {
        require(_asset != address(0), "Asset cannot be zero address");
        assetToken = IERC20(_asset);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!shutdown, "Vault is shutdown");
        require(assets > 0, "Cannot deposit zero assets");
        require(receiver != address(0), "Invalid receiver");
        
        // Calculate shares to mint (round DOWN as in production vaults)
        shares = _convertToSharesDown(assets);
        
        // Transfer assets from sender to vault
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        
        // Mint shares to receiver
        _mint(receiver, shares);
        
        // Update total idle assets
        totalIdleAssets += assets;
        
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function withdraw(
        uint256 assets,
        address receiver,
        address owner,
        uint256 maxLoss,
        address[] calldata strategies
    ) external returns (uint256 shares) {
        require(assets > 0, "Cannot withdraw zero assets");
        require(receiver != address(0), "Invalid receiver");
        
        // Calculate shares to burn (round UP so that shares * pricePerShare >= assets)
        shares = _convertToSharesUp(assets);
        
        // Check if caller is authorized to withdraw for owner
        if (msg.sender != owner) {
            uint256 currentAllowance = allowance(owner, msg.sender);
            require(currentAllowance >= shares, "Insufficient allowance");
            _approve(owner, msg.sender, currentAllowance - shares);
        }
        
        // Burn shares from owner
        _burn(owner, shares);
        
        // Transfer assets to receiver
        assetToken.safeTransfer(receiver, assets);
        
        // Update total idle assets
        totalIdleAssets = totalIdleAssets > assets ? totalIdleAssets - assets : 0;
        
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function asset() external view returns (address) {
        return address(assetToken);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function totalAssets() external view returns (uint256) {
        return totalIdleAssets + totalDebtAssets;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function pricePerShare() external view returns (uint256) {
        if (_pricePerShare > 0) {
            return _pricePerShare;
        }
        uint256 supply = totalSupply();
        if (supply == 0) {
            return PRECISION;
        }
        // round up to the nearest integer
        return (totalIdleAssets + totalDebtAssets) * PRECISION / supply;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function totalIdle() external view returns (uint256) {
        return totalIdleAssets;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function totalDebt() external view returns (uint256) {
        return totalDebtAssets;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function isShutdown() external view returns (bool) {
        return shutdown;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function maxWithdraw(address owner, uint256 maxLoss, address[] calldata strategies) external view returns (uint256) {
        if (shutdown) return 0;
        uint256 userShares = balanceOf(owner);
        if (userShares == 0) return 0;
        
        uint256 userAssets = _convertToAssets(userShares);
        uint256 availableAssets = totalIdleAssets;

        uint256 base = userAssets > availableAssets ? availableAssets : userAssets;
        if (_withdrawLimit != 0 && _withdrawLimit < base) {
            return _withdrawLimit;
        }
        return base;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function maxDeposit(address receiver) external view returns (uint256) {
        if (shutdown) return 0;
        return MAX_DEPOSIT;
    }

    /// @inheritdoc ICurveCrvUSDVault
    function previewWithdraw(uint256 assets) external view returns (uint256 shares) {
        return _convertToSharesUp(assets);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function previewDeposit(uint256 assets) external view returns (uint256 shares) {
        return _convertToSharesDown(assets);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function previewRedeem(uint256 shares) external view returns (uint256 assets) {
        return _convertToAssets(shares);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function redeem(
        uint256 shares,
        address receiver,
        address owner,
        uint256 maxLoss,
        address[] calldata strategies
    ) external returns (uint256 assets) {
        require(shares > 0, "Cannot redeem zero shares");
        require(receiver != address(0), "Invalid receiver");

        // Calculate assets to withdraw (round DOWN as per ERC4626 spec)
        assets = _convertToAssets(shares);

        // Check if caller is authorized to redeem for owner
        if (msg.sender != owner) {
            uint256 currentAllowance = allowance(owner, msg.sender);
            require(currentAllowance >= shares, "Insufficient allowance");
            _approve(owner, msg.sender, currentAllowance - shares);
        }

        // Burn shares from owner
        _burn(owner, shares);

        // Transfer assets to receiver
        assetToken.safeTransfer(receiver, assets);

        // Update total idle assets
        totalIdleAssets = totalIdleAssets > assets ? totalIdleAssets - assets : 0;

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @inheritdoc ICurveCrvUSDVault
    function maxRedeem(address owner, uint256 maxLoss, address[] calldata strategies) external view returns (uint256) {
        if (shutdown) return 0;
        uint256 userShares = balanceOf(owner);
        if (userShares == 0) return 0;

        // Calculate how many shares can be redeemed based on available assets
        uint256 availableAssets = totalIdleAssets;
        if (availableAssets == 0) return 0;

        // Convert available assets to shares (round down)
        uint256 maxSharesFromAssets = _convertToSharesDown(availableAssets);

        // Return the minimum of user's shares and what can be redeemed
        uint256 maxShares = userShares > maxSharesFromAssets ? maxSharesFromAssets : userShares;

        if (_withdrawLimit != 0) {
            // Convert withdraw limit to shares
            uint256 limitShares = _convertToSharesDown(_withdrawLimit);
            if (limitShares < maxShares) {
                return limitShares;
            }
        }

        return maxShares;
    }

    // Internal helper functions

    // @dev integer ceil division helper (x / y, rounding up)
    function _ceilDiv(uint256 x, uint256 y) private pure returns (uint256) {
        return x == 0 ? 0 : (x - 1) / y + 1;
    }

    /// @dev assets -> shares (rounding DOWN) – used for deposits
    function _convertToSharesDown(uint256 assets) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        return assets * supply / (totalIdleAssets + totalDebtAssets);
    }

    /// @dev assets -> shares (rounding UP) – used for withdrawals / previewWithdraw
    function _convertToSharesUp(uint256 assets) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        uint256 total = totalIdleAssets + totalDebtAssets;
        return _ceilDiv(assets * supply, total);
    }

    /// @dev shares -> assets (always rounds DOWN as per ERC4626 spec)
    function _convertToAssets(uint256 shares) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return shares;
        return shares * (totalIdleAssets + totalDebtAssets) / supply;
    }

    // Admin functions for testing
    function setShutdown(bool _shutdown) external {
        shutdown = _shutdown;
    }

    function setTotalDebt(uint256 _totalDebt) external {
        totalDebtAssets = _totalDebt;
    }

    function setTotalIdle(uint256 _totalIdle) external {
        totalIdleAssets = _totalIdle;
    }

    function adjustPricePerShare(uint256 __pricePerShare) external {
        _pricePerShare = __pricePerShare;

        // Keep internal accounting consistent: update totalIdleAssets so that
        // pricePerShare = (totalIdleAssets + totalDebtAssets) / totalSupply.
        uint256 supply = totalSupply();
        if (supply > 0) {
            uint256 desiredTotalAssets = (__pricePerShare * supply) / PRECISION;
            // Prevent underflow if debt exceeds desired total assets (should not happen in tests)
            if (desiredTotalAssets > totalDebtAssets) {
                totalIdleAssets = desiredTotalAssets - totalDebtAssets;
            } else {
                totalIdleAssets = 0;
            }
        }
    }

}