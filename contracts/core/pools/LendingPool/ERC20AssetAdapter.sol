// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../../interfaces/core/pools/LendingPool/IAssetAdapter.sol";
import "@openzeppelin/contracts/access/Ownable.sol";


/// @notice Minimal interface for oracle providing token prices in crvUSD (18 decimals)
interface IPriceOracle {
    /// @notice Returns the price of 1 unit of `token` in crvUSD (18-decimal)
    function getLatestPrice() external view returns (uint256);
}

/// @notice custom methods belonging to ERC20 Adapter only
interface IERC20Adapter {
    /// @notice Returns the raw asset balance of the user
    /// @param user The address of the user
    function balanceOf(address user) external returns (uint256);
}

/// @title ERC20AssetAdapter
/// @author RAAC Protocol Team
/// @notice Adapter for ERC20 collateral, normalizes token units to 18 decimals (crvUSD standard)
/// @dev Only the registered LendingPool may invoke deposit/withdraw; calldata is `amount`
/// @dev The oracle must be an ASSET/crvUSD price feed and return value in 18 decimals.
contract ERC20AssetAdapter is IAssetAdapter, IERC20Adapter, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IPriceOracle public priceOracle;
    address public immutable lendingPool;

    // User balances of the collateral token
    mapping(address => uint256) private _balances;

    /// @notice Emitted when a user deposits tokens
    event TokenDeposited(address indexed token, address indexed user, uint256 amount);
    /// @notice Emitted when a user withdraws tokens
    event TokenWithdrawn(address indexed token, address indexed user, uint256 amount);
    /// @notice Emitted when the price oracle is updated
    event PriceOracleSet(address indexed oracle);

    /// @param _token Address of the ERC20 collateral token
    /// @param _priceOracle Address of oracle returning price in crvUSD (18 decimals)
    /// @param _lendingPool Address of the LendingPool contract allowed to call adapter
    constructor(address _token, address _priceOracle, address _lendingPool) Ownable(msg.sender) {
        require(_token != address(0), "ERC20Adapter: zero token");
        require(_priceOracle != address(0), "ERC20Adapter: zero price oracle");
        require(_lendingPool != address(0), "ERC20Adapter: zero lending pool");
        token = IERC20(_token);
        priceOracle = IPriceOracle(_priceOracle);
        lendingPool = _lendingPool;
    }

    /**
     * @notice Set the price oracle
     * @param _oracle The new price oracle address
     */
    function setPriceOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "ERC20Adapter: address 0");
        require(_oracle != address(priceOracle), "ERC20Adapter: oracle address same as previous");

        priceOracle = IPriceOracle(_oracle);
        emit PriceOracleSet(_oracle);
    }

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "ERC20Adapter: only pool");
        _;
    }

    /// @inheritdoc IAssetAdapter
    /// @dev Does not support fee-on-transfer tokens because we will be working with no fee-on-transfer tokens.
    function deposit(address user, bytes calldata data) external override onlyLendingPool {
        uint256 amount = abi.decode(data, (uint256));
        require(amount > 0, "ERC20Adapter: invalid amount");

        // To block reentrancy, transfer tokens first
        token.safeTransferFrom(user, address(this), amount);
        // Effects: update balance
        _balances[user] += amount;

        emit TokenDeposited(address(token), user, amount);
    }

    /// @inheritdoc IAssetAdapter
    function withdraw(address user, bytes calldata data) external override onlyLendingPool {
        uint256 amount = abi.decode(data, (uint256));
        _transferAsset(user, amount, user);

        emit TokenWithdrawn(address(token), user, amount);
    }

    /// @inheritdoc IAssetAdapter
    /// @dev Used mainly in liquidation where entire amount will be liquidated.
    function transferAsset(address user, bytes calldata data, address to) external override onlyLendingPool {
        uint256 amount = _balances[user];

        _transferAsset(user, amount, to);
        emit TokenWithdrawn(address(token), to, amount);
    }

    function _transferAsset(address user, uint256 amount, address to) internal {
        uint256 bal = _balances[user];
        require(amount > 0 && bal >= amount, "ERC20Adapter: insufficient balance");

        // Effects: update balance
        _balances[user] = bal - amount;

        // Interaction: transfer tokens
        token.safeTransfer(to, amount);
    }

    /// @inheritdoc IAssetAdapter
    function getAssetValue(address user, bytes calldata) external view override returns (uint256) {
        return _assetValue(user);
    }

    function _assetValue(address user) internal view returns (uint256) {
        uint256 amount = _balances[user];
        if (amount == 0) return 0;
        uint8 decimals = IERC20Metadata(address(token)).decimals();
        uint256 normalized = amount * (10 ** (18 - decimals));
        uint256 price = priceOracle.getLatestPrice();
        return (normalized * price) / 1e18;
    }

    /// @inheritdoc IAssetAdapter
    function getWithdrawValue(address user, bytes calldata data) external view override returns (uint256) {
        uint256 amount = abi.decode(data, (uint256));
        require(_balances[user] >= amount, "ERC20Adapter: insufficient balance");
        uint8 decimals = IERC20Metadata(address(token)).decimals();
        uint256 normalized = amount * (10 ** (18 - decimals));
        uint256 price = priceOracle.getLatestPrice();
        return (normalized * price) / 1e18;
    }

    /// @dev Generate the keccak key for the position
    function _computeKey() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(address(token)));
    }

    /// @inheritdoc IAssetAdapter
    function getPositionKey(bytes calldata) external view override returns (bytes32) {
        return keccak256(abi.encodePacked(address(token)));
    }

    /// @inheritdoc IAssetAdapter
    function supportsPartialWithdraw() external pure override returns (bool) {
        return true;
    }

    /// @inheritdoc IAssetAdapter
    function getAssetType() external pure override returns (string memory) {
        return "ERC20";
    }

    /// @inheritdoc IAssetAdapter
    function getAssetToken() external view override returns (address) {
        return address(token);
    }

    /// @inheritdoc IAssetAdapter
    function getPositionKeys(address) external view returns(bytes32[] memory) {
        bytes32[] memory positionKeys = new bytes32[](1);
        positionKeys[0] = _computeKey();

        return positionKeys;
    }

    /// @inheritdoc IAssetAdapter
    function getTotalAssetValue(address user) external view override returns(uint256) {
        return _assetValue(user);
    }

    /// @inheritdoc IERC20Adapter
    function balanceOf(address user) external view returns(uint256) {
        return _balances[user];
    }

    /// @inheritdoc IAssetAdapter
    function validateLiquidationData(address user, bytes calldata data) external view returns(bool) {
        uint256 amount = abi.decode(data, (uint256));
        return _balances[user] == amount;
    }

    /// @inheritdoc IAssetAdapter
    /// @dev ERC20 does not require validation of the parameter since it is the amount
    function validate(address user, bytes calldata data) external view {}
}