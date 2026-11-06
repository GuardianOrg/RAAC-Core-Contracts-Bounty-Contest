// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "../../../interfaces/core/pools/LendingPool/IAssetAdapter.sol";
import "../../../interfaces/core/pools/LendingPool/IERC721Adapter.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../../interfaces/core/oracles/IERC721PriceOracle.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title ERC721AssetAdapter
/// @author RAAC Protocol Team
/// @notice Adapter for ERC721 collateral, prices in crvUSD (18 decimals)
/// @dev Only the registered LendingPool may invoke deposit/withdraw
/// @dev The oracle must be an ASSET/crvUSD price feed and return value in 18 decimals.
contract ERC721AssetAdapter is IAssetAdapter, IERC721Adapter, Ownable, IERC721Receiver {
    IERC721 public immutable token;
    IERC721PriceOracle public priceOracle;
    address public immutable lendingPool;

    // Tracks which tokenIds each user has deposited
    mapping(address => mapping(uint256 => bool)) private _deposits;
    // Tracks list of deposited tokenIds per user for enumeration
    mapping(address => uint256[]) private _depositedTokens;
    // Maps tokenId to its index in the user's depositedTokens array
    mapping(address => mapping(uint256 => uint256)) private _depositedTokensIndex;
    // Reverse mapping from tokenId to depositor
    mapping(uint256 => address) private _tokenOwner;
    // Upper bound on depositable tokens per user
    uint256 public maxTokenPerUser = 10;

    /// @notice Emitted when a user deposits an NFT
    event NFTDeposited(address indexed token, address indexed user, uint256 indexed tokenId);
    /// @notice Emitted when a user withdraws an NFT
    event NFTWithdrawn(address indexed token, address indexed user, uint256 indexed tokenId);
    /// @notice Emitted when the price oracle is updated
    event PriceOracleSet(address indexed oracle);
    /// @notice Emitted when the max token per user is set
    event MaxTokenPerUserSet(uint256 _maxTokenPerUser);

    /// @param _token Address of the ERC721 collateral token
    /// @param _priceOracle Address of oracle returning price in crvUSD (18 decimals)
    /// @param _lendingPool Address of the LendingPool contract allowed to call adapter
    constructor(address _token, address _priceOracle, address _lendingPool) Ownable(msg.sender) {
        require(_token != address(0), "ERC721Adapter: zero token");
        require(_priceOracle != address(0), "ERC721Adapter: zero price oracle");
        require(_lendingPool != address(0), "ERC721Adapter: zero lending pool");
        token = IERC721(_token);
        priceOracle = IERC721PriceOracle(_priceOracle);
        lendingPool = _lendingPool;
    }

    /// @inheritdoc IAssetAdapter
    function setPriceOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "ERC721Adapter: address 0");
        require(_oracle != address(priceOracle), "ERC721Adapter: oracle address same as previous");

        priceOracle = IERC721PriceOracle(_oracle);
        emit PriceOracleSet(_oracle);
    }

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "ERC721Adapter: only pool");
        _;
    }

    /// @inheritdoc IAssetAdapter
    function deposit(address user, bytes calldata data) external override onlyLendingPool {
        uint256 tokenId = abi.decode(data, (uint256));
        require(!_deposits[user][tokenId], "ERC721Adapter: already deposited");
        require(token.ownerOf(tokenId) == user, "ERC721Adapter: not owner");
        require(_depositedTokens[user].length < maxTokenPerUser, "Token deposit exceeds user max deposit allowance"); 

        // To block reentrancy, transfer NFT into adapter first
        token.transferFrom(user, address(this), tokenId);

        // Effects: record state before interaction
        _deposits[user][tokenId] = true;
        _tokenOwner[tokenId] = user;
        _depositedTokensIndex[user][tokenId] = _depositedTokens[user].length;
        _depositedTokens[user].push(tokenId);
        emit NFTDeposited(address(token), user, tokenId);
    }

    /// @inheritdoc IAssetAdapter
    function withdraw(address user, bytes calldata data) external override onlyLendingPool {
        uint256 tokenId = abi.decode(data, (uint256));
        _transferAsset(user, tokenId, user);

        emit NFTWithdrawn(address(token), user, tokenId);
    }

    /// @inheritdoc IAssetAdapter
    function transferAsset(address user, bytes calldata data, address to) external override onlyLendingPool {
        uint256 tokenId = abi.decode(data, (uint256));
        _transferAsset(user, tokenId, to);
        emit NFTWithdrawn(address(token), to, tokenId);
    }

    function setMaxTokenPerUser(uint256 _maxTokenPerUser) external onlyOwner { 
        require(_maxTokenPerUser > maxTokenPerUser, "Max depositable tokens must increase");
        maxTokenPerUser = _maxTokenPerUser;
        emit MaxTokenPerUserSet(_maxTokenPerUser);
    }

    function _transferAsset(address user, uint256 tokenId, address to) internal {
        require(_deposits[user][tokenId], "ERC721Adapter: not deposited");
        require(_tokenOwner[tokenId] == user, "ERC721Adapter: not depositor");

        // Effects: remove from user's list
        uint256 lastIndex = _depositedTokens[user].length - 1;
        uint256 tokenIndex = _depositedTokensIndex[user][tokenId];
        if (tokenIndex != lastIndex) {
            uint256 lastTokenId = _depositedTokens[user][lastIndex];
            _depositedTokens[user][tokenIndex] = lastTokenId;
            _depositedTokensIndex[user][lastTokenId] = tokenIndex;
        }
        _depositedTokens[user].pop();
        delete _depositedTokensIndex[user][tokenId];
        _deposits[user][tokenId] = false;
        delete _tokenOwner[tokenId];

        // Interaction: return NFT to user
        token.safeTransferFrom(address(this), to, tokenId);
    }

    /// @inheritdoc IAssetAdapter
    function getAssetValue(address user, bytes calldata data) external view override returns (uint256) {
        uint256 tokenId = abi.decode(data, (uint256));
        // require(_deposits[user][tokenId], "ERC721Adapter: not deposited");
        (uint256 price,) = priceOracle.getLatestPrice(tokenId);
        return price;
    }

    /// @inheritdoc IAssetAdapter
    function getWithdrawValue(address user, bytes calldata data) external view override returns (uint256) {
        uint256 tokenId = abi.decode(data, (uint256));
        // require(_deposits[user][tokenId], "ERC721Adapter: not deposited");
        (uint256 price,) = priceOracle.getLatestPrice(tokenId);
        return price;
    }

    /// @dev Generate the keccak key for the position
    function _computeKey(uint256 tokenId) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(address(token), tokenId));
    }

    /// @inheritdoc IAssetAdapter
    function getPositionKey(bytes calldata data) external view override returns (bytes32) {
        uint256 tokenId = abi.decode(data, (uint256));
        return _computeKey(tokenId);
    }

    /// @inheritdoc IAssetAdapter
    function supportsPartialWithdraw() external pure override returns (bool) {
        return false;
    }

    /// @inheritdoc IAssetAdapter
    function getAssetType() external pure override returns (string memory) {
        return "ERC721";
    }

    /// @inheritdoc IAssetAdapter
    function getAssetToken() external view override returns (address) {
        return address(token);
    }

    /// @inheritdoc IAssetAdapter
    function getPositionKeys(address user) external view returns(bytes32[] memory) {
        bytes32[] memory positionKeys = new bytes32[](_depositedTokens[user].length);
        for (uint256 i = 0; i < positionKeys.length; i++) {
            uint256 tokenId = _depositedTokens[user][i];
            positionKeys[i] = _computeKey(tokenId);
        } 
        return positionKeys;
    }

    /// @inheritdoc IAssetAdapter
    /// @dev Although it is expensive call to loop through all the tokens, it will be used in the view model only for lending pool.
    /// @dev Will be subsituted with off-chain calculation in the future.
    /// @dev Check usage in LendingPool.sol::getUserDebt()
    function getTotalAssetValue(address user) external view override returns(uint256 totalValue) {
        uint256 length = _depositedTokens[user].length;
        for (uint256 i = 0; i < length; i++) {
            uint256 tokenId = _depositedTokens[user][i];
            (uint256 price,) = priceOracle.getLatestPrice(tokenId);
            totalValue += price;
        }
        return totalValue;
    }

    /// @inheritdoc IERC721Adapter
    function getDepositedTokens(address user) external view returns (uint256[] memory) {
        return _depositedTokens[user];
    }

    /// @inheritdoc IERC721Adapter
    function getDepositor(uint256 tokenId) external view returns (address) {
        return _tokenOwner[tokenId];
    }

    /// @inheritdoc IERC721Adapter
    function tokenOfOwnerByIndex(address user, uint256 index) external view returns (uint256) {
        require(index < _depositedTokens[user].length, "ERC721Adapter: index out of bounds");
        return _depositedTokens[user][index];
    }

    /// @inheritdoc IAssetAdapter
    function validateLiquidationData(address user, bytes calldata data) external view returns(bool) {
        uint256 tokenId = abi.decode(data, (uint256));
        return _tokenOwner[tokenId] == user;
    }

    /// @inheritdoc IAssetAdapter
    function validate(address user, bytes calldata data) external view {
        // Validate ownership
        uint256 tokenId = abi.decode(data, (uint256));
        require(_tokenOwner[tokenId] == user, "ERC721Adapter: not depositor");
    }

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("ERC721AssetAdapter: push deposits disabled");
    }
}
