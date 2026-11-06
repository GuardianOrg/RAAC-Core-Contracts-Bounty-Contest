# RAAC Core Contracts

## Getting Started

## Read the doc live : [https://docs.raac.io/](https://docs.raac.io/)

### Prerequisites

- Node.js

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/RegnumAurumAcquisitionCorp/core
   cd core
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

### Running the Project

To start a local development environment with all contracts deployed:

```bash
npm run dev
```

This command will:
- Start a local Ethereum node
- Deploy all contracts
- Populate the `configs/chains.json` file with deployed contract addresses

## Documentation

For detailed information about the RAAC system, please refer to the [documentation](docs/README.md).

You also can run docsify locally with:

```bash
docsify serve ./docs
```

### Deployments

See [DEPLOY.md](DEPLOY.md) for more information on deploying the docsify server or the smart contracts.

### Testing and Security

See [TESTING.md](TESTING.md) for more information on testing and security. Run the `npm test` for a simple run-all look at the errors.

## Contributing

## License

## Acknowledgments

- OpenZeppelin for secure smart contract libraries
