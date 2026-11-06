// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/core/vaults/IVaultAssetAdapter.sol";
import "../../interfaces/core/oracles/IERC20PriceOracle.sol";

/**
 * @title ERC20VaultAdapter
 * @author RAAC Protocol Team
 * @notice Vault-specific adapter implementing IVaultAssetAdapter for a single ERC20 token.
 * @dev Assuming non-rebasing and no fee-on-transfer tokens are being used (e.g. mainly stablecoins are accepted, crvUSD, goldUSD, USDC)
 */
contract ERC20VaultAdapter is IVaultAssetAdapter, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Emitted when tokens are deposited into the adapter
    event TokenDeposited(address indexed token, address indexed from, uint256 amount);
    /// @notice Emitted when tokens are withdrawn from the adapter
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice ERC20 token managed by this adapter
    IERC20 public immutable token;
    /// @notice Oracle address for price
    IERC20PriceOracle public priceOracle;
    /// @notice Vault core contract allowed to call deposit/withdraw
    address public immutable vault;
    address private immutable _self;
    uint256 public totalDeposited;

    /// @param _token Underlying ERC20 token
    /// @param _priceOracle Address of oracle returning price in crvUSD (18 decimals)
    /// @param _vault Vault core address permitted to call adapter methods
    constructor(address _token, address _priceOracle, address _vault) Ownable(msg.sender) {
        require(address(_token) != address(0), "ERC20VaultAdapter: zero token");
        require(address(_priceOracle) != address(0), "ERC20VaultAdapter: zero oracle");
        require(_vault != address(0), "ERC20VaultAdapter: zero vault");
        _self = address(this);
        token = IERC20(_token);
        priceOracle = IERC20PriceOracle(_priceOracle);
        vault = _vault;
    }

    /// @inheritdoc IVaultAssetAdapter
    function setPriceOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "ERC20Adapter: address 0");
        require(_oracle != address(priceOracle), "ERC20Adapter: oracle address same as previous");

        priceOracle = IERC20PriceOracle(_oracle);
        emit PriceOracleUpdated(_oracle);
    }

    /**
     * @notice Modifier to ensure only the vault can call the function
     */
    modifier onlyVault() {
        require(msg.sender == vault, "ERC20VaultAdapter: only vault");
        _;
    }

    /// @inheritdoc IVaultAssetAdapter
    function deposit(bytes calldata data, address from) external onlyVault returns(uint256) {
        uint256 amount = abi.decode(data, (uint256));
        require(amount > 0, "ERC20VaultAdapter: invalid amount");
        // Pull tokens from vault into this adapter
        token.safeTransferFrom(from, address(this), amount);
        totalDeposited += amount;
        emit TokenDeposited(address(token), from, amount);

        return _assetValue(amount);
    }

    /// @inheritdoc IVaultAssetAdapter
    function withdraw(bytes calldata data, address to) external onlyVault returns(uint256 value) {
        uint256 amount = abi.decode(data, (uint256));
        require(amount > 0, "ERC20VaultAdapter: invalid amount");
        require(totalDeposited >= amount, "ERC20VaultAdapter: insufficient balance");

        totalDeposited -= amount;
        token.safeTransfer(to, amount);
        emit TokenWithdrawn(address(token), to, amount);

        return _assetValue(amount);
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetValue(bytes calldata data) external view returns (uint256) {
        uint256 amount = abi.decode(data, (uint256));
        return _assetValue(amount);
    }

    /// @inheritdoc IVaultAssetAdapter
    function totalValue() external view returns (uint256) {
        return _assetValue(totalDeposited);
    }

    /// @dev Get the value of the asset based on oracle
    function _assetValue(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint8 decimals = IERC20Metadata(address(token)).decimals();
        uint256 normalized = amount * (10 ** (18 - decimals));
        uint256 price = priceOracle.getLatestPrice();
        return (normalized * price) / 1e18;
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetType() external pure returns (string memory assetType) {
        return "ERC20";
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetToken() external view returns (address tokenAddr) {
        return address(token);
    }

    /// @inheritdoc IVaultAssetAdapter
    function approve(address spender, bytes calldata data) external returns (bool) {
        require(address(this) != _self, "Function must be called through delegatecall");
        return IERC20(token).approve(spender, abi.decode(data, (uint256)));
    }
}
