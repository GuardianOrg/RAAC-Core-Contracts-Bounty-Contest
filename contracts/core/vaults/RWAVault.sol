// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import "../../interfaces/core/oracles/IBaseVRFv2Consumer.sol";
import "../../interfaces/core/vaults/IBaseHybridVault.sol";
import "../../interfaces/core/tokens/IVaultToken.sol";
import "../../interfaces/core/tokens/IRAACNFT.sol";
import "../../interfaces/core/vaults/IVaultAssetAdapter.sol";
import "../../interfaces/core/vaults/IERC721VaultAdapter.sol";
import "../../interfaces/core/collectors/IFeeCollector.sol";
import "../../interfaces/INFTWhitelist.sol";
import "../primitives/WithCompliance.sol";
import "../../libraries/math/PercentageMath.sol";
import {IKYCVerifyModule} from "../oracles/KYCVerifyModule.sol";

/// @title RWAVault
/// @author RAAC Protocol Team
/// @notice The vault for the RAAC NFTs.
/// @dev This contract is a hybrid vault that supports both different types of assets under the same vault.
/// @dev Each asset is wrapped in an adapter contract. The contract provides the necessary functions to interact with the asset in the vault.
contract RWAVault is IBaseHybridVault, Ownable, ReentrancyGuard, WithCompliance, Pausable {
    using PercentageMath for uint256;
    
    // Stability pool connected for liquidation
    address public stabilityPool;
    // Managers that can withdraw the crvUSD to purchase more NFTs
    mapping(address => bool) public managers;

    address public vaultToken; // eg. Index Token
    IBaseVRFv2Consumer public vrfConsumer; // Chainlink VRF

    /// @notice whitelist of supported adapters
    mapping(address => bool) public supportedAdapters;

    /// @notice list of supported adapter addresses
    address[] public adapters;

    /// @notice whitelist of supported ERC721 adapters to redeem
    mapping(address => bool) public supportedRedeemableERC721Adapters;

    /// @notice list of supported ERC721 adapters to redeem
    address[] public redeemableERC721Adapters;

    /// @notice whitelist of supported ERC721 adapters to redeem
    mapping(address => bool) public supportedDepositableAdapters;

    /// @notice list of supported ERC721 adapters to redeem
    address[] public depositableAdapters;

    /// @notice minting fees for every mint of index token
    uint256 public indexTokenMintingFee = 2_00; // 2%

    /// @notice address of feeCollector the minting fees will go to
    address public feeCollector;

    /// @notice time after which another VRF request can be sent to call another NFT
    uint256 public vrfRequestDelay = 3 days;

    /// @notice enable sending request for new seed
    bool public allowVRFRequest;

    /// @notice Address of the KYC verify module
    /// @dev If unset, KYC is disabled
    address public kycVerifyModule;

    /// @dev Ensures the manager can take the action
    modifier onlyManager() {
        if (!managers[msg.sender]) revert NotManager(msg.sender);
        _;
    }

    constructor(address _vaultToken, address _complianceRegistry) Ownable(msg.sender) WithCompliance(_complianceRegistry) {
        if (_vaultToken == address(0)) revert InvalidAddress();
        vaultToken = _vaultToken;
        allowVRFRequest = false;
    }

    /**
     * @notice Sets the VRF consumer address.
     * @param _vrfConsumer Address of the new VRF consumer.
     */
    function setVRFConsumer(address _vrfConsumer) external onlyOwner {
        if (_vrfConsumer == address(0)) revert InvalidAddress();
        vrfConsumer = IBaseVRFv2Consumer(_vrfConsumer);
        // initialize the first VRF request - make sure there is random seed
        vrfConsumer.requestRandomWords();
        emit VRFConsumerUpdated(_vrfConsumer);
    }

    /**
     * @notice Sets the stability pool address.
     * @param _stabilityPool Address of the new stability pool.
     */
    function setStabilityPool(address _stabilityPool) external onlyOwner {
        if (_stabilityPool == address(0)) revert InvalidAddress();
        stabilityPool = _stabilityPool;
        emit StabilityPoolUpdated(_stabilityPool);
    }

    /**
     * @notice Sets the index token minting fee.
     * @param _indexTokenMintingFee Fee percentage (e.g., 10000 for 100%).
     * @dev This fee is applied when a user deposits an NFT and mints index tokens. 0 means no fee.
     */
    function setIndexTokenMintingFee(uint256 _indexTokenMintingFee) external onlyOwner {
        require(_indexTokenMintingFee >= 0 && _indexTokenMintingFee <= 100_00, "RWAVault: Invalid percentage value");
        indexTokenMintingFee = _indexTokenMintingFee;
        emit IndexTokenMintingFeeSet(_indexTokenMintingFee);
    }

    /**
     * @notice Sets the feeCollector address.
     * @param _feeCollector Address of the new feeCollector.
     */
    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert InvalidAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    /**
     * @notice Sets the VRF request delay.
     * @param _newDelay The new delay in seconds.
     * @dev If a NFT is not redeemed for some time, after the delay from last request, the user can send another request.
     */
    function setVRFRequestDelay(uint256 _newDelay) external onlyOwner {
        if (_newDelay == 0) revert("delay cannoy be 0");
        vrfRequestDelay = _newDelay;
        emit VRFRequestDelayUpdated(_newDelay);
    }

    /**
     * @notice Sets the allowVRFRequest flag.
     * @param _value The new value of the flag.
     */
    function setAllowVRFRequest(bool _value) external onlyOwner {
        allowVRFRequest = _value;
        emit AllowVRFRequestUpdated(_value);
    }

    /** 
     * @notice Set the KYC verify module address
     * @param _kycVerifyModule The new KYC verify module address
     * @dev The address of the KYC verify module on the chain (e.g. Ethereum: )
     */
    function setKYCVerifyModule(address _kycVerifyModule) external onlyOwner {
        kycVerifyModule = _kycVerifyModule;
        emit KYCVerifyModuleUpdated(_kycVerifyModule);
    }

    /** 
     * @notice Register a new adapter.
     * @param adapter The address of the new adapter.
     */
    function registerAdapter(address adapter) external onlyOwner {
        require(!supportedAdapters[adapter], "RWAVault: adapter already supported");
        supportedAdapters[adapter] = true;
        adapters.push(adapter);
        emit AdapterRegistered(adapter);
    }

    /**
     * @notice Remove an existing adapter.
     * @param adapter The address of the adapter to remove.
     */
    function unregisterAdapter(address adapter) external onlyOwner {
        require(supportedAdapters[adapter], "RWAVAult: not supported");
        // if adapter is registered as redeemable or depositable, revert
        if (supportedRedeemableERC721Adapters[adapter] || supportedDepositableAdapters[adapter]) revert("RWAVault: adapter is registered as redeemable or depositable");
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

    /**
     * @notice Register a new redeemable ERC721 adapter.
     * @param adapter The address of the new redeemable ERC721 adapter.
     * @dev The adapter must be supported and be an ERC721 adapter.
     * @dev Since the ERC721VaultAdapter is a child of the IERC721VaultAdapter, we ensure that required interface is supported.
     */
    function registerRedeemableERC721Adapter(address adapter) external onlyOwner onlySupportedAdapter(adapter) {
        require(!supportedRedeemableERC721Adapters[adapter], "RWAVault: redeemalble already supported");
        require(_isERC721Adapter(adapter), "RWAVault: adapter is not ERC721");
        supportedRedeemableERC721Adapters[adapter] = true;
        redeemableERC721Adapters.push(adapter);
        emit RedeemableERC721AdapterRegistered(adapter);
    }

    /**
     * @notice Check if an adapter is an ERC721 adapter.
     * @param adapter The address of the adapter to check.
     * @return True if the adapter is an ERC721 adapter, false otherwise.
     */
    function _isERC721Adapter(address adapter) internal pure returns (bool) {
        string memory t = IVaultAssetAdapter(adapter).getAssetType();
        return keccak256(bytes(t)) == keccak256(bytes("ERC721"));
    }

    /**
     * @notice Remove an existing redeemable ERC721 adapter.
     * @param adapter The address of the redeemable ERC721 adapter to remove.
     */
    function unregisterRedeemableERC721Adapter(address adapter) external onlyOwner {
        require(supportedRedeemableERC721Adapters[adapter], "RWAVault: redeemalble not supported");
        supportedRedeemableERC721Adapters[adapter] = false;
        // Remove from redeemableERC721Adapter array
        for (uint256 i = 0; i < redeemableERC721Adapters.length; i++) {
            if (redeemableERC721Adapters[i] == adapter) {
                redeemableERC721Adapters[i] = redeemableERC721Adapters[redeemableERC721Adapters.length - 1];
                redeemableERC721Adapters.pop();
                break;
            }
        }
        emit RedeemableERC721AdapterRemoved(adapter);
    }

    /**
     * @notice Register a new depositable adapter.
     * @param adapter The address of the new depositable adapter.
     * @dev The adapter must be supported.
     */
    function registerDepositableAdapter(address adapter) external onlyOwner onlySupportedAdapter(adapter) {
        require(!supportedDepositableAdapters[adapter], "RWAVault: depositable already supported");
        supportedDepositableAdapters[adapter] = true;
        depositableAdapters.push(adapter);
        emit DepositableAdapterRegistered(adapter);
    }

    /**
     * @notice Remove an existing depositable adapter.
     * @param adapter The address of the depositable adapter to remove.
     */
    function unregisterDepositableAdapter(address adapter) external onlyOwner {
        require(supportedDepositableAdapters[adapter], "RWAVault: depositable not supported");
        supportedDepositableAdapters[adapter] = false;
        // Remove from redeemableERC721Adapter array
        for (uint256 i = 0; i < depositableAdapters.length; i++) {
            if (depositableAdapters[i] == adapter) {
                depositableAdapters[i] = depositableAdapters[depositableAdapters.length - 1];
                depositableAdapters.pop();
                break;
            }
        }
        emit DepositableAdapterRemoved(adapter);
    }

    /**
     * @notice Check if an adapter is supported.
     * @param adapter The address of the adapter to check.
     * @return True if the adapter is supported, false otherwise.
     */
    function supportedAdapter(address adapter) external view returns (bool) {
        return supportedAdapters[adapter];
    }

    /**
     * @notice Modifier to make sure adapter is supported.
     * @param adapter The address of the adapter to check.
     */
    modifier onlySupportedAdapter(address adapter) {
        require(supportedAdapters[adapter], "RWAVault: adapter not supported");
        _;
    }

    /**
     * @notice Modifier to make sure adapter is supported.
     * @param adapter The address of the adapter to check.
     */
    modifier onlySupportedDepositableAdapter(address adapter) {
        require(supportedDepositableAdapters[adapter], "RWAVault: depositable adapter not supported");
        _;
    }

    /***************************************
     *         Core Public Vault Ops
     ***************************************/

    /// @inheritdoc IBaseHybridVault
    function depositAsset(address adapter, bytes calldata data, address receiver, uint256 minSharesOut) external override onlySupportedDepositableAdapter(adapter) notBlacklisted(msg.sender) whenNotPaused nonReentrant returns (uint256 sharesMinted) {
        return _deposit(adapter, data, receiver, indexTokenMintingFee, minSharesOut);
    }

    /// @inheritdoc IBaseHybridVault
    function poolDepositAsset(address adapter, bytes calldata data, address receiver, uint256 minSharesOut) external onlySupportedAdapter(adapter) nonReentrant returns (uint256 sharesMinted) {
        require(msg.sender == stabilityPool, "RWAVault: only stability pool caller");
        return _deposit(adapter, data, receiver, 0, minSharesOut);
    }

    function _deposit(address adapter, bytes calldata data, address receiver, uint256 mintFeePercentage, uint256 minSharesOut) internal returns(uint256) {
        if (receiver == address(0)) revert InvalidAddress();

        uint256 assetsBefore = totalAssets();
        uint256 supplyBefore = IVaultToken(vaultToken).totalSupply();
        uint256 depositedAssetValue = IVaultAssetAdapter(adapter).deposit(data, msg.sender);
        uint256 sharesMinted;
        if (supplyBefore == 0 || assetsBefore == 0) {
            sharesMinted = depositedAssetValue;  // 1:1 for the first depositor
        } else {
            sharesMinted = (depositedAssetValue * supplyBefore) / assetsBefore;
        }

        if (sharesMinted == 0) revert InvalidShares();

        // Mint all in current contract, then distribute after the fees
        IVaultToken(vaultToken).mint(address(this), sharesMinted);
        uint256 mintingFee = 0;

        if (feeCollector != address(0) && mintFeePercentage > 0) {
            mintingFee = sharesMinted.percentMul(mintFeePercentage);
            // Take some fees
            // send minting fees to fee collector
            bool approval = IERC20(vaultToken).approve(feeCollector, mintingFee);
            if (!approval) revert ApprovalFailed();
            IFeeCollector(feeCollector).collectFee(vaultToken, address(this), mintingFee, keccak256("MINT_FEE"));
        }
       
        // Send remaining to the user
        uint256 netAmount = sharesMinted - mintingFee;
        if (netAmount < minSharesOut) revert SlippageExceeded();
        IERC20(vaultToken).transfer(receiver, netAmount);
        
        return netAmount;
    }

    /// @inheritdoc IBaseHybridVault
    function adminDepositAsset(address adapter, bytes calldata data, bool mint, uint256 minSharesOut) external onlyManager onlySupportedAdapter(adapter) nonReentrant {
        // Deposit asset via adapter. Mint vault tokens only when allowMinting is true.
        if (mint) {
            _deposit(adapter, data, msg.sender, 0, minSharesOut);
        } else {
            IVaultAssetAdapter(adapter).deposit(data, msg.sender);
        }
        emit AdminDeposit(adapter, data, mint);
    }

    /// @inheritdoc IBaseHybridVault
    function adminWithdrawAsset(address adapter, bytes calldata data, address receiver, bool burn, uint256 maxSharesBurn) external onlyManager onlySupportedAdapter(adapter) nonReentrant {
        // This is kind of emergency withdraw of asset. Shares burned only if allowBurning is true
        if (receiver == address(0)) revert InvalidAddress();

        uint256 assetValue = IVaultAssetAdapter(adapter).getAssetValue(data);
        if (burn) {
            uint256 sharesToBurn = convertToShares(assetValue);
            if (sharesToBurn > maxSharesBurn) revert SlippageExceeded();
            // check that user provides the correct balance
            if (IVaultToken(vaultToken).balanceOf(msg.sender) < sharesToBurn) revert InsufficientBalance();
            IVaultToken(vaultToken).burn(msg.sender, sharesToBurn);
        }

        IVaultAssetAdapter(adapter).withdraw(data, receiver);
        emit AdminWithdraw(adapter, data, receiver, burn);
    }

    /// @inheritdoc IBaseHybridVault
    function burnVaultToken(address from, uint256 amount) external {
        if (!isManager(msg.sender) && msg.sender != stabilityPool) revert("only manager or stability pool");
        IVaultToken(vaultToken).burn(from, amount);
        emit VaultTokenBurned(from, amount);
    }

    /***************************************
     *         Core NFT Vault Ops
     ***************************************/     
    /// @inheritdoc IBaseHybridVault
    function redeemNFT(address _adapter, uint256 _tokenId, uint256 maxSharesBurn) external override nonReentrant whenNotPaused notBlacklisted(msg.sender) {
        if (address(vrfConsumer) == address(0)) revert InvalidVRFAddress();

        (address adapter, uint256 tokenId) = getNextRandomNFT();
        if (adapter != _adapter || tokenId != _tokenId) revert NFTNotRedeemable();

        // Verify the user has approved the ZKME cooperator
        if (kycVerifyModule != address(0)) {
            if(!IKYCVerifyModule(kycVerifyModule).verifyKYC(msg.sender)) {
                revert IKYCVerifyModule.KYCNotVerified();
            }
        }

        bytes memory data = abi.encode(tokenId);
        uint256 nftPrice = IVaultAssetAdapter(adapter).getAssetValue(data);
        if (nftPrice == 0) revert InvalidNFT();
        uint256 sharesBurned = convertToShares(nftPrice);
        if (sharesBurned > maxSharesBurn) revert SlippageExceeded();
        if (IVaultToken(vaultToken).balanceOf(msg.sender) < sharesBurned) revert InsufficientBalance();

        IVaultToken(vaultToken).burn(msg.sender, sharesBurned);
        IVaultAssetAdapter(adapter).withdraw(data, msg.sender);
        // send the request for the next token to redeem
        vrfConsumer.requestRandomWords();

        emit RedeemNFT(msg.sender, IVaultAssetAdapter(adapter).getAssetToken(), tokenId, sharesBurned);
    }

    /// @inheritdoc IBaseHybridVault
    function getNextRandomNFT() public view returns (address adapter, uint256 tokenId) {
        if (address(vrfConsumer) == address(0)) revert InvalidVRFAddress();
        IBaseVRFv2Consumer.RequestStatus memory requestStatus = vrfConsumer.getRequestStatus();
        if (!requestStatus.fulfilled) revert IBaseVRFv2Consumer.RequestNotFulfilled();

        uint256 rand = requestStatus.randomWords[0];
        adapter = _findRandomAdapter(rand);
        tokenId = IERC721VaultAdapter(adapter).getDepositedTokenAtIndex(rand % IERC721VaultAdapter(adapter).getDepositedTokensCount());
        return (adapter, tokenId);
    }

    /**
     * @notice Find a random adapter with at least 1 NFT deposited. Uses reservoir sampling to select the adapter.
     * @dev We are only expecting 3-4 adapters to be ever redeemable. Right now, it will only be RAACNFT and do not plan to add more.
     * @param rand The random seed.
     * @return The address of the random adapter.
     */
    function _findRandomAdapter(uint256 rand) internal view returns (address) {
        uint256 aCount = redeemableERC721Adapters.length;
        require(aCount > 0, "RWAVault: no redeemable adapters");

        address chosen;
        uint256 seen;
        for (uint256 i; i < aCount; ++i) {
            uint256 bal = IERC721VaultAdapter(redeemableERC721Adapters[i]).getDepositedTokensCount();
            if (bal == 0) continue;
            ++seen;
            if (uint256(keccak256(abi.encode(rand, i))) % seen == 0) {
                chosen = redeemableERC721Adapters[i];
            }
        }
        require(seen > 0, "RWAVault: no NFTs available");
        return chosen;
    }

    /// @inheritdoc IBaseHybridVault
    function requestRandomSeed() external notBlacklisted(msg.sender) whenNotPaused {
        if (!allowVRFRequest) revert("public requests disabled");
        require(block.timestamp - vrfConsumer.getLastFulfillTimestamp() >= vrfRequestDelay, "you cannot send request");
        vrfConsumer.requestRandomWords();
        emit RandomSeedRequested(block.timestamp);
    }

    /***************************************
     *          Share Calculation
     ***************************************/
    /// @inheritdoc IBaseHybridVault
    function convertToShares(uint256 assetAmount) public view override returns (uint256) {
        uint256 supply = IVaultToken(vaultToken).totalSupply();
        uint256 assets = totalAssets();
        if (supply == 0 || assets == 0) return assetAmount;
        // Round up division: (a * b + c - 1) / c
        return (assetAmount * supply + assets - 1) / assets;
    }

    /// @inheritdoc IBaseHybridVault
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 supply = IVaultToken(vaultToken).totalSupply();
        uint256 assets = totalAssets();
        if (assets ==0 || supply == 0) return shares;
        else return (shares * assets) / supply;
    }

    /// @inheritdoc IBaseHybridVault
    function previewDeposit(uint256 assetAmount) external view override returns (uint256 shares) {
        uint256 supply = IVaultToken(vaultToken).totalSupply();
        uint256 total  = totalAssets();

        if (supply == 0 || total == 0) return assetAmount;
        // rounding down
        return (assetAmount * supply) / total;
    }

    /// @inheritdoc IBaseHybridVault
    function previewWithdraw(uint256 assetAmount) external view override returns (uint256 shares){
        uint256 supply = IVaultToken(vaultToken).totalSupply();
        uint256 total  = totalAssets();

        if (supply == 0 || total == 0) return assetAmount;
        // rouding up
        return (assetAmount * supply + total - 1) / total;
    }

    /***************************************
     *           Vault Statistics
     ***************************************/
    /// @inheritdoc IBaseHybridVault
    function pricePerShare() external view override returns (uint256) {
        return convertToAssets(1e18);
    }

    /// @inheritdoc IBaseHybridVault
    function totalAssets() public view override returns (uint256 totalValue) {
        for (uint256 i = 0; i < adapters.length; i++) {
            totalValue += IVaultAssetAdapter(adapters[i]).totalValue();
        }
        return totalValue;
    }
   
    /// @inheritdoc IBaseHybridVault
    function underlyingVaultToken() external view override returns (address) {
        return vaultToken;
    }

    /***************************************
     *         Manager Ops
     ***************************************/
    /**
     * @notice Check if an address is a manager.
     * @param user The address to check.
     * @return True if the address is a manager, false otherwise.
     */
    function isManager(address user) public view returns (bool) {
        return managers[user];
    }

    /**
     * @notice Add a new manager.
     * @param user The address of the new manager.
     */
    function addManager(address user) external onlyOwner {
        managers[user] = true;
        emit ManagerAdded(msg.sender, user);
    }

    /**
     * @notice Remove a manager.
     * @param user The address of the manager to remove.
     */
    function removeManager(address user) external onlyOwner {
        managers[user] = false;
        emit ManagerRemoved(msg.sender, user);
    }


    /**
     * @notice Pauses the contract functions under `whenNotPaused`
     * @dev Only callable by the contract owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract functions under `whenNotPaused`
     * @dev Only callable by the contract owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    error InvalidVRFAddress();
    error InsufficientBalance();
    error InvalidPercentage();
    error NFTNotRedeemable();
    error SlippageExceeded();
}
