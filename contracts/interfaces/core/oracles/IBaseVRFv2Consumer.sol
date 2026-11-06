// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

interface IBaseVRFv2Consumer {
    struct RequestStatus {
        bool fulfilled;
        bool exists;
        uint256[] randomWords;
    }

    function requestRandomWords() external returns (uint256 requestId);

    function getRequestStatus() external view returns (RequestStatus memory);

    function getLastFulfillTimestamp() external view returns (uint256);

    event RequestSent(uint256 requestId, uint32 numWords);
    event RequestFulfilled(uint256 requestId, uint256[] randomWords);
    event RequestNotFound(uint256 requestId);
    event RequestIdMismatch(uint256 requestId, uint256 lastRequestId);
    event RequestStalled(uint256 requestId);

    event MaxStallUpdated(uint256 _newMaxStall);

    error RequestNotFulfilled();
    error RequestAlreadyPending();

    error ErrorRequestNotFound();
    error Unauthorized();
    error InvalidAddress();
    error InvalidSubscriptionId();
    error InvalidValue();

    event ExternalContractUpdated(address _newAddress);
    event SubscriptionIdUpdated(uint256 _newId);
    event KeyHashUpdated(bytes32 _newHash);
    event CallbackGasUpdated(uint32 _newLimit);
    event RequestConfirmationsUpdated(uint16 _newValue);
    event NumWordsUpdated(uint32 _newValue);
}
