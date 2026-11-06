import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("Invariant - RAACMinter", function () {
    let wadRayMath;

    beforeEach(async function () {
        const [owner] = await ethers.getSigners();
        const WadRayMath = await ethers.getContractFactory("WadRayMathMock");
        wadRayMath = await WadRayMath.deploy();
    });

    describe("Reward Distribution Comparison", function () {

        it("should compare different reward distribution methods to prevent rounding errors", async function () {
            const excessTokens = ethers.parseEther("1000"); // 1000 tokens to distribute
            // 6 pools and their weights
            const weights = [1000n, 2000n, 1500n, 800n, 1200n, 500n];
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);

            console.log(`--- Total tokens to distribute: ${ethers.formatEther(excessTokens)}`);
            console.log(`--- Total weight: ${totalWeight}`);


            // Ray = wadToRay().rayDiv().rayMul().rayToWad()
            // Simple division = / then *
            // Ray down = wadToRay().rayDivDown().rayMulDown().rayToWad()

            let totalDistributedRay = 0n;
            let totalDistributedSimple = 0n;
            let totalDistributedRayDown = 0n;

            for (let i = 0; i < weights.length; i++) {
                const weight = weights[i];

                // Using ray
                const rayConversion = await wadRayMath.wadToRay(excessTokens);
                const rewardPerWeightRay = await wadRayMath.rayDiv(rayConversion, totalWeight);
                const pendingRewardsRay = await wadRayMath.rayMul(rewardPerWeightRay, weight);
                const pendingRewardsRayVersion = await wadRayMath.rayToWad(pendingRewardsRay);

                // Using simple division (natural rounding down)
                const pendingRewardsSimple = excessTokens * weight / totalWeight;

                // Ray down rounding
                // const rewardPerWeightRayDown = await wadRayMath.rayDivDown(rayConversion, totalWeight);
                // const pendingRewardsRayDown = await wadRayMath.rayMulDown(rewardPerWeightRayDown, weight);
                // const pendingRewardsRayDownVersion = await wadRayMath.rayToWad(pendingRewardsRayDown);

                totalDistributedRay += pendingRewardsRayVersion;
                totalDistributedSimple += pendingRewardsSimple;
                // totalDistributedRayDown += pendingRewardsRayDownVersion;

                console.log(`\nPool ${i + 1} (weight: ${weight}):`);
                console.log(`  RayUp: ${ethers.formatEther(pendingRewardsRayVersion)} tokens`);
                console.log(`  Simple: ${ethers.formatEther(pendingRewardsSimple)} tokens`);
                // console.log(`  RayDown: ${ethers.formatEther(pendingRewardsRayDownVersion)} tokens`);
            }

            console.log("\n=== DISTRIBUTION ===");
            console.log(`Available tokens: ${ethers.formatEther(excessTokens)}`);
            console.log(`RayUp total: ${ethers.formatEther(totalDistributedRay)}`);
            console.log(`Simple total: ${ethers.formatEther(totalDistributedSimple)}`);
            // console.log(`RayDown total: ${ethers.formatEther(totalDistributedRayDown)}`);

            expect(totalDistributedSimple).to.be.lte(excessTokens);
            // expect(totalDistributedRayDown).to.be.lte(excessTokens);

            const remainderRay = totalDistributedRay > excessTokens ? 0n : excessTokens - totalDistributedRay;
            const remainderSimple = excessTokens - totalDistributedSimple;
            // const remainderRayDown = excessTokens - totalDistributedRayDown;

            console.log("\n=== REMAINING ===");
            console.log(`RayUp: ${ethers.formatEther(remainderRay)}`);
            console.log(`Simple: ${ethers.formatEther(remainderSimple)}`);
            // console.log(`RayDown: ${ethers.formatEther(remainderRayDown)}`);
        });

        it("should test", async function () {
            const excessTokens = 1111111111111111111n;
            const weights = [333333333333333333n, 333333333333333337n, 333333333333333333n];
            const totalWeight = 999999999999999999n + 4n;

            let totalDistributedRay = 0n;
            let totalDistributedSimple = 0n;
            let totalDistributedRayDown = 0n;

            for (let i = 0; i < weights.length; i++) {
                const weight = weights[i];

                const rayConversion = await wadRayMath.wadToRay(excessTokens);
                const rewardPerWeightRay = await wadRayMath.rayDiv(rayConversion, totalWeight);
                const pendingRewardsRay = await wadRayMath.rayMul(rewardPerWeightRay, weight);
                const pendingRewardsRayVersion = await wadRayMath.rayToWad(pendingRewardsRay);

                // const rewardPerWeightRayDown = await wadRayMath.rayDivDown(rayConversion, totalWeight);
                // const pendingRewardsRayDown = await wadRayMath.rayMulDown(rewardPerWeightRayDown, weight);
                // const pendingRewardsRayDownVersion = await wadRayMath.rayToWad(pendingRewardsRayDown);

                const pendingRewardsSimple = excessTokens * weight / totalWeight;

                totalDistributedRay += pendingRewardsRayVersion;
                totalDistributedSimple += pendingRewardsSimple;
                // totalDistributedRayDown += pendingRewardsRayDownVersion;
                console.log(`\nPool ${i + 1} (weight: ${weight}):`);
                console.log(`  RayUp: ${pendingRewardsRayVersion} wei`);
                console.log(`  Simple: ${pendingRewardsSimple} wei`);
                // console.log(`  RayDown: ${pendingRewardsRayDownVersion} wei`);
            }

            console.log(`Available tokens: ${excessTokens} wei`);
            console.log(`RayUp total: ${totalDistributedRay} wei`);
            console.log(`Simple division total: ${totalDistributedSimple} wei`);
            // console.log(`RayDown total: ${totalDistributedRayDown} wei`);

            if(totalDistributedRay > excessTokens) {
                expect(totalDistributedRay).to.be.lt(excessTokens);
                throw new Error("RayUp exceeds available tokens");
            }
           
            expect(totalDistributedSimple).to.be.lte(excessTokens);
        });
    });
}); 