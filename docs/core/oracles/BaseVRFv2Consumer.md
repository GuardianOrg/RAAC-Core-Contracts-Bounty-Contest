# BaseVRFv2Consumer

## Overview

The BaseVRFv2Consumer is a Chainlink VRF v2-enabled contract that inherits from VRFConsumerBaseV2Plus. It provides a base implementation for consuming verifiable random numbers from Chainlink's VRF service. The contract is designed to be inherited by other contracts that require on-chain randomness.

## Purpose

- Provide base functionality for requesting and consuming verifiable random numbers
- Manage VRF request and fulfillment lifecycle
- Ensure one request at a time to maintain simplicity
- Handle request fulfillment through events rather than reverts
- Support both owner and external contract access for requests

## Access Control

The contract implements access control with distinct roles:

| Role | Description |
|------|-------------|
| Owner | Can send requests and manage configuration |
| External Contract | Can send requests (typically a token contract using randomness) |

## Key Functions

| Name | Description | Access | Parameters |
|------|-------------|---------|------------|
| requestRandomWords | Requests random numbers from VRF | Owner/External | None |
| fulfillRandomWords | Processes VRF response | Internal | `_requestId`: uint256 <br> `_randomWords`: uint256[] |
| getRequestStatus | Returns current request status | Public | None |
| getLastFulfillTimestamp | Returns last fulfillment timestamp | Public | None |

## Configuration Functions

| Name | Description | Access | Parameters |
|------|-------------|---------|------------|
| setExternalContract | Sets authorized external contract | Owner | `_externalContract`: address |
| setSubscriptionId | Updates VRF subscription ID | Owner | `_subscriptionId`: uint256 |
| setKeyHash | Updates VRF key hash | Owner | `_keyHash`: bytes32 |
| setCallbackGasLimit | Updates callback gas limit | Owner | `_callbackGasLimit`: uint32 |
| setRequestConfirmations | Updates request confirmations | Owner | `_requestConfirmations`: uint16 |
| setNumWords | Updates number of random words | Owner | `_numWords`: uint32 |

## Implementation Details

The component implements:

- Integration with Chainlink VRF v2
- Single request at a time management
- Event-based error handling
- Configurable parameters
- State tracking for requests and fulfillments

Dependencies:

- @chainlink/contracts/VRFConsumerBaseV2Plus
- @chainlink/contracts/VRFV2PlusClient

## Events

| Name | Type | Description |
|------|------|-------------|
| RequestSent | uint256, uint32 | Emitted when request is sent |
| RequestFulfilled | uint256, uint256[] | Emitted when request is fulfilled |
| RequestNotFound | uint256 | Emitted when fulfillment references non-existent request |
| RequestIdMismatch | uint256, uint256 | Emitted when fulfillment ID doesn't match last request |

## Error Conditions

| Name | Description |
|------|-------------|
| Unauthorized | Caller is not owner or external contract |
| RequestAlreadyPending | New request attempted while previous is pending |
| InvalidAddress | Zero address provided for external contract |
| InvalidSubscriptionId | Zero subscription ID provided |
| InvalidValue | Zero value provided for configuration |
| ErrorRequestNotFound | Request status queried for non-existent request |

## Important Notes

- Only one request can be pending at a time
- No request stalling mechanism implemented
- Network congestion delays are tolerated
- Errors during fulfillment are handled via events rather than reverts
- Requires valid Chainlink VRF subscription
- Configuration parameters must be set during construction
- Supports both owner and external contract access for requests

## Test Setup Requirements

1. Contract Setup:
   - Deploy mock VRF Coordinator
   - Deploy inheriting contract
   - Set valid subscription ID
   - Configure VRF parameters

2. Test Categories:
   - Access control verification
   - Request handling
   - Response processing
   - Configuration updates
   - Error handling
   - Event emission 