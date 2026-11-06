import hre from "hardhat";
const { ethers } = hre;

import deployLiquidationSwap from "./deployLiquidationSwap.js";
import deployLiquidationStrategyProxy from "./deployLiquidationStrategyProxy.js";

export default async function deployStabilityPool(owner, supplyAsset, rToken, complianceRegistry, lendingPool, rwaIndexToken, treasury, rwaVault, crvusdToUSDOracle, raacToken) {
    const DETokenFactory = await ethers.getContractFactory("DEToken");
    const deToken = await DETokenFactory.deploy("DEToken", "DEToken", owner.address, rToken.target, complianceRegistry.target);
    await deToken.waitForDeployment();

    const StabilityPool = await ethers.getContractFactory("StabilityPool");
    const stabilityPoolImplementation = await StabilityPool.deploy(complianceRegistry.target);
    await stabilityPoolImplementation.waitForDeployment();

    const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = await ProxyAdmin.deploy(owner.address);
    await proxyAdmin.waitForDeployment();

    const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
    const stabilityPoolProxy = await TransparentUpgradeableProxy.deploy(stabilityPoolImplementation.target, proxyAdmin.target, "0x");
    await stabilityPoolProxy.waitForDeployment();

    const stabilityPool = StabilityPool.attach(stabilityPoolProxy);

    // await deToken.setStabilityPool(stabilityPool.target);
    // await rToken.setStabilityPool(stabilityPool.target);

    await lendingPool.setStabilityPool(stabilityPool.target);
    await deToken.setStabilityPool(stabilityPool.target);
    await deToken.transferOwnership(stabilityPool.target)

    const {
        liquidationSwap,
    } = await deployLiquidationSwap(rwaIndexToken, supplyAsset, rwaVault, crvusdToUSDOracle, owner)

    const {
        liquidationStrategyProxy,
    } = await deployLiquidationStrategyProxy()

    await liquidationSwap.setStabilityPool(stabilityPool.target);

    await stabilityPool.initialize(
        rToken.target,
        deToken.target,
        supplyAsset.target,
        lendingPool.target,
        treasury.target,
        liquidationStrategyProxy.target,
        owner.address
    )

    await stabilityPool.setLiquidationSwap(liquidationSwap.target)
    await stabilityPool.setRWAVault(rwaVault.target);

    // Fix me
    const liquidationSplitPercentages = {
        mint: 0,
        burn: 0,
        swap: 100,
        liquidity: 0
      }

    await stabilityPool.setLiquidationVaultTokenSplit(liquidationSplitPercentages.mint * 100, liquidationSplitPercentages.burn * 100, liquidationSplitPercentages.swap * 100, liquidationSplitPercentages.liquidity * 100);


    await rwaVault.setStabilityPool(stabilityPool.target)
    return {
        stabilityPool,
        deToken,
        liquidationStrategyProxy,
        liquidationSwap,
    };
}