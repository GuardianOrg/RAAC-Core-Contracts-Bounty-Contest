import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("WadRayMath", function () {
    let wadRayMath;
    let reserveLibrary;

    beforeEach(async function () {
        const [owner] = await ethers.getSigners();
        const WadRayMath = await ethers.getContractFactory("WadRayMathMock");
        wadRayMath = await WadRayMath.deploy();

        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        const crvusd = await CrvUSDToken.deploy(owner.address);

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
        const complianceRegistry = await ComplianceRegistry.deploy()

        const RToken = await ethers.getContractFactory("RToken");
        const rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);

        const initialPrimeRate = ethers.parseUnits("0.1", 27);
        const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary")
        const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy()
        const LendingPool = await ethers.getContractFactory("LendingPool", {
          libraries: {
            LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
          }
        });

        const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
        const liquidationProxy = await LiquidationProxy.deploy();

        const VaultProxy = await ethers.getContractFactory("VaultProxy");
        const vaultProxy = await VaultProxy.deploy();

        const DebtToken = await ethers.getContractFactory("DebtToken");
        const debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, complianceRegistry.target);

        const lendingPool = await LendingPool.deploy(
        crvusd.target,
        rToken.target,
        debtToken.target,
        liquidationProxy.target,
        vaultProxy.target,
        complianceRegistry.target,
        initialPrimeRate,
        owner.address
        );

        await debtToken.setLendingPool(lendingPool.target);
        await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
        await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap

        // Deploy ReserveLibrary for comparison
        const ReserveLibrary = await ethers.getContractFactory("ReserveLibraryMock");
        reserveLibrary = await ReserveLibrary.deploy(debtToken.target, rToken.target);
    });

    describe("rayExp vs ReserveLibrary Implementations", function () {
        async function calculateManualTaylorSeries(rate, timeDelta) {
            if (timeDelta < 1) {
                return ethers.parseUnits("1.0", 27); // RAY
            }

            const SECONDS_PER_YEAR = 31536000n;
            const ratePerSecond = (rate * ethers.parseUnits("1.0", 27)) / SECONDS_PER_YEAR;
            const exponent = (ratePerSecond * BigInt(timeDelta)) / ethers.parseUnits("1.0", 27);

            // Manual Taylor series calculation
            const RAY = ethers.parseUnits("1.0", 27);
            let result = RAY + exponent;
            
            // x^2/2!
            const term2 = (exponent * exponent) / (2n * ethers.parseUnits("1.0", 27));
            result += term2;

            // x^3/3!
            const term3 = (term2 * exponent) / (3n * ethers.parseUnits("1.0", 27));
            result += term3;

            // x^4/4!
            const term4 = (term3 * exponent) / (4n * ethers.parseUnits("1.0", 27));
            result += term4;

            // x^5/5!
            const term5 = (term4 * exponent) / (5n * ethers.parseUnits("1.0", 27));
            result += term5;

            const term6 = (term5 * exponent) / (6n * ethers.parseUnits("1.0", 27));
            result += term6;

            let term7 = (term6 * exponent) / (7n * ethers.parseUnits("1.0", 27));
            result += term7;

            return result;
        }

        it("should give similar results for various inputs", async function () {
            const testCases = [
                { rate: "0.0", timeDelta: "2" },
                { rate: "1", timeDelta: "2" },
                { rate: "0.1", timeDelta: "86400" },    // 1 day with 10% rate
                { rate: "0.05", timeDelta: "604800" },  // 1 week with 5% rate
                { rate: "0.15", timeDelta: "2592000" }, // 1 month with 15% rate
                { rate: "0.20", timeDelta: "31536000" }, // 1 year with 20% rate
                // Edge cases
                { rate: "0.01", timeDelta: "1" },       // Very small time delta
                { rate: "0.001", timeDelta: "31536000" }, // Very small rate for a year
                { rate: "0.5", timeDelta: "31536000" }  // High rate for a year
            ];

            for (const testCase of testCases) {
                const rate = ethers.parseUnits(testCase.rate, 27); // RAY precision
                const timeDelta = BigInt(testCase.timeDelta);

                // Calculate the exponent for rayExp
                const SECONDS_PER_YEAR = 31536000n;
                const ratePerSecond = (rate * ethers.parseUnits("1.0", 27)) / SECONDS_PER_YEAR;
                const exponent = (ratePerSecond * BigInt(timeDelta)) / ethers.parseUnits("1.0", 27);

                // console.log(exponent);

                // Get result from rayExp
                const rayExpResult = await wadRayMath.rayExp(exponent);

                // Get result from ReserveLibrary implementation
                const reserveLibResult = await reserveLibrary.calculateCompoundedInterest(rate, timeDelta);

                // Get result from manual calculation
                const manualResult = await calculateManualTaylorSeries(rate, timeDelta);

                // Allow for small difference (0.1%)
                const tolerance = (manualResult * 1n) / 1000n; // 0.1% tolerance

                console.log(`\nTest case: rate=${testCase.rate}, timeDelta=${testCase.timeDelta}`);
                console.log(`rayExp result:          ${rayExpResult}`);
                console.log(`ReserveLib result:      ${reserveLibResult}`);
                console.log(`manual JS result:       ${manualResult}`);
                console.log(`tolerance:              ${tolerance}`);
                console.log(`diff rayExp-ReserveLib: ${rayExpResult > reserveLibResult ? rayExpResult - reserveLibResult : reserveLibResult - rayExpResult}`);
                console.log("---");

                // Compare rayExp with ReserveLibrary result
                const diffRayExpReserve = rayExpResult > reserveLibResult ? 
                    rayExpResult - reserveLibResult : 
                    reserveLibResult - rayExpResult;

                expect(diffRayExpReserve).to.be.lte(tolerance, 
                    `rayExp and ReserveLibrary results differ too much for rate=${testCase.rate}, timeDelta=${testCase.timeDelta}`
                );

                // Compare manual calculation with both implementations
                const diffManualRayExp = rayExpResult > manualResult ? 
                    rayExpResult - manualResult : 
                    manualResult - rayExpResult;

                const diffManualReserve = reserveLibResult > manualResult ? 
                    reserveLibResult - manualResult : 
                    manualResult - reserveLibResult;

                expect(diffManualRayExp).to.be.lte(tolerance, 
                    `rayExp and manual results differ too much for rate=${testCase.rate}, timeDelta=${testCase.timeDelta}`
                );

                expect(diffManualReserve).to.be.lte(tolerance, 
                    `ReserveLibrary and manual results differ too much for rate=${testCase.rate}, timeDelta=${testCase.timeDelta}`
                );
            }
        });
    });

    describe("Gas Comparison", function () {
        const testCases = [
            { rate: "0.1", timeDelta: "86400", description: "1 day with 10% rate" },
            { rate: "0.05", timeDelta: "604800", description: "1 week with 5% rate" },
            { rate: "0.15", timeDelta: "2592000", description: "1 month with 15% rate" },
            { rate: "0.20", timeDelta: "31536000", description: "1 year with 20% rate" }
        ];

        for (const testCase of testCases) {
            it(`Gas usage comparison for ${testCase.description}`, async function () {
                const rate = ethers.parseUnits(testCase.rate, 27); // RAY precision
                const timeDelta = BigInt(testCase.timeDelta);

                // Calculate the exponent for rayExp
                const SECONDS_PER_YEAR = 31536000n;
                const ratePerSecond = (rate * ethers.parseUnits("1.0", 27)) / SECONDS_PER_YEAR;
                const exponent = (ratePerSecond * BigInt(timeDelta)) / ethers.parseUnits("1.0", 27);

                // Measure gas for rayExp
                const rayExpTx = await wadRayMath.rayExp.estimateGas(exponent);
                
                // Measure gas for ReserveLibrary
                const reserveLibTx = await reserveLibrary.calculateCompoundedInterest.estimateGas(rate, timeDelta);

                console.log(`\nGas comparison for ${testCase.description}:`);
                console.log(`rayExp gas used:               ${rayExpTx}`);
                console.log(`calculateCompoundedInterest:   ${reserveLibTx}`);
                console.log(`Difference:                    ${rayExpTx > reserveLibTx ? rayExpTx - reserveLibTx : reserveLibTx - rayExpTx}`);
                console.log(`Cheaper method:                ${rayExpTx > reserveLibTx ? 'ReserveLibrary' : 'rayExp'}`);
                console.log("---");

                // Store gas results for analysis
                const gasResults = {
                    rayExp: rayExpTx,
                    reserveLib: reserveLibTx,
                    difference: rayExpTx > reserveLibTx ? rayExpTx - reserveLibTx : reserveLibTx - rayExpTx,
                    winner: rayExpTx > reserveLibTx ? 'ReserveLibrary' : 'rayExp'
                };

                // Optional: Add assertions if you want to enforce gas limits
                // expect(rayExpTx).to.be.lte(50000, "rayExp gas usage too high");
                // expect(reserveLibTx).to.be.lte(50000, "ReserveLibrary gas usage too high");
            });
        }
    });
}); 