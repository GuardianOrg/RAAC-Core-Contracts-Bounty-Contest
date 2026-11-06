// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "../../interfaces/core/vaults/IVaultAssetAdapter.sol";
import "../../interfaces/core/vaults/IERC721VaultAdapter.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/core/oracles/IERC721PriceOracle.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title ERC721VaultAdapter
/// @author RAAC Protocol Team
/// @notice Vault-specific adapter implementing IVaultAssetAdapter for a single ERC721 token.
contract ERC721VaultAdapter is IVaultAssetAdapter, IERC721VaultAdapter, Ownable, IERC721Receiver {
    /// @notice Emitted when an NFT is deposited into the adapter
    event TokenDeposited(address indexed token, address indexed from, uint256 indexed tokenId);
    /// @notice Emitted when an NFT is withdrawn from the adapter
    event TokenWithdrawn(address indexed token, address indexed to, uint256 indexed tokenId);

    /// @notice ERC721 token managed by this adapter
    IERC721 public immutable token;
    /// @notice Oracle for NFT pricing
    IERC721PriceOracle public priceOracle;
    /// @notice Vault core contract allowed to call deposit/withdraw
    address public immutable vault;
    address private immutable _self;

    // Internal tracking of deposited tokenIds
    uint256[] private _tokenIds;
    mapping(uint256 => uint256) private _index;
    mapping(uint256 => bool) private _exists;

    /// @param _token Underlying ERC721 token
    /// @param _priceOracle Oracle returning price for each tokenId
    /// @param _vault Vault core address permitted to call adapter methods
    constructor(address _token, address _priceOracle, address _vault) Ownable(msg.sender) {
        require(_token != address(0),       "ERC721VaultAdapter: zero token");
        require(_priceOracle != address(0), "ERC721VaultAdapter: zero oracle");
        require(_vault != address(0),       "ERC721VaultAdapter: zero vault");
        _self = address(this);
        token = IERC721(_token);
        priceOracle = IERC721PriceOracle(_priceOracle);
        vault = _vault;
    }

    function setPriceOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "ERC20Adapter: address 0");
        require(_oracle != address(priceOracle), "ERC20Adapter: oracle address same as previous");

        priceOracle = IERC721PriceOracle(_oracle);
        emit PriceOracleUpdated(_oracle);
    }

    modifier onlyVault() {
        require(msg.sender == vault, "ERC721VaultAdapter: only vault");
        _;
    }

    /// @inheritdoc IVaultAssetAdapter
    function deposit(bytes calldata data, address from) public virtual onlyVault returns(uint256 value) {
        uint256 tokenId = abi.decode(data, (uint256));
        require(!_exists[tokenId], "ERC721VaultAdapter: already deposited");
        // Get the current price of the NFT
        (uint256 price,) = priceOracle.getLatestPrice(tokenId);
        require(price > 0, "ERC721VaultAdapter: price is zero, cannot deposit");

        // Transfer NFT from vault into adapter
        token.transferFrom(from, address(this), tokenId);

        _exists[tokenId] = true;
        _index[tokenId] = _tokenIds.length;
        _tokenIds.push(tokenId);

        emit TokenDeposited(address(token), from, tokenId);

        // Return its current price as normalized value
        return price;
    }

    /// @inheritdoc IVaultAssetAdapter
    function withdraw(bytes calldata data, address to) public virtual onlyVault returns(uint256 value) {
        uint256 tokenId = abi.decode(data, (uint256));
        require(_exists[tokenId], "ERC721VaultAdapter: not deposited");

        // Remove from tracking
        uint256 lastIndex = _tokenIds.length - 1;
        uint256 idx = _index[tokenId];
        if (idx != lastIndex) {
            uint256 lastId = _tokenIds[lastIndex];
            _tokenIds[idx] = lastId;
            _index[lastId] = idx;
        }
        _tokenIds.pop();
        delete _index[tokenId];
        delete _exists[tokenId];

        // Return NFT to recipient
        token.safeTransferFrom(address(this), to, tokenId);
        emit TokenWithdrawn(address(token), to, tokenId);
        (uint256 price,) = priceOracle.getLatestPrice(tokenId);
        return price;
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetValue(bytes calldata data) external view returns (uint256) {
        uint256 tokenId = abi.decode(data, (uint256));
        (uint256 price,) = priceOracle.getLatestPrice(tokenId);
        return price;
    }

    /// @inheritdoc IVaultAssetAdapter
    function totalValue() public view virtual returns (uint256 _totalValue) {
        uint256 len = _tokenIds.length;
        for (uint256 i = 0; i < len; ++i) {
            (uint256 price,) = priceOracle.getLatestPrice(_tokenIds[i]);
            _totalValue += price;
        }
        return _totalValue;
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetType() external pure returns (string memory) {
        return "ERC721";
    }

    /// @inheritdoc IVaultAssetAdapter
    function getAssetToken() external view returns (address) {
        return address(token);
    }

    /// @inheritdoc IVaultAssetAdapter
    function approve(address to, bytes calldata data) external returns (bool) {
        require(address(this) != _self, "Function must be called through delegatecall");
        IERC721(token).approve(to, abi.decode(data, (uint256)));
        return true;
    }

    /// @notice Returns the list of tokenIds deposited by a user
    /// @return tokenIds Array of deposited tokenIds
    function getDepositedTokens() external view returns (uint256[] memory) {
        return _tokenIds;
    }

    /// @notice Returns the total number of NFTs currently managed by the adapter
    /// @dev    Relies on the adapter's internal accounting and therefore is immune to
    ///         unsolicited transfers ("donations") that could otherwise distort the
    ///         vault state when relying on the raw ERC721 balance.
    function getDepositedTokensCount() external view returns (uint256) {
        return _tokenIds.length;
    }

    /// @notice Returns the tokenId stored at a given `index` in the internal list
    /// @param  index Position within the `_tokenIds` array (0-based)
    /// @return tokenId The tokenId held by the adapter at the provided `index`
    function getDepositedTokenAtIndex(uint256 index) external view returns (uint256 tokenId) {
        require(index < _tokenIds.length, "ERC721VaultAdapter: index out of bounds");
        return _tokenIds[index];
    }

    /// @notice Returns true if the tokenId is deposited in the adapter
    /// @param tokenId The tokenId to check
    /// @return true if the tokenId is deposited in the adapter, false otherwise
    function isDeposited(uint256 tokenId) public view returns (bool) {
        return _exists[tokenId];
    }

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("ERC721VaultAdapter: push deposits disabled");
    }
}
