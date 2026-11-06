import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

// Helper: advance past period start if needed
async function advancePastPeriodStart(gauge) {
    const { periodStartTime } = await gauge.getPeriodBoundaries();
    const currentTime = await time.latest();
    if (currentTime < periodStartTime) {
        await time.setNextBlockTimestamp(Number(periodStartTime));
        await network.provider.send("evm_mine");
    }
}

describe("RAACGauge", () => {
    let raacGauge;
    let gaugeController;
    let veToken;
    let raacToken;
    let rewardToken;
    let owner;
    let user1;
    let user2;
    let emergencyAdmin;
    let snapshotId;
    let initialTimeAtLock;
    let leRAAC;
    let ragequitLib, powerCheckpointLib, lockManagerLib, libraries;
    
    const WEEK = 7 * 24 * 3600;
    const WEIGHT_PRECISION = 10000;
    const DAY = 24 * 3600;
    const YEAR = 365 * DAY;
    const MAX_LOCK_EPOCHS = 52

    let INIT_TIME;
    // TODO review me, may be unneccesary or need to at least factorize fromt he other tests somehow
    // or have other tests do something else than RWA / RAAC
    beforeEach(async () => {
        snapshotId = await network.provider.send('evm_snapshot');
        [owner, user1, user2, emergencyAdmin] = await ethers.getSigners();

        INIT_TIME = await time.latest();
        const RaacToken = await ethers.getContractFactory("RAACToken");
        raacToken = await RaacToken.deploy(owner.address);
        await raacToken.waitForDeployment();

        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target }
        });
        ragequitLib = await RagequitLibFactory.deploy();
        await ragequitLib.waitForDeployment();

        //PowerCheckpointLib (linking LockManager)
        const PowerCheckpointLib = await ethers.getContractFactory("PowerCheckpoint",{
            libraries: {
                LockManager:lockManagerLib.target
            }
        });
        powerCheckpointLib = await PowerCheckpointLib.deploy();
        await powerCheckpointLib.waitForDeployment();

        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target }
        });
        const rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        libraries = {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target
        }
        const VeRAACToken = await ethers.getContractFactory("VeRAACToken", { libraries });
        veToken = await VeRAACToken.deploy(await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veToken.waitForDeployment();


        // Minter role
        await raacToken.setMinter(owner.address);

        const MockToken = await ethers.getContractFactory("MockToken");
        rewardToken = await MockToken.deploy("USD Coin", "USDC", 18);
        await rewardToken.waitForDeployment();
        
        const GaugeController = await ethers.getContractFactory("GaugeController");
        gaugeController = await GaugeController.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        const GaugeRewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
        const distributor = await GaugeRewardsDistributor.deploy(
            await gaugeController.getAddress(),
            await rewardToken.getAddress()
        );
        await distributor.waitForDeployment();
        await gaugeController.setDistributor(await distributor.getAddress());

        const RAACGauge = await ethers.getContractFactory("RAACGauge");
        raacGauge = await RAACGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,                       // stands in for the RAAC liquid locker
            await raacToken.getAddress(),
            await rewardToken.getAddress(),
            await distributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        await raacToken.mint(owner.address, ethers.parseEther("10000000"));
        await raacToken.mint(user1.address, ethers.parseEther("1000000"));
        await raacToken.mint(user2.address, ethers.parseEther("500000"));
        await rewardToken.mint(owner.address, ethers.parseEther("1000000"));

        // Lock RAAC
        await raacToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);
        
        await raacToken.connect(user1).approve(await veToken.getAddress(), ethers.parseEther("100000"));
        await veToken.connect(user1).lock(ethers.parseEther("100000"), MAX_LOCK_EPOCHS);
        
        await raacToken.connect(user2).approve(await veToken.getAddress(), ethers.parseEther("50000"));
        await veToken.connect(user2).lock(ethers.parseEther("50000"), MAX_LOCK_EPOCHS);

        initialTimeAtLock = await time.latest();
        // Transfer rewards to gauge
        await rewardToken.connect(owner).transfer(raacGauge.getAddress(), ethers.parseEther("100000"));

        const CONTROLLER_ROLE = await raacGauge.CONTROLLER_ROLE();
        await raacGauge.grantRole(CONTROLLER_ROLE, owner.address);
        await raacGauge.grantRole(CONTROLLER_ROLE, await gaugeController.getAddress());
        await gaugeController.grantRole(await gaugeController.GAUGE_ADMIN(), owner.address);

        // Add gauge to controller
        await gaugeController.addGauge(await raacGauge.getAddress()); // Type 1 for RAAC
    });

    afterEach(async () => {
        await network.provider.send('evm_revert', [snapshotId]);
    });

    describe("Initialization", () => {
        it("should initialize with correct state", async () => {
            const gaugeData = await raacGauge.gaugeData();
            expect(gaugeData.gaugeInitialStartTime).to.closeTo(INIT_TIME, 7 * DAY);
            expect(gaugeData.periodDuration).to.equal(WEEK);
            expect(gaugeData.periodIndex).to.equal(0);
            expect(gaugeData.stakingToken).to.equal(await raacToken.getAddress());
            // TODO: GaugeController ? 
            expect(gaugeData.totalSupply).to.equal(0);
            expect(gaugeData.workingSupply).to.equal(0);
            expect(gaugeData.lastUpdateTime).to.closeTo(await time.latest(), 1000);
        });

        it("should verify period boundaries", async () => {
            const { periodStartTime, periodEndTime } = await raacGauge.getPeriodBoundaries();
            expect(periodStartTime).to.be.gt(0);
            expect(periodEndTime).to.be.gt(periodStartTime);
            expect(periodEndTime - periodStartTime).to.equal(BigInt(WEEK));
        });
    });

    describe("Weight Voting", () => {
        beforeEach(async () => {
            // Move to period start time
            const { periodStartTime } = await raacGauge.getPeriodBoundaries();
            const currentTime = await time.latest();
            if (currentTime < periodStartTime) {
                await time.setNextBlockTimestamp(Number(periodStartTime));
                await network.provider.send("evm_mine");
            }
            await time.increase(60);
        });

        it("should handle weight voting through controller", async () => {
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 2500); // 25%

            const user1Power = await veToken.balanceOf(user1.address);
            const weightAfter = await gaugeController.getGaugeWeight(await raacGauge.getAddress());
            expect(weightAfter).to.be.gt(0n);
            expect(weightAfter).to.be.closeTo(user1Power / 4n, user1Power * 3n / 100n);
        });

        it("should respect voting power in weight votes", async () => {
            // User1 and User2 vote with different voting power
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 2500); // 25%
            await gaugeController.connect(user2).vote(await raacGauge.getAddress(), 2500); // 25%

            // User1 locked twice as much as user2 for the same duration, so their
            // ve power (and thus their vote contribution) is twice as large.
            const user1Power = await veToken.balanceOf(user1.address);
            const user2Power = await veToken.balanceOf(user2.address);
            expect(user1Power).to.be.gt(0n);
            expect(user1Power).to.be.closeTo(user2Power * 2n, user2Power / 100n);

            // The gauge weight (ve-bias units) becomes active at the next epoch
            // and sums both users' 25% contributions.
            await time.increase(WEEK);
            const gaugeWeight = await gaugeController.getGaugeWeight(await raacGauge.getAddress());
            const combined = user1Power + user2Power;
            expect(gaugeWeight).to.be.closeTo(combined / 4n, combined * 3n / 100n);
        });
    });

    describe("Period Management", () => {
        it("should handle weekly period transitions", async () => {
            const { periodStartTime, periodEndTime } = await raacGauge.getPeriodBoundaries();
            const periodDuration = BigInt(await raacGauge.periodDuration());
            
            // period duration is weekly
            expect(periodDuration).to.equal(BigInt(WEEK));
            
            expect(periodEndTime).to.be.gt(periodStartTime);
            expect(periodEndTime - periodStartTime).to.equal(periodDuration);
        });

        it("should have correct period duration", async () => {
            const periodDuration = await raacGauge.periodDuration();
            expect(periodDuration).to.equal(WEEK);
        });
    });

    describe("Staking Functionality", () => {
        beforeEach(async () => {
            const { periodStartTime } = await raacGauge.getPeriodBoundaries();
            const currentTime = await time.latest();
            if (currentTime < periodStartTime) {
                await time.setNextBlockTimestamp(Number(periodStartTime));
                await network.provider.send("evm_mine");
            }

            await raacToken.mint(user1.address, ethers.parseEther("1000"));
            await raacToken.mint(user2.address, ethers.parseEther("1000"));
            
            // Approve all 
            await raacToken.connect(user1).approve(raacGauge.getAddress(), ethers.MaxUint256);
            await raacToken.connect(user2).approve(raacGauge.getAddress(), ethers.MaxUint256);
        });

        it("should handle stake correctly", async () => {
            await raacGauge.connect(user1).stake(ethers.parseEther("100"));
            const rawBalance = await raacGauge.rawBalanceOf(user1.address);
            expect(rawBalance).to.equal(ethers.parseEther("100"));

            const balance = await raacGauge.balanceOf(user1.address);
            expect(balance).to.equal(ethers.parseEther("45.216"));
        });

        it("should handle withdraw correctly", async () => {
            await raacGauge.connect(user1).stake(ethers.parseEther("100"));
            await raacGauge.connect(user1).withdraw(ethers.parseEther("50"));
            
            const rawBalance = await raacGauge.rawBalanceOf(user1.address);
            expect(rawBalance).to.equal(ethers.parseEther("50"));

            const balance = await raacGauge.balanceOf(user1.address);
            expect(balance).to.equal(ethers.parseEther("22.608"));
        });

        it("should prevent withdrawing more than staked", async () => {
            await raacGauge.connect(user1).stake(ethers.parseEther("100"));
            await expect(
                raacGauge.connect(user1).withdraw(ethers.parseEther("101"))
            ).to.be.revertedWithCustomError(raacGauge, "InsufficientStakedBalance");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Extra Rewards Distribution
    // ─────────────────────────────────────────────────────────────────────────
    describe("Extra Rewards Distribution", () => {
        let extraRewardToken;
        // owner acts as the authorized distributor throughout these tests

        // depositAmount chosen so rate = exactly 1e18 tokens/sec (clean math)
        const DEPOSIT_AMOUNT = ethers.parseEther(String(WEEK)); // 604800 * 1e18

        beforeEach(async () => {
            await advancePastPeriodStart(raacGauge);

            await raacGauge.manageDistributor(owner.address, true);

            const MockTokenFactory = await ethers.getContractFactory("MockToken");
            extraRewardToken = await MockTokenFactory.deploy("Extra Reward", "EXTRA", 18);
            await extraRewardToken.waitForDeployment();

            // Give users fresh RAAC + approvals for staking
            await raacToken.mint(user1.address, ethers.parseEther("1000"));
            await raacToken.mint(user2.address, ethers.parseEther("1000"));
            await raacToken.connect(user1).approve(raacGauge.getAddress(), ethers.MaxUint256);
            await raacToken.connect(user2).approve(raacGauge.getAddress(), ethers.MaxUint256);
        });

        // ── Admin Setup ────────────────────────────────────────────────────
        describe("addRewardToken", () => {
            it("registers token with correct data", async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());

                const tokenData = await raacGauge.extraRewardTokenData(extraRewardToken.getAddress());
                expect(tokenData.isActive).to.be.true;
                expect(tokenData.decimals).to.equal(18);
                expect(tokenData.rate).to.equal(0);
            });

            it("emits ExtraRewardTokenAdded", async () => {
                await expect(
                    raacGauge.addRewardToken(extraRewardToken.getAddress())
                ).to.emit(raacGauge, "ExtraRewardTokenAdded")
                 .withArgs(await extraRewardToken.getAddress());
            });

            it("reverts when called by non-controller", async () => {
                await expect(
                    raacGauge.connect(user1).addRewardToken(extraRewardToken.getAddress())
                ).to.be.reverted;
            });

            it("reverts with zero token address", async () => {
                await expect(
                    raacGauge.addRewardToken(ethers.ZeroAddress)
                ).to.be.revertedWithCustomError(raacGauge, "InvalidAddress");
            });

            it("reverts when the token is already registered", async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());
                await expect(
                    raacGauge.addRewardToken(extraRewardToken.getAddress())
                ).to.be.revertedWithCustomError(raacGauge, "TokenAlreadyInitialized");
            });

            it("reverts when MAX_EXTRA_REWARDS (8) is reached", async () => {
                const MockTokenFactory = await ethers.getContractFactory("MockToken");
                for (let i = 0; i < 8; i++) {
                    const t = await MockTokenFactory.deploy(`Token${i}`, `TK${i}`, 18);
                    await raacGauge.addRewardToken(t.getAddress());
                }
                const overflow = await MockTokenFactory.deploy("Over", "OVER", 18);
                await expect(
                    raacGauge.addRewardToken(overflow.getAddress())
                ).to.be.revertedWithCustomError(raacGauge, "MaxExtraRewardsReached");
            });
        });

        // ── depositRewardToken ─────────────────────────────────────────────
        describe("depositRewardToken", () => {
            beforeEach(async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());
                await extraRewardToken.mint(owner.address, DEPOSIT_AMOUNT * 3n);
                await extraRewardToken.connect(owner).approve(raacGauge.getAddress(), ethers.MaxUint256);
            });

            it("sets correct rate (amount * 1e18 / WEEK)", async () => {
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                const tokenData = await raacGauge.extraRewardTokenData(extraRewardToken.getAddress());
                // rate is stored scaled by 1e18 for integer precision:
                //   rate = DEPOSIT_AMOUNT * 1e18 / WEEK
                //        = (WEEK * 1e18) * 1e18 / WEEK = 1e36
                const RATE_PRECISION = 10n ** 18n;
                const expectedRate = DEPOSIT_AMOUNT * RATE_PRECISION / BigInt(WEEK);
                expect(tokenData.rate).to.equal(expectedRate);
            });

            it("sets periodFinish to now + WEEK", async () => {
                const txTime = (await time.latest()) + 1;
                await time.setNextBlockTimestamp(txTime);
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                const tokenData = await raacGauge.extraRewardTokenData(extraRewardToken.getAddress());
                expect(tokenData.periodFinish).to.equal(BigInt(txTime) + BigInt(WEEK));
            });

            it("emits ExtraRewardDeposited", async () => {
                await expect(
                    raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT)
                ).to.emit(raacGauge, "ExtraRewardDeposited")
                 .withArgs(await extraRewardToken.getAddress(), DEPOSIT_AMOUNT);
            });

            it("reverts for non-distributor caller", async () => {
                await extraRewardToken.mint(user1.address, DEPOSIT_AMOUNT);
                await extraRewardToken.connect(user1).approve(raacGauge.getAddress(), DEPOSIT_AMOUNT);
                await expect(
                    raacGauge.connect(user1).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT)
                ).to.be.revertedWithCustomError(raacGauge, "DistributorNotAdded");
            });

            it("reverts for unregistered token", async () => {
                const MockTokenFactory = await ethers.getContractFactory("MockToken");
                const unknown = await MockTokenFactory.deploy("Unknown", "UNK", 18);
                await extraRewardToken.mint(owner.address, DEPOSIT_AMOUNT);
                // owner is an approved distributor, so the token-registration check fires
                await expect(
                    raacGauge.connect(owner).depositRewardToken(unknown.getAddress(), DEPOSIT_AMOUNT)
                ).to.be.revertedWithCustomError(raacGauge, "NotSupportedToken");
            });

            it("reverts for zero amount", async () => {
                await expect(
                    raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), 0)
                ).to.be.revertedWithCustomError(raacGauge, "InvalidAmount");
            });

            it("rolls the whole deposit over when nobody is staked to stream to", async () => {
                // Nothing is staked in this block, so gaugeData.totalSupply == 0 and
                // _checkpointRewards never advances lastUpdate: with no stakers there is nobody
                // to accrue to, so the period effectively has not started and no tokens are spent.

                // First deposit: rate = DEPOSIT_AMOUNT * 1e18 / WEEK
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                // Advance half a week; with zero supply nothing was distributed in that time
                await time.increase(WEEK / 2);

                // Second deposit of same amount mid-period
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                const tokenData = await raacGauge.extraRewardTokenData(extraRewardToken.getAddress());
                // leftover is measured from lastUpdate (still the first deposit), so remaining is a
                // full WEEK: leftover = WEEK * rate1 = DEPOSIT_AMOUNT * 1e18, i.e. all of deposit #1.
                // total = 2 * DEPOSIT_AMOUNT * 1e18 -> new rate = 2 * DEPOSIT_AMOUNT * 1e18 / WEEK.
                // Nothing is stranded: every token stays attributable to a future staker.
                const RATE_PRECISION = 10n ** 18n;
                const expectedRate = (DEPOSIT_AMOUNT * 2n) * RATE_PRECISION / BigInt(WEEK);
                // tolerance = 1 full-precision rate-unit (accounts for integer division rounding)
                expect(tokenData.rate).to.be.closeTo(expectedRate, RATE_PRECISION);
            });
        });

        // ── Accrual (view) ─────────────────────────────────────────────────
        describe("Pending rewards accrual", () => {
            beforeEach(async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());
                await extraRewardToken.mint(owner.address, DEPOSIT_AMOUNT);
                await extraRewardToken.connect(owner).approve(raacGauge.getAddress(), DEPOSIT_AMOUNT);

                // Both users stake equal amounts before deposit
                await raacGauge.connect(user1).stake(ethers.parseEther("100"));
                await raacGauge.connect(user2).stake(ethers.parseEther("100"));

                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);
            });

            it("pendingExtraRewards is 0 at deposit time", async () => {
                expect(await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address)).to.equal(0);
            });

            it("pendingExtraRewards increases as time passes", async () => {
                const before = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                await time.increase(DAY);
                const after = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                expect(after).to.be.gt(before);
            });

            it("pendingExtraRewards stops increasing after periodFinish", async () => {
                await time.increase(WEEK + DAY);
                const atEnd = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                await time.increase(DAY);
                const later = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                expect(later).to.equal(atEnd);
            });

            it("distributes proportionally — equal stakes get equal rewards", async () => {
                await time.increase(WEEK);
                const p1 = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                const p2 = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user2.address);
                // Each has 50 % of totalSupply (100 / 200) → each gets DEPOSIT_AMOUNT / 2
                expect(p1).to.be.closeTo(DEPOSIT_AMOUNT / 2n, ethers.parseEther("1"));
                expect(p2).to.be.closeTo(DEPOSIT_AMOUNT / 2n, ethers.parseEther("1"));
            });

            it("distributes proportionally — double stake gets double rewards", async () => {
                // user1 stakes an extra 100 on top of the existing 100 → 200 vs user2's 100
                await raacGauge.connect(user1).stake(ethers.parseEther("100"));

                await time.increase(WEEK);

                const p1 = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                const p2 = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user2.address);
                // user1 should earn roughly twice user2 for the time after the second stake
                expect(p1).to.be.gt(p2);
            });

            it("new staker earns nothing for time elapsed before their stake", async () => {
                await time.increase(DAY); // 1 day passes — user1/user2 accrue, owner has not staked yet

                await raacToken.connect(owner).approve(raacGauge.getAddress(), ethers.MaxUint256);
                await raacGauge.connect(owner).stake(ethers.parseEther("100"));

                // Immediately after staking, owner's pending should be 0
                expect(await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), owner.address)).to.equal(0);
            });

            it("allPendingExtraRewards returns correct token list and amounts", async () => {
                await time.increase(WEEK / 2);
                const [tokens, amounts] = await raacGauge.allPendingExtraRewards(user1.address);
                expect(tokens.length).to.equal(1);
                expect(tokens[0]).to.equal(await extraRewardToken.getAddress());
                expect(amounts[0]).to.be.gt(0);
            });
        });

        // ── Claiming ───────────────────────────────────────────────────────
        describe("Claiming extra rewards", () => {
            beforeEach(async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());
                await extraRewardToken.mint(owner.address, DEPOSIT_AMOUNT);
                await extraRewardToken.connect(owner).approve(raacGauge.getAddress(), DEPOSIT_AMOUNT);

                await raacGauge.connect(user1).stake(ethers.parseEther("100"));
                await raacGauge.connect(user2).stake(ethers.parseEther("100"));

                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);
                await time.increase(WEEK); // full period elapses
            });

            it("claimExtraReward transfers the correct amount", async () => {
                const pending = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                const balBefore = await extraRewardToken.balanceOf(user1.address);

                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());

                const received = (await extraRewardToken.balanceOf(user1.address)) - balBefore;
                expect(received).to.be.closeTo(pending, ethers.parseEther("1"));
            });

            it("claimExtraRewards claims all registered extra tokens", async () => {
                const balBefore = await extraRewardToken.balanceOf(user1.address);
                await raacGauge.connect(user1).claimExtraRewards();
                expect(await extraRewardToken.balanceOf(user1.address)).to.be.gt(balBefore);
            });

            it("pending is 0 immediately after claiming", async () => {
                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                expect(
                    await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address)
                ).to.equal(0);
            });

            it("emits ExtraRewardClaimed with correct token, user and amount", async () => {
                const pending = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                await expect(
                    raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress())
                ).to.emit(raacGauge, "ExtraRewardClaimed")
                 .withArgs(
                    await extraRewardToken.getAddress(),
                    user1.address,
                    (amount) => {
                        const tol = ethers.parseEther("1");
                        return amount >= pending - tol && amount <= pending + tol;
                    }
                 );
            });

            it("claimExtraReward returns the transferred amount", async () => {
                const balBefore = await extraRewardToken.balanceOf(user1.address);
                const returned = await raacGauge.connect(user1).claimExtraReward.staticCall(
                    extraRewardToken.getAddress()
                );
                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                const received = (await extraRewardToken.balanceOf(user1.address)) - balBefore;
                expect(returned).to.equal(received);
                expect(returned).to.be.gt(0);
            });

            it("sum of both users' claims equals total deposited (conservation)", async () => {
                const gaugeBefore = await extraRewardToken.balanceOf(raacGauge.getAddress());

                const bal1Before = await extraRewardToken.balanceOf(user1.address);
                const bal2Before = await extraRewardToken.balanceOf(user2.address);

                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                await raacGauge.connect(user2).claimExtraReward(extraRewardToken.getAddress());

                const claimed1 = (await extraRewardToken.balanceOf(user1.address)) - bal1Before;
                const claimed2 = (await extraRewardToken.balanceOf(user2.address)) - bal2Before;
                const totalClaimed = claimed1 + claimed2;

                // Total claimed must not exceed what was deposited
                expect(totalClaimed).to.be.lte(DEPOSIT_AMOUNT);
                // And it should be close to the full deposit (both staked for the full period)
                expect(totalClaimed).to.be.closeTo(DEPOSIT_AMOUNT, ethers.parseEther("1"));
            });

            it("second claim in same block transfers nothing", async () => {
                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                const balAfterFirst = await extraRewardToken.balanceOf(user1.address);

                // No time passes between the two calls (same block scenario)
                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                expect(await extraRewardToken.balanceOf(user1.address)).to.equal(balAfterFirst);
            });

            it("does not affect the other user's pending", async () => {
                const p2before = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user2.address);
                await raacGauge.connect(user1).claimExtraReward(extraRewardToken.getAddress());
                const p2after = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user2.address);
                expect(p2after).to.be.closeTo(p2before, ethers.parseEther("1"));
            });
        });

        // ── Stake / Withdraw integration ───────────────────────────────────
        describe("Stake / Withdraw integration with extra rewards", () => {
            beforeEach(async () => {
                await raacGauge.addRewardToken(extraRewardToken.getAddress());
                await extraRewardToken.mint(owner.address, DEPOSIT_AMOUNT);
                await extraRewardToken.connect(owner).approve(raacGauge.getAddress(), DEPOSIT_AMOUNT);
            });

            it("accrued extra rewards are preserved across an additional stake", async () => {
                await raacGauge.connect(user1).stake(ethers.parseEther("100"));
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                await time.increase(DAY);
                const pendingBefore = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);

                // Stake again — checkpoint should preserve the earned rewards
                await raacGauge.connect(user1).stake(ethers.parseEther("10"));
                const pendingAfter = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);

                expect(pendingAfter).to.be.gte(pendingBefore);
            });

            it("accrued extra rewards are preserved across a withdraw", async () => {
                await raacGauge.connect(user1).stake(ethers.parseEther("100"));
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                await time.increase(DAY);
                const pendingBefore = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);

                await raacGauge.connect(user1).withdraw(ethers.parseEther("50"));
                const pendingAfter = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);

                expect(pendingAfter).to.be.gte(pendingBefore);
            });

            it("user who withdraws all stops earning extra rewards", async () => {
                await raacGauge.connect(user1).stake(ethers.parseEther("100"));
                await raacGauge.connect(user2).stake(ethers.parseEther("100"));
                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);

                await time.increase(DAY);
                await raacGauge.connect(user1).withdraw(ethers.parseEther("100")); // full withdrawal

                const pendingAtWithdraw = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);
                await time.increase(DAY);
                const pendingLater = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user1.address);

                expect(pendingLater).to.equal(pendingAtWithdraw);
            });

            it("rewards are based on raw balance, not working balance (boost-independent)", async () => {
                // owner has large veToken balance (high boost); user2 has smaller veToken balance (lower boost)
                // Both stake the same raw amount → extra rewards must be equal
                await raacToken.connect(owner).approve(raacGauge.getAddress(), ethers.MaxUint256);
                await raacGauge.connect(owner).stake(ethers.parseEther("100"));
                await raacGauge.connect(user2).stake(ethers.parseEther("100"));

                await raacGauge.connect(owner).depositRewardToken(extraRewardToken.getAddress(), DEPOSIT_AMOUNT);
                await time.increase(WEEK);

                const pendingOwner = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), owner.address);
                const pendingUser2 = await raacGauge.pendingExtraRewards(extraRewardToken.getAddress(), user2.address);

                // Working balances differ (different boosts) but raw balances are equal → equal extra rewards
                expect(pendingOwner).to.be.closeTo(pendingUser2, ethers.parseEther("1"));
            });
        });
    });
});
