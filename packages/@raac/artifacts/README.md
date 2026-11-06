# @raac/artifacts

Contract artifacts, TypeChain types, and error utilities for the RAAC protocol.

## Installation

```bash
npm install @raac/artifacts
```

## Usage

### TypeChain Types

Use typed contract factories for type-safe interactions:

```typescript
import { ethers } from 'ethers';
import { 
  LendingPool__factory, 
  RAACToken__factory,
  RAACNFT__factory 
} from '@raac/artifacts';

const provider = new ethers.JsonRpcProvider('...');
const signer = await provider.getSigner();

const lendingPool = LendingPool__factory.connect(LENDING_POOL_ADDRESS, signer);
const raacToken = RAACToken__factory.connect(RAAC_TOKEN_ADDRESS, signer);

const balance = await raacToken.balanceOf(userAddress);
```

### Contract ABIs

Import ABIs directly for use with ethers or other libraries.

```typescript
import LendingPoolABI from '@raac/artifacts/artifacts/core/pools/LendingPool/LendingPool.sol/LendingPool.json';
import RAACTokenABI from '@raac/artifacts/artifacts/core/tokens/RAACToken.sol/RAACToken.json';

// Use within ethers
const contract = new ethers.Contract(address, LendingPoolABI.abi, provider);
```

### Error Handling

Decode custom Solidity errors using the error map:

```typescript
import errorMap from '@raac/artifacts/generated/errorMap.json';

function decodeError(errorData: string) {
  if (!errorData || errorData.length < 10) return null;
  const selector = errorData.slice(0, 10).toLowerCase();
  return errorMap[selector] || null;
}

try {
  await lendingPool.borrow(amount);
} catch (error: any) {
  const decoded = decodeError(error.data);
  if (decoded) {
    console.log(`Error: ${decoded.name}`);
    console.log(`Message: ${decoded.message}`);
  }
}
```

Here some common artifacts to import:

```typescript
// Tokens
import RAACToken from '@raac/artifacts/artifacts/core/tokens/RAACToken.sol/RAACToken.json';
import RAACNFT from '@raac/artifacts/artifacts/core/tokens/RAACNFT.sol/RAACNFT.json';
import RToken from '@raac/artifacts/artifacts/core/tokens/RToken.sol/RToken.json';
import DebtToken from '@raac/artifacts/artifacts/core/tokens/DebtToken.sol/DebtToken.json';
import VeRAACToken from '@raac/artifacts/artifacts/core/tokens/veRAACToken.sol/veRAACToken.json';

// Pools
import LendingPool from '@raac/artifacts/artifacts/core/pools/LendingPool/LendingPool.sol/LendingPool.json';
import StabilityPool from '@raac/artifacts/artifacts/core/pools/StabilityPool/StabilityPool.sol/StabilityPool.json';

// Governance
import Governance from '@raac/artifacts/artifacts/core/governance/proposals/Governance.sol/Governance.json';
import GaugeController from '@raac/artifacts/artifacts/core/governance/gauges/GaugeController.sol/GaugeController.json';
```

## Prepare for publishing

### Regenerate error map

This will generate the error map based on the artifacts.

```bash
yarn generate:errors
```

### Setup the package

This will compile the contracts, copy the artifacts, generate the types and the error map.

```bash
yarn setup
```