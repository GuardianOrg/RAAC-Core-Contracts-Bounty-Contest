// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;


interface IFunctionsRouter {
    /// @notice Sends a request using the provided subscriptionId
  /// @param subscriptionId - A unique subscription ID allocated by billing system,
  /// a client can make requests from different contracts referencing the same subscription
  /// @param data - CBOR encoded Chainlink Functions request data, use FunctionsClient API to encode a request
  /// @param dataVersion - Gas limit for the fulfillment callback
  /// @param callbackGasLimit - Gas limit for the fulfillment callback
  /// @param donId - An identifier used to determine which route to send the request along
  /// @return requestId - A unique request identifier
  function sendRequest(
    uint64 subscriptionId,
    bytes calldata data,
    uint16 dataVersion,
    uint32 callbackGasLimit,
    bytes32 donId
  ) external returns (bytes32);
}


/**
 * @notice A minimal mock of the Chainlink Functions Router,
 *         returning a unique requestId each time sendRequest is called.
 */
contract MockFunctionsRouter is IFunctionsRouter {
    // We won't implement everything from IFunctionsRouter, just the bare minimum for tests.
    
    // Counter to generate unique requestIds
    uint256 private requestCounter = 0;

    // -------------
    // IFunctionsRouter stubs
    // -------------

    // This is required by the client. We'll just stub it out.
    function getContractById(bytes32) external pure returns (address) {
        return address(0);
    }

    // The real router's sendRequest function returns a bytes32 requestId.
    // We'll generate a unique requestId for each call.
    function sendRequest(
        uint64,       // subscriptionId
        bytes memory, // data
        uint16,       // dataVersion
        uint32,       // gasLimit
        bytes32       // donId
    ) external returns (bytes32) {
        // Increment the counter
        requestCounter++;
        
        // Create a unique requestId based on the counter
        bytes32 requestId = keccak256(abi.encode("request", requestCounter));
        return requestId;
    }

    // We won't bother implementing the rest for this minimal example.
}
