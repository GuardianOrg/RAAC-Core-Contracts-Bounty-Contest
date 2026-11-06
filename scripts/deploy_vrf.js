import hre from "hardhat";
const { ethers } = hre;
async function deployVRF() {
	const [deployer] = await ethers.getSigners();
	// console.log(deployer)
	// const VRFConsumer = await ethers.getContractFactory("BaseVRFv2Consumer");

	const subscriptionId = 100515845171883043581006007440611924675868175240446484723611418148889610440353n;
	const coordinatorAddress = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B";
	const _keyHash =
		"0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
	const callbackGasLimit = 200_000;
	const requestConfirmations = 3;
	const numWords = 1;
	const indexTokenAddress = "0x3A663C401AdF767d710C7f0133DF40eA18F24863";

	// const vrfConsumer = await VRFConsumer.deploy(
	// 	subscriptionId,
	// 	coordinatorAddress,
	// 	_keyHash,
	// 	callbackGasLimit,
	// 	requestConfirmations,
	// 	numWords,
	// 	indexTokenAddress
	// );
	// await vrfConsumer.waitForDeployment()
	// console.log("VRFConsumer deployed to:", await vrfConsumer.getAddress());

	// verify contract on etherscan
	await hre.run("verify:verify", {
		address: "0x689e7a3B6b58ACd2d9Dd1BEa2b8A870e760b57bA",
		constructorArguments: [
			subscriptionId,
			coordinatorAddress,
			_keyHash,
			callbackGasLimit,
			requestConfirmations,
			numWords,
			indexTokenAddress,
		],
	});

}

// sepolia: 0x689e7a3B6b58ACd2d9Dd1BEa2b8A870e760b57bA

deployVRF();
