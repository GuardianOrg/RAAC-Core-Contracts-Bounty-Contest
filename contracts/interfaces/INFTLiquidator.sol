// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title INFTLiquidator
 * @author RegnumAurumAcquisitionCorp
 * @notice Interface for the NFTLiquidator contract that manages the liquidation process for under-collateralized RAAC NFT loans
 * @dev Implements an auction mechanism for liquidated NFTs and interacts with the StabilityPool
 */
interface INFTLiquidator {
    /* ========== CORE FUNCTIONS ========== */

    /**
     * @notice Liquidates an NFT and starts the auction process
     * @param tokenId The ID of the NFT to be liquidated
     * @param debt The amount of debt associated with the NFT
     */
    function liquidateNFT(uint256 tokenId, uint256 debt) external;

    /**
     * @notice Allows users to place bids on liquidated NFTs
     * @param tokenId The ID of the NFT being auctioned
     */
    function placeBid(uint256 tokenId) external payable;

    /**
     * @notice Ends the auction for a specific NFT
     * @param tokenId The ID of the NFT whose auction is ending
     */
    function endAuction(uint256 tokenId) external;

    /**
     * @notice Allows users to buy back liquidated NFTs at a premium
     * @param tokenId The ID of the NFT to be bought back
     */
    function buyBackNFT(uint256 tokenId) external payable;

    /* ========== ADMIN FUNCTIONS ========== */

    /**
     * @notice Sets the StabilityPool address
     * @param _stabilityPool New StabilityPool address
     */
    function setStabilityPool(address _stabilityPool) external;

    /**
     * @notice Sets the minimum bid increase percentage
     * @param _minBidIncreasePercentage New minimum bid increase percentage
     */
    function setMinBidIncreasePercentage(uint256 _minBidIncreasePercentage) external;

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Returns the stability pool address
     * @return Address of the stability pool
     */
    function stabilityPool() external view returns (address);

    /**
     * @notice Returns the minimum bid increase percentage
     * @return Minimum percentage increase required for new bids
     */
    function minBidIncreasePercentage() external view returns (uint256);

    /**
     * @notice Returns the token data for a specified NFT
     * @param tokenId The ID of the NFT
     * @return debt The debt associated with the NFT
     * @return auctionEndTime The end time of the auction
     * @return highestBid The current highest bid
     * @return highestBidder The address of the highest bidder
     */
    function tokenData(uint256 tokenId) external view returns (
        uint256 debt,
        uint256 auctionEndTime,
        uint256 highestBid,
        address highestBidder
    );

    /* ========== EVENTS ========== */

    /**
     * @notice Emitted when an NFT is liquidated
     * @param tokenId The ID of the liquidated NFT
     * @param debt The debt associated with the NFT
     */
    event NFTLiquidated(uint256 indexed tokenId, uint256 debt);

    /**
     * @notice Emitted when an auction is started
     * @param tokenId The ID of the NFT
     * @param startingPrice The starting price of the auction
     * @param endTime The end time of the auction
     */
    event AuctionStarted(uint256 indexed tokenId, uint256 startingPrice, uint256 endTime);

    /**
     * @notice Emitted when a bid is placed
     * @param tokenId The ID of the NFT
     * @param bidder The address of the bidder
     * @param amount The bid amount
     */
    event BidPlaced(uint256 indexed tokenId, address bidder, uint256 amount);

    /**
     * @notice Emitted when an auction ends
     * @param tokenId The ID of the NFT
     * @param winner The address of the winner
     * @param amount The winning bid amount
     */
    event AuctionEnded(uint256 indexed tokenId, address winner, uint256 amount);

    /**
     * @notice Emitted when an NFT is bought back
     * @param tokenId The ID of the NFT
     * @param buyer The address of the buyer
     * @param amount The buyback amount
     */
    event BuybackCompleted(uint256 indexed tokenId, address buyer, uint256 amount);

    /**
     * @notice Emitted when the stability pool address is set
     * @param newStabilityPool The new stability pool address
     */
    event StabilityPoolSet(address newStabilityPool);

    /**
     * @notice Emitted when the minimum bid increase percentage is set
     * @param newPercentage The new minimum bid increase percentage
     */
    event MinBidIncreasePercentageSet(uint256 newPercentage);

    /* ========== ERRORS ========== */

    /// @notice When address is zero address
    error ZeroAddress();

    /// @notice When caller is not the stability pool
    error OnlyStabilityPool();

    /// @notice When auction has not ended yet
    error AuctionNotEnded();

    /// @notice When no bids have been placed
    error NoBidsPlaced();

    /// @notice When auction has already ended
    error AuctionHasEnded();

    /// @notice When bid is too low
    error BidTooLow(uint256 minBidAmount);

    /// @notice When NFT is not in liquidation
    error NFTNotInLiquidation();

    /// @notice When payment is insufficient
    error InsufficientPayment(uint256 requiredAmount);
}