# PowerCheckpoint

## Overview

The PowerCheckpoint library provides checkpointing utilities compatible with governance systems, backed by LockManager point calculations. It manages historical voting power tracking through compressed checkpoints and integrates with the LockManager for accurate power decay calculations at specific block numbers.

## Purpose

- Track historical voting power for governance participants
- Manage proposal-specific voting power snapshots
- Maintain compressed checkpoint history for gas efficiency
- Track total supply changes over time with decay calculations
- Support governance power queries at historical blocks
- Provide efficient binary search for checkpoint lookups
- Integrate with LockManager for accurate power decay

## Key Functions

| Function Name | Description | Access | Parameters | Returns |
|---------------|-------------|---------|------------|---------|
| writeCheckpoint | Creates new compressed checkpoint | External | `state`: Checkpoint state<br>`user`: User address<br>`newPower`: New voting power | None |
| getVotingPowerAtBlock | Gets voting power at historical block | External View | `state`: Checkpoint state<br>`lockState`: Lock state<br>`user`: User address<br>`blockNumber`: Target block | uint256: Historical voting power |
| getPastTotalSupply | Gets total supply at historical block | External View | `state`: Checkpoint state<br>`lockState`: Lock state<br>`blockNumber`: Target block | uint256: Historical total supply |
| setProposalSnapshot | Sets snapshot block for proposal | External | `state`: Checkpoint state<br>`proposalId`: Proposal ID<br>`blockNumber`: Snapshot block | None |
| findCheckpointIndex | Finds checkpoint index at or before block | Public View | `checkpoints`: Checkpoint array<br>`blockNumber`: Target block | uint256: Checkpoint index |
| latestCheckpoint | Gets the most recent checkpoint value | Public View | `cps`: Checkpoint array | uint256: Latest checkpoint value |

## Implementation Details

### Features:

- Compressed checkpoint storage using uint32 block numbers and uint224 values
- Binary search algorithm for efficient checkpoint lookups
- Integration with LockManager for power decay calculations
- Separate tracking for user checkpoints and total supply
- Proposal snapshot management with validation
- Fallback to LockManager history for decay between checkpoints
- Gas-efficient storage with packed checkpoint struct

## Data Structures

### CheckpointState
| Field | Type | Description |
|-------|------|-------------|
| userCheckpoints | mapping(address => Checkpoint[]) | Per-user voting power history |
| proposalSnapshots | mapping(uint256 => uint256) | Block numbers for proposal snapshots |
| totalSupplyCheckpoints | Checkpoint[] | Historical total supply data |

### Checkpoint
| Field | Type | Description |
|-------|------|-------------|
| fromBlock | uint32 | Block number when checkpoint was created |
| value | uint224 | Voting power value at checkpoint |

## Error Conditions

| Error Name | Description |
|------------|-------------|
| InvalidBlockNumber | Block number is in the future or invalid |
| InvalidBlockOrder | Block numbers are not in ascending order |
| InvalidProposalId | Proposal ID is zero (invalid) |
| PowerTooHigh | Power value exceeds uint224 maximum |

## Usage Notes

- Power values must not exceed uint224 maximum (26,959,946,667,150,639,794,667,015,087,019,630,673,637,144,422,540,572,481,103,610,249,215)
- Block numbers must be in the past for queries
- Proposal IDs must be non-zero for snapshot operations
- Checkpoints use compressed storage (uint32 for blocks, uint224 for values)
- When querying between checkpoints, the library falls back to LockManager for decay calculations
- Total supply queries use a 12-second block time assumption for decay calculations
- Binary search provides O(log n) lookup performance
- Zero address writes to total supply checkpoints
- Historical data is immutable once written

## Dependencies

The library depends on:

- LockManager library for lock state and power decay calculations
- Solidity version 0.8.19 or higher for overflow checks and safe math

## Security Considerations

- Power values are compressed and must be within uint224 range
- Block numbers are validated to prevent future block queries
- Proposal IDs must be non-zero to prevent accidental overwrites
- Only authorized contracts should write checkpoints
- Historical data is immutable and cannot be modified
- Binary search algorithm is bounds-checked
- Time decay calculations use safe math operations
- Block time assumption (12 seconds) is used for decay estimation
- Checkpoint compression maintains precision while saving gas
