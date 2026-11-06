import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("BaseGauge", () => {
    let gauge;
    let gaugeController;
    let rewardToken;
    let stakingToken;
    let distributor;
    let veToken;
    let owner;
    let user1;
    let user2;
    let ragequitLib, powerCheckpointLib, lockManagerLib, rewardLib, libraries;

    const WEIGHT_PRECISION = 10000;
    const DAY = 24 * 3600;
    const WEEK = 7 * DAY;
    // const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;
    const REWARD_AMOUNT = ethers.parseEther("1000");
    const STAKE_AMOUNT = ethers.parseEther("100");
    const MAX_LOCK_EPOCHS = 52 // GaugeController requires maxLockEpochs * epochDuration == 52 weeks

    let INIT_TIME;
    async function advancePastPeriod(gauge) {
        const { periodStartTime, periodEndTime } = await gauge.getPeriodBoundaries();
        const gaugePeriodEnd = BigInt(periodEndTime);

        const currentTime = BigInt(await time.latest());
        const targetTime = currentTime >= gaugePeriodEnd ? currentTime + 1n : gaugePeriodEnd + 1n;

        await time.increaseTo(Number(targetTime));
    }

    // Vote for the gauge then move into the next controller epoch so the vote weight is
    // active for deposits made afterwards (votes register at the NEXT epoch).
    async function voteAndActivate(weightBps = 5000) {
        await gaugeController.vote(await gauge.getAddress(), weightBps);
        await time.increase(WEEK);
    }

    async function depositAndPull(amount = REWARD_AMOUNT) {
        await rewardToken.approve(await distributor.getAddress(), amount);
        await distributor.deposit(await rewardToken.getAddress(), amount);
        await gauge.pullRewardsFromDistributor();
    }

    beforeEach(async () => {
        [owner, user1, user2] = await ethers.getSigners();

        INIT_TIME = await time.latest();
        const MockToken = await ethers.getContractFactory("MockToken");
        rewardToken = await MockToken.deploy("USD Coin", "USDC", 18);
        await rewardToken.waitForDeployment();

        //LockManager (now externalized)
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        //RagequitLib (linking LockManager)
        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: {
                LockManager: lockManagerLib.target
            }
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

        //RewardLib (linking LockManager)
        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: {
                LockManager: lockManagerLib.target
            }
        });
        rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        libraries = {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target
        }

        const RaacToken = await ethers.getContractFactory("RAACToken");
        stakingToken = await RaacToken.deploy(owner.address);
        await stakingToken.waitForDeployment();

        const VeToken = await ethers.getContractFactory("VeRAACToken",{ libraries });
        veToken = await VeToken.deploy(await stakingToken.getAddress(),owner.address,MAX_LOCK_EPOCHS );
        await veToken.waitForDeployment();

        const GaugeController = await ethers.getContractFactory("GaugeController");
        gaugeController = await GaugeController.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        const GaugeRewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
        distributor = await GaugeRewardsDistributor.deploy(
            await gaugeController.getAddress(),
            await rewardToken.getAddress()
        );
        await distributor.waitForDeployment();

        // Controller must know the distributor before gauges can be added
        await gaugeController.setDistributor(await distributor.getAddress());

        // Weekly gauge (RWAGauge is now a 28-day gauge). Owner stands in for the RAAC
        // liquid locker, which also grants it CLAIM_FOR_ROLE.
        const RAACGauge = await ethers.getContractFactory("RAACGauge");
        gauge = await RAACGauge.deploy(
            await stakingToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await stakingToken.getAddress(),
            await rewardToken.getAddress(),
            await distributor.getAddress()
        );
        await gauge.waitForDeployment();

        await rewardToken.mint(owner.address, REWARD_AMOUNT * 10n);
        await stakingToken.connect(owner).setMinter(owner.address);
        await stakingToken.mint(owner.address, ethers.parseEther("1000000")); // 1M for veToken
        await stakingToken.mint(user1.address, STAKE_AMOUNT * 10n);
        await stakingToken.mint(user2.address, STAKE_AMOUNT * 10n);

        // locking RAAC
        await stakingToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);

        await stakingToken.connect(owner).setMinter(await veToken.getAddress());

        // Approve tokens
        await rewardToken.approve(await distributor.getAddress(), REWARD_AMOUNT * 10n);
        await stakingToken.connect(user1).approve(await gauge.getAddress(), STAKE_AMOUNT * 10n);
        await stakingToken.connect(user2).approve(await gauge.getAddress(), STAKE_AMOUNT * 10n);

        await gaugeController.addGauge(await gauge.getAddress());

        const { periodStartTime, periodEndTime } = await gauge.getPeriodBoundaries();
        const currentTime = await time.latest();

        if (currentTime < periodStartTime) {
            await time.increaseTo(Number(periodStartTime));
        }
    });

    describe("Core Functionality", () => {
        it("should initialize with correct state", async () => {
            const gaugeDataStruct = await gauge.gaugeData();
            expect(gaugeDataStruct.stakingToken).to.equal(await stakingToken.getAddress());
            expect(gaugeDataStruct.rewardToken).to.equal(await rewardToken.getAddress());
            expect(gaugeDataStruct.rewardDistributor).to.equal(await distributor.getAddress());
            expect(await gauge.getControllerAddress()).to.equal(await gaugeController.getAddress());
        });
    });

    describe("Weight Management", () => {
        beforeEach(async () => {
            await advancePastPeriod(gauge);
        });

        it("should calculate user weight with boost", async () => {
            const weight = await gauge.getUserWeight(user1.address);
            expect(weight).to.be.gte(0);
        });

        it("should track total weight correctly", async () => {
            const totalWeight = await gauge.totalSupply();
            expect(totalWeight).to.be.gte(0);
        });
    });

    describe("Reward Distribution", () => {
        beforeEach(async () => {
            await advancePastPeriod(gauge);
            await voteAndActivate();
            await depositAndPull();
        });

        it("should track reward per token", async () => {
            const gaugeDataStruct = await gauge.gaugeData();
            // Init every thursday, so roughly INIT_TIME +/- 7 days
            expect(gaugeDataStruct.gaugeInitialStartTime).to.closeTo(INIT_TIME, 7 * DAY);
            expect(gaugeDataStruct.periodDuration).to.equal(WEEK);
            expect(gaugeDataStruct.periodIndex).to.be.gte(1);
            expect(gaugeDataStruct.stakingToken).to.equal(await stakingToken.getAddress());

            expect(gaugeDataStruct.totalSupply).to.equal(0);
            expect(gaugeDataStruct.workingSupply).to.equal(0);
            expect(gaugeDataStruct.lastUpdateTime).to.closeTo(await time.latest(), 1000);

            expect(gaugeDataStruct.rewardToken).to.equal(await rewardToken.getAddress());
            const rewardTokenDatum = await gauge.getGaugeRewardTokenData(await rewardToken.getAddress());
            expect(rewardTokenDatum.isActive).to.equal(true);
        });

        it("should calculate earned rewards", async () => {
            await gauge.connect(user1).stake(STAKE_AMOUNT);
            await time.increase(WEEK);
            const earned = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            expect(earned).to.be.gt(0);
        });
    });

    describe("Distributor Management", () => {
        it("should allow admin to add distributor", async () => {
            const newDistributor = await (await ethers.getContractFactory("GaugeRewardsDistributor")).deploy(
                await gaugeController.getAddress(),
                await rewardToken.getAddress()
            );
            await gauge.manageDistributor(await newDistributor.getAddress(), true);
            const distributors = await gauge.getDistributors();
            expect(distributors).to.include(await newDistributor.getAddress());
        });

        it("should revert when non-admin tries to manage distributors", async () => {
            await expect(
                gauge.connect(user1).manageDistributor(await distributor.getAddress(), true)
            ).to.be.revertedWithCustomError(gauge, "AccessControlUnauthorizedAccount");
        });
    });

    describe("Working Balance Tests", () => {
        beforeEach(async () => {
            await stakingToken.connect(owner).setMinter(owner.address);
        });

        afterEach(async () => {
            await stakingToken.connect(owner).setMinter(await veToken.getAddress());
        });

        it("should give 40% base working balance without veToken", async () => {
            const balance = ethers.parseUnits("1000", 18);
            await stakingToken.mint(user1.address, balance);
            await stakingToken.connect(user1).approve(await gauge.getAddress(), balance);
            await gauge.connect(user1).stake(balance);

            const workingBalance = await gauge.balanceOf(user1.address);
            expect(workingBalance).to.equal(balance * 4000n / 10000n); // 40% of balance
        });

        it("should boost working balance based on veToken share", async () => {
            const userBalance = ethers.parseUnits("1000", 18);
            const veBalance = ethers.parseUnits("100", 18);

            // Lock RAAC to get veToken balance
            await stakingToken.mint(user1.address, veBalance);
            await stakingToken.connect(user1).approve(await veToken.getAddress(), veBalance);
            await veToken.connect(user1).lock(veBalance, MAX_LOCK_EPOCHS);

            // Stake in gauge
            await stakingToken.mint(user1.address, userBalance);
            await stakingToken.connect(user1).approve(await gauge.getAddress(), userBalance);
            await gauge.connect(user1).stake(userBalance);

            const workingBalance = await gauge.balanceOf(user1.address);

            const minExpected = userBalance * 4000n / 10000n;
            expect(workingBalance).to.be.gte(minExpected);
            expect(workingBalance).to.be.lte(userBalance); // At most 100%
        });

        it("should cap working balance at actual balance", async () => {
            const balance = ethers.parseUnits("1000", 18);
            const veBalance = ethers.parseUnits("2000", 18);

            await stakingToken.mint(user1.address, veBalance);
            await stakingToken.connect(user1).approve(await veToken.getAddress(), veBalance);
            await veToken.connect(user1).lock(veBalance, MAX_LOCK_EPOCHS);

            // Stake in gauge
            await stakingToken.mint(user1.address, balance);
            await stakingToken.connect(user1).approve(await gauge.getAddress(), balance);
            await gauge.connect(user1).stake(balance);

            const workingBalance = await gauge.balanceOf(user1.address);

            expect(workingBalance).to.be.gte(balance * 4000n / 10000n); // At least 40% (base working balance even for no veToken)
            expect(workingBalance).to.be.lte(balance); // Will be slightly more than 40%, but defo less than 100%
        });
    });

    describe("Security Tests", () => {
        beforeEach(async () => {
            // Setup: vote so the gauge has weight, then stream rewards for the current period
            await advancePastPeriod(gauge);
            await voteAndActivate();
            await depositAndPull();

            // Approve staking tokens
            await stakingToken.connect(user1).approve(await gauge.getAddress(), STAKE_AMOUNT);
        });

        it("should not allow double reward claiming through updateUserRewards", async () => {
            // Setup: Stake tokens and wait for rewards to accumulate
            await gauge.connect(user1).stake(STAKE_AMOUNT);
            await time.increase(WEEK);

            // 1. First get rewards through normal claim path
            const balanceBeforeNormalClaim = await rewardToken.balanceOf(user1.address);
            await gauge.connect(user1).claimRewardToken();
            const balanceAfterNormalClaim = await rewardToken.balanceOf(user1.address);

            // Stream an identical deposit for the next period, then wait another week
            await depositAndPull();
            await time.increase(WEEK);

            // 2. Try the potential exploit path: updateUserRewards followed by claim
            await gauge.connect(user1).updateUserRewards(user1.address);
            await gauge.connect(user1).claimRewardToken();
            const balanceAfterExploitAttempt = await rewardToken.balanceOf(user1.address);

            // The rewards from both claiming methods should be similar
            // We allow for some small difference due to time-based calculations
            const normalClaimReward = balanceAfterNormalClaim - balanceBeforeNormalClaim;
            const exploitAttemptReward = balanceAfterExploitAttempt - balanceAfterNormalClaim;

            // Log the rewards for verification
            console.log("Normal claim rewards:", ethers.formatEther(normalClaimReward));
            console.log("Exploit attempt rewards:", ethers.formatEther(exploitAttemptReward));

            // The exploit attempt should not yield significantly more rewards
            expect(exploitAttemptReward).to.be.closeTo(normalClaimReward, ethers.parseEther("1"));
        });
        it("should ensure claimOnBehalf access control", async () => {
            await gauge.connect(user1).stake(STAKE_AMOUNT);
            await time.increase(WEEK);

            const rewardAddr = await rewardToken.getAddress();
            const pending = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            expect(pending).to.be.gt(0n, "user1 should have pending rewards before unauthorized call");

            const CLAIM_FOR_ROLE = await gauge.CLAIM_FOR_ROLE();
            expect(await gauge.hasRole(CLAIM_FOR_ROLE, user1.address)).to.equal(
                false,
                "user1 should not have CLAIM_FOR_ROLE"
            );

            await expect(
                gauge.connect(user1).claimOnBehalfOf(rewardAddr, pending, user2.address)
            ).to.be.revertedWithCustomError(gauge, "AccessControlUnauthorizedAccount");
        });
        it("should let CLAIM_FOR_ROLE transfer pending rewards via claimOnBehalfOf", async () => {
            await stakingToken.connect(owner).setMinter(owner.address);
            await stakingToken.mint(owner.address, STAKE_AMOUNT * 10n);
            await stakingToken.connect(owner).setMinter(await veToken.getAddress());
            await stakingToken.connect(owner).approve(await gauge.getAddress(), STAKE_AMOUNT);

            await gauge.connect(owner).stake(STAKE_AMOUNT);
            await time.increase(WEEK);

            const rewardAddr = await rewardToken.getAddress();
            const pending = await gauge.pendingRewards(await rewardToken.getAddress(), owner.address);
            expect(pending).to.be.gt(0n, "owner should have pending rewards");

            // owner is the raacLiquidLocker, so it holds CLAIM_FOR_ROLE from the constructor
            expect(await gauge.hasRole(await gauge.CLAIM_FOR_ROLE(), owner.address)).to.equal(true);

            const user2Before = await rewardToken.balanceOf(user2.address);
            await expect(
                gauge.connect(owner).claimOnBehalfOf(rewardAddr, pending, user2.address)
            ).to.not.be.reverted;
            expect(await rewardToken.balanceOf(user2.address)).to.be.gt(user2Before);
        });
    });

    const setupRewardPosition = async (accrualSeconds = WEEK - DAY, veTopUp, withExtraRewardToken = false) => {
        let extraRewardToken = null;

        if (veTopUp !== undefined && veTopUp > 0n) {
            await stakingToken.connect(owner).setMinter(owner.address);
            await stakingToken.mint(user1.address, veTopUp);
            await stakingToken.connect(owner).setMinter(await veToken.getAddress());
            await stakingToken.connect(user1).approve(await veToken.getAddress(), veTopUp);
        }

        await advancePastPeriod(gauge);
        await voteAndActivate();
        await depositAndPull();

        if (withExtraRewardToken) {
            // Second reward tokens are now handled by the gauge's extra-reward streaming
            // mechanism, not by the (single-token) distributor.
            const MockToken = await ethers.getContractFactory("MockToken");
            extraRewardToken = await MockToken.deploy("Tether USD", "USDT", 18);
            await extraRewardToken.waitForDeployment();
            await extraRewardToken.mint(owner.address, REWARD_AMOUNT * 10n);
            await extraRewardToken.approve(await gauge.getAddress(), REWARD_AMOUNT * 10n);
            await gauge.addRewardToken(await extraRewardToken.getAddress());
            await gauge.manageDistributor(owner.address, true);
            await gauge.depositRewardToken(await extraRewardToken.getAddress(), REWARD_AMOUNT);
        }

        await gauge.connect(user1).stake(STAKE_AMOUNT);
        await gauge.connect(user2).stake(STAKE_AMOUNT);

        if (accrualSeconds > 0) {
            await time.increase(accrualSeconds);
        }

        return extraRewardToken;
    };

    describe("Checkpoint Ordering", () => {
        it("should not inflate pending rewards upon checkpoint", async () => {
            const veTopUp = ethers.parseEther("50000");
            await setupRewardPosition(3 * DAY, veTopUp);

            const pendingRewardsBefore = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);

            // ~3/7 of the weekly stream, split evenly between two identical stakers
            expect(pendingRewardsBefore).to.be.gt(0n);
            expect(pendingRewardsBefore).to.be.lt(REWARD_AMOUNT);

            await veToken.connect(user1).lock(veTopUp, MAX_LOCK_EPOCHS);

            await gauge.connect(user1).updateUserRewards(user1.address);

            const pendingRewardsAfter = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            expect(pendingRewardsAfter).to.be.closeTo(pendingRewardsBefore, ethers.parseEther("1"));
        });
    });

    describe("Leftover rewards and unclaimed rewards", () => {
        it("should not give away rewards that are owed to non-claimers", async () => {
            // Soft assertion helper temporary to demonstrate the issues
            const errors = [];
            const softExpect = async (fn, description) => {
                try {
                    await fn();
                } catch (err) {
                    errors.push(`Soft assertion failed: ${description || ""}`);
                    errors.push(err);
                }
            };

            await setupRewardPosition(WEEK - DAY);

            await softExpect(
                async () => expect(await gauge.pendingRewards(await rewardToken.getAddress(), user1.address)).to.be.gt(0n),
                "user1 initial pending rewards > 0"
            );
            await softExpect(
                async () => expect(await gauge.pendingRewards(await rewardToken.getAddress(), user2.address)).to.be.gt(0n),
                "user2 initial pending rewards > 0"
            );

            await gauge.connect(user1).claimRewardToken();

            await gauge.connect(user2).updateUserRewards(user2.address);

            await rewardToken.approve(await distributor.getAddress(), REWARD_AMOUNT);
            await distributor.deposit(await rewardToken.getAddress(), REWARD_AMOUNT);

            await time.increase(WEEK);
            await gauge.pullRewardsFromDistributor();

            await time.increase(3 * DAY);

            const pendingRewardUser1Before = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            const pendingRewardUser2Before = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);
            const gaugeBalanceBefore = await rewardToken.balanceOf(await gauge.getAddress());

            console.log("pendingRewardUser1Before", ethers.formatEther(pendingRewardUser1Before));
            console.log("pendingRewardUser2Before", ethers.formatEther(pendingRewardUser2Before));
            console.log("gaugeBalanceBefore", ethers.formatEther(gaugeBalanceBefore));

            await gauge.connect(user1).updateUserRewards(user1.address);
            await gauge.connect(user2).updateUserRewards(user2.address);

            const pendingRewardUser1After = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            const pendingRewardUser2After = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);

            console.log("pendingRewardUser1After", ethers.formatEther(pendingRewardUser1After));
            console.log("pendingRewardUser2After", ethers.formatEther(pendingRewardUser2After));
            const gaugeBalanceAfter = await rewardToken.balanceOf(await gauge.getAddress());

            // Cannot be more (modulo streaming dust: the rate-based model re-quantizes the
            // leftover stream on each pull, so pending can overshoot the balance by ~1e-6 relative)
            const STREAMING_DUST = ethers.parseEther("0.01");
            console.log("gaugeBalanceAfter", ethers.formatEther(gaugeBalanceAfter));
            console.log("pendingRewardUser1After + pendingRewardUser2After", ethers.formatEther(pendingRewardUser1After + pendingRewardUser2After));
            await softExpect(
                async () => expect(pendingRewardUser1After + pendingRewardUser2After).to.be.at.most(gaugeBalanceAfter + STREAMING_DUST),
                "pendingRewardUser1After + pendingRewardUser2After <= gaugeBalanceAfter (+ dust)"
            );

            // User 1 claim
            await gauge.connect(user1).claimRewardToken();
            const user1BalanceAfterClaim = await rewardToken.balanceOf(user1.address);
            console.log("user1BalanceAfterClaim", ethers.formatEther(user1BalanceAfterClaim));
            await softExpect(
                async () => expect(user1BalanceAfterClaim).to.be.gt(0n),
                "user1 gets reward on claim"
            );

            const gaugeBalanceAfterClaim = await rewardToken.balanceOf(await gauge.getAddress());
            console.log("gaugeBalanceAfterClaim", ethers.formatEther(gaugeBalanceAfterClaim));
            await softExpect(
                async () => expect(gaugeBalanceAfterClaim).to.be.gt(0n),
                "gauge balance after user1 claim > 0"
            );

            const pendingRewardUser1AfterClaim = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            console.log("pendingRewardUser1AfterClaim", ethers.formatEther(pendingRewardUser1AfterClaim));

            const pendingRewardUser2AfterClaim = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);
            console.log("pendingRewardUser2AfterClaim", ethers.formatEther(pendingRewardUser2AfterClaim));
            await softExpect(
                async () => expect(pendingRewardUser2AfterClaim).to.be.gt(0n),
                "user2 pending rewards after user1 claim"
            );

            // User 2 claim
            await gauge.connect(user2).claimRewardToken();
            const user2BalanceAfter = await rewardToken.balanceOf(user2.address);
            console.log("user2BalanceAfter", ethers.formatEther(user2BalanceAfter));

            // Deposit new rewards
            await rewardToken.approve(await distributor.getAddress(), REWARD_AMOUNT);
            await distributor.deposit(await rewardToken.getAddress(), REWARD_AMOUNT);

            // next period with new rewards
            await advancePastPeriod(gauge);

            await gauge.pullRewardsFromDistributor();

            await time.increase(3 * DAY);

            const pendingRewardUser1AfterNextPeriod = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            console.log("pendingRewardUser1AfterNextPeriod", ethers.formatEther(pendingRewardUser1AfterNextPeriod));
            await softExpect(
                async () => expect(pendingRewardUser1AfterNextPeriod).to.be.gt(0n),
                "user1 pending rewards after next period"
            );

            const pendingRewardUser2AfterNextPeriod = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);
            console.log("pendingRewardUser2AfterNextPeriod", ethers.formatEther(pendingRewardUser2AfterNextPeriod));
            await softExpect(
                async () => expect(pendingRewardUser2AfterNextPeriod).to.be.gt(0n),
                "user2 pending rewards after next period"
            );

            // User 1 claim
            await gauge.connect(user1).claimRewardToken();
            const user1BalanceAfterNextPeriodClaim = await rewardToken.balanceOf(user1.address);
            console.log("user1BalanceAfterNextPeriodClaim", ethers.formatEther(user1BalanceAfterNextPeriodClaim));
            await softExpect(
                async () => expect(user1BalanceAfterNextPeriodClaim).to.be.gt(0n),
                "user1 gets reward on next period claim"
            );

            const gaugeBalanceAfterNextPeriodClaim = await rewardToken.balanceOf(await gauge.getAddress());
            console.log("gaugeBalanceAfterNextPeriodClaim", ethers.formatEther(gaugeBalanceAfterNextPeriodClaim));
            await softExpect(
                async () => expect(gaugeBalanceAfterNextPeriodClaim).to.be.gt(0n),
                "gauge balance after user1 claim next period > 0"
            );

            const pendingRewardUser1AfterNextPeriodClaim = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            console.log("pendingRewardUser1AfterNextPeriodClaim", ethers.formatEther(pendingRewardUser1AfterNextPeriodClaim));
            await softExpect(
                async () => expect(pendingRewardUser1AfterNextPeriodClaim).to.be.eq(0n),
                "user1 pending reward after next period claim == 0"
            );

            const pendingRewardUser2AfterNextPeriodClaim = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);
            console.log("pendingRewardUser2AfterNextPeriodClaim", ethers.formatEther(pendingRewardUser2AfterNextPeriodClaim));
            await softExpect(
                async () => expect(pendingRewardUser2AfterNextPeriodClaim).to.be.gt(0n),
                "user2 pending reward after next period claim > 0"
            );

            // User 2 claim
            await gauge.connect(user2).claimRewardToken();
            const user2BalanceAfterNextPeriodClaim = await rewardToken.balanceOf(user2.address);
            console.log("user2BalanceAfterNextPeriodClaim", ethers.formatEther(user2BalanceAfterNextPeriodClaim));
            await softExpect(
                async () => expect(user2BalanceAfterNextPeriodClaim).to.be.gt(0n),
                "user2 gets reward on next period claim"
            );

            const user2PendingRewardAfterNextPeriodClaim = await gauge.pendingRewards(await rewardToken.getAddress(), user2.address);
            console.log("user2PendingRewardAfterNextPeriodClaim", ethers.formatEther(user2PendingRewardAfterNextPeriodClaim));
            await softExpect(
                async () => expect(user2PendingRewardAfterNextPeriodClaim).to.be.eq(0n),
                "user2 pending reward after next period claim == 0"
            );

            const gaugeBalanceAfterNextPeriodClaim2 = await rewardToken.balanceOf(await gauge.getAddress());
            console.log("gaugeBalanceAfterNextPeriodClaim2", ethers.formatEther(gaugeBalanceAfterNextPeriodClaim2));

            await softExpect(
                async () => expect(await gauge.pendingRewards(await rewardToken.getAddress(), user1.address)).to.be.eq(0n),
                "user1 final pending reward"
            );
            await softExpect(
                async () => expect(await gauge.pendingRewards(await rewardToken.getAddress(), user2.address)).to.be.eq(0n),
                "user2 final pending reward"
            );

            if (errors.length > 0) {
                console.error("Soft assertion errors:", errors);
                throw new Error("Soft assertion errors" + errors.join(" & "));
            }
        });
    });

    describe("Extra reward precision", () => {
        it("should accrue 6-decimal extra rewards", async () => {
            await advancePastPeriod(gauge);

            const largeStake = ethers.parseEther("1000");
            const smallStake = ethers.parseEther("1");

            await stakingToken.connect(owner).setMinter(owner.address);
            await stakingToken.mint(user1.address, largeStake);
            await stakingToken.mint(user2.address, smallStake * 100n);
            await stakingToken.connect(owner).setMinter(await veToken.getAddress());
            await stakingToken.connect(user1).approve(await gauge.getAddress(), largeStake);
            await stakingToken.connect(user2).approve(await gauge.getAddress(), smallStake * 100n);

            const MockToken = await ethers.getContractFactory("MockToken");
            const extraRewardToken = await MockToken.deploy("Extra Reward", "USDC", 6);
            await extraRewardToken.waitForDeployment();

            const extraRewardAddr = await extraRewardToken.getAddress();
            await gauge.addRewardToken(extraRewardAddr);
            await gauge.manageDistributor(owner.address, true);

            await gauge.connect(user1).stake(largeStake);

            const extraAmount = 10n * 10n ** 6n; // 10 USDC streamed over one week
            await extraRewardToken.mint(owner.address, extraAmount * 10n);
            await extraRewardToken.approve(await gauge.getAddress(), extraAmount * 10n);
            await gauge.depositRewardToken(extraRewardAddr, extraAmount);

            for (let i = 0; i < 100; i++) {
                await time.increase(12);
                await gauge.connect(user2).stake(smallStake);
            }

            const pending = await gauge.pendingExtraRewards(extraRewardAddr, user1.address);
            const elapsed = 1200n; // 100 checkpoints * 12 seconds
            const expected = extraAmount * elapsed / BigInt(WEEK);

            // user1's share of the raw staked supply decays from 100% to ~91% as user2
            // stakes, so it should collect ~95% of the total streamed amount
            expect(expected).to.be.gt(0n);
            expect(pending).to.be.gte(expected * 88n / 100n);
            expect(pending).to.be.lte(expected * 101n / 100n);
        });

        it("should transfer correct native-decimal amount on claimExtraReward", async () => {
            await advancePastPeriod(gauge);

            const MockToken = await ethers.getContractFactory("MockToken");
            const extraRewardToken = await MockToken.deploy("Extra Reward", "USDC", 6);
            await extraRewardToken.waitForDeployment();

            const extraRewardAddr = await extraRewardToken.getAddress();
            await gauge.addRewardToken(extraRewardAddr);
            await gauge.manageDistributor(owner.address, true);

            await stakingToken.connect(owner).setMinter(owner.address);
            await stakingToken.mint(user1.address, STAKE_AMOUNT);
            await stakingToken.connect(owner).setMinter(await veToken.getAddress());
            await stakingToken.connect(user1).approve(await gauge.getAddress(), STAKE_AMOUNT);
            await gauge.connect(user1).stake(STAKE_AMOUNT);

            const extraAmount = 10n * 10n ** 6n; // 10 USDC
            await extraRewardToken.mint(owner.address, extraAmount);
            await extraRewardToken.approve(await gauge.getAddress(), extraAmount);
            await gauge.depositRewardToken(extraRewardAddr, extraAmount);

            // advance past full distribution period
            await time.increase(WEEK + 1);

            const balanceBefore = await extraRewardToken.balanceOf(user1.address);
            await gauge.connect(user1).claimExtraReward(extraRewardAddr);
            const received = await extraRewardToken.balanceOf(user1.address) - balanceBefore;

            // sole staker receives all 10 USDC in native (6-decimal) units, within 1 raw unit of rounding
            expect(received).to.be.gte(extraAmount - 1n);
            expect(received).to.be.lte(extraAmount);
        });
    });

    describe("Mid-period reward syncs", () => {
        it("should distribute remaining rewards in period when pullRewardsFromDistributor is called mid-period", async () => {
            await advancePastPeriod(gauge);
            await voteAndActivate();

            const rewardAddr = await rewardToken.getAddress();
            const gaugeAddr = await gauge.getAddress();

            await gauge.connect(user1).stake(STAKE_AMOUNT);

            await rewardToken.approve(await distributor.getAddress(), REWARD_AMOUNT * 2n);
            await distributor.deposit(rewardAddr, REWARD_AMOUNT);
            await gauge.pullRewardsFromDistributor();

            const { periodStartTime, periodEndTime } = await gauge.getPeriodBoundaries();
            const periodDuration = Number(periodEndTime - periodStartTime);

            await time.increase(Math.floor(periodDuration * 0.75));

            await distributor.deposit(rewardAddr, REWARD_AMOUNT);
            await gauge.pullRewardsFromDistributor();

            await time.increase(periodDuration);

            const userBalanceBefore = await rewardToken.balanceOf(user1.address);
            await gauge.connect(user1).claimRewardToken();
            const received = await rewardToken.balanceOf(user1.address) - userBalanceBefore;

            const gaugeBalance = await rewardToken.balanceOf(gaugeAddr);
            const totalDeposited = REWARD_AMOUNT * 2n;

            expect(received).to.be.equal(totalDeposited,`mid-period sync should not leave part of rewards undistributed (received: ${ethers.formatEther(received)}, totalDeposited: ${ethers.formatEther(totalDeposited)})`);
            expect(gaugeBalance).to.equal(0n, "no rewards should remain stuck in the gauge");
        });
    });

    describe("Multi-Token Reward Isolation", () => {
        it("should not erase token B pending rewards when token A is claimed", async () => {
            const extraRewardToken = await setupRewardPosition(DAY, undefined, true);
            const tokenB = await extraRewardToken.getAddress();

            const pendingBeforeTokenA = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            console.log("pendingBeforeTokenA", ethers.formatEther(pendingBeforeTokenA));
            const pendingBeforeTokenB = await gauge.pendingExtraRewards(tokenB, user1.address);
            console.log("pendingBeforeTokenB", ethers.formatEther(pendingBeforeTokenB));

            expect(pendingBeforeTokenA).to.be.gt(0n);
            expect(pendingBeforeTokenB).to.be.gt(0n);

            console.log('claim token A only')
            await gauge.connect(user1).claimRewardToken();

            // Check balance of token A and token B
            const balanceTokenA = await rewardToken.balanceOf(user1.address);
            console.log("balanceTokenA", ethers.formatEther(balanceTokenA));
            expect(balanceTokenA).to.be.gt(0n);
            const balanceTokenB = await extraRewardToken.balanceOf(user1.address);
            console.log("balanceTokenB", ethers.formatEther(balanceTokenB));
            expect(balanceTokenB).to.be.eq(0n);

            const pendingAfterTokenA = await gauge.pendingRewards(await rewardToken.getAddress(), user1.address);
            console.log("pendingAfterTokenA", ethers.formatEther(pendingAfterTokenA));
            const pendingAfterTokenB = await gauge.pendingExtraRewards(tokenB, user1.address);
            console.log("pendingAfterTokenB", ethers.formatEther(pendingAfterTokenB));
            expect(pendingAfterTokenA).to.be.closeTo(0n, ethers.parseEther("0.1"));
            expect(pendingAfterTokenB).to.be.closeTo(pendingBeforeTokenB, ethers.parseEther("0.1"));
        });
    });
});
