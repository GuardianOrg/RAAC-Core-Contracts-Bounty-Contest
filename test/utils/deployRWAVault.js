import hre from "hardhat";
const { ethers } = hre;

import deployVRFConsumerWithMock from "./deployVRFConsumerWithMock.js";

const RANDOM_NUMBER = 12

export default async function deployRWAVault(supplyAsset, complianceRegistry, raacNFT, raacHousePrices, stabilityPool) {
    let rwaIndexToken, rwaVault, vrfConsumer;
    const RWAIndexToken = await ethers.getContractFactory("RWAIndexToken");
    rwaIndexToken = await RWAIndexToken.deploy("RWA Index Token", 'RRWA', complianceRegistry.target)
  
    const RWAVault = await ethers.getContractFactory("RWAVault");
    rwaVault = await RWAVault.deploy(rwaIndexToken.target, complianceRegistry.target);
  
    const vrf = await deployVRFConsumerWithMock(rwaVault.target)
    vrfConsumer = vrf.vrfConsumer;
  
    await rwaVault.setVRFConsumer(vrfConsumer.target);
    await vrf.vrfCoordinator.fulfillRandomWordsWithOverride(await vrfConsumer.lastRequestId(), vrfConsumer.target, [RANDOM_NUMBER]);
    rwaIndexToken.setVault(rwaVault.target);

    const RAACNFTVaultAdapterOracle = await ethers.getContractFactory("RAACNFTVaultAdapterOracle");
    const raacNFTVaultAdapterOracle = await RAACNFTVaultAdapterOracle.deploy(raacHousePrices.target);

    const RAACNFTVaultAdapter = await ethers.getContractFactory("RAACNFTVaultAdapterV2");
    const raacNFTVaultAdapter = await RAACNFTVaultAdapter.deploy(raacNFT.target, raacNFTVaultAdapterOracle.target, rwaVault.target, raacHousePrices.target);

    await rwaVault.registerAdapter(raacNFTVaultAdapter.target)

    const crvUSDPriceOracle = await (await ethers.getContractFactory("MockERC20PriceOracle")).deploy();
    await crvUSDPriceOracle.setLatestPrice(ethers.parseEther("1"));

    const ERC20VaultAdapter = await ethers.getContractFactory("ERC20VaultAdapter");
    const erc20TokenVaultAdapter = await ERC20VaultAdapter.deploy(supplyAsset.target, crvUSDPriceOracle.target, rwaVault.target)
    await rwaVault.registerAdapter(erc20TokenVaultAdapter);
    await rwaVault.registerDepositableAdapter(erc20TokenVaultAdapter);
    
    return {
        raacNFTVaultAdapter,
        rwaIndexToken,
        rwaVault,
        crvUSDPriceOracle,
        erc20TokenVaultAdapter,
        vrf,
    };
  }