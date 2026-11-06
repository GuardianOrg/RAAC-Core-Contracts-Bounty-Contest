# RAACHousePrices

## Overview

The RAACHousePrices contract serves as a price oracle for RAAC NFTs, storing and managing house prices associated with specific token IDs.

## Purpose

- Store and manage house prices for RAAC NFTs
- Allow updates to house prices through an authorized oracle
- Provide a mechanism for retrieving the latest price for a given token ID

## Key Functions

| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| setOracle | Sets the address of the authorized oracle | Owner Only | `_oracle`: Address of the new oracle |
| updatePriceFromOracle | Updates the price of a token from the oracle | Oracle Only | `_tokenId`: ID of the token to update<br>`_newPrice`: New price for the token |
| getLatestPrice | Retrieves the latest price and timestamp for a token | Public View | `_tokenId`: ID of the token |
| setHousePrice | Manually sets the price for a token | Owner Only | `_tokenId`: ID of the token to update<br>`_amount`: New price for the token |
| setDataFeed | Sets the Chainlink data feed used for spot pricing | Owner Only | `_dataFeed`: Address of the feed |
| setCircuitBreakerEnabled | Enables/disables the circuit breaker | Owner Only | `_enabled`: Boolean |
| setCircuitBreakerThresholds | Updates min/max price thresholds for the circuit breaker | Owner Only | `_minThreshold`, `_maxThreshold` |
| checkCircuitBreakerStatus | Returns the current circuit breaker status code | Public View | – |

## Implementation Details

The RAACHousePrices is implemented in the RAACHousePrices.sol contract.

Key features of the implementation include:

- Uses OpenZeppelin's Ownable for access control
- Stores house prices in a mapping of token IDs to prices
- Implements a time-based update interval to prevent too frequent price updates
- Allows for both oracle-based and manual price updates
- Implements a circuit breaker that validates oracle prices against configurable upper and lower thresholds
- When the circuit breaker is triggered, `getLatestPrice` gracefully returns a fallback price (the last on-chain price) instead of reverting, ensuring downstream protocols continue to operate
- Provides owner-controlled toggles and threshold setters for the circuit breaker

## Interactions

The RAACHousePrices contract interacts with:

- Oracle: An external entity authorized to update prices
- Owner: For setting the oracle address and manual price updates
- Other contracts: For querying the latest prices of tokens

## Circuit Breaker & Fallback Pricing

RAACHousePrices integrates a **circuit breaker** to protect the system from abnormal oracle prices (e.g., stale data, extreme volatility, or malicious manipulation).

1. **How it works**
   • The contract continuously compares the Chainlink oracle price to owner-configurable `minPriceThreshold` and `maxPriceThreshold` values (8-decimals).
   • If the current oracle price is **outside** this safe range **or** the oracle returns a non-positive value, the circuit breaker is considered *triggered*.

2. **Fallback behaviour**
   • Instead of reverting, `getLatestPrice` **returns the last stored house price** (i.e., the on-chain USD value previously written by the oracle) along with its timestamp.
   • This design choice guarantees that dependent contracts—such as **RWAIndexToken**, **RAACNFT**, and other on-chain accounting modules—can still function even during oracle outages. Having prices go down is preferable to halting critical functionality.

3. **Operator controls**
   • The owner can toggle the circuit breaker on or off with `setCircuitBreakerEnabled`.
   • Safe price bands can be updated via `setCircuitBreakerThresholds(min, max)`.

4. **Status checks**
   • External actors can call `checkCircuitBreakerStatus()` to inspect whether the circuit breaker is currently active and to fetch the latest oracle price used in the evaluation.

By returning a fallback price rather than reverting, RAACHousePrices keeps the broader RAAC ecosystem operational even in adverse market or oracle conditions.
