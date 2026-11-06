import { expect } from "chai";
import hre from 'hardhat';
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

import circulatingSupply from "../mocks/distributions/circulating-total.json" with { type: "json" };
import circulatingDetails from "../mocks/distributions/circulating-details.json" with { type: "json" };
import emissionSchedule from "../mocks/distributions/emission-schedule.json" with { type: "json" };



describe("Distribution System", function () {
    let owner, user1, user2, user3, user4, initialLiquidityWallet, earlyLiquidityWallet;

    let raacToken, raacMinter, veToken, releaseOrchestrator, gaugeController, gaugeRewardsDistributor, treasury;
    
    let lpToken;

    let mockUSDC;
    let rwaGauge, raacGauge;
    let feeCollector;
    let initialLockTime;

    const DAY = 24 * 60 * 60;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;

    const MAX_SUPPLY = ethers.parseEther("21000000");
    const BLOCK_PER_DAY = 7141;
    const TIME_PER_BLOCK = DAY / BLOCK_PER_DAY;

    const BASE_WEEKLY_EMISSION = 23_852_798580398015692800n;
    const SECONDS_IN_WEEK = 604800; //(7 * 24 * 60 * 60);
    const BASE_PER_SECOND = BASE_WEEKLY_EMISSION / BigInt(SECONDS_IN_WEEK);
    const GAUGE_EMISSIONS_CAP = ethers.parseEther("8137500"); // 40.8% of 21M

    function emissionPerSecondForWeek(w) {
        if (w === 0 || w >= 781) return 0n;
        if (w <= 104) return BASE_PER_SECOND;
        const periods = BigInt(Math.floor((w - 105) / 13) + 1);
        let result = 10n ** 18n;
        let base = 950000000000000000n;
        let exp = periods;
        while (exp > 0n) {
            if (exp & 1n) result = (result * base) / 10n ** 18n;
            base = (base * base) / 10n ** 18n;
            exp >>= 1n;
        }
        return (BASE_PER_SECOND * result) / 10n ** 18n;
    }
    function cumulativeEmission(weeks) {
        let total = 0n;
        for (let w = 1; w <= weeks; w++) total += emissionPerSecondForWeek(w) * 604800n;
        return total;
    }

    let deployTime;

    /**
     * We will test the proper minting of RAAC tokens to the gauges. 
     * Minter mints RAAC, those are then distributed to the gauges.
     * We also have a release orchestrator able to micro-manage some tokens portion to individual addresses.
     * 
     * There is multiple elements. 
     * 
     * - Early Liquidity Provider: 1% - Minted at launch.
     * - Initial Liquidity: 7.8% - Minted at launch.
     * 
     * - Team: 17.3% - Minted, sent to release orchestrator
     * - Advisors: 11.3% - Minted, sent to release orchestrator
     * - Treasury: 8% - Minted, sent to release orchestrator
     * - Private Sale: 3.8% - Minted to release orchestrator
     * - Public Sale: 10% - Minted to release orchestrator
     * 
     * - Liquidity Emissions (part to Gauges over tine): 40.8% - Minted, directly to gauges
     * 
     * We have the release orchestrator. 
     */
    async function mintBlocksToTime(time) {
        const blocksToMint = time / TIME_PER_BLOCK;
        for (let i = 0; i < blocksToMint; i++) {
            await network.provider.send("evm_mine");
        }
    }

    async function simulateMinting(time) {
        const blocksToMint = Math.floor(time / TIME_PER_BLOCK);
        await hre.network.provider.send("hardhat_mine", [
            blocksToMint,
            Math.floor(TIME_PER_BLOCK)// Closest approximation of time per block (a little bit less than reality)
        ]);
    }

    let expectedMintedWithTreasury;
    let gaugeBalance;

    before(async function () {
        [owner, user1, user2, user3, user4, earlyLiquidityWallet, initialLiquidityWallet] = await ethers.getSigners();

        // RAAC Token 0% tax rates
        const raacTokenFactory = await ethers.getContractFactory("RAACToken");
        raacToken = await raacTokenFactory.deploy(owner.address); // tax parameters were removed
        await raacToken.waitForDeployment();

        // VeRAACToken requires linked libraries
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        const lockManagerLib = await LockManagerFactory.deploy();
        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const ragequitLib = await RagequitLibFactory.deploy();
        const PowerCheckpointFactory = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const powerCheckpointLib = await PowerCheckpointFactory.deploy();
        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const rewardLib = await RewardLibFactory.deploy();
        const veTokenFactory = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target,
            },
        });
        veToken = await veTokenFactory.deploy(await raacToken.getAddress(), owner.address, 52);
        await veToken.waitForDeployment();

        const raacMinterFactory = await ethers.getContractFactory("RAACMinter");
        raacMinter = await raacMinterFactory.deploy(await raacToken.getAddress(), owner.address);
        await raacMinter.waitForDeployment();
        
        deployTime = await time.latest();
        const raacReleaseOrchestratorFactory = await ethers.getContractFactory("RAACReleaseOrchestrator");
        releaseOrchestrator = await raacReleaseOrchestratorFactory.deploy(await raacToken.getAddress());
        await releaseOrchestrator.waitForDeployment();

        const gaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await gaugeControllerFactory.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        const gaugeRewardsDistributorFactory = await ethers.getContractFactory("GaugeRewardsDistributor");
        gaugeRewardsDistributor = await gaugeRewardsDistributorFactory.deploy(
            await gaugeController.getAddress(),
            await raacToken.getAddress() // single reward token, fixed at construction
        );
        await gaugeRewardsDistributor.waitForDeployment();
        await gaugeController.setDistributor(await gaugeRewardsDistributor.getAddress());

        const lpTokenFactory = await ethers.getContractFactory("LPToken");
        lpToken = await lpTokenFactory.deploy("RAACToken LP", "RAACToken LP", owner.address);
        await lpToken.waitForDeployment();

        await lpToken.setMinter(owner.address);
        await lpToken.setBurner(owner.address);

        const raacGaugeFactory = await ethers.getContractFactory("RAACGauge");
        raacGauge = await raacGaugeFactory.deploy(
            await lpToken.getAddress(),                    // staking token
            await gaugeController.getAddress(),
            owner.address,                                  // stands in for the RAAC liquid locker
            await raacToken.getAddress(),
            await raacToken.getAddress(),                   // reward token
            await gaugeRewardsDistributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        const Treasury = await ethers.getContractFactory("Treasury")
        treasury = await Treasury.deploy(owner.address);
        
        // We need RAAC token to be supported in Treasury
        await treasury.connect(owner).addSupportedToken(await raacToken.getAddress());


        await gaugeController.addGauge(await raacGauge.getAddress()); // RAAC Gauge (type/weight args removed)
        const RAAC_CONTROLLER_ROLE = await raacGauge.CONTROLLER_ROLE();
        await raacGauge.connect(owner).grantRole(RAAC_CONTROLLER_ROLE, owner.address);
        // the distributor's reward token is fixed at construction and the gauge pulls
        // its share itself; the old per-gauge token registration methods are gone
    });

    describe("Distribute Emissions to RAAC Gauges", function () {
        it("should set the minter to the owner", async function () {
            await raacToken.connect(owner).setMinter(await owner.address);
        });
        it("should perform initial minting of RAAC tokens", async function () {

            // We mint 1% of 21M tokens for the early liquidity wallet
            const earlyLiquidityMint = ethers.parseEther("210000");
            await raacToken.connect(owner).mint(earlyLiquidityWallet.address, earlyLiquidityMint);

            // We mint 7.8% of 21M tokens for the initial liquidity wallet
            const initialLiquidityMint = ethers.parseEther("1627500");
            await raacToken.connect(owner).mint(initialLiquidityWallet.address, initialLiquidityMint); 

            // Release Orchestrator
            const releaseOrchestratorAddress = await releaseOrchestrator.getAddress();

            // We mint 17.3% of 21M tokens for the team
            const teamMint = ethers.parseEther("3622500");
            await raacToken.connect(owner).mint(releaseOrchestratorAddress, teamMint);

            // We mint 11.3% of 21M tokens for the advisors
            const advisorsMint = ethers.parseEther("2415000");
            await raacToken.connect(owner).mint(releaseOrchestratorAddress, advisorsMint);

            // We mint ~8% of 21M tokens for the treasury
            const treasuryMint = ethers.parseEther("1837500");
            await raacToken.connect(owner).mint(releaseOrchestratorAddress, treasuryMint);

            // We mint 3.8% of 21M tokens for the private sale
            const privateSaleMint = ethers.parseEther("1050000");
            await raacToken.connect(owner).mint(releaseOrchestratorAddress, privateSaleMint);

            // We mint 10% of 21M tokens for the public sale
            const publicSaleMint = ethers.parseEther("2100000");
            await raacToken.connect(owner).mint(releaseOrchestratorAddress, publicSaleMint);

            // Left over ~40.8% of 21M tokens for the gauges - not minted now, will be done via tick() function. 
            // const gaugesMint = ethers.parseEther("8137500");
            // We verify the total minted tokens
            const totalMinted = await raacToken.totalSupply();
            expectedMintedWithTreasury = ethers.parseEther("12862500")
            const expectedRemainingMint = ethers.parseEther("8137500")
            // Minted but mostly locked - We can test more that aspect, but for now we expect the ReleaseOrchestrator tests to cover that. 
            expect(totalMinted).to.equal(expectedMintedWithTreasury);
            expect(MAX_SUPPLY - totalMinted).to.equal(expectedRemainingMint);
        });
        it('should grant the minter the minter role', async function () {
            await raacToken.setMinter(await raacMinter.getAddress());
        });
        it('should set the pools and stakers for distribution', async function () {
            await raacMinter.tick();
            await raacMinter.addDistributionPool(await treasury.getAddress(), 1000);
            await raacMinter.addDistributionPool(await gaugeRewardsDistributor.getAddress(), 5000);

            const STAKED_AMOUNT = ethers.parseEther("1000");
            // Owner mints 1000 LP tokens to user1
            await lpToken.connect(owner).mint(user1.address, STAKED_AMOUNT);
            
            // User 1 stakes 1000 LP token to the gauge (which only starts at the next
            // Thursday boundary after deployment)
            const { periodStartTime } = await raacGauge.getPeriodBoundaries();
            if ((await time.latest()) < periodStartTime) {
                await time.increaseTo(Number(periodStartTime));
            }
            await lpToken.connect(user1).approve(await raacGauge.getAddress(), STAKED_AMOUNT);
            await raacGauge.connect(user1).stake(STAKED_AMOUNT);
        });

        it("should distribute emissions to RAAC gauges and treasury", async function () {
            let week = 0;
            let maxWeek = 1;

            let previousSupply = await raacToken.totalSupply();

            // We disable automine to ensure we can control the time
            // await network.provider.send("evm_setAutomine", [false]);

            // Minting is not active (startTimestamp is 0)
            expect(await raacMinter.mintingStartAtTimestamp()).to.equal(0);
            // Make a month pass to ensure there is no minting happening
            await simulateMinting(MONTH);
            await raacMinter.tick();
            expect(await raacToken.totalSupply()).to.equal(previousSupply);
            expect(await raacToken.totalSupply()).to.equal(ethers.parseEther("12862500"));

            // Start the minting process
            const tx = await raacMinter.activate();
            const receipt = await tx.wait();
            
            const startTimestamp = receipt.logs[0].args[0];
            expect(startTimestamp).to.closeTo(await time.latest(), 10);
            expect(tx).to.emit(raacMinter, "MintingActivated").withArgs(startTimestamp);
            expect(await raacMinter.mintingStartAtTimestamp()).to.equal(startTimestamp);

            expect(await raacToken.balanceOf(await gaugeRewardsDistributor.getAddress())).to.equal(0);
            // ======== START OF MINTING (WEEK 1) ========

            // One block passes
            expect(await raacToken.totalSupply()).to.equal(ethers.parseEther("12862500"));

            await network.provider.send("evm_mine", [parseInt(startTimestamp) + 12]);
            await raacMinter.tick();
            let timeNow = BigInt(await time.latest());
            let passedTime = timeNow - BigInt(startTimestamp);

            expect(passedTime).to.equal(12n);
            let expectedSupply = ethers.parseEther("12862500") + (BASE_PER_SECOND * 12n);
            expect(await raacToken.totalSupply()).to.equal(expectedSupply);
            
            // Check the distribution
            expect(await raacToken.balanceOf(await gaugeRewardsDistributor.getAddress())).to.closeTo((BASE_PER_SECOND * 12n) / 6000n * 5000n, ethers.parseEther("0.1"));
            expect(await raacToken.balanceOf(await raacGauge.getAddress())).to.equal(0n);
            // We expect everything to have been distributed to the gauges
            expect(await raacToken.balanceOf(await raacMinter.getAddress())).to.equal(0n);
            expect(await raacToken.balanceOf(await treasury.getAddress())).to.closeTo((BASE_PER_SECOND * 12n) / 6000n * 1000n, ethers.parseEther("0.1"));

            // Another block, one second passes
            await network.provider.send("evm_mine", [parseInt(timeNow) + 1]);
            await raacMinter.tick();
            timeNow = BigInt(await time.latest());
            expectedSupply = ethers.parseEther("12862500") + (BASE_PER_SECOND * 13n);
            expect(await raacToken.totalSupply()).to.equal(expectedSupply);

            await network.provider.send("evm_mine", [parseInt(timeNow) + SECONDS_IN_WEEK-13]);
            await raacMinter.tick();

            timeNow = BigInt(await time.latest());
            expect(timeNow - BigInt(startTimestamp)).to.equal(SECONDS_IN_WEEK);
            expectedSupply = ethers.parseEther("12862500") + (BASE_WEEKLY_EMISSION);
            expect(await raacToken.totalSupply()).to.equal(expectedSupply);
            // ==== WEEK 2 ====

            // Another 4 weeks pass
            await network.provider.send("evm_mine", [parseInt(timeNow) + SECONDS_IN_WEEK*4]);
            await raacMinter.tick();

            timeNow = BigInt(await time.latest());
            expect(timeNow - BigInt(startTimestamp)).to.equal(SECONDS_IN_WEEK*5);
            expectedSupply = ethers.parseEther("12862500") + (BASE_WEEKLY_EMISSION * 5n);
            expect(await raacToken.totalSupply()).to.equal(expectedSupply);

            expect(timeNow - BigInt(startTimestamp)).to.equal(3024000n);// 5 weeks
            expect(await raacToken.totalSupply() - previousSupply).to.equal(BASE_WEEKLY_EMISSION * 5n);

            // Go to end of week 104 - 7700 seconds
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*104 - 7700)]);
            await raacMinter.tick();

            timeNow = BigInt(await time.latest());
            expect(timeNow - BigInt(startTimestamp)).to.equal(SECONDS_IN_WEEK*104 - 7700);
            expectedSupply = ethers.parseEther("12862500") + (BASE_WEEKLY_EMISSION * 104n) - (BASE_PER_SECOND * 7700n);
            expect(await raacToken.totalSupply()).to.equal(expectedSupply);
            expect(await raacToken.totalSupply() - previousSupply).to.equal(cumulativeEmission(104) - BASE_PER_SECOND * 7700n);
            previousSupply = await raacToken.totalSupply();

            // Go to start of week 105 + 7700 seconds (total diff is 15400 seconds but across a reduction period)
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*104 + 7700)]);
            await raacMinter.tick();
            timeNow = BigInt(await time.latest());

            // Had a reduction period: 7700s at the base rate + 7700s at the reduced (x0.95) rate
            expect(await raacToken.totalSupply() - previousSupply).to.equal(
                BASE_PER_SECOND * 7700n + emissionPerSecondForWeek(105) * 7700n
            );


            // Go to week 573 (checkpoint check)
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*573)]);
            await raacMinter.tick();
            timeNow = BigInt(await time.latest());
            expect(timeNow - BigInt(startTimestamp)).to.equal(SECONDS_IN_WEEK*573);

            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.equal(cumulativeEmission(573));
            previousSupply = await raacToken.totalSupply();

            // Go to week 780 (ts spent: 471744000)
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*780)]);
            await raacMinter.tick();
            timeNow = BigInt(await time.latest());
            expect(timeNow - BigInt(startTimestamp)).to.equal(471744000n);
            // full schedule: min(cumulative emissions, 40.8% gauge allocation cap)
            const fullSchedule = cumulativeEmission(780);
            const expectedFinalEmission = fullSchedule > GAUGE_EMISSIONS_CAP ? GAUGE_EMISSIONS_CAP : fullSchedule;
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.equal(expectedFinalEmission);
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.be.lte(GAUGE_EMISSIONS_CAP);

            previousSupply = await raacToken.totalSupply();

            // Go to week 800
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*800)]);
            await raacMinter.tick();
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.equal(expectedFinalEmission);
            expect(previousSupply).to.equal(await raacToken.totalSupply());
            // Never exceed
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.be.lte(GAUGE_EMISSIONS_CAP);

            // Check the distribution (5000/6000 to the distributor, 1000/6000 to the treasury)
            expect(await raacToken.balanceOf(await gaugeRewardsDistributor.getAddress())).to.closeTo(expectedFinalEmission / 6000n * 5000n, ethers.parseEther("0.1"));
            expect(await raacToken.balanceOf(await raacGauge.getAddress())).to.equal(0n);
            // the minter may retain a few wei of division dust in excessTokens
            expect(await raacToken.balanceOf(await raacMinter.getAddress())).to.be.lte(6000n);
            expect(await raacToken.balanceOf(await treasury.getAddress())).to.closeTo(expectedFinalEmission / 6000n * 1000n, ethers.parseEther("0.1"));

            // Sanity extreme check (go very far in the future)
            await network.provider.send("evm_mine", [parseInt(startTimestamp) + (SECONDS_IN_WEEK*1000)]);
            await raacMinter.tick();
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.equal(expectedFinalEmission);
            expect(previousSupply).to.equal(await raacToken.totalSupply());
            // Never exceed
            expect(await raacToken.totalSupply() - expectedMintedWithTreasury).to.be.lte(GAUGE_EMISSIONS_CAP);

            // TODO: Claiming from gauges is tested in gauges-tests.js
            // However, it would be gentlemanly to test it here as well. 
        });
    });
 
}); 