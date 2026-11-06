import hre from "hardhat";
const { ethers } = hre;

export default async function deployLiquidationStrategy() {
    const LiquidationStrategyProxy = await ethers.getContractFactory("LiquidationStrategyProxy")
    const liquidationStrategyProxy = await LiquidationStrategyProxy.deploy();

    return {
        liquidationStrategyProxy,
    };
}