// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {ConfirmedOwner} from "@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

/**
 * @title BaseChainlinkFunctionsOracle
 * @author Chainlink Labs and RAAC Protocol Team
 * @dev Base contract for oracles using Chainlink Functions
 * @dev All the chainlink Function oracles should inherit from this contract
 */
abstract contract BaseChainlinkFunctionsOracle is FunctionsClient, ConfirmedOwner {
    using FunctionsRequest for FunctionsRequest.Request;
    
    mapping(bytes32 => bool) public s_requestIds;
    bytes32 public donId;
    bytes32 public s_lastRequestId;
    bytes public s_lastResponse;
    bytes public s_lastError;
    string public s_source;
    FunctionsRequest.Location public s_secretsLocation;
    bytes public s_encryptedSecretsReference;
    uint64 public s_subscriptionId;
    uint32 public s_callbackGasLimit;

    /// @notice Thrown when the fulfillment fails
    error FulfillmentFailed();
    /// @notice Thrown when the request ID is not the last request ID
    error UnexpectedRequestID(bytes32 requestId);
    /// @notice Thrown when the DON ID is invalid
    error InvalidDONId();
    /// @notice Thrown when the source code is empty
    error EmptySourceCode();
    /// @notice Thrown when the subscription ID is invalid
    error InvalidSubscriptionId();
    /// @notice Thrown when the callback gas limit is invalid
    error InvalidCallbackGasLimit();
    /// @notice Emitted when an oracle request is sent
    event OracleRequestSent(bytes32 indexed requestId);
    /// @notice Emitted when the subscription ID is updated
    event SubscriptionIdUpdated(uint64 newSubscriptionId);
    /// @notice Emitted when the callback gas limit is updated
    event CallbackGasLimitUpdated(uint32 newCallbackGasLimit);
    /// @notice Emitted when the encrypted secrets reference is updated
    event EncryptedSecretsReferenceUpdated(FunctionsRequest.Location newSecretsLocation, bytes newEncryptedSecretsReference);

    constructor(
        address router,
        bytes32 _donId,
        string memory _source,
        FunctionsRequest.Location _secretsLocation,
        bytes memory _encryptedSecretsReference,
        uint64 _subscriptionId,
        uint32 _callbackGasLimit
    ) FunctionsClient(router) ConfirmedOwner(msg.sender) {
        if (_donId == bytes32(0)) revert InvalidDONId();
        if (bytes(_source).length == 0) revert EmptySourceCode();
        if (_subscriptionId == 0) revert InvalidSubscriptionId();
        if (_callbackGasLimit == 0) revert InvalidCallbackGasLimit();
        
        donId = _donId;
        s_source = _source;
        s_secretsLocation = _secretsLocation;
        s_encryptedSecretsReference = _encryptedSecretsReference;
        s_subscriptionId = _subscriptionId;
        s_callbackGasLimit = _callbackGasLimit;
    }

    /**
     * @notice Update the subscription ID (owner only)
     * @param newSubscriptionId New subscription ID
     */
    function setSubscriptionId(uint64 newSubscriptionId) external onlyOwner {
        if (newSubscriptionId == 0) revert InvalidSubscriptionId();
        s_subscriptionId = newSubscriptionId;
        emit SubscriptionIdUpdated(newSubscriptionId);
    }

    /**
     * @notice Update the callback gas limit (owner only)
     * @param newCallbackGasLimit New callback gas limit
     */
    function setCallbackGasLimit(uint32 newCallbackGasLimit) external onlyOwner {
        if (newCallbackGasLimit == 0) revert InvalidCallbackGasLimit();
        s_callbackGasLimit = newCallbackGasLimit;
        emit CallbackGasLimitUpdated(newCallbackGasLimit);
    }

    /**
     * @notice Update the encrypted secrets reference (owner only)
     * @param newSecretsLocation New secrets location
     * @param newEncryptedSecretsReference New encrypted secrets reference
     */
    function setEncryptedSecretsReference(FunctionsRequest.Location newSecretsLocation, bytes memory newEncryptedSecretsReference) external onlyOwner {
        s_secretsLocation = newSecretsLocation;
        s_encryptedSecretsReference = newEncryptedSecretsReference;
        emit EncryptedSecretsReferenceUpdated(newSecretsLocation, newEncryptedSecretsReference);
    }

    /**
     * @notice Prepares a Functions request with the given parameters
     * @dev Helper function for request preparation to avoid stack too deep errors
     */
    function _prepareRequest(
        string[] memory args,
        bytes[] memory bytesArgs
    ) internal view returns (bytes memory) {
        FunctionsRequest.Request memory req;
        req.initializeRequest(
            FunctionsRequest.Location.Inline,
            FunctionsRequest.CodeLanguage.JavaScript,
            s_source
        );
        req.secretsLocation = s_secretsLocation;
        req.encryptedSecretsReference = s_encryptedSecretsReference;
        if (args.length > 0) {
            req.setArgs(args);
        }
        if (bytesArgs.length > 0) {
            req.setBytesArgs(bytesArgs);
        }
        return req.encodeCBOR();
    }

    /**
     * @notice Triggers an on-demand Functions request - can be overridden by child contracts     
     * @dev Can be overridden by child contracts that need custom logic, but most should use this
     * @param args String arguments passed into the source code and accessible via the global variable `args`
     * @param bytesArgs Bytes arguments passed into the source code and accessible via the global variable `bytesArgs` as hex strings
     * @return requestId The ID of the request
     */
    function sendRequest(
        string[] calldata args,
        bytes[] calldata bytesArgs
    ) external virtual onlyOwner returns (bytes32) {
        _validateRequest(args, bytesArgs);
        
        // Prepare the encoded request using all stored configuration
        bytes memory encodedRequest = _prepareRequest(args, bytesArgs);
        
        bytes32 requestId = _sendRequest(
            encodedRequest,
            s_subscriptionId,
            s_callbackGasLimit,
            donId
        );

        s_requestIds[requestId] = true;
        s_lastRequestId = requestId;
        _processRequest(requestId, args);
        
        _beforeFulfill(args);
        
        emit OracleRequestSent(requestId);
        
        // Child contracts responsible for handling events
        _emitRequestEvents(requestId, args);
        
        return requestId;
    }
    
    /**
     * @notice Hook for validating request inputs
     * @dev Override in child contracts to perform custom validation
     * @param args String arguments passed to sendRequest
     * @param bytesArgs Bytes arguments passed to sendRequest
     */
    function _validateRequest(
        string[] calldata args,
        bytes[] calldata bytesArgs
    ) internal virtual { }
    
    /**
     * @notice Hook for processing request data
     * @dev Override in child contracts to store request-specific data
     * @param requestId The ID of the request
     * @param args String arguments passed to sendRequest
     */
    function _processRequest(
        bytes32 requestId, 
        string[] calldata args
    ) internal virtual { }
    
    /**
     * @notice Hook for emitting custom events
     * @dev Override in child contracts to emit additional events
     * @param requestId The ID of the request
     * @param args String arguments passed to sendRequest
     */
    function _emitRequestEvents(
        bytes32 requestId,
        string[] calldata args
    ) internal virtual { }

    /**
     * @notice Hook that is called before fulfillment with the request arguments
     * @param args The arguments that were passed to sendRequest
     */
    function _beforeFulfill(string[] calldata args) internal virtual;

    /**
     * @notice Hook that is called to process the response
     * @param requestId The request ID, returned by sendRequest()
     * @param response The response from the oracle
     */
    function _processResponse(bytes32 requestId, bytes memory response) internal virtual;

    /**
     * @notice Store latest result/error
     * @param requestId The request ID, returned by sendRequest()
     * @param response Aggregated response from the user code
     * @param err Aggregated error from the user code or from the execution pipeline
     * Either response or error parameter will be set, but never both
     */
    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal override {
        if(!s_requestIds[requestId]) {
            revert UnexpectedRequestID(requestId);
        }

        s_lastResponse = response;
        s_lastError = err;

        if (err.length == 0) {
            if (response.length == 0) {
                revert FulfillmentFailed();
            }
            _processResponse(requestId, response);
        }

        s_requestIds[requestId] = false;
    }
} 