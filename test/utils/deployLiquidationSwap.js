import hre from "hardhat";
const { ethers } = hre;

export default async function deployLiquidationSwap(rwaIndexToken, supplyAsset, rwaVault, crvusdToUSDOracle, owner) {
    const LiquidationSwap = await ethers.getContractFactory("LiquidationSwap");
    const liquidationSwap = await LiquidationSwap.deploy(rwaIndexToken.target, supplyAsset.target, rwaVault.target, crvusdToUSDOracle.target, owner.address);
    return {
        liquidationSwap,
    };
}