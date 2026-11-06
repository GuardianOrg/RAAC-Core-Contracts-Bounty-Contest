# RWAIndexTokenCollector

## Overview
`RWAIndexTokenCollector` is a thin, purpose-built wrapper around the generic [`ERC20Collector`](ERC20Collector.md).
Its sole responsibility is to aggregate swap fees that are generated when users trade the
**RWA Index Token** and forward them, in bulk, to the central [`FeeCollector`](FeeCollector.md).

Because it inherits all logic from `ERC20Collector`, the contract itself is extremely small – the constructor merely
supplies the addresses of the `FeeCollector`, the RWA Index ERC-20 token and a bytes32 **feeType** identifier
(`keccak256("RWA_INDEX_TOKEN_SWAP_FEE")`).  All behaviour (access-control, fee distribution, token rescue, …) is
therefore identical to `ERC20Collector` & `RAACTokenCollector`.

## Contract Details
- **Contract Name**: `RWAIndexTokenCollector`
- **Inheritance**: `ERC20Collector → AccessControl, ReentrancyGuard`
- **License**: BSL-1.1

## Constructor
```solidity
constructor(address _feeCollector, address _rwaIndexToken)
        ERC20Collector(_feeCollector, _rwaIndexToken, keccak256("RWA_INDEX_TOKEN_SWAP_FEE")) {}
```
| Parameter | Description |
|-----------|-------------|
| `_feeCollector` | Address of the protocol `FeeCollector` that ultimately receives the fees. |
| `_rwaIndexToken` | ERC-20 contract address of the RWA Index Token. |

**Behaviour**
1. Validates both addresses are non-zero (handled in `ERC20Collector`).
2. Sets immutable `feeType = keccak256("RWA_INDEX_TOKEN_SWAP_FEE")` so that the downstream `FeeCollector` credits the
   correct bucket.
3. Grants both `DEFAULT_ADMIN_ROLE` and `FEE_MANAGER_ROLE` to the deployer.

## Core Functions
The collector inherits all public API from `ERC20Collector`, most notably:
* `setFeeCollector(address)` – update the destination collector.
* `distributeCollectedFees()` – forward full token balance to `FeeCollector`.
* `rescueToken(address token, address recipient, uint256 amount)` – recover unrelated assets.

Refer to the [`ERC20Collector`](ERC20Collector.md#core-functions) documentation for detailed semantics.

## Fee Type Mapping
`FeeCollector` recognises the following mapping for **RWAIndexTokenCollector**:

| feeType hash | Human Name | Usage |
|--------------|------------|-------|
| `0xa6d8…` (`keccak256("RWA_INDEX_TOKEN_SWAP_FEE")`) | RWA Index Swap Fee | Portion of swap tax from DEX or liquidity pool trades |

## Security & Operational Notes
* **Fee-on-Transfer Safe** – Like all collectors, it relies on `FeeCollector` to account for deflationary behaviour,
  therefore it works even if the RWA Index Token applies a transfer tax.
* **Role Management** – Keep `FEE_MANAGER_ROLE` restricted to ops-multisig; malicious updates could siphon fees.
* **Distribution Cadence** – Operate an off-chain keeper or cron job to call `distributeCollectedFees()` on a regular
  schedule (e.g. daily) to minimise idle capital.

## Events & Errors
The collector surfaces the same events/errors as `ERC20Collector`:
* `FeeDistributed`, `FeeCollectorSet`, `TokenRescued`
* `ApprovalFailed`, `InvalidAddress`, `NoFeesToDistribute`, `CannotRescueMainAsset`

## Integration Steps
1. **Deploy** `RWAIndexTokenCollector` with correct addresses.
2. **Whitelist** the deployed address in any AMM or external fee source as the recipient of swap fees.
3. **Schedule** periodic `distributeCollectedFees()` transactions.
4. **Monitor** `FeeDistributed` events to track inflows in the protocol treasury. 