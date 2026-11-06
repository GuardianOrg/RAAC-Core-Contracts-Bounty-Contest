import hre from "hardhat";
const { ethers } = hre;

export default async function deployFeeCollector(owner) {
    const FeeCollector = await ethers.getContractFactory("FeeCollector");
    const feeCollector = await FeeCollector.deploy(owner.address);
    await feeCollector.waitForDeployment();
    return feeCollector;
}