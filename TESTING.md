# Testing and Security

This repository contains a number of tools and scripts to help with testing and security.

We use hardhat internally, the whole test-suite can be executed running the `npm test` command will run all the unit and e2e tests.  Thoses tests can be found in the `test` directory.

Alternatively, e2e tests can be ran independently with the `npm run test:e2e`; The Goal of such test is to simulate as closely as possible the contracts stacks and integration between them.  

We have a burn-in test (it will run over and over the same tests) with the `npm run test:burn-in`.

A `npm run test:unit:all` allow for unit test specific executions.  
For specific debugging or developement tests, a series of singular tests are available:

| NPM Script Command | Executed Equivalent Command |
|-------------------|----------------------------|
| **test:unit:collectors** | npx hardhat test test/unit/core/collectors/*.test.js |
| **test:unit:collectors:fee** | npx hardhat test test/unit/core/collectors/FeeCollector.test.js |
| **test:unit:governance** | npx hardhat test test/unit/core/governance/*/*.test.js |
| **test:unit:tokens** | npx hardhat test test/unit/core/tokens/*.test.js |
| **test:unit:tokens:debt** | npx hardhat test test/unit/core/tokens/DebtToken.test.js |
| **test:unit:tokens:rtoken** | npx hardhat test test/unit/core/tokens/RToken.test.js |
| **test:unit:tokens:raacnft** | npx hardhat test test/unit/core/tokens/RAACNFT.test.js |
| **test:unit:zeno** | npx hardhat test test/unit/Zeno/Integration.test.js |
| **test:unit:minters** | npx hardhat test test/unit/core/minters/*.test.js |
| **test:unit:minters:minter** | npx hardhat test test/unit/core/minters/RAACMinter.test.js |
| **test:unit:minters:orchestrator** | npx hardhat test test/unit/core/minters/RAACReleaseOrchestrator.test.js |
| **test:unit:pools** | npx hardhat test test/unit/core/pools/*/*.test.js |
| **test:unit:pools:lendingpool** | npx hardhat test test/unit/core/pools/LendingPool/LendingPool.test.js |
| **test:unit:pools:stabilitypool** | npx hardhat test test/unit/core/pools/StabilityPool/StabilityPool.test.js |
| **test:unit:raac** | npx hardhat test test/unit/core/tokens/RAACToken.test.js |
| **test:unit:veraac** | npx hardhat test test/unit/core/tokens/veRAACToken.test.js |
| **test:unit:libraries** | npx hardhat test test/unit/libraries/*/*.test.js |
| **test:integration:governance** | npx hardhat test contracts/test/integration/governance.integration.js |
| **test:unit:oracles** | npx hardhat test test/unit/core/oracles/*.test.js |

Run independants tests by following the same patterns.

## Smart Contract Analysis

We use Slither for static analysis of our smart contracts.

### Installing Slither

To install Slither, using a virtual environment:

### Create a virtual environment and activate it

   ```bash
   python3 -m venv ./venv/
   python3 -m venv ./venv/slither-env
   source ./venv/slither-env/bin/activate
   ```

### Install Slither

   ```bash
   pip install slither-analyzer
   ```

### Running Slither

To analyze the smart contracts, run:

```bash
slither .
```
