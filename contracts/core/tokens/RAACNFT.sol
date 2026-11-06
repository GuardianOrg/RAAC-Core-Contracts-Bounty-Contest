// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../../interfaces/core/oracles/IRAACHousePrices.sol";
import "../../interfaces/core/tokens/IRAACNFT.sol";
import "../../interfaces/core/collectors/IFeeCollector.sol";
import "../primitives/WithCompliance.sol";

import {IKYCVerifyModule} from "../oracles/KYCVerifyModule.sol";

/**
 * @title RAACNFT
 * @author RAAC Protocol Team
 * @notice The core contract for the RAAC NFT. It allows external users to mint/purchase RAAC NFTs.
 * @dev Accepted token: crvUSD (18 decimals). The RAAC House Prices return price in 18 decimals and is developed for RAAC NFT only.
 */
contract RAACNFT is ERC721, ERC721Enumerable, AccessControl, ReentrancyGuard, IRAACNFT, Ownable, WithCompliance {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant WITHDRAW_ROLE = keccak256("WITHDRAW_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    IERC20 public token;
    IRAACHousePrices public raac_hp;

    /// @notice Fees enforced to the minting
    uint256 public MINT_FEE_PERCENTAGE = 0; // as basis point (eg: 2 = 0.02%, 20_00 = 20%)
    uint256 public MAX_FEE_PERCENTAGE = 0; // as basis point (eg: 2 = 0.02%, 20_00 = 20%). 0 = no maximum
    /// @notice Fees enforced to the secondary market sales
    uint256 public TRADE_FEE_PERCENTAGE = 0; // as basis point (eg: 1_00 = 1%). 0 = no trade fee
    /// @notice Maximun allowed age for price data (default 1 hout)
    uint256 PRICE_STALENESS_THRESHOLD  = 3600;

    /// @notice Address of the fee collector to which the mint fees are sent
    address public feeCollector;
    /// @notice Address of the royalty fee collector to which the trade fees are sent
    address public nftRoyaltyFeeCollector;
    /// @notice Address of the KYC verify module
    /// @dev If unset, KYC is disabled
    address public kycVerifyModule;

    /// @notice Whether we allow burning NFTs
    bool public allowBurning = false;

    /// @notice Whether we allow minting NFTs
    bool public allowMinting = true;

    /// @notice Whether a burned nft is mintable again
    mapping(uint256 => bool) public disableReminting;

    /// @notice Base URI for the NFTs
    /// @dev Used as placeholder. The deployment will set the actual URI.
    string public baseURI = "ipfs://QmZzEbTnUWs5JDzrLKQ9yGk1kvszdnwdMaVw9vNgjCFLo2/";

    /**
     * @notice Emitted when lthe price staleness threshold is updated
     * @param oldThreshold The value of old threshold
     * @param newThreshold The value of new threshold
    */
    event PriceStalenessThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

     /// @notice Emitted when stale price data is detected
    error StalePriceData();

    constructor(address _token, address _housePrices, address _complianceRegistry, address initialOwner) ERC721("RAAC NFT", "RAACNFT") Ownable(initialOwner) WithCompliance(_complianceRegistry) {
        if (_token == address(0) || _housePrices == address(0) || initialOwner == address(0) || _complianceRegistry == address(0)) {
            revert InvalidAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(WITHDRAW_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        
        token = IERC20(_token);
        raac_hp = IRAACHousePrices(_housePrices);
    }
  
    /** 
     * @notice Add a minter to the contract
     * @param minter The address of the minter to add
     */
    function addMinter(address minter) external onlyRole(ADMIN_ROLE) {
        _grantRole(MINTER_ROLE, minter);
    }

    /** 
     * @notice Remove a minter from the contract
     * @param minter The address of the minter to remove
     */
    function removeMinter(address minter) external onlyRole(ADMIN_ROLE) {
        _revokeRole(MINTER_ROLE, minter);
    }

    /** 
     * @notice Get the base URI for the contract
     * @return The base URI
     */
    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

     /** 
     * @notice Set the trade fee percentage for secondary market sales
     * @param _tradeFeePercentage The trade fee as basis points (100 = 1%)
     */
    function setTradeFee(uint256 _tradeFeePercentage) external onlyRole(ADMIN_ROLE) {
        if(_tradeFeePercentage >= 100_00)  revert ExceedsMaxFee(); 
        TRADE_FEE_PERCENTAGE = _tradeFeePercentage;
        emit TradeFeeUpdated(_tradeFeePercentage);
    }

    /**
     * @notice Returns the royalty info for a token (see ERC2981)
     * @param _tokenId The token ID
     * @param _salePrice The sale price of the token
     */
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice) public view virtual returns (address receiver, uint256 royaltyAmount) {
        if (nftRoyaltyFeeCollector == address(0) || TRADE_FEE_PERCENTAGE == 0) {
            return (address(0), 0);
        }
        receiver = nftRoyaltyFeeCollector;
        royaltyAmount = (_salePrice * TRADE_FEE_PERCENTAGE) / 100_00;
        return (receiver, royaltyAmount);
    }

    /** 
     * @notice Set the mint fee for the contract in basis points (eg: 2 = 0.02%, 20_00 = 20%)
     * @param newFee The new mint fee
     */
    function setMintFee(uint256 newFee) external onlyRole(ADMIN_ROLE) {
        if(newFee > MAX_FEE_PERCENTAGE && MAX_FEE_PERCENTAGE != 0) revert ExceedsMaxFee();
        MINT_FEE_PERCENTAGE = newFee;
        emit NFTFeeUpdated(MINT_FEE_PERCENTAGE);
    }

      /**
     * @notice Set the price staleness threshold
     * @param _threshold Maximum allowed age for price data in seconds
     */
    function setPriceStalenessThreshold(uint256 _threshold) external onlyRole(ADMIN_ROLE) {
        uint256 oldThreshold = PRICE_STALENESS_THRESHOLD;
        PRICE_STALENESS_THRESHOLD = _threshold;
        emit PriceStalenessThresholdUpdated(oldThreshold, _threshold);
    }

    /** 
     * @notice Mint a new NFT
     * @param _tokenId The ID of the token to mint
     * @param _amount The price of the token to mint in crvUSD
     */
    function mint(uint256 _tokenId, uint256 _amount) public override nonReentrant notBlacklisted(msg.sender) {
        if (!allowMinting) revert MintingDisabled();
        if (raac_hp.isPendingRequest(_tokenId)) revert HousePricePending();

        (uint256 price, uint256 timestamp ) = raac_hp.getLatestPrice(_tokenId);
        if(price == 0) revert HousePriceZero();
        _validatePriceFreshness(timestamp);

        uint256 mintFee = (price > 0) ? price * MINT_FEE_PERCENTAGE / 100_00 : 0;
        uint256 totalPrice = price + mintFee;
        if(totalPrice > _amount) revert InsufficientFundsMint();

        // Verify the user has approved the ZKME cooperator
        if (kycVerifyModule != address(0)) {
            if(!IKYCVerifyModule(kycVerifyModule).verifyKYC(msg.sender)) {
                revert IKYCVerifyModule.KYCNotVerified();
            }
        }

        // transfer erc20 from user to contract 
        token.safeTransferFrom(msg.sender, address(this), totalPrice);

        // mint tokenId to user
        _initiateMint(msg.sender, _tokenId, price);

        if(mintFee > 0) {
            if(feeCollector != address(0)) {
                // If not set, we will expect admin_role to deal with the fee
                bool approve = IERC20(token).approve(feeCollector, mintFee);
                if (!approve) revert ApprovalFailed();
                IFeeCollector(feeCollector).collectFee(address(token), address(this), mintFee, keccak256("MINT_FEE"));
            }
            emit NFTFeePaid(msg.sender, mintFee);
        }
    }

    /** 
     * @notice Minter mint a new NFT
     * @param to The address to mint the token to
     * @param tokenId The ID of the token to mint
     * @dev The method will not require strick KYC. Minter is expected to handle the KYC verification if required.
     */
    function minterMint(address to, uint256 tokenId) external onlyRole(MINTER_ROLE) nonReentrant {
        if(to == address(0)) revert ZeroAddress();
        _initiateMint(to, tokenId, 0);
    }

    /** 
     * @notice Internal function to initiate a mint
     * @param to The address to mint the token to
     * @param tokenId The ID of the token to mint
     * @dev If remint, set reminting to false for the tokenId
     */
    function _initiateMint(address to, uint256 tokenId, uint256 price) internal {
        if (disableReminting[tokenId]) revert CannotRemint();
        _safeMint(to, tokenId);
        emit NFTMinted(msg.sender, tokenId, price, MINT_FEE_PERCENTAGE);
    }

    /** 
     * @notice Get the house price for a token
     * @param _tokenId The ID of the token to get the house price for
     * @return The house price for the token
     */
    function getHousePrice(uint256 _tokenId) public view override returns(uint256) {
        (uint256 price, ) = raac_hp.getLatestPrice(_tokenId);
        return price;
    }

    /** 
     * @notice Set the house price oracle
     * @param _housePrices The new house price oracle address
     */
    function setHousePriceOracle(address _housePrices) external onlyRole(ADMIN_ROLE) {
        if(_housePrices == address(0)) revert ZeroAddress();
        raac_hp = IRAACHousePrices(_housePrices);
        emit HousePriceOracleUpdated(_housePrices);
    }

    /** 
     * @notice Get the mint fee for a token
     * @param _tokenId The ID of the token to get the mint fee for
     * @return The mint fee for the token
     */
    function getMintPrice(uint256 _tokenId) public view returns(uint256) {
        (uint256 price, ) = raac_hp.getLatestPrice(_tokenId);
        uint256 mintFee = (price > 0) ? price * MINT_FEE_PERCENTAGE / 100_00 : 0;
        return price + mintFee;
    }

 /**
     * @notice Internal function to validate price freshness
     * @param _timestamp The timestamp of the price data
     */
    function _validatePriceFreshness( uint256 _timestamp) internal view {
        if(_timestamp ==0 || (PRICE_STALENESS_THRESHOLD >0 && block.timestamp>_timestamp + PRICE_STALENESS_THRESHOLD)){
            revert StalePriceData();
        }
    }

    /** 
     * @notice Get all tokens in a range
     * @dev Required for RPC calls that reject long arrays
     * @param start The start of the range
     * @param end The end of the range
     * @return The tokens in the range
     */
    function getAllTokens(uint256 start, uint256 end) external view returns (uint256[] memory) {
        if (end > totalSupply()) end = totalSupply();
        if (totalSupply() == 0) return new uint256[](0);
        if (start >= end) revert InvalidRange();
        uint256[] memory tokens = new uint256[](end - start);
        for (uint256 i = 0; i < end - start; i++) {
            tokens[i] = tokenByIndex(i + start);
        }
        return tokens;
    }

    /** 
     * @notice Get all tokens
     * @dev Optimistic call (use getAllTokens(0, totalSupply()) instead for long arrays)
     * @return The tokens
     */
    function getAllTokens() external view returns (uint256[] memory) {
        return this.getAllTokens(0, totalSupply());
    }

    /** 
     * @notice Get all tokens by owner in a range
     * @dev Required for RPC calls that reject long arrays
     * @param owner The owner of the tokens
     * @param start The start of the range
     * @param end The end of the range
     * @return The tokens in the range
     */
    function getTokensByOwner(address owner, uint256 start, uint256 end) external view returns (uint256[] memory) {
        uint256 balance = balanceOf(owner);
        if (balance == 0) return new uint256[](0);
        if(end > balance) end = balance;
        if(start >= end) revert InvalidRange();
        uint256[] memory tokens = new uint256[](end - start);
        
        for (uint256 i = 0; i < end - start; i++) {
            tokens[i] = tokenOfOwnerByIndex(owner, i + start);
        }
        return tokens;
    }

    /** 
     * @notice Get all tokens by owner
     * @dev Optimistic call (use getTokensByOwner(owner, 0, balanceOf(owner)) instead for long arrays)
     * @param owner The owner of the tokens
     * @return The tokens
     */
    function getTokensByOwner(address owner) external view returns (uint256[] memory) {
        return this.getTokensByOwner(owner, 0, balanceOf(owner));
    }


    /** 
     * @notice Set the base URI for the contract
     * @param _uri The new base URI
     */
    function setBaseUri(string memory _uri) external override onlyRole(ADMIN_ROLE) {
        baseURI = _uri;
        emit BaseURIUpdated(_uri);
    }


    /** 
     * @notice Set whether we allow burning NFTs
     * @param _allowBurning Whether we allow burning NFTs
     */
    function setAllowBurning(bool _allowBurning) external onlyRole(ADMIN_ROLE) {
        allowBurning = _allowBurning;
        emit AllowBurningUpdated(_allowBurning);
    }

    /** 
     * @notice Set the maximum mint fee percentage
     * @param _maxFeePercentage The maximum mint fee as basis point (eg: 2 = 0.02%, 20_00 = 20%)
     */
    function setMaxFee(uint256 _maxFeePercentage) external onlyRole(ADMIN_ROLE) {
        MAX_FEE_PERCENTAGE = _maxFeePercentage;
        emit MaxFeeUpdated(_maxFeePercentage);
    }

    /** 
     * @notice Set the KYC verify module address
     * @param _kycVerifyModule The new KYC verify module address
     * @dev The address of the KYC verify module on the chain (e.g. Ethereum: )
     */
    function setKYCVerifyModule(address _kycVerifyModule) external onlyRole(ADMIN_ROLE) {
        kycVerifyModule = _kycVerifyModule;
        emit KYCVerifyModuleUpdated(_kycVerifyModule);
    }

    /** 
     * @notice Transfer a specficic role from an address to another address
     * @param role The role to transfer
     * @param oldAddress The old address to transfer the role from
     * @param newAddress The new address to transfer the role to
     */
    function transferRole(bytes32 role, address oldAddress, address newAddress) external onlyRole(ADMIN_ROLE) {
        _revokeRole(role, oldAddress);
        _grantRole(role, newAddress);
        emit RoleTransferred(role, oldAddress, newAddress);
    }

    /** 
     * @notice Supports the ERC165 interface
     * @param interfaceId The interface ID
     * @return True if the interface is supported, false otherwise
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721Enumerable, AccessControl, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    /** 
     * @notice Internal function to increase the balance of an account
     * @dev Overrides the ERC721 implementation for rejecting burn requests (if allowBurning is false)
     * @param account The account to increase the balance of
     * @param value The amount to increase the balance by
     */
    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    /** 
     * @notice Internal function to update the owner of a token
     * @dev Disallow transfers to blacklisted addresses
     * @param to The new owner of the token
     * @param tokenId The ID of the token to update the owner of
     * @param auth The address that is updating the owner
     * @return The previous owner of the token
     */
    function _update(address to, uint256 tokenId, address auth) internal override(ERC721, ERC721Enumerable) returns (address) {
        address from = _ownerOf(tokenId);
        
        if (from != address(0) && to != address(0)) {
            if (complianceRegistry.isBlacklisted(from)) {
                revert IComplianceRegistry.BlacklistedAddress();
            }
            if (complianceRegistry.isBlacklisted(to)) {
                revert IComplianceRegistry.BlacklistedAddress();
            }
        }
        
        return super._update(to, tokenId, auth);
    }

    /** 
     * @notice Set the fee collector address
     * @param _feeCollector The new fee collector address
     */
    function setFeeCollector(address _feeCollector) external onlyRole(ADMIN_ROLE) {
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    /** 
     * @notice Set the address of royalty fee collector
     * @param _address The new address of the royalty fee collector
     */
    function setNFTRoyaltyFeeCollector(address _address) external onlyRole(ADMIN_ROLE) {
        nftRoyaltyFeeCollector = _address;
        emit NFTRoyaltyFeeCollectorUpdated(_address);
    }

    /** 
     * @notice Set whether we allow minting NFTs
     * @param _allowMinting Whether we allow minting NFTs
     */
    function setAllowMinting(bool _allowMinting) external onlyRole(ADMIN_ROLE) {
        allowMinting = _allowMinting;
        emit AllowMintingUpdated(_allowMinting);
    }

    /** 
    * @notice Reset the remint flag to allow reminting of a previously disabled token
    * @param tokenId The ID of the token to reset the remint flag for
    * @dev Can only reset tokens that have reminting disabled (flag set to true)
    */
    function resetRemintFlag(uint256 tokenId) external onlyRole(ADMIN_ROLE) {
        if (!disableReminting[tokenId]) revert RemintAlreadyEnabled();
        disableReminting[tokenId] = false;
        emit UpdateRemint(tokenId, false);
    }
    /**
     * @notice Allows the user to withdraw the underlying tokens from the contract
     * @dev Used to take out the tokens used to mint/purchase the NFTs
     * @dev Only callable by the owner
     * @param tokenAddress The address of the token to withdraw
     * @param to The address to withdraw the tokens to
     * @param amount The amount of tokens to withdraw
     * @return True if the tokens were withdrawn successfully, false otherwise
     */
    function withdrawUnderlying(address tokenAddress, address to, uint256 amount) public onlyRole(WITHDRAW_ROLE) returns (bool) {
        if (address(tokenAddress) == address(0)) revert InvalidAddress();
        if (to == address(0)) revert InvalidAddress();
        
        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance();
        
        IERC20(tokenAddress).safeTransfer(to, amount);

        return true;
    }

    /**
     * @notice Get the fee structure for the contract
     * @return The fee structure
     */
    function getFeeStructure() public view returns (FeeStructure memory) {
        return FeeStructure({
            mintFee: MINT_FEE_PERCENTAGE,
            tradeFee: TRADE_FEE_PERCENTAGE
        });
    }

    /**
     * @notice Burn an NFT token
     * @param tokenId The ID of the token to burn
     * @dev Burn could be used in case of security issue.
     * @dev Admin can decide whether the same NFT can be reissued or not.
     */
    function burn(uint256 tokenId, bool disableRemint) external onlyRole(ADMIN_ROLE) {
        if (!allowBurning) revert BurningDisabled();

        if (disableRemint) {
            disableReminting[tokenId] = true;
            emit UpdateRemint(tokenId, disableRemint);
        }
        _burn(tokenId);
    }
}