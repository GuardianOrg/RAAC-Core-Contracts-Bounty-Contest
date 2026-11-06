# RAACHousePriceOracle

## Overview

The RAACHousePriceOracle is a Chainlink Functions-enabled oracle that fetches and updates house pricing data from off-chain APIs. It acts as a secure bridge between the RAAC protocol and external real estate pricing data sources.
It inhetics from [BaseChainlinkFunctionsOracles](core/oracles/BaseChainlinkFunctionsOracle.md)

## Purpose

- Fetch real-time house pricing data from off-chain sources
- Securely update house prices in the RAACHousePrices contract
- Provide a trusted price feed for the RAAC protocol
- Ensure data integrity through owner-controlled updates

## Access Control

The access control are implemented in the [inherited contract](core/oracles/BaseChainlinkFunctionsOracle.md).  

## Key Functions

| Name | Description | Access | Parameters |
|------|-------------|---------|------------|
| constructor | Initializes the oracle with router, DON ID and house prices contract | Public | `router`: Router address <br> `_donId`: DON ID <br> `housePricesAddress`: RAACHousePrices contract address |
| _beforeFulfill | Hook called before fulfillment to store house ID | Internal | `args`: string[] - Arguments passed to sendRequest |
| _processResponse | Processes oracle response and updates house price | Internal | `response`: bytes - Response from oracle |

## Implementation Details

The component implements:

- Integration with Chainlink Functions Client (via BaseChainlinFunctionsOracle)
- Secure price updates through oracle responses
- Error handling for failed requests
- House ID tracking for price updates
- Event emission for price changes
- Support for concurrent requests with different fulfillment order
- Handling of multiple requests for the same house ID (last request wins)
- Server script provides house values in 18 decimals to match RAACNFT contract requirements


Dependencies:

- [BaseChainlinkFunctionsOracles](core/oracles/BaseChainlinkFunctionsOracle.md)
- RAACHousePrices contract
- Stringutils contract (for `.stringToUint()`).

## Events

| Name | Description |
|------|-------------|
| HousePriceUpdated | Emitted when a house price is updated with new value |

## Error Conditions

| Name | Description |
|------|-------------|
| FulfillmentFailed | Oracle response processing failed |

### Test Setup Requirements

1. Contract Deployment:
   - Deploy MockFunctionsRouter
   - Deploy RAACHousePrices contract
   - Deploy RAACHousePriceOracle with router and DON ID
   - Set oracle address in RAACHousePrices

2. Test Categories:
   - Access control verification
   - Request handling
   - Response processing
   - Price update validation
   - Error handling

## Notes

- Requires valid Chainlink Functions subscription
- DON ID must be set during construction
- Only processes valid responses from authorized Chainlink nodes
- House prices are updated through the RAACHousePrices contract
- Integration setup handled through deployment process
- Security considerations for owner-only functions 

## Concurrent Request Handling

The oracle supports multiple concurrent requests with the following characteristics:

- Multiple requests can be in flight simultaneously
- Requests can be fulfilled in any order
- For multiple requests targeting the same house ID, the last fulfilled request's price update takes precedence
- Each request is tracked independently using a requestId to houseId mapping
- Request tracking data is cleaned up after successful fulfillment
