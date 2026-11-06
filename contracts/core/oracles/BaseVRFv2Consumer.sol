// SPDX-License-Identifier: BUSL-1.1
// An example of a consumer contract that relies on a subscription for funding.
pragma solidity ^0.8.7;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "../../interfaces/core/oracles/IBaseVRFv2Consumer.sol";

/**
 * @notice This contract is used to consume VRF requests from Chainlink.
 * @author Chainlink Labs and RAAC Protocol Team
 * @dev All the chainlink VRF oracles should inherit from this contract
 * @dev For configuration variable such as coordinator or keyHash, see the documentation: https://docs.chain.link/docs/vrf/v2/subscription/supported-networks/#configurations
 * @dev Supports one request at a time. No batch requests.
 */
contract BaseVRFv2Consumer is VRFConsumerBaseV2Plus, IBaseVRFv2Consumer {
    RequestStatus public s_request;

    // Your subscription ID.
    uint256 s_subscriptionId;

    uint256 public lastRequestId;
    uint256 lastFulfillTimestamp;

    bytes32 keyHash;

    // Depends on the number of requested values that you want sent to the
    // fulfillRandomWords() function. Storing each word costs about 20,000 gas,
    // so 100,000 is a safe default for this example contract. Test and adjust
    // this limit based on the network that you select, the size of the request,
    // and the processing of the callback request in the fulfillRandomWords()
    // function.
    uint32 callbackGasLimit = 200000;

    uint16 requestConfirmations = 3;

    uint32 numWords = 1;
    uint256 public MAX_STALL = 60 minutes;
    uint256 public lastRequestTimestamp;

    /// @notice The address of the external contract that can call the function
    address public externalContract;

    /// @notice Only the owner or the external contract can call the function
    modifier onlyOwnerOrExternalContract() {
        if (msg.sender != owner() && msg.sender != externalContract) revert Unauthorized();
        _;
    }

    /**
     * @param subscriptionId The ID of the chainlink VRF subription for funding the request.
     * @param _vrfCoordinator The address of the VRF Coordinator on the blockchain. Vary for each network.
     * @param _keyHash The hash of the key used by the VRF Coordinator (X gwei key hash). Vary for each network.
     * @param _callbackGasLimit The gas limit for the callback function.
     * @param _requestConfirmations The number of confirmations required to fulfill the request.
     * @param _numWords The number of random words to request.
     */
    constructor(
        uint256 subscriptionId,
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations,
        uint32 _numWords,
        address _externalContract
    )
        VRFConsumerBaseV2Plus(_vrfCoordinator)
    {
        s_subscriptionId = subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        numWords = _numWords;
        externalContract = _externalContract;
    }

    /**
     * @notice Request random words from the VRF Coordinator.
     * @dev The contract must have a subscription to the VRF Coordinator.
     * @dev If the previous request is not fulfilled within MAX_STALL, the request will be ignored.
     * @dev The requestId is overwritten, so the previous request will be ignored in the fulfillRandomWords function.
     * @dev The requestId is returned, so the caller can track the request.
     */
    function requestRandomWords() external onlyOwnerOrExternalContract returns (uint256 requestId) {
        // Prevent new requests if previous one is not fulfilled
        if (s_request.exists && !s_request.fulfilled) {
            if (block.timestamp - lastRequestTimestamp > MAX_STALL) {
                emit RequestStalled(lastRequestId);
                // we allow sending another request. since the requestId is overritten, the previous one will be ignored in the fulfillRandomWords function
            } else {
                revert RequestAlreadyPending();
            }
        }
        
        // Will revert if subscription is not set and funded.
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );
        s_request = RequestStatus({
            randomWords: new uint256[](0),
            exists: true,
            fulfilled: false
        });
        lastRequestId = requestId;
        lastRequestTimestamp = block.timestamp;
        emit RequestSent(requestId, numWords);
        return requestId;
    }

    /**
     * @notice Fulfill the random words request.
     * @dev This function is called by the VRF Coordinator when the request is fulfilled.
     * @dev fulfillRandomWords must not revert.
     * @param _requestId The request ID.
     * @param _randomWords The random words.
     */
    function fulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) internal override {
        if (!s_request.exists) {
            emit RequestNotFound(_requestId);
            return;
        }
        // Verify requestId matches the last request
        if (_requestId != lastRequestId) {
            emit RequestIdMismatch(_requestId, lastRequestId);
            return;
        }

        s_request.fulfilled = true;
        s_request.randomWords = _randomWords;
        lastFulfillTimestamp = block.timestamp;
        emit RequestFulfilled(_requestId, _randomWords);
    }

    /**
     * @notice Get the request status.
     * @dev This function is used to get the request status.
     * @return The request status.
     */
    function getRequestStatus() external view returns (RequestStatus memory) {
        if (!s_request.exists) revert ErrorRequestNotFound();
        return s_request;
    }

    /**
     * @notice Get the last fulfill timestamp.
     * @dev This function is used to get the last fulfill timestamp.
     * @return The last fulfill timestamp.
     */
    function getLastFulfillTimestamp() external view returns (uint256) {
        return lastFulfillTimestamp;
    }

    // Setters
    /**
     * @notice Set the external contract.
     * @dev This function is used to set the external contract.
     * @param _externalContract The address of the external contract.
     */
    function setExternalContract(address _externalContract) external onlyOwner {
        if (_externalContract == address(0)) revert InvalidAddress();
        externalContract = _externalContract;
        emit ExternalContractUpdated(_externalContract);
    }

    /**
     * @notice Set the subscription ID.
     * @dev This function is used to set the subscription ID.
     * @param _subscriptionId The ID of the subscription.
     */
    function setSubscriptionId(uint256 _subscriptionId) external onlyOwner {
        if (_subscriptionId == 0) revert InvalidSubscriptionId();
        s_subscriptionId = _subscriptionId;
        emit SubscriptionIdUpdated(_subscriptionId);
    }

    /**
     * @notice Set the key hash.
     * @dev This function is used to set the key hash.
     * @param _keyHash The hash of the key.
     */
    function setKeyHash(bytes32 _keyHash) external onlyOwner {
        if (_keyHash == bytes32(0)) revert InvalidValue();
        keyHash = _keyHash;
        emit KeyHashUpdated(_keyHash);
    }

    /**
     * @notice Set the callback gas limit.
     * @dev This function is used to set the callback gas limit.
     * @param _callbackGasLimit The gas limit for the callback function.
     */
    function setCallbackGasLimit(uint32 _callbackGasLimit) external onlyOwner {
        if (_callbackGasLimit == 0) revert InvalidValue();
        callbackGasLimit = _callbackGasLimit;
        emit CallbackGasUpdated(_callbackGasLimit);
    }

    /**
     * @notice Set the request confirmations.
     * @dev This function is used to set the request confirmations.
     * @param _requestConfirmations The number of confirmations required to fulfill the request.
     */
    function setRequestConfirmations(uint16 _requestConfirmations) external onlyOwner {
        if (_requestConfirmations == 0) revert InvalidValue();
        requestConfirmations = _requestConfirmations;
        emit RequestConfirmationsUpdated(_requestConfirmations);
    }

    /**
     * @notice Set the number of words.
     * @dev This function is used to set the number of words.
     * @param _numWords The number of words.
     */
    function setNumWords(uint32 _numWords) external onlyOwner {
        if (_numWords == 0) revert InvalidValue();
        numWords = _numWords;
        emit NumWordsUpdated(_numWords);
    }

    /**
     * @notice Set the max stall value.
     * @dev This function is used to set the max stall value.
     * @param _maxStall The new value to add..
     */
    function setMaxStall(uint256 _maxStall) external onlyOwner {
        if (_maxStall == 0) revert InvalidValue();
        MAX_STALL = _maxStall;
        emit MaxStallUpdated(_maxStall);
    }
}

