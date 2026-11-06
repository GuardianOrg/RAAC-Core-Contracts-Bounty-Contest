import hre from "hardhat";
const { ethers } = hre;

export default async function deployRAACNFT(referenceAsset, complianceRegistry, owner) {
    const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
    const crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);
    
    // Deploy RAACNFT with oracle
    const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
    let raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);

    // Deploy RAACNFT
    const RAACNFT = await ethers.getContractFactory("RAACNFT");
    let raacNFT = await RAACNFT.deploy(referenceAsset.target, raacHousePrices.target, complianceRegistry.target, owner.address);

   return { raacHousePrices, raacNFT, crvUSDToUSDOracle };
}