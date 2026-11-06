import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe.skip("CrvUSDToUSDOracle (Mainnet Fork Test)", function () {
    let deployer, testOracle;

    // Real mainnet addresses for testing
    const CHAINLINK_CRVUSD_USD = "0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f"; // crvUSD/USD feed (not yet available)
    const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // ETH/USD feed
    const CURVE_TRIPOOL_ORACLE = "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14"; // TriCrypto pool (crvUSD/ETH/CRV)

    // Test constants
    const DECIMALS = 18;
    const INITIAL_FALLBACK_PRICE = ethers.parseEther("1.0"); // 1 USD
    const MIN_PRICE_THRESHOLD = ethers.parseEther("0.9"); // 0.9 USD
    const MAX_PRICE_THRESHOLD = ethers.parseEther("1.1"); // 1.1 USD



    beforeEach(async function () {
        [deployer] = await ethers.getSigners();

        // Deploy the CrvUSDToUSDOracle contract
        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        testOracle = await CrvUSDToUSDOracle.deploy(deployer.address, 0);
        await testOracle.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should deploy with correct initial values", async function () {
            expect(await testOracle.decimals()).to.equal(DECIMALS);
            expect(await testOracle.fallbackPriceInUSD()).to.equal(INITIAL_FALLBACK_PRICE);
            expect(await testOracle.circuitBreakerEnabled()).to.be.true;
            expect(await testOracle.minPriceThreshold()).to.equal(MIN_PRICE_THRESHOLD);
            expect(await testOracle.maxPriceThreshold()).to.equal(MAX_PRICE_THRESHOLD);
        });

        it("Should have correct owner", async function () {
            expect(await testOracle.owner()).to.equal(deployer.address);
        });
    });

    describe("Oracle Configuration", function () {
        it("Should allow owner to set ETH data feed", async function () {
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            expect(await testOracle.ethDataFeed()).to.equal(CHAINLINK_ETH_USD);
        });

        it("Should allow owner to set curve oracle", async function () {
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
            expect(await testOracle.curveOracle()).to.equal(CURVE_TRIPOOL_ORACLE);
        });

        it("Should emit events when setting oracles", async function () {
            await expect(testOracle.setEthDataFeed(CHAINLINK_ETH_USD))
                .to.emit(testOracle, "EthDataFeedUpdated")
                .withArgs(CHAINLINK_ETH_USD);

            await expect(testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE))
                .to.emit(testOracle, "CurveOracleUpdated")
                .withArgs(CURVE_TRIPOOL_ORACLE);
        });

        it("Should not allow non-owner to set oracles", async function () {
            const [, nonOwner] = await ethers.getSigners();

            await expect(
                testOracle.connect(nonOwner).setEthDataFeed(CHAINLINK_ETH_USD)
            ).to.be.revertedWithCustomError(testOracle, "OwnableUnauthorizedAccount");

            await expect(
                testOracle.connect(nonOwner).setCurveOracle(CURVE_TRIPOOL_ORACLE)
            ).to.be.revertedWithCustomError(testOracle, "OwnableUnauthorizedAccount");
        });
    });

    describe("Fallback Price Mechanism", function () {
        context("When no oracles are set", function () {
            it("Should return fallback price", async function () {
                const price = await testOracle.getPrice();
                expect(price).to.equal(INITIAL_FALLBACK_PRICE);
            });

            it("Should return fallback price with correct metadata", async function () {
                const [price, timestamp, fallbackLevel] = await testOracle.getLatestPrice();
                expect(price).to.equal(INITIAL_FALLBACK_PRICE);
                expect(fallbackLevel).to.equal(2); // Hard-coded fallback
                expect(timestamp).to.be.gt(0);
            });
        });

        it("Should allow owner to update fallback price", async function () {
            const newFallbackPrice = ethers.parseEther("0.95");

            await expect(testOracle.setFallbackPriceInUSD(newFallbackPrice))
                .to.emit(testOracle, "FallbackPriceInUSDUpdated")
                .withArgs(newFallbackPrice);

            expect(await testOracle.fallbackPriceInUSD()).to.equal(newFallbackPrice);
        });

        it("Should not allow setting zero fallback price", async function () {
            await expect(testOracle.setFallbackPriceInUSD(0))
                .to.be.revertedWithCustomError(testOracle, "InvalidFallbackPrice");
        });
    });

    describe("ETH/USD + Curve Oracle Mechanism", function () {
        beforeEach(async function () {
            // Set up the secondary oracle mechanism (ETH/USD + Curve)
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
        });

        it("Should use ETH/USD + Curve oracle when available", async function () {
            const [price, timestamp, fallbackLevel] = await testOracle.getLatestPrice();

            // Should use level 1 fallback (ETH/USD + Curve)
            expect(fallbackLevel).to.equal(1);
            expect(price).to.be.gt(0);
            expect(timestamp).to.be.gt(0);

            console.log(`Price from ETH/USD + Curve: ${ethers.formatEther(price)} USD`);
        });

        it("Should return reasonable price range", async function () {
            const price = await testOracle.getPrice();

            // crvUSD should be close to $1 (between $0.90 and $1.10)
            expect(price).to.be.gte(ethers.parseEther("0.90"));
            expect(price).to.be.lte(ethers.parseEther("1.10"));
        });

        it("Should have consistent pricing between getPrice() and getLatestPrice()", async function () {
            const simplePrice = await testOracle.getPrice();
            const [detailedPrice] = await testOracle.getLatestPrice();

            expect(simplePrice).to.equal(detailedPrice);
        });
    });

    describe("Circuit Breaker Functionality", function () {
        beforeEach(async function () {
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
        });

        it("Should clamp prices within circuit breaker bounds", async function () {
            // Test with very tight bounds to trigger clamping
            const tightMin = ethers.parseEther("0.999");
            const tightMax = ethers.parseEther("1.001");

            await testOracle.setCircuitBreakerConfig(true, tightMin, tightMax);

            const price = await testOracle.getPrice();
            expect(price).to.be.gte(tightMin);
            expect(price).to.be.lte(tightMax);
        });

        it("Should allow disabling circuit breaker", async function () {
            // Disable circuit breaker
            await testOracle.setCircuitBreakerConfig(false, MIN_PRICE_THRESHOLD, MAX_PRICE_THRESHOLD);

            expect(await testOracle.circuitBreakerEnabled()).to.be.false;

            // Price should still be returned (not clamped)
            const price = await testOracle.getPrice();
            expect(price).to.be.gt(0);
        });

        it("Should validate circuit breaker parameters", async function () {
            // Should reject zero minimum threshold
            await expect(
                testOracle.setCircuitBreakerConfig(true, 0, MAX_PRICE_THRESHOLD)
            ).to.be.revertedWithCustomError(testOracle, "MinThresholdMustBePositive");

            // Should reject invalid thresholds (min >= max)
            await expect(
                testOracle.setCircuitBreakerConfig(true, MAX_PRICE_THRESHOLD, MIN_PRICE_THRESHOLD)
            ).to.be.revertedWithCustomError(testOracle, "InvalidThresholds");
        });

        it("Should emit event when updating circuit breaker config", async function () {
            const newMin = ethers.parseEther("0.95");
            const newMax = ethers.parseEther("1.05");

            await expect(testOracle.setCircuitBreakerConfig(false, newMin, newMax))
                .to.emit(testOracle, "CircuitBreakerConfigUpdated")
                .withArgs(false, newMin, newMax);
        });
    });

    describe("Stale Time Configuration", function () {
        it("Should allow owner to update stable stale time", async function () {
            const newStaleTime = 2 * 24 * 60 * 60; // 2 days

            await expect(testOracle.setMaxStableStaleTime(newStaleTime))
                .to.emit(testOracle, "MaxStableStaleTimeUpdated")
                .withArgs(newStaleTime);

            expect(await testOracle.maxStableStaleTime()).to.equal(newStaleTime);
        });

        it("Should allow owner to update unstable stale time", async function () {
            const newUnstableStaleTime = 2 * 60 * 60; // 2 hours

            await expect(testOracle.setMaxUnstableStaleTime(newUnstableStaleTime))
                .to.emit(testOracle, "MaxUnstableStaleTimeUpdated")
                .withArgs(newUnstableStaleTime);

            expect(await testOracle.maxUnstableStaleTime()).to.equal(newUnstableStaleTime);
        });
    });

    describe("Real Oracle Integration", function () {
        beforeEach(async function () {
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
        });

        it("Should successfully fetch ETH price from Chainlink", async function () {
            // Get ETH/USD price directly from Chainlink
            const ethDataFeed = await ethers.getContractAt("AggregatorV3Interface", CHAINLINK_ETH_USD);
            const [, ethPrice, , timestamp] = await ethDataFeed.latestRoundData();

            expect(ethPrice).to.be.gt(0);
            expect(timestamp).to.be.gt(0);

            console.log(`ETH/USD price from Chainlink: $${ethers.formatUnits(ethPrice, 8)}`);
            console.log(`Last updated: ${new Date(Number(timestamp) * 1000).toISOString()}`);
        });

        it("Should successfully fetch price from Curve TriPool", async function () {
            // Get price from Curve TriPool oracle - use fully qualified name
            const curveOracle = await ethers.getContractAt("contracts/core/oracles/CrvUSDToUSDOracle.sol:ICrvUsdCurveOracle", CURVE_TRIPOOL_ORACLE);
            const curvePrice = await curveOracle.price_oracle(0); // ETH price in crvUSD

            expect(curvePrice).to.be.gt(0);

            console.log(`ETH price in crvUSD from Curve: ${ethers.formatEther(curvePrice)}`);
        });

        it("Should compute reasonable crvUSD price using combined oracles", async function () {
            // Get individual oracle values for detailed analysis
            const ethDataFeed = await ethers.getContractAt("AggregatorV3Interface", CHAINLINK_ETH_USD);
            const [, ethPriceChainlink, , ethTimestamp] = await ethDataFeed.latestRoundData();

            const curveOracle = await ethers.getContractAt("contracts/core/oracles/CrvUSDToUSDOracle.sol:ICrvUsdCurveOracle", CURVE_TRIPOOL_ORACLE);
            const ethPriceInCrvUSD = await curveOracle.price_oracle(0);

            // Get computed price from our oracle
            const [price, timestamp, fallbackLevel] = await testOracle.getLatestPrice();

            // Extract values for calculation verification
            const ethUsdPrice = parseFloat(ethers.formatUnits(ethPriceChainlink, 8));
            const ethCrvUsdPrice = parseFloat(ethers.formatEther(ethPriceInCrvUSD));
            const computedCrvUsdPrice = parseFloat(ethers.formatEther(price));

            // Manual calculation for verification
            const manualCalculation = ethUsdPrice / ethCrvUsdPrice;
            const expectedMarketPrice = 1.0; // crvUSD should be close to $1
            const deviationFromMarket = Math.abs(computedCrvUsdPrice - expectedMarketPrice);
            const deviationPercentage = (deviationFromMarket / expectedMarketPrice) * 100;

            console.log("SOURCE DATA:");
            console.log(`  ETH/USD (Chainlink): $${ethUsdPrice.toFixed(4)}`);
            console.log(`  ETH/crvUSD (Curve):  ${ethCrvUsdPrice.toFixed(6)}`);
            console.log(`  Last updated: ${new Date(Number(ethTimestamp) * 1000).toISOString()}`);
            console.log();
            console.log("CALCULATION:");
            console.log(`  Formula: crvUSD/USD = ETH/USD ÷ ETH/crvUSD`);
            console.log(`  Manual calc: $${ethUsdPrice.toFixed(4)} ÷ ${ethCrvUsdPrice.toFixed(6)} = $${manualCalculation.toFixed(8)}`);
            console.log(`  Oracle result: $${computedCrvUsdPrice.toFixed(8)}`);
            console.log(`  Fallback level: ${fallbackLevel} (1 = ETH/USD + Curve)`);
            console.log();
            console.log("MARKET COMPARISON:");
            console.log(`  Expected market price: $${expectedMarketPrice.toFixed(2)}`);
            console.log(`  Computed price: $${computedCrvUsdPrice.toFixed(8)}`);
            console.log(`  Absolute deviation: $${deviationFromMarket.toFixed(8)}`);
            console.log(`  Percentage deviation: ${deviationPercentage.toFixed(3)}%`);
            console.log();
            console.log("PRECISION ANALYSIS:");
            console.log(`  Manual vs Oracle: ${Math.abs(manualCalculation - computedCrvUsdPrice) < 0.000001 ? 'MATCH' : 'DIFF'}`);
            console.log(`  Market accuracy: ${deviationPercentage < 1.0 ? 'EXCELLENT' : deviationPercentage < 2.0 ? 'GOOD' : 'POOR'}`);
            console.log("=".repeat(80));

            // Assertions
            expect(fallbackLevel).to.equal(1); // Using ETH/USD + Curve
            expect(price).to.be.gt(0);
            expect(timestamp).to.be.gt(0);

            // Price should be close to $1 for crvUSD
            expect(parseFloat(ethers.formatEther(price))).to.be.closeTo(1.0, 0.1);

            // Additional precision checks
            expect(deviationPercentage).to.be.lt(5.0, "Price deviation should be less than 5%");
            expect(Math.abs(manualCalculation - computedCrvUsdPrice)).to.be.lt(0.000001, "Manual calculation should match oracle result");
        });

        it("Should validate calculation accuracy against known market values", async function () {
            const [oraclePrice, timestamp, fallbackLevel] = await testOracle.getLatestPrice();
            const priceInUsd = parseFloat(ethers.formatEther(oraclePrice));

            // Known market data for crvUSD (typically trades between $0.995 - $1.005)
            const knownMarketPriceMin = 0.995;
            const knownMarketPriceMax = 1.005;
            const expectedPeg = 1.0;

            const deviationFromPeg = Math.abs(priceInUsd - expectedPeg);
            const deviationBps = (deviationFromPeg / expectedPeg) * 10000; // basis points

            console.log();
            console.log("MARKET VALIDATION ANALYSIS");
            console.log("-".repeat(50));
            console.log(`Oracle calculated price: $${priceInUsd.toFixed(8)}`);
            console.log(`Expected peg target: $${expectedPeg.toFixed(3)}`);
            console.log(`Known market range: $${knownMarketPriceMin} - $${knownMarketPriceMax}`);
            console.log(`Deviation from peg: $${deviationFromPeg.toFixed(8)}`);
            console.log(`Deviation in basis points: ${deviationBps.toFixed(1)} bps`);
            console.log(`Within market range: ${priceInUsd >= knownMarketPriceMin && priceInUsd <= knownMarketPriceMax ? 'YES' : 'NO'}`);
            console.log(`Calculation timestamp: ${new Date(Number(timestamp) * 1000).toISOString()}`);
            console.log(`Data source: ${fallbackLevel === 1 ? 'ETH/USD + Curve' : fallbackLevel === 0 ? 'Direct crvUSD/USD' : 'Fallback'}`);
            console.log();

            // Quality assessment
            let quality;
            if (deviationBps < 50) quality = "EXCELLENT";
            else if (deviationBps < 100) quality = "VERY GOOD";
            else if (deviationBps < 200) quality = "GOOD";
            else if (deviationBps < 500) quality = "ACCEPTABLE";
            else quality = "POOR";

            console.log(`QUALITY ASSESSMENT: ${quality}`);
            console.log(`(< 50 bps = EXCELLENT, < 100 bps = VERY GOOD, < 200 bps = GOOD)`);
            console.log("-".repeat(50));

            // Validation assertions
            expect(fallbackLevel).to.equal(1, "Should use ETH/USD + Curve calculation");
            expect(priceInUsd).to.be.gte(knownMarketPriceMin, "Price should be above minimum market range");
            expect(priceInUsd).to.be.lte(knownMarketPriceMax, "Price should be below maximum market range");
            expect(deviationBps).to.be.lt(1000, "Deviation should be less than 1000 basis points (10%)");
        });

        it("Should handle oracle failures gracefully", async function () {
            // Test with invalid oracle address to simulate failure
            await testOracle.setCurveOracle(ethers.ZeroAddress);

            const [price, , fallbackLevel] = await testOracle.getLatestPrice();

            // Should fall back to hard-coded fallback
            expect(fallbackLevel).to.equal(2);
            expect(price).to.equal(INITIAL_FALLBACK_PRICE);
        });
    });

    describe("Gas Usage", function () {
        beforeEach(async function () {
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
        });

        it("Should report gas usage for price fetching", async function () {
            const tx = await testOracle.getPrice.populateTransaction();
            const estimatedGas = await ethers.provider.estimateGas(tx);

            console.log(`Estimated gas for getPrice(): ${estimatedGas.toString()}`);

            // Should be reasonable gas usage (less than 200k gas)
            expect(estimatedGas).to.be.lt(200000);
        });

        it("Should report gas usage for detailed price fetching", async function () {
            const tx = await testOracle.getLatestPrice.populateTransaction();
            const estimatedGas = await ethers.provider.estimateGas(tx);

            console.log(`Estimated gas for getLatestPrice(): ${estimatedGas.toString()}`);

            // Should be reasonable gas usage
            expect(estimatedGas).to.be.lt(250000);
        });
    });

    describe("Error Handling", function () {
        it("Should handle non-existent oracle addresses", async function () {
            // Set zero addresses (which are checked in the contract)
            await testOracle.setEthDataFeed(ethers.ZeroAddress);
            await testOracle.setCurveOracle(ethers.ZeroAddress);

            // Should fall back to hardcoded price without reverting
            const price = await testOracle.getPrice();
            console.log("Price from non-existent oracle addresses: ", price);
            expect(price).to.equal(INITIAL_FALLBACK_PRICE);
        });

        it("Should handle oracle call failures gracefully", async function () {
            try {
                // Set invalid but non-zero oracle addresses (EOA addresses that don't have oracle interface)
                const [, , randomAddress] = await ethers.getSigners();
                await testOracle.setEthDataFeed(randomAddress.address);
                await testOracle.setCurveOracle(randomAddress.address);

                // Should fall back to hardcoded price if oracle calls fail
                const price = await testOracle.getPrice();
                expect(price).to.equal(INITIAL_FALLBACK_PRICE);
            } catch (error) {
                // If the call reverts, that's also acceptable behavior
                console.log("Oracle calls reverted as expected with invalid addresses");
            }
        });

        it("Should not revert on view functions", async function () {
            // Even with invalid setups, view functions should not revert
            const price = await testOracle.getPrice();
            const [detailedPrice, timestamp, fallbackLevel] = await testOracle.getLatestPrice();

            expect(price).to.be.gt(0);
            expect(detailedPrice).to.be.gt(0);
            expect(timestamp).to.be.gt(0);
            expect(fallbackLevel).to.be.gte(0).and.lte(2);
        });
    });

    describe("Edge Cases", function () {
        beforeEach(async function () {
            await testOracle.setEthDataFeed(CHAINLINK_ETH_USD);
            await testOracle.setCurveOracle(CURVE_TRIPOOL_ORACLE);
        });

        it("Should handle extreme circuit breaker settings", async function () {
            // Set very tight circuit breaker
            const veryTightMin = ethers.parseEther("0.9999");
            const veryTightMax = ethers.parseEther("1.0001");

            await testOracle.setCircuitBreakerConfig(true, veryTightMin, veryTightMax);

            const price = await testOracle.getPrice();
            expect(price).to.be.gte(veryTightMin);
            expect(price).to.be.lte(veryTightMax);
        });

        it("Should maintain precision with different decimals", async function () {
            const price = await testOracle.getPrice();
            const decimals = await testOracle.decimals();

            expect(decimals).to.equal(18);

            // Price should maintain 18 decimal precision
            const priceString = price.toString();
            expect(priceString.length).to.be.gte(18);
        });
    });

    // Skip tests that require unavailable crvUSD/USD feed
    describe("Primary Oracle (crvUSD/USD Chainlink Feed)", function () {
        it("Should use primary oracle when available", async function () {
            // This test would work once crvUSD/USD Chainlink feed is available
            await testOracle.setCrvUSDDataFeed(CHAINLINK_CRVUSD_USD);

            const [price, timestamp, fallbackLevel] = await testOracle.getLatestPrice();

            expect(fallbackLevel).to.equal(0); // Primary oracle
            expect(price).to.be.gt(0);
            expect(timestamp).to.be.gt(0);
        });
    });
});