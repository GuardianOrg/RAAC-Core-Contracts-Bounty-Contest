# RagequitLib

## Overview

The RagequitLib library provides functionality for calculating ragequit fees and fee distributions. It implements a dual-fee system with fixed and variable components, where the variable fee scales based on remaining lock time, enabling users to exit their locked positions early with appropriate penalties.

## Purpose

- Calculate fixed exit fees as a percentage of locked amount
- Calculate variable exit fees based on remaining lock duration
- Cap remaining time to maximum duration for fee calculations
- Split variable fees between treasury and stream destinations
- Provide high-precision fee calculations using basis points
- Support early exit mechanisms for locked token positions

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|---------|------------|---------|
| cappedRemaining | Caps remaining time to max duration | External Pure | `unlockTime`: Lock unlock timestamp<br>`nowTs`: Current timestamp<br>`maxDuration`: Maximum lock duration | uint256: Capped remaining time |
| computeFeesForLock | Computes fixed and variable fees | External Pure | `amount`: Locked amount<br>`remainingTime`: Remaining time (capped)<br>`maxDuration`: Max lock duration<br>`fixedExitFee`: Fixed fee in BPS<br>`maxVariableExitFee`: Max variable fee in BPS<br>`bpsDenominator`: BPS denominator | (uint256, uint256): fixedFee and variableFee |
| splitVariable | Splits variable fee into parts | External Pure | `variableFee`: Total variable fee | (uint256, uint256): toTreasury and toStream |

## Implementation Details

### Features:

- Dual-fee structure with fixed and variable components
- Time-weighted variable fee calculation
- High-precision arithmetic using basis points
- Fixed 33%/67% split for variable fees
- Automatic handling of zero duration edge cases
- No external dependencies or state modifications

### Fee Calculation Logic:

**Fixed Fee:**
- Constant percentage of the locked amount
- Formula: `fixedFee = (amount * fixedExitFee) / bpsDenominator`
- Typically burned as a penalty

**Variable Fee:**
- Scales linearly with remaining lock time
- Formula: 
  1. `remainingRatio = (remainingTime * bpsDenominator) / maxDuration`
  2. `variableFeeBPS = (remainingRatio * maxVariableExitFee) / bpsDenominator`
  3. `variableFee = (amount * variableFeeBPS) / bpsDenominator`
- Higher remaining time results in higher variable fee
- Zero if no time remaining or max duration is zero

**Variable Fee Distribution:**
- 33% allocated to treasury
- 67% allocated to stream
- Formula: `toTreasury = (variableFee * 33) / 100`
- Formula: `toStream = variableFee - toTreasury`

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Treasury Split | 33% | Percentage of variable fee to treasury |
| Stream Split | 67% | Percentage of variable fee to stream |

## Usage Notes

- All fee parameters are expressed in basis points (BPS)
- Standard BPS denominator is 10,000 (1 BPS = 0.01%)
- Remaining time should be capped using `cappedRemaining` before fee calculation
- If `maxDuration` is 0, variable fee returns 0
- If `remainingTime` is 0, variable fee returns 0
- Fixed fee is independent of time remaining
- Variable fee increases linearly with remaining lock time
- Maximum variable fee is reached at full `maxDuration`
- Fee calculations use integer arithmetic with high precision
- No rounding errors due to careful order of operations
- All functions are pure (no state reads or writes)

## Example Scenarios

**Scenario 1: Early Exit with 75% Time Remaining**
- Amount: 1000 tokens
- Remaining time: 3 years (out of 4 max)
- Fixed fee (5%): 50 tokens
- Variable fee (max 20%): 15 tokens (75% of max)
- Total penalty: 65 tokens
- User receives: 935 tokens
- Treasury receives: 4.95 tokens (33% of variable)
- Stream receives: 10.05 tokens (67% of variable)

**Scenario 2: Exit Near Expiration**
- Amount: 1000 tokens
- Remaining time: 0.1 years (out of 4 max)
- Fixed fee (5%): 50 tokens
- Variable fee: 0.5 tokens (2.5% of max)
- Total penalty: 50.5 tokens
- User receives: 949.5 tokens

**Scenario 3: Exit at Expiration**
- Amount: 1000 tokens
- Remaining time: 0
- Fixed fee (5%): 50 tokens
- Variable fee: 0 tokens
- Total penalty: 50 tokens
- User receives: 950 tokens

## Dependencies

The library depends on:

- Solidity version 0.8.19 or higher for safe math operations
- No external contract dependencies

## Security Considerations

- All arithmetic operations use Solidity 0.8+ overflow protection
- Division order prevents precision loss in multi-step calculations
- Edge cases (zero duration, zero time) are explicitly handled
- Fee calculations are deterministic and cannot be manipulated
- Pure functions ensure no unexpected state changes
- BPS denominator should match standard (10,000) for correct calculations
- Remaining time must be pre-capped to prevent fee inflation
- Fixed fee should be validated to not exceed 100% (10,000 BPS)
- Max variable fee should be validated to not exceed reasonable bounds
- Total fees (fixed + variable) can theoretically exceed amount if parameters are misconfigured
- Implementing contracts should validate fee parameters on initialization
- Treasury/stream split is hardcoded and cannot be changed
- Integer division in splitVariable may result in 1 wei dust going to stream