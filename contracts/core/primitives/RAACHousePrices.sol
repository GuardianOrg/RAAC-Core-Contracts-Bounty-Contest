// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/core/oracles/IRAACHousePrices.sol";
import "../../interfaces/core/oracles/IRAACHousePriceOracle.sol";
import {ICrvUSDToUSDOracle} from "../oracles/CrvUSDToUSDOracle.sol";

/**
 * @title RAACHousePrices
 * @author RAAC Protocol Team
 * @notice Contract for managing house prices associated with RAAC tokens.
 * @dev This contract allows an oracle to update prices and provides functions to retrieve the latest prices.
 */
contract RAACHousePrices is Ownable, IRAACHousePrices {
    /// @notice Mapping from RAAC tokenId to house price in USD (18 decimals)
    mapping(uint256 => uint256) public tokenToHousePrice;
    /// @notice Mapping from RAAC tokenId to its timestamp of last update
    mapping(uint256 => uint256) public tokenToLastUpdateTimestamp;
    mapping(uint256 => bool) public existingTokens;

    /// @dev Internal and temprary use only: it will be obsolete when Graph is implemented
    uint256 public count;

    /// @notice The address of the oracle
    address public oracle;

    /// @notice Timestamp of the last global price update
    uint256 public lastUpdateTimestamp;

    /// @notice The addresses of all the syncers
    address[] public syncers;

    /// @notice The maximum number of syncers
    uint256 public constant MAX_SYNCERS = 5;
    /// @notice The address of the crvUSD to USD oracle
    ICrvUSDToUSDOracle public crvUSDToUSDOracle;

     /// @notice Emitted when a price is updated
    event PriceUpdated(uint256 tokenId, uint256 newPrice);

    /// @notice Emitted when a price is created (first time)
    event PriceCreated(uint256 tokenId, uint256 newPrice);

    /// @notice Emitted when the the oracle is updated
    event OracleUpdated(address newOracle);

    /// @notice Emitted when the crvUSD to USD oracle is updated
    event CrvUSDToUSDOracleUpdated(address newCrvUSDToUSDOracle);

    /// @notice Emitted when the oracle price is invalid
    error InvalidOraclePrice();

    /// @notice Emitted when the caller is not the oracle
    error NotOracle();

    /// @notice Emitted when the array lengths mismatch
    error ArrayLengthMismatch();

    /// @notice Emitted when the syncer does not support the interface
    error SyncerDoesNotSupportInterface();

    /// @notice Emitted when the maximum number of syncers is reached
    error MaximumSyncers();
    

    /// @notice Emitted when a syncer is added
    event SyncerAdded(address indexed syncer);

    /// @notice Emitted when a syncer is removed
    event SyncerRemoved(address indexed syncer);


    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(address _crvUSDToUSDOracle, address initialOwner) Ownable(initialOwner) {
        crvUSDToUSDOracle = ICrvUSDToUSDOracle(_crvUSDToUSDOracle);
    }

    /**
     * @notice Retrieves the latest price and update timestamp for a given token
     * @param _tokenId The ID of the RAAC token
     * @dev in case of circuit breaker, we could disable the circuit breaker and return to 1:1 in case we do not want to halt the system.
     * @return _crvUSDPrice The latest price in crvUSD
     * @return _lastUpdateTimestamp The timestamp of the last update
     */
    function getLatestPrice(uint256 _tokenId) public view returns (uint256 _crvUSDPrice, uint256 _lastUpdateTimestamp) {
        uint256 usdPrice = tokenToHousePrice[_tokenId];
        // Using the price only since fallack and staleness handled in the oracle
        _crvUSDPrice = (usdPrice * 10 ** crvUSDToUSDOracle.decimals()) / crvUSDToUSDOracle.getPrice();
        _lastUpdateTimestamp = tokenToLastUpdateTimestamp[_tokenId];
    }

    function crvUSDToUSDPrice() external view returns (uint256) {
        return crvUSDToUSDOracle.getPrice() * 10 ** (18 - crvUSDToUSDOracle.decimals());
    }
    /**
     * @notice Returns the decimals of the house prices (crvUsd 18 decimals, USD 8 decimals)
     * @return decimals The decimals of the house prices
     */
    function decimals() external view returns (uint8) {
        return crvUSDToUSDOracle.decimals();
    }

    /**
     * @notice Returns the raw price and timestamp for a given token (in USD)
     * @param _tokenId The ID of the RAAC token
     * @return price The raw price
     * @return timestamp The timestamp of the last update
     */
    function getRawPrice(uint256 _tokenId) external view returns (uint256, uint256) {
        return (tokenToHousePrice[_tokenId], tokenToLastUpdateTimestamp[_tokenId]);
    }

    /**
     * @notice Allows the owner to set the house price for a token
     * @param _tokenId The ID of the RAAC token
     * @param _amount The price to set for the house in USD
     *
     * Updates timestamp for each token individually
     */
    function setHousePrice(uint256 _tokenId, uint256 _amount) external onlyOracle {
        uint256 previousPrice = tokenToHousePrice[_tokenId];
        tokenToHousePrice[_tokenId] = _amount;
        tokenToLastUpdateTimestamp[_tokenId] = block.timestamp;
        lastUpdateTimestamp = block.timestamp;

        if (!existingTokens[_tokenId]) {
            existingTokens[_tokenId] = true;
            count++;
            emit PriceCreated(_tokenId, _amount);
        } else {
            emit PriceUpdated(_tokenId, _amount);
        }

        for (uint256 i = 0; i < syncers.length; i++) {
            IRAACHousePriceSyncer(syncers[i]).notify(_tokenId, previousPrice, _amount);
        }
    }

    /**
     * @notice Allows the oracle to set the prices of multiple houses
     * @param tokenIds The IDs of the RAAC token
     * @param amounts The prices to set for the house in USD
     *
     * Updates timestamp for each token individually
     */
    function setHousePrices(uint256[] calldata tokenIds, uint256[] calldata amounts) external onlyOracle {
        if (tokenIds.length != amounts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            uint256 amount = amounts[i];
            uint256 previousPrice = tokenToHousePrice[tokenId];
            tokenToHousePrice[tokenId] = amount;
            tokenToLastUpdateTimestamp[tokenId] = block.timestamp;

            /// @dev Internal and temporary use only: it will be obsolete when Graph is implemented
            if (!existingTokens[tokenId]) {
                existingTokens[tokenId] = true;
                count++;
                emit PriceCreated(tokenId, amount);
            } else {
                emit PriceUpdated(tokenId, amount);
            }

            for (uint256 j = 0; j < syncers.length; j++) {
                IRAACHousePriceSyncer(syncers[j]).notify(tokenId, previousPrice, amount);
            }
        }

        lastUpdateTimestamp = block.timestamp;
    }

    /**
     * @notice Allows the owner to set the oracle address
     * @param _oracle The address of the oracle
     */
    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    /**
     * @notice Allows the owner to set the crvUSD to USD oracle address
     * @param _crvUSDToUSDOracle The address of the crvUSD to USD oracle
     */
    function setCrvUSDToUSDOracle(address _crvUSDToUSDOracle) external onlyOwner {
        crvUSDToUSDOracle = ICrvUSDToUSDOracle(_crvUSDToUSDOracle);
        emit CrvUSDToUSDOracleUpdated(_crvUSDToUSDOracle);
    }

    /**
     * @notice Return whether a token request is pending
     * @param _tokenId The ID of the RAAC token
     * @return true if the token request is pending, false otherwise
     */
    function isPendingRequest(uint256 _tokenId) external view returns(bool) {
        if (oracle == address(0)) return false;
        (bool success, bytes memory data) = address(oracle).staticcall(
            abi.encodeWithSelector(IRAACHousePriceOracle.isPendingRequest.selector, _tokenId)
        );
        if (!success || data.length == 0) return false;
        return abi.decode(data, (bool));
    }

    /**
     * @notice Add a syncer to the house prices
     * @param _syncer The address of the syncer
     */
    function addSyncer(address _syncer) external onlyOwner {
        // Maximum 5 syncers
        if (syncers.length >= MAX_SYNCERS) revert MaximumSyncers();
        // need to check that the syncer is has IRAACHousePriceSyncer interface
        if (!IRAACHousePriceSyncer(_syncer).supportsInterface(type(IRAACHousePriceSyncer).interfaceId)) revert SyncerDoesNotSupportInterface();
        syncers.push(_syncer);
        emit SyncerAdded(_syncer);
    }

    /**
     * @notice Remove a syncer from the house prices
     * @param _syncer The address of the syncer
     */
    function removeSyncer(address _syncer) external onlyOwner {
        for (uint256 i = 0; i < syncers.length; i++) {
            if (syncers[i] == _syncer) {
                syncers[i] = syncers[syncers.length - 1];
                syncers.pop();
                emit SyncerRemoved(_syncer);
                break;
            }
        }
    }
}
