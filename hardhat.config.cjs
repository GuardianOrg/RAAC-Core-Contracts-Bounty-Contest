require("dotenv").config();
require("hardhat-contract-sizer");
require("hardhat-gas-reporter");
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("@nomicfoundation/hardhat-verify");


const deploymentNetworks = {};

if (process.env.BASE_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY) {
	deploymentNetworks.base = {
		url: process.env.BASE_RPC_URL,
		accounts: [process.env.DEPLOYER_PRIVATE_KEY],
	};
}

if (process.env.BASE_SEPOLIA_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY) {
	deploymentNetworks.baseSepolia = {
		url: process.env.BASE_SEPOLIA_RPC_URL,
		accounts: [process.env.DEPLOYER_PRIVATE_KEY],
	};
}

if (process.env.SEPOLIA_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY) {
	deploymentNetworks.sepolia = {
		url: process.env.SEPOLIA_RPC_URL,
		accounts: [process.env.DEPLOYER_PRIVATE_KEY],
	};
}

if (process.env.MAINNET_RPC_URL) {
	deploymentNetworks.mainnet = {
		url: process.env.MAINNET_RPC_URL,
		// accounts: [process.env.DEPLOYER_PRIVATE_KEY], // Removed for deployment verification
	};
}

const SolcV076 = {
	version: "0.7.6",
	settings: {
	  optimizer: {
		enabled: true,
		runs: 200,
	  },
	  evmVersion: "istanbul",
	},
  };
  
  const SolcV0820 = {
	version: "0.8.20",
	settings: {
	  optimizer: {
		enabled: true,
		runs: 200,
	  },
	  evmVersion: "shanghai",
	  viaIR: true,
  
	},
  };

  const SolcV0830 = {
	version: "0.8.30",
	settings: {
	  optimizer: {
		enabled: true,
		runs: 1,
		details: {
			yul: true
		}
	  },
	  evmVersion: "shanghai",
	  viaIR: true,
	},
  };

const config = {
	solidity: {
		compilers: [SolcV076, SolcV0820, SolcV0830],
	},
	networks: {
		hardhat: {
			mining: {
				auto: true,
				interval: 0
			},
			forking: {
				enabled: !!(process?.env?.FORK_RPC_URL),
				url: process?.env?.FORK_RPC_URL || '',
				blockNumber: process?.env?.FORK_BLOCK_NUMBER ? parseInt(process.env.FORK_BLOCK_NUMBER) : undefined,
			},
			// Autofork for sepolia: if we have RPC, we 11155111, otherwise 8453
			chainId: (() => {
				if (process?.env?.FORK_CHAIN_ID) return parseInt(process.env.FORK_CHAIN_ID);
				const url = process?.env?.FORK_RPC_URL || '';

				const chainId = url.includes('sepolia') ? 11155111 : url.includes('mainnet') ? 1 : 8453;
				return chainId;
			})(),
			gasPrice: 1000000000, // 1 gwei
			allowBlocksWithSameTimestamp: process.env.ALLOW_SAME_TIMESTAMP !== "false",
			allowUnlimitedContractSize: false
		},
		devnet: {
			url: "http://0.0.0.0:8545",
			chainId: 8453,
		},
		...deploymentNetworks,
	},
	etherscan: {
		enabled: true,
		apiKey: process.env.ETHERSCAN_API_KEY,
		customChains: [
			{
				network: "baseSepolia",
				chainId: 84532,
				urls: {
					apiURL: "https://api-sepolia.basescan.org/api",
					browserURL: "https://sepolia.basescan.org/",
				},
			},
		],
	},

	sourcify: {
		enabled: true,
	},

	paths: {
		sources: "./contracts",
		tests: "./test",
		cache: "./cache",
		artifacts: "./artifacts",
		"@openzeppelin": "./node_modules/@openzeppelin",
	},

	gasReporter:{
		enabled: process.env.COINMARKETCAP_KEY !== undefined,
		L1: "ethereum",
		token: "ETH",
		currency: "USD",
		coinmarketcap: process.env.COINMARKETCAP_KEY,
		L1Etherscan: process.env.ETHERSCAN_API_KEY,
	}
};

module.exports = config;