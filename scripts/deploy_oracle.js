import hre from "hardhat";
const { ethers } = hre;

async function deployOracle() {
	const [deployer] = await ethers.getSigners();
	
    const deployedAddresses = {
        HOUSE_PRICES: "0xC6B219bE87db9fDFd539cC0507Aa94914CF84e92"
    }

    // 1. Get the route 
    // 2. Get the donId
    // 3. Take the .env file that contains the secrets -> encryt it -> store the encrypted data in json -> store the json file on pinata -> get the cid
    // 4. Encrypt the cid URL and store in the `encryptedSecretsReference`
    // 5. Store the source code on pinata -> get the cid -> fetch when deploying the contract
    // 6. NOTE: the account that encrypts the secrest must match subscription owner. This means account A signs the secrets and also is the owner of the Subscription. When don decrypts, it checks that account A matches the subscription owner
    // At deployment time, the deployer might now be the owner of the subscription, but we can manually add the contract
    // Update susbvscription + encryption keys will fix this post deployment

    const router = "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0"
    const donId = "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000"
    const secretsLocation = 1;
    const encryptedSecretsReference = "0x6572bfaa25cb42c425c52c2f41793b2f038a6f4c4671effed0af0ba742aea56a35fcff282334c1b11e07f48ddf2401288aae6d0f19e0b03fb4dd99fa83730ec5886c785c56288bd2b01b4016d06d429953bdb06f91a2baec30509f215040b5257a6836a9c25e93fa5fb2280bf264f440f9ee3200ed12f997b8a8e65804d556a826313722289bcbfd845f7f1d21d120038ae389c5e03bc5e26785d892274a911a4fbcdb765cd50f4a34cd775429eb5b60ae7189ddf9d3a0cdbc2cd3067b5dd0a3c0d490efa55a04bf34a5e10109f8d9d2be"
    const source = "https://emerald-many-grasshopper-318.mypinata.cloud/ipfs/bafkreihrmo4cl57tmzwsy7i6mgaqr3wszuewkov7m57uctazg3k5brftia" // Since Location.Inline -> need source code. If want to use Remove -> set Location.Remote in the BasechainlinkFunctions
    const subscriptionId = 4392
    const callbackGasLimit = 200000
    const raacNFT = "0xc986D2750327EA6454d16cE2cD00BA62421dd0bC"

    // const RAACHousePriceOracle = await ethers.getContractFactory("RAACHousePriceOracle");
    // const raacHousePriceOracle = await RAACHousePriceOracle.deploy(
    //     router,
    //     donId,
    //     await (await fetch(source)).text(),
    //     secretsLocation,
    //     encryptedSecretsReference,
    //     subscriptionId,
    //     callbackGasLimit,
    //     deployedAddresses.HOUSE_PRICES,
    //     raacNFT
    // )
    // await raacHousePriceOracle.waitForDeployment()
    // console.log("RAACHousePriceOracle deployed to:", await raacHousePriceOracle.getAddress());

    // // verify contract on etherscan
    // await hre.run("verify:verify", {
    //     address: await raacHousePriceOracle.getAddress(),
    //     constructorArguments: [
    //         router,
    //         donId,
    //         source,
    //         secretsLocation,
    //         encryptedSecretsReference,
    //         subscriptionId,
    //         callbackGasLimit,
    //         deployedAddresses.HOUSE_PRICES,
    //         raacNFT
    //     ]
    // })

    
    // const housePrice = await ethers.getContractAt("RAACHousePrices", deployedAddresses.HOUSE_PRICES)
    // await housePrice.setOracle(await raacHousePriceOracle.getAddress())
    // console.log("Oracle set")

    const raacHousePriceOracle = await ethers.getContractAt("RAACHousePriceOracle", "0x0C27aDA65B4B4ec9eb434b9A149002354b769042")
    await (await raacHousePriceOracle.sendRequest(["11155111", await raacHousePriceOracle.raacNFT(), "1"], [])).wait()
    console.log("Request sent")
}

deployOracle();
