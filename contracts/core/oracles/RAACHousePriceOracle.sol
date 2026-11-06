// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./BaseChainlinkFunctionsOracle.sol";
import "../primitives/RAACHousePrices.sol";
import "../../libraries/utils/StringUtils.sol";
import "../../interfaces/core/oracles/IRAACHousePriceOracle.sol";

/**
 * @title RAACHousePriceOracle
 * @author RAAC Protocol Team
 * @dev Contract for using oracles to fetch house pricing data from off-chain api
 * This contract allows an oracle to update prices.
 */
contract RAACHousePriceOracle is BaseChainlinkFunctionsOracle, IRAACHousePriceOracle {
    using StringUtils for string;
    using Strings for uint256;

    RAACHousePrices public housePrices;
    string public raacNFT;
    
    // Mapping from requestId to houseId to prevent overwriting when multiple requests are in flight
    mapping(bytes32 => uint256) public requestToHouseId;
    mapping(uint256 => bool) public pendingRequest;

    event HousePriceUpdated(uint256 indexed houseId, uint256 price);
    event HousePriceRequestSent(bytes32 indexed requestId, uint256 indexed houseId);
    
    error InvalidPrice(uint256 houseId);
    
    constructor(
        address router,
        bytes32 donId,
        string memory source,
        FunctionsRequest.Location secretsLocation,
        bytes memory encryptedSecretsReference,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        address housePricesAddress,
        string memory raacNFTAddress
    ) BaseChainlinkFunctionsOracle(router, donId, source, secretsLocation, encryptedSecretsReference, subscriptionId, callbackGasLimit) {
        require(housePricesAddress != address(0), "HousePrices address must be set");
        require(bytes(raacNFTAddress).length > 0, "RAAC NFT address must be set");
        housePrices = RAACHousePrices(housePricesAddress);
        raacNFT = raacNFTAddress;
    }

    /**
     * @notice Validates that the request has the required house ID parameter
     * @param args String arguments passed to sendRequest
     */
    function _validateRequest(
        string[] calldata args, // chainId, contractAddress, tokenId
        bytes[] calldata /* bytesArgs */
    ) internal view override {
        require(args.length == 3, "Request must have 3 arguments");

        string memory onChainId = block.chainid.toString();
        require(keccak256(bytes(args[0])) == keccak256(bytes(onChainId)),"chainId mismatch");
        require(keccak256(bytes(args[1])) == keccak256(bytes(raacNFT)),"contractAddress mismatch");
        require(bytes(args[2]).length > 0, "tokenId must not be empty");
    }

    /**
     * @notice Processes the request and stores relevant data
     * @param requestId The ID of the request
     * @param args String arguments passed to sendRequest
     */
    function _processRequest(
        bytes32 requestId, 
        string[] calldata args
    ) internal override {
        uint256 houseId = args[2].stringToUint();
        requestToHouseId[requestId] = houseId;
        pendingRequest[houseId] = true;
    }

    /**
     * @notice Emits house price specific events
     * @param requestId The ID of the request
     * @param args The arguments passed to sendRequest
     */
    function _emitRequestEvents(
        bytes32 requestId,
        string[] calldata args
    ) internal override {
        uint256 houseId = args[2].stringToUint();
        emit HousePriceRequestSent(requestId, houseId);
    }

    /**
     * @notice Hook called before fulfillment with the request arguments
     * @param args The arguments passed to sendRequest
     */
    function _beforeFulfill(string[] calldata args) internal override {}

    /**
     * @notice Process the response from the oracle
     * @param response The response from the oracle
     */
    function _processResponse (bytes32 requestId, bytes memory response) internal override {
        uint256 price = abi.decode(response, (uint256));
        uint256 houseId = requestToHouseId[requestId];
        if (price == 0) revert InvalidPrice(houseId);
        housePrices.setHousePrice(houseId, price);
        delete requestToHouseId[requestId];
        pendingRequest[houseId] = false;
        emit HousePriceUpdated(houseId, price);
    }

    /**
     * @notice Return whether a request has been finalized for a house.
     * @param houseId The house ID to check
     * @return true if a request has been finalized for the house, false otherwise
     */
    function isPendingRequest(uint256 houseId) external view returns(bool) {
        return pendingRequest[houseId];
    }
}
