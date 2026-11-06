import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const CircuitBreakerStatus = {
    NORMAL_OPERATION: 0,
    NO_ORACLE_CONFIGURED: 1,
    CIRCUIT_BREAKER_DISABLED: 2,
    INVALID_ORACLE_PRICE: 3,
    PRICE_BELOW_MINIMUM: 4,
    PRICE_ABOVE_MAXIMUM: 5
}

describe("RAACHousePrices", () => {
    let raacHousePrices;
    let owner;
    let oracle;
    let user;
    let dataFeed;
    let crvUSDToUSDOracle;

    beforeEach(async () => {
        [owner, oracle, user] = await ethers.getSigners();

        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

        const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
        raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);
        await raacHousePrices.setOracle(oracle.address);

        const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
        const decimals = 8;
        const initialPrice = ethers.parseUnits("1", decimals);
        dataFeed = await MockChainlinkAggregator.deploy(decimals, "CRVUSD / USD", initialPrice);
        await crvUSDToUSDOracle.setCrvUSDDataFeed(dataFeed.target);
    });

    describe("Initialization", () => {
        it("should set the correct owner", async () => {
            expect(await raacHousePrices.owner()).to.equal(owner.address);
        });

        it("should set the correct oracle", async () => {
            expect(await raacHousePrices.oracle()).to.equal(oracle.address);
        });

        it("should set the correct crvUSD to USD oracle", async () => {
            expect(await raacHousePrices.crvUSDToUSDOracle()).to.equal(crvUSDToUSDOracle.target);
        });
    });

    describe("Access Control Management", () => {
        it("should allow owner to change oracle", async () => {
            await raacHousePrices.setOracle(user.address);
            expect(await raacHousePrices.oracle()).to.equal(user.address);
        });

        it("should prevent non-owner from changing oracle", async () => {
            await expect(
                raacHousePrices.connect(user).setOracle(user.address)
            ).to.be.revertedWithCustomError(raacHousePrices, "OwnableUnauthorizedAccount");
        });

        it("should allow owner to change data feed", async () => {
            await raacHousePrices.setCrvUSDToUSDOracle(dataFeed.target);
            expect(await raacHousePrices.crvUSDToUSDOracle()).to.equal(dataFeed.target);
        });
        it("should prevent non-owner from changing data feed", async () => {
            await expect(
                raacHousePrices.connect(user).setCrvUSDToUSDOracle(dataFeed.target)
            ).to.be.revertedWithCustomError(raacHousePrices, "OwnableUnauthorizedAccount");
        });
    });

    describe("Price Updates", () => {
        const tokenId = 1;
        const price = ethers.parseEther("100"); // 100 USD

        it("should allow oracle to set house price", async () => {
            expect(await raacHousePrices.count()).to.equal(0);
            let [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId);
            expect(storedPrice).to.equal(0);
            
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId);
            
            expect(storedPrice).to.equal(price);
            expect(timestamp).to.be.gt(0);
            expect(await raacHousePrices.count()).to.equal(1);
        });

        it("should emit PriceCreated event only on first price set", async () => {
            await expect(raacHousePrices.connect(oracle).setHousePrice(tokenId, price))
                .to.emit(raacHousePrices, "PriceCreated")
                .withArgs(tokenId, price);

                const newPrice = ethers.parseEther("150");
            await expect(raacHousePrices.connect(oracle).setHousePrice(tokenId, newPrice))
                .to.emit(raacHousePrices, "PriceUpdated")
                .withArgs(tokenId, newPrice)
                .and.not.to.emit(raacHousePrices, "PriceCreated");
        });

        it("should prevent non-oracle from setting price", async () => {
            await expect(
                raacHousePrices.connect(user).setHousePrice(tokenId, price)
            ).to.be.revertedWithCustomError(raacHousePrices, "NotOracle");
        });

        it("should update tokenToLastUpdateTimestamp when price is set", async () => {
            const tx = await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            const receipt = await tx.wait();
            const blockTimestamp = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
            
            expect(await raacHousePrices.tokenToLastUpdateTimestamp(tokenId)).to.equal(blockTimestamp);
            expect(await raacHousePrices.lastUpdateTimestamp()).to.equal(blockTimestamp);
        });

        it("should update the count only when a new price is set", async () => {
            expect(await raacHousePrices.count()).to.equal(0);
            expect(await raacHousePrices.existingTokens(tokenId)).to.be.false;
            
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            expect(await raacHousePrices.existingTokens(tokenId)).to.be.true;
            
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            
            expect(await raacHousePrices.count()).to.equal(1);
        });

        it("should batch update the prices", async function() {
            const tokens = [1,2,3,4,5,6]
            const prices = [ethers.parseEther("100"), ethers.parseEther("200"), ethers.parseEther("300"), ethers.parseEther("400"), ethers.parseEther("500"), ethers.parseEther("600")]
            expect(await raacHousePrices.count()).to.equal(0);
            
            await raacHousePrices.connect(oracle).setHousePrices(tokens, prices);

            expect(await raacHousePrices.count()).to.equal(tokens.length);
            for (let i = 0; i < tokens.length; i++) {
                expect((await raacHousePrices.getLatestPrice(tokens[i]))[0]).to.equal(prices[i].toString());
            }
        })

        it("should revert if tokens and prices length mismatch", async function() {
            const tokens = [1,2,3,4,5,6]
            const prices = [ethers.parseEther("100"), ethers.parseEther("200"), ethers.parseEther("300"), ethers.parseEther("400"), ethers.parseEther("500")]

            await expect(raacHousePrices.connect(oracle).setHousePrices(tokens, prices)).to.be.revertedWithCustomError(raacHousePrices, "ArrayLengthMismatch");
        })

        it("should handle duplicate token IDs in batch", async () => {
            const tokens = [1, 2, 1];
            const prices = [ethers.parseEther("100"), ethers.parseEther("200"), ethers.parseEther("300")];
            
            await raacHousePrices.connect(oracle).setHousePrices(tokens, prices);
            
            const [price1] = await raacHousePrices.getLatestPrice(1);
            expect(price1).to.equal(prices[2]);
            
            expect(await raacHousePrices.count()).to.equal(2);
        });
    });

    describe("Price Retrieval", () => {
        const tokenId1 = 1;
        const tokenId2 = 2;
        const price1 = ethers.parseEther("100");
        const price2 = ethers.parseEther("200");

        beforeEach(async () => {
            await raacHousePrices.connect(oracle).setHousePrice(tokenId1, price1);
        });

        it("should return correct price and timestamp for existing token", async () => {
            const [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId1);
            expect(storedPrice).to.equal(price1);
            expect(timestamp).to.be.gt(0);
        });

        it("should return zero price and timestamp for non-existent token", async () => {
            const nonExistentTokenId = 999;
            const [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(nonExistentTokenId);
            expect(storedPrice).to.equal(0);
            expect(timestamp).to.equal(0);
        });

        it("should handle multiple token updates with different timestamps", async () => {
            await time.increase(60);
            
            await raacHousePrices.connect(oracle).setHousePrice(tokenId2, price2);
            
            const [storedPrice1, timestamp1] = await raacHousePrices.getLatestPrice(tokenId1);
            const [storedPrice2, timestamp2] = await raacHousePrices.getLatestPrice(tokenId2);
            
            expect(storedPrice1).to.equal(price1);
            expect(storedPrice2).to.equal(price2);
            
            expect(timestamp2).to.be.gt(timestamp1);
            
            expect(await raacHousePrices.lastUpdateTimestamp()).to.equal(timestamp2);
        });
    });

    // Test price decimal precision
    describe("Price Decimal Precision", () => {
        const tokenId = 1;
        const price = ethers.parseEther("100.123456789");

        it("should handle price with 9 decimal places", async () => {
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            const [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId);
            expect(storedPrice).to.equal(price);
        });

        it("should handle price with 18 decimal places", async () => {
            const price = ethers.parseEther("100.123456789012345678");
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            const [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId);
            expect(storedPrice).to.equal(price);
        });
    });

    // Test data feed
    describe("Data Feed", () => {
        const tokenId = 1;
        const price = ethers.parseEther("100");

        beforeEach(async () => {
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
        });

        it("should return the correct price when data feed is set", async () => {
            const [storedPrice, timestamp] = await raacHousePrices.getLatestPrice(tokenId);
            expect(storedPrice).to.equal(price);
        });

        it("should handle CRVUSD trading at $0.95 (discount)", async () => {
            await dataFeed.updateAnswer(ethers.parseUnits("0.95", 8));
            
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.be.closeTo(ethers.parseEther("105.263157894736842105"), ethers.parseEther("0.001"));
        });

        it("should handle CRVUSD trading at $1.05 (premium)", async () => {
            await dataFeed.updateAnswer(ethers.parseUnits("1.05", 8));
            
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.be.closeTo(ethers.parseEther("95.238095238095238095"), ethers.parseEther("0.001"));
        });
        it("should revert on zero oracle price", async () => {
            await dataFeed.updateAnswer(ethers.parseUnits("0", 8));
            
            expect(await raacHousePrices.getLatestPrice(tokenId)).to.deep.equal([price, BigInt(await time.latest())]);
        });

        it("should revert on negative oracle price", async () => {
            await dataFeed.updateAnswer(-100000000);
            
            expect(await raacHousePrices.getLatestPrice(tokenId)).to.deep.equal([price, BigInt(await time.latest())]);
        });

        it("should handle oracle returning to valid price after error", async () => {
            await dataFeed.updateAnswer(ethers.parseUnits("0", 8));
            expect(await raacHousePrices.getLatestPrice(tokenId)).to.deep.equal([price, BigInt(await time.latest())]);
            
            await dataFeed.updateAnswer(ethers.parseUnits("1", 8));
            
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.equal(price);
        });

        it("should fallback to 1:1 when dataFeed is zero address", async () => {
            await crvUSDToUSDOracle.setCrvUSDDataFeed(ethers.ZeroAddress);
            
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.equal(price);
        });

        it("should allow setting dataFeed to zero address", async () => {
            await expect(crvUSDToUSDOracle.setCrvUSDDataFeed(ethers.ZeroAddress)).to.emit(crvUSDToUSDOracle, "CrvUSDDataFeedUpdated").withArgs(ethers.ZeroAddress);
            expect(await crvUSDToUSDOracle.crvUSDDataFeed()).to.equal(ethers.ZeroAddress);
        });
    });

    // Test fallback mechanism
    describe("Fallback Mechanism", () => {
        const tokenId = 1;
        const price = ethers.parseEther("100");
        let ethPriceFeed, curvePriceFeed;

        beforeEach(async () => {
            await raacHousePrices.connect(oracle).setHousePrice(tokenId, price);
            const MockCurveEMA = await ethers.getContractFactory("MockCurveEMA");
            curvePriceFeed = await MockCurveEMA.deploy(ethers.parseEther("3612"));
            await raacHousePrices.setOracle(curvePriceFeed.target);

            const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator");
            ethPriceFeed = await MockChainlinkAggregator.deploy(8, "ETH / USD", ethers.parseEther("3603"));
            await crvUSDToUSDOracle.setEthDataFeed(ethPriceFeed.target);

            // update data feed to 0.9998
            await dataFeed.updateAnswer(ethers.parseUnits("0.9998", 8));

            // set the oracles up
            await crvUSDToUSDOracle.setCrvUSDDataFeed(dataFeed.target);
            await crvUSDToUSDOracle.setCurveOracle(curvePriceFeed.target);
            await crvUSDToUSDOracle.setEthDataFeed(ethPriceFeed.target);
        });

        it("should return the crvUSD/USD price if not stale", async () => {
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.be.equal(((price * BigInt(1e18)) / ethers.parseEther("0.9998")));
        });

        it("should return the ETH/USD + ETH/crvUSD route price crvUSD/USD is stale", async function() {
            // Make the crvUSD/USD price stale
            await dataFeed.updateAnswerWithTimestamp(ethers.parseUnits("0.9998", 8), 2 * 24 * 60 * 60); // 2 days ago

            // eth price is not stale
            await ethPriceFeed.updateAnswer(ethers.parseUnits("3603", 8));

            // expected USd price per crvusd
            const expectedPrice = (ethers.parseEther("3603") * BigInt(1e18)) / ethers.parseEther("3612");

            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.be.equal(((price * BigInt(1e18)) / expectedPrice));
        })

        it("should return fallback price if eth price is stale as well as crvusd price", async function() {
            // Make the crvUSD/USD and eth price stale
            // since eth stall time < crvUSD stall time, the fallback price should be used
            await time.increase(await crvUSDToUSDOracle.maxStableStaleTime() + 1n);

            await crvUSDToUSDOracle.setFallbackPriceInUSD(ethers.parseEther("0.9997"));
            // expected USd price per crvusd
            const [crvUSDPrice] = await raacHousePrices.getLatestPrice(tokenId);
            expect(crvUSDPrice).to.be.equal(((price * BigInt(1e18)) / ethers.parseEther("0.9997")));
        })
        it("should clamp the price if the circuit breaker is enabled", async function() {
            await crvUSDToUSDOracle.setCircuitBreakerConfig(true, ethers.parseEther("0.9"), ethers.parseEther("1.1"));

            await dataFeed.updateAnswer(ethers.parseUnits("0.8", 8));

            const [crvUSDPrice] = await crvUSDToUSDOracle.getLatestPrice();
            expect(crvUSDPrice).to.be.equal(ethers.parseEther("0.9"));
        });
        it("should not clamp the price if the circuit breaker is disabled", async function() {
            await crvUSDToUSDOracle.setCircuitBreakerConfig(false, ethers.parseEther("0.9"), ethers.parseEther("1.1")); 

            await dataFeed.updateAnswer(ethers.parseUnits("0.8", 8));

            const [crvUSDPrice] = await crvUSDToUSDOracle.getLatestPrice();
            expect(crvUSDPrice).to.be.equal(ethers.parseEther("0.8"));
        });
    });
    
}); 