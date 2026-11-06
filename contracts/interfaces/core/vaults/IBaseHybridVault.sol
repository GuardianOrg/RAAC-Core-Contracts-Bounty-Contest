// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title IBaseHybridVault
 * @dev Interface for a vault that:
 *      1) Accepts ERC-20 tokens (e.g., crvUSD) and mints/burns vault shares,
 *      2) Accepts NFTs and mints vault shares (based on NFT value),
 *      3) Allows NFT redemption (burning shares to withdraw an NFT),
 *      4) Provides "preview" functions and share-calculation utilities.
 */
interface IBaseHybridVault {
    /***************************************
     *              Structs
     ***************************************/
    struct NFT {
        address nftAddress;
        uint256 tokenId;
        uint64 depositedAt;
        address depositedBy;
    }
    /***************************************
     *              Events
     ***************************************/
    event RedeemNFT(
        address indexed receiver,
        address indexed nftAddress,
        uint256 tokenId,
        uint256 sharesBurned
    );
    event ManagerAdded(
        address actor,
        address receiver
    );
    event ManagerRemoved(
        address actor,
        address receiver
    );
    /**
     * @notice Emitted when the index token minting fee is set
     * @param indexTokenMintingFee New index token minting fee
     */
    event IndexTokenMintingFeeSet(uint256 indexTokenMintingFee);

    event AdminDeposit(
        address indexed adapter,
        bytes data,
        bool mint
    );

    event AdminWithdraw(
        address indexed adapter,
        bytes data,
        address receiver,
        bool burn
    );

    event VRFConsumerUpdated(address indexed vrfConsumer);
    event StabilityPoolUpdated(address indexed stabilityPool);
    event FeeCollectorUpdated(address indexed feeCollector);
    event VRFRequestDelayUpdated(uint256 indexed newDelay);
    event AllowVRFRequestUpdated(bool indexed value);
    event AdapterRegistered(address adapter);
    event AdapterRemoved(address adapter);
    event RedeemableERC721AdapterRegistered(address adapter);
    event RedeemableERC721AdapterRemoved(address adapter);
    event DepositableAdapterRegistered(address adapter);
    event DepositableAdapterRemoved(address adapter);
    event VaultTokenBurned(address indexed from, uint256 indexed amount);
    event RandomSeedRequested(uint256 indexed timestamp);
    event KYCVerifyModuleUpdated(address kycVerifyModule);
    /***************************************
     *              Errors
     ***************************************/

    error InvalidAddress();
    error InvalidNFT();
    error NotManager(address);
    /// @notice When token approval fails
    error ApprovalFailed();
    /// @notice When shares minted is 0
    error InvalidShares();
    /***************************************
     *         Core ERC-20 Vault Ops
     ***************************************/

    /**
     * @notice Deposit 'amount' of underlying ERC-20 (e.g. crvUSD) and receive vault shares.
     * @dev    Must have prior approval for this vault to pull the tokens.
     * @param  adapter    The address of the asset adapter we are depositing to
     * @param  data The bytes data that differs for each asset (e.g. tokenId for ERC721 or amount for ERC20)
     * @param  receiver The person who will receive the minted index token
     * @return sharesMinted Number of vault shares minted.
     */
    function depositAsset(
        address adapter,
        bytes calldata data,
        address receiver,
        uint256 minSharesOut
    ) external returns (uint256 sharesMinted);

    /**
     * @notice Deposit 'amount' of underlying ERC-20 (e.g. crvUSD) and receive vault shares. Called only by the stability pool
     * @dev    Must have prior approval for this vault to pull the tokens.
     * @param  adapter    The address of the asset adapter we are depositing to
     * @param  data The bytes data that differs for each asset (e.g. tokenId for ERC721 or amount for ERC20)
     * @param  receiver The person who will receive the minted index token
     * @return sharesMinted Number of vault shares minted.
     */
    function poolDepositAsset(
        address adapter,
        bytes calldata data,
        address receiver,
        uint256 minSharesOut
    ) external returns (uint256 sharesMinted);


    /**
     * @notice Admin deposit an asset without minting vault token
     * @dev    Must be a manager. Does not require vault token to be deposited. Used for peg management or depositing asset bought with vault assets (in single transaction)
     * @param  adapter    The address of the asset adapter we are depositing to
     * @param  data The bytes data that differs for each asset (e.g. tokenId for ERC721 or amount for ERC20)
     * @param  mint Whether to mint vault token
     * @param  minSharesOut The minimum number of shares to mint
     */
    function adminDepositAsset(
        address adapter,
        bytes calldata data,
        bool mint,
        uint256 minSharesOut
    ) external;

    /**
     * @notice Admin withdraw an asset without burning vault token
     * @dev    Must be a manager. Does not require vault token to be deposited. Used for peg management or withdrawing asset to be sold to buy other assets (in single transaction)
     * @param  adapter    The address of the asset adapter we are depositing to
     * @param  data The bytes data that differs for each asset (e.g. tokenId for ERC721 or amount for ERC20)
     * @param  receiver The person who will receive the withdrawn asset
     */
    function adminWithdrawAsset(
        address adapter,
        bytes calldata data,
        address receiver,
        bool burn,
        uint256 maxSharesBurn
    ) external;

    /**
     * @notice Burn vault token amount.
     * @dev    Must be a manager or stability pool
     * @param  from    The address of the user or stability pool
     * @param  amount       Amount of token to burn
     */
    function burnVaultToken(
        address from,
        uint256 amount
    ) external;

    /***************************************
     *         Core NFT Vault Ops
     ***************************************/

    /**
     * @notice Redeem a specific NFT from the vault by burning the required number of shares.
     * @param _adapter The address of the adapter that contains the NFT.
     * @param _tokenId The tokenId of the NFT.
     * @param maxSharesBurn The maximum number of shares to burn.
     * @dev The parameters make sure that user does not redeem a NFT that was not expected to be redeemed.
     */
    function redeemNFT(address _adapter, uint256 _tokenId, uint256 maxSharesBurn) external;

    /**
     * @notice Get the next random NFT from the vault.
     * @return adapter The address of the adapter that contains the NFT.
     * @return tokenId The tokenId of the NFT.
     */
    function getNextRandomNFT() external view returns (address, uint256);

    /**
     * @notice Request a new random seed.
     * @dev This function is used to request a new random seed.
     *      It is used to get the next random NFT in case one has not been redeemed for some time.
     */
    function requestRandomSeed() external;

    /***************************************
     *          Share Calculation
     ***************************************/

    /**
     * @notice Return the amount of shares that would be minted for a given 'assetAmount'
     *         of underlying ERC-20 tokens if deposited right now.
     * @dev    This is a "purely calculative" or "view" function that does not actually deposit.
     * @param  assetAmount The amount of underlying tokens.
     * @return shares      The number of shares that would be minted.
     */
    function convertToShares(
        uint256 assetAmount
    ) external view returns (uint256);

    /**
     * @notice Return the amount of underlying ERC-20 tokens that would be received for burning 'shares'.
     * @dev    Does not actually burn or withdraw.
     * @param  shares The number of vault shares.
     * @return assetAmount The amount of underlying tokens the user would receive.
     */
    function convertToAssets(uint256 shares) external view returns (uint256);

    /**
     * @notice Preview the amount of shares that would be minted for a given 'assetAmount'
     * @dev    This is a "purely calculative" or "view" function that does not actually deposit.
     * @param  assetAmount The amount of underlying tokens.
     * @return shares      The number of shares that would be minted.
     */
    function previewDeposit(uint256 assetAmount) external view returns (uint256 shares);

    /**
     * @notice Preview the amount of shares that would be burned for a given 'assetAmount'
     * @dev    This is a "purely calculative" or "view" function that does not actually withdraw.
     * @param  assetAmount The amount of underlying tokens.
     * @return shares      The number of shares that would be burned.
     */
    function previewWithdraw(uint256 assetAmount) external view returns (uint256 shares);

    /***************************************
     *           Vault Statistics
     ***************************************/

    /**
     * @notice Returns the current "price per share", typically = totalAssets() / totalSupply().
     * @dev    Represented in terms of the underlying token (crvUSD).
     */
    function pricePerShare() external view returns (uint256);

    /**
     * @notice Total value of vault assets in terms of the underlying token (crvUSD).
     *         Sum of:
     *          - The vault's ERC-20 token balance
     *          - The appraised value of all NFTs in the vault
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice The address of the ERC-20 vault token that is considered the "underlying" (e.g. indexToken).
     */
    function underlyingVaultToken() external view returns (address);

    /**
     * @notice Check if an adapter is supported.
     * @param _adapter The address of the adapter to check.
     * @return True if the adapter is supported, false otherwise.
     */
    function supportedAdapter(address _adapter) external returns (bool);

    /**
     * @notice Sets the index token minting fee.
     * @param _indexTokenMintingFee Fee percentage (e.g., 10000 for 100%).
     * @dev This fee is applied when a user deposits an NFT and mints index tokens. 0 means no fee.
     */
    function setIndexTokenMintingFee(uint256 _indexTokenMintingFee) external;
}
