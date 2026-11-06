import hre from "hardhat";
const { ethers } = hre;

// Helper function to deploy contracts
async function deployContract(name, args = []) {
	const Contract = await ethers.getContractFactory(name);
	const contract = await Contract.deploy(...args);
	await contract.waitForDeployment();
	return contract;
}


// TODO: setup fee collector and other fee stuff


async function main() {
	const network = await ethers.provider.getNetwork();
	// Check if the local node is running
	// try {
	// 	// the provider should be coming from the --network type we chose in the command line and config defined in hardhat.config.cjs
	// 	const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
	// 	await provider.getNetwork();
	// } catch (error) {
	// 	console.error("\x1b[31mError: Local node not detected!\x1b[0m");
	// 	console.log("\x1b[33mPlease start the local node first by running:\x1b[0m");
	// 	console.log("\x1b[36mnpm run node\x1b[0m");
	// 	process.exit(1);
	// }



	console.log(
		"\x1b[32mLocal node detected, proceeding with deployment...\x1b[0m"
	);

	console.log("Deploying on network:", network.name);

	// Get signers
	const [deployer, user, treasurySigner, feeCollectorSigner] =
		await ethers.getSigners();
	console.log("Deploying contracts with account:", deployer.address);

	// Track deployed addresses and constructor arguments
	const deployedAddresses = {
        CRVUSD: "0xd39d5D3289B6B76D4d584a9cD58AED99442D29eb",
        RWAVAULTTOKEN: "0xc23b30B0fd654f51e6b833d3d550c320c0f32018",
        RWAVAULT: "0x4e41b7d32D2AeD257e479a9d76ee00A3F38Cf38E",
    };
	const constructorArgs = {};

	

	const MockLiquidityPool = await ethers.getContractFactory("CurveStyleCrvUSDiRAACPool");
	const liquidityPoolArgs = [
		deployedAddresses.CRVUSD, deployedAddresses.RWAVAULTTOKEN,  // coin addresses - crvUSD first, IndexToken second
		deployedAddresses.RWAVAULT,
		1_00,                            // A parameter
		'crvUSD-iRAAC LP',             // LP token name
        'crvUSD-iRAAC-LP'              // LP token symbol
	]

	const liquidityPool = await MockLiquidityPool.deploy(...liquidityPoolArgs);
	await liquidityPool.waitForDeployment();
	deployedAddresses.MOCK_LIQUIDITY_POOL = await liquidityPool.getAddress();
	constructorArgs.MOCK_LIQUIDITY_POOL = liquidityPoolArgs;
	console.log("MockLiquidityPool deployed at:", deployedAddresses.MOCK_LIQUIDITY_POOL);



	// Export addresses for easy copy-paste
	console.log("\nAddresses (copy-pastable):");
	console.log(JSON.stringify(deployedAddresses, null, 2));
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
