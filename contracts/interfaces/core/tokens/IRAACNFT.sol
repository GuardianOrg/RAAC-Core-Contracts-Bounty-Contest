// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";

interface IRAACNFT is IERC721, IERC721Enumerable, IERC2981 {
    struct FeeStructure {
        uint256 mintFee;
        uint256 tradeFee;
    }

    function mint(uint256 _tokenId, uint256 _amount) external;
    function getHousePrice(uint256 _tokenId) external view returns (uint256);
    function setBaseUri(string memory _uri) external;
    function setMintFee(uint256 newFee) external;
    function setTradeFee(uint256 newFee) external;
    function setMaxFee(uint256 newFee) external;
    function minterMint(address to, uint256 tokenId) external;
    function addMinter(address minter) external;
    function removeMinter(address minter) external;
    function setAllowBurning(bool _allowBurning) external;
    function transferRole(bytes32 role, address oldAddress, address newAddress) external;
    function withdrawUnderlying(address tokenAddress, address to, uint256 amount) external returns (bool);
    function getAllTokens(uint256 start, uint256 end) external view returns (uint256[] memory);
    function getAllTokens() external view returns (uint256[] memory);
    function getTokensByOwner(address owner, uint256 start, uint256 end) external view returns (uint256[] memory);
    function getTokensByOwner(address owner) external view returns (uint256[] memory);
    function getMintPrice(uint256 _tokenId) external view returns (uint256);
    function setFeeCollector(address _feeCollector) external;
    function getFeeStructure() external view returns (FeeStructure memory);
    function burn(uint256 tokenId, bool disabled) external;
    function setHousePriceOracle(address _housePrices) external;
    // Events
    event NFTMinted(address indexed minter, uint256 tokenId, uint256 price, uint256 mintFee);
    event BaseURIUpdated(string uri);
    event NFTFeeUpdated(uint256 fee);
    event NFTFeePaid(address indexed payer, uint256 fee);
    event AllowBurningUpdated(bool allowBurning);
    event MaxFeeUpdated(uint256 maxFee);
    event MintFeeUpdated(uint256 mintFee);
    event TradeFeeUpdated(uint256 tradeFee);
    event RoleTransferred(bytes32 indexed role, address indexed previousAddress, address indexed newAddress);
    event KYCVerifyModuleUpdated(address kycVerifyModule);
    event FeeCollectorUpdated(address feeCollector);
    event NFTRoyaltyFeeCollectorUpdated(address nftRoyaltyFeeCollector);
    event AllowMintingUpdated(bool allowMinting);
    event HousePriceOracleUpdated(address housePrices);
    event UpdateRemint(uint256 tokenId, bool disabled);
    // Errors
    error HousePriceZero();
    error InsufficientFundsMint();
    error InvalidAddress();
    error TokenAlreadyMinted();
    error InsufficientBalance();
    error ExceedsMaxFee();
    error ZeroAddress();
    error InvalidRange();
    error ApprovalFailed();
    error BurningDisabled();
    error HousePricePending();
    error MintingDisabled();
    error CannotRemint();
    error RemintAlreadyEnabled();
}