# CrvUSDToUSDOracle

## Overview

The CrvUSDToUSDOracle contract provides a robust, multi-stage oracle system for determining the USD price of crvUSD. This oracle is critical for the RAAC protocol as it ensures continuous pricing availability even during oracle outages, stale data, or extreme market conditions.

## Purpose

- Provide reliable crvUSD/USD pricing for the RAAC ecosystem
- Implement a multi-stage fallback mechanism to handle oracle failures
- Protect against price manipulation and extreme volatility through circuit breakers
- Ensure the protocol remains operational even during adverse market conditions

## Multi-Stage Oracle Architecture

One of the main challenges faced by the RAAC protocol was determining what to do during depeg events, stale prices, or incorrect price feeds. Since other critical components such as the RWA vault and overall protocol depend on crvUSD prices, reverting was not an option. Therefore, a sophisticated multi-stage oracle system was implemented.

### Stage 1: Primary Chainlink Oracle (crvUSD/USD)
The oracle first attempts to use the direct Chainlink crvUSD/USD price feed:
- **Validation**: Checks that the price is positive and updated within `maxStableStaleTime` (default: 25 hours)
- **Fallback Level**: 0
- **Benefits**: Most direct and accurate pricing when available

### Stage 2: Derived Price from ETH/USD + ETH/crvUSD
If the primary Chainlink feed is stale or unavailable, the oracle derives the crvUSD/USD price using:
- **ETH/USD price**: From Chainlink ETH/USD feed
- **ETH/crvUSD price**: From Curve pool oracle (TriCRV)
- **Calculation**: `crvUSD/USD = (ETH/USD) / (ETH/crvUSD)`
- **Validation**: ETH/USD feed must be updated within `maxUnstableStaleTime` (default: 70 minutes)
- **Fallback Level**: 1
- **Benefits**: Although not perfect, this provides a good approximation of the actual crvUSD/USD price during stale conditions

### Stage 3: Hard-coded Fallback Price
As a final resort, the oracle returns a pre-configured fallback price:
- **Default**: 1.0 USD (1e18 in 18 decimals)
- **Fallback Level**: 2
- **Benefits**: Ensures the protocol never reverts due to pricing issues

## Circuit Breaker Protection

To protect against depeg events and extreme price volatility, the oracle implements circuit breakers similar to those found in traditional trading markets. This gives the protocol time to pause the system or take other protective measures.

### How Circuit Breakers Work

1. **Price Validation**: All prices (from any stage) are validated against configurable thresholds
2. **Clamping Mechanism**: If prices exceed the safe range, they are clamped to the threshold values
3. **Threshold Configuration**: 
   - Default minimum: 0.9 USD (90% of peg)
   - Default maximum: 1.1 USD (110% of peg)
4. **Graceful Handling**: Unlike traditional circuit breakers that halt trading, these clamp prices to maintain protocol operations

### Circuit Breaker Benefits

- **Depeg Protection**: Prevents extreme price deviations from affecting protocol operations
- **Time to React**: Provides opportunity for governance to respond to market anomalies
- **Continued Operations**: Protocol remains functional even during extreme market conditions
- **Configurable Limits**: Thresholds can be adjusted based on market conditions

## Key Functions

| Function Name | Description | Access | Parameters |
|---------------|-------------|--------|------------|
| getLatestPrice | Returns crvUSD price in USD with timestamp and fallback level | Public View | – |
| getPrice | Returns crvUSD price in USD (simplified interface) | Public View | – |
| decimals | Returns the number of decimals (18) | Public View | – |
| setCrvUSDDataFeed | Sets the primary Chainlink crvUSD/USD feed address | Owner Only | `_crvUSDDataFeed`: Feed address |
| setEthDataFeed | Sets the Chainlink ETH/USD feed address | Owner Only | `_ethDataFeed`: Feed address |
| setCurveOracle | Sets the Curve oracle address for ETH/crvUSD pricing | Owner Only | `_curveOracle`: Oracle address |
| setMaxStableStaleTime | Sets maximum staleness for primary feed | Owner Only | `_maxStableStaleTime`: Time in seconds |
| setMaxUnstableStaleTime | Sets maximum staleness for ETH feed | Owner Only | `_maxUnstableStaleTime`: Time in seconds |
| setFallbackPriceInUSD | Sets the hard-coded fallback price | Owner Only | `_fallbackPriceInUSD`: Price in 18 decimals |
| setCircuitBreakerConfig | Configures circuit breaker settings | Owner Only | `_enabled`, `_minThreshold`, `_maxThreshold` |

## Implementation Details

The CrvUSDToUSDOracle is implemented in the CrvUSDToUSDOracle.sol contract.

Key features of the implementation include:

- **Multi-stage Fallback**: Three-tier oracle system ensuring price availability
- **Circuit Breaker Protection**: Configurable price clamping to prevent extreme deviations
- **Staleness Detection**: Different staleness thresholds for stable vs. unstable conditions
- **Decimal Normalization**: All prices normalized to 18 decimals for consistency
- **Event Logging**: Comprehensive event emission for monitoring and debugging
- **Owner Controls**: Full configurability of all oracle parameters

## Fallback Level Indicators

The `getLatestPrice()` function returns a fallback level indicator:

- **Level 0**: Using primary Chainlink crvUSD/USD feed (most reliable)
- **Level 1**: Using derived price from ETH/USD + ETH/crvUSD (good approximation)
- **Level 2**: Using hard-coded fallback price (emergency mode)

## Interactions

The CrvUSDToUSDOracle contract interacts with:

- **Chainlink Price Feeds**: For primary crvUSD/USD and ETH/USD pricing
- **Curve Oracle**: For ETH/crvUSD pool pricing when deriving fallback prices
- **RAAC Protocol Contracts**: Providing crvUSD pricing for lending, vaults, and other operations
- **Owner/Governance**: For configuration updates and emergency controls

## Emergency Considerations

This oracle design prioritizes protocol continuity over perfect accuracy:

1. **Never Reverts**: Always returns a price, even if it's a fallback value
2. **Graceful Degradation**: Automatically switches between oracle sources
3. **Circuit Breaker Protection**: Clamps extreme prices rather than rejecting them
4. **Operator Controls**: Full configurability for emergency response

This approach ensures that critical RAAC protocol functions (lending, liquidations, vault operations) can continue operating even during extreme market conditions or oracle infrastructure failures. 