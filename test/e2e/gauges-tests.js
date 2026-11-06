import { expect } from "chai";
import hre from 'hardhat';
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Dual Gauge System", function () {
    let owner, user1, user2, user3, user4;
    let raacToken, veToken, lpToken;
    let mockUSDC;
    let gaugeController, rewardsDistributor;
    let rwaGauge, raacGauge;
    let lockManagerLib, ragequitLib, powerCheckpointLib, rewardLib;

    const DAY = 24 * 60 * 60;
    const WEEK = 7 * 24 * 60 * 60;
    const MAX_LOCK_EPOCHS = 52;
    const MAX_TIME = 52n * 7n * 86400n;

    // User stake amounts
    const USER1_RWA_STAKE = ethers.parseEther("100");  // User1: 100 tokens in RWA
    const USER2_RAAC_STAKE = ethers.parseEther("100"); // User2: 100 tokens in RAAC
    const USER3_STAKE = ethers.parseEther("50");       // User3: 50 tokens in both
    const USER4_RWA_STAKE = ethers.parseEther("75");   // User4: 75 in RWA, 25 in RAAC
    const USER4_RAAC_STAKE = ethers.parseEther("25");

    const TOTAL_REWARDS = ethers.parseEther("20000"); // deposited once, split 50/50 across gauges

    async function deployVeLibraries() {
        if (lockManagerLib) return;
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        ragequitLib = await RagequitLibFactory.deploy();
        await ragequitLib.waitForDeployment();

        const PowerCheckpointFactory = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target },
        });
        powerCheckpointLib = await PowerCheckpointFactory.deploy();
        await powerCheckpointLib.waitForDeployment();

        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();
    }

    // Deploys a full, freshly wired dual-gauge system on the current API.
    async function deployAll() {
        await deployVeLibraries();

        const raacTokenFactory = await ethers.getContractFactory("RAACToken");
        raacToken = await raacTokenFactory.deploy(owner.address); // tax/whitelist params removed
        await raacToken.waitForDeployment();

        const veTokenFactory = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target,
            },
        });
        veToken = await veTokenFactory.deploy(await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veToken.waitForDeployment();

        const MockTokenFactory = await ethers.getContractFactory("MockToken");
        lpToken = await MockTokenFactory.deploy("RAACToken LP", "RAAC-LP", 18);
        await lpToken.waitForDeployment();

        mockUSDC = await MockTokenFactory.deploy("USD Coin", "USDC", 18);
        await mockUSDC.waitForDeployment();

        const gaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await gaugeControllerFactory.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        const rewardsDistributorFactory = await ethers.getContractFactory("GaugeRewardsDistributor");
        rewardsDistributor = await rewardsDistributorFactory.deploy(
            await gaugeController.getAddress(),
            await mockUSDC.getAddress()
        );
        await rewardsDistributor.waitForDeployment();

        // Controller must know the distributor before gauges can be added
        await gaugeController.setDistributor(await rewardsDistributor.getAddress());

        const rwaGaugeFactory = await ethers.getContractFactory("RWAGauge");
        rwaGauge = await rwaGaugeFactory.deploy(
            await lpToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await rewardsDistributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        const raacGaugeFactory = await ethers.getContractFactory("RAACGauge");
        raacGauge = await raacGaugeFactory.deploy(
            await lpToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await rewardsDistributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        await gaugeController.addGauge(await rwaGauge.getAddress());
        await gaugeController.addGauge(await raacGauge.getAddress());

        // Grant CONTROLLER_ROLE to owner for both gauges
        await rwaGauge.connect(owner).grantRole(await rwaGauge.CONTROLLER_ROLE(), owner.address);
        await raacGauge.connect(owner).grantRole(await raacGauge.CONTROLLER_ROLE(), owner.address);

        // Both gauges start at the next Thursday midnight; move there so staking is allowed
        const { periodStartTime } = await rwaGauge.getPeriodBoundaries();
        if ((await time.latest()) < periodStartTime) {
            await time.increaseTo(Number(periodStartTime));
        }
    }

    async function mintRaac(to, amount) {
        await raacToken.connect(owner).setMinter(owner.address);
        await raacToken.connect(owner).mint(to, amount);
        await raacToken.connect(owner).setMinter(await veToken.getAddress());
    }

    async function lockRaac(user, amount, epochs = MAX_LOCK_EPOCHS) {
        await raacToken.connect(user).approve(await veToken.getAddress(), amount);
        await veToken.connect(user).lock(amount, epochs);
    }

    async function advancePastPeriod(gauge) {
        const { periodEndTime } = await gauge.getPeriodBoundaries();
        const current = BigInt(await time.latest());
        const target = current >= periodEndTime ? current + 1n : periodEndTime + 1n;
        await time.increaseTo(Number(target));
    }

    // Expected bias a vote adds at the next epoch: sum over live locks of
    // allocated * (end - nextEpoch) / maxTime (mirrors GaugeController._scheduleLocks).
    async function expectedVoteBias(userAddress, bps) {
        const locks = await veToken.getLocks(userAddress);
        const nextEpoch = await gaugeController.getNextEpoch();
        let bias = 0n;
        for (const l of locks) {
            const end = BigInt(l.unlockTime);
            if (end <= nextEpoch) continue;
            const allocated = (BigInt(l.amount) * BigInt(bps)) / 10000n;
            bias += (allocated * (end - nextEpoch)) / MAX_TIME;
        }
        return bias;
    }

    before(async function () {
        [owner, user1, user2, user3, user4] = await ethers.getSigners();
        await deployAll();

        const userInitialBalance = ethers.parseEther("2000000");
        await mintRaac(owner.address, ethers.parseEther("9000000"));
        for (const user of [user1, user2, user3, user4]) {
            await raacToken.connect(owner).transfer(user.address, userInitialBalance);
            await lpToken.mint(user.address, userInitialBalance);
        }

        await mockUSDC.mint(owner.address, ethers.parseEther("1000000"));
    });

    describe("Gauge System Tests", function () {
        it('should properly set up gauges with the shared distributor and reward token', async function () {
            expect(await rewardsDistributor.rewardToken()).to.equal(await mockUSDC.getAddress());

            // Each gauge is wired to the distributor and the reward token
            const rwaData = await rwaGauge.gaugeData();
            const raacData = await raacGauge.gaugeData();
            expect(rwaData.rewardToken).to.equal(await mockUSDC.getAddress());
            expect(raacData.rewardToken).to.equal(await mockUSDC.getAddress());
            expect(rwaData.rewardDistributor).to.equal(await rewardsDistributor.getAddress());
            expect(raacData.rewardDistributor).to.equal(await rewardsDistributor.getAddress());

            // The distributor holds DISTRIBUTOR_ROLE on the gauges (granted in the constructor)
            const DISTRIBUTOR_ROLE = await rwaGauge.DISTRIBUTOR_ROLE();
            expect(await rwaGauge.hasRole(DISTRIBUTOR_ROLE, await rewardsDistributor.getAddress())).to.be.true;
            expect(await raacGauge.hasRole(DISTRIBUTOR_ROLE, await rewardsDistributor.getAddress())).to.be.true;

            // Extra-reward depositors are registered via manageDistributor (auto-approved)
            await rwaGauge.manageDistributor(await rewardsDistributor.getAddress(), true);
            await raacGauge.manageDistributor(await rewardsDistributor.getAddress(), true);

            const rwaDistributors = await rwaGauge.getDistributors();
            const raacDistributors = await raacGauge.getDistributors();
            expect(rwaDistributors.length).to.equal(1);
            expect(raacDistributors.length).to.equal(1);
            expect(rwaDistributors[0]).to.equal(await rewardsDistributor.getAddress());
            expect(raacDistributors[0]).to.equal(await rewardsDistributor.getAddress());

            // Both gauges are active in the controller
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.true;
            expect(await gaugeController.isGaugeActive(await raacGauge.getAddress())).to.be.true;
        });

        it('should allow users to stake tokens', async function () {
            expect(await mockUSDC.balanceOf(user1.address)).to.equal(0);
            expect(await mockUSDC.balanceOf(user2.address)).to.equal(0);
            expect(await mockUSDC.balanceOf(user3.address)).to.equal(0);
            expect(await mockUSDC.balanceOf(user4.address)).to.equal(0);

            await lockRaac(user1, ethers.parseEther("1000000"));
            await lockRaac(user2, ethers.parseEther("100000"));
            await lockRaac(user3, ethers.parseEther("500000"));
            await lockRaac(user4, ethers.parseEther("500000"));

            await lpToken.connect(user1).approve(await rwaGauge.getAddress(), USER1_RWA_STAKE);
            await lpToken.connect(user2).approve(await raacGauge.getAddress(), USER2_RAAC_STAKE);
            await lpToken.connect(user3).approve(await rwaGauge.getAddress(), USER3_STAKE);
            await lpToken.connect(user3).approve(await raacGauge.getAddress(), USER3_STAKE);
            await lpToken.connect(user4).approve(await rwaGauge.getAddress(), USER4_RWA_STAKE);
            await lpToken.connect(user4).approve(await raacGauge.getAddress(), USER4_RAAC_STAKE);

            await rwaGauge.connect(user1).stake(USER1_RWA_STAKE);
            await raacGauge.connect(user2).stake(USER2_RAAC_STAKE);
            await rwaGauge.connect(user3).stake(USER3_STAKE);
            await raacGauge.connect(user3).stake(USER3_STAKE);
            await rwaGauge.connect(user4).stake(USER4_RWA_STAKE);
            await raacGauge.connect(user4).stake(USER4_RAAC_STAKE);

            // rawBalanceOf tracks the staked amount; balanceOf is the boosted working balance
            expect(await rwaGauge.rawBalanceOf(user1.address)).to.equal(USER1_RWA_STAKE);
            expect(await raacGauge.rawBalanceOf(user2.address)).to.equal(USER2_RAAC_STAKE);
            expect(await rwaGauge.rawBalanceOf(user3.address)).to.equal(USER3_STAKE);
            expect(await raacGauge.rawBalanceOf(user3.address)).to.equal(USER3_STAKE);
            expect(await rwaGauge.rawBalanceOf(user4.address)).to.equal(USER4_RWA_STAKE);
            expect(await raacGauge.rawBalanceOf(user4.address)).to.equal(USER4_RAAC_STAKE);

            // Working balances land between 40% (base) and 100% (max boost) of the raw stake
            for (const [gauge, user, stake] of [
                [rwaGauge, user1, USER1_RWA_STAKE],
                [raacGauge, user2, USER2_RAAC_STAKE],
                [rwaGauge, user3, USER3_STAKE],
                [raacGauge, user3, USER3_STAKE],
                [rwaGauge, user4, USER4_RWA_STAKE],
                [raacGauge, user4, USER4_RAAC_STAKE],
            ]) {
                const working = await gauge.balanceOf(user.address);
                expect(working).to.be.gte(stake * 4000n / 10000n);
                expect(working).to.be.lte(stake);
            }

            expect(await rwaGauge.rawTotalSupply()).to.equal(USER1_RWA_STAKE + USER3_STAKE + USER4_RWA_STAKE);
            expect(await raacGauge.rawTotalSupply()).to.equal(USER2_RAAC_STAKE + USER3_STAKE + USER4_RAAC_STAKE);
        });

        it('should distribute rewards proportionally to working balances', async function () {
            expect(await rwaGauge.periodDuration()).to.equal(14 * DAY); // RWAGauge is the 14-day gauge
            expect(await raacGauge.periodDuration()).to.equal(WEEK);    // RAACGauge is the weekly gauge

            // Owner votes 50/50 for the two gauges; votes activate at the NEXT weekly epoch
            await lockRaac(owner, ethers.parseEther("100000"));
            await gaugeController.connect(owner).vote(await rwaGauge.getAddress(), 5000);
            await gaugeController.connect(owner).vote(await raacGauge.getAddress(), 5000);
            await time.increase(WEEK);

            // Deposit once; each gauge pulls its relative-weight share (equal votes -> 50/50)
            await mockUSDC.connect(owner).approve(await rewardsDistributor.getAddress(), TOTAL_REWARDS);
            await rewardsDistributor.connect(owner).deposit(await mockUSDC.getAddress(), TOTAL_REWARDS);

            await rwaGauge.pullRewardsFromDistributor();
            await raacGauge.pullRewardsFromDistributor();

            const rwaGaugeBalance = await mockUSDC.balanceOf(await rwaGauge.getAddress());
            const raacGaugeBalance = await mockUSDC.balanceOf(await raacGauge.getAddress());
            expect(rwaGaugeBalance).to.be.closeTo(raacGaugeBalance, ethers.parseEther("0.1"));
            expect(rwaGaugeBalance + raacGaugeBalance).to.equal(TOTAL_REWARDS);

            // Let both gauges finish their current periods so the streams are fully accrued
            await advancePastPeriod(raacGauge);
            await advancePastPeriod(rwaGauge);

            // pendingRewards is keyed by reward token, then by user
            const rewardToken = await mockUSDC.getAddress();
            const rwaUser1Pending = await rwaGauge.pendingRewards(rewardToken, user1.address);
            const raacUser2Pending = await raacGauge.pendingRewards(rewardToken, user2.address);
            const rwaUser3Pending = await rwaGauge.pendingRewards(rewardToken, user3.address);
            const raacUser3Pending = await raacGauge.pendingRewards(rewardToken, user3.address);
            const rwaUser4Pending = await rwaGauge.pendingRewards(rewardToken, user4.address);
            const raacUser4Pending = await raacGauge.pendingRewards(rewardToken, user4.address);

            // Rewards split according to working balances
            const rwaWorkingSupply = await rwaGauge.totalSupply();
            const raacWorkingSupply = await raacGauge.totalSupply();
            const DUST = ethers.parseEther("0.01"); // streaming/rounding dust

            expect(rwaUser1Pending).to.be.closeTo(
                rwaGaugeBalance * (await rwaGauge.balanceOf(user1.address)) / rwaWorkingSupply, DUST);
            expect(raacUser2Pending).to.be.closeTo(
                raacGaugeBalance * (await raacGauge.balanceOf(user2.address)) / raacWorkingSupply, DUST);
            expect(rwaUser3Pending).to.be.closeTo(
                rwaGaugeBalance * (await rwaGauge.balanceOf(user3.address)) / rwaWorkingSupply, DUST);
            expect(raacUser3Pending).to.be.closeTo(
                raacGaugeBalance * (await raacGauge.balanceOf(user3.address)) / raacWorkingSupply, DUST);
            expect(rwaUser4Pending).to.be.closeTo(
                rwaGaugeBalance * (await rwaGauge.balanceOf(user4.address)) / rwaWorkingSupply, DUST);
            expect(raacUser4Pending).to.be.closeTo(
                raacGaugeBalance * (await raacGauge.balanceOf(user4.address)) / raacWorkingSupply, DUST);

            expect(rwaUser1Pending).to.be.gt(rwaUser3Pending);
            expect(raacUser2Pending).to.be.gt(raacUser3Pending);

            // Everyone claims (claimRewardToken is no-arg: main token only)
            await rwaGauge.connect(user1).claimRewardToken();
            await raacGauge.connect(user2).claimRewardToken();
            await rwaGauge.connect(user3).claimRewardToken();
            await raacGauge.connect(user3).claimRewardToken();
            await rwaGauge.connect(user4).claimRewardToken();
            await raacGauge.connect(user4).claimRewardToken();

            expect(await mockUSDC.balanceOf(user1.address)).to.be.closeTo(rwaUser1Pending, DUST);
            expect(await mockUSDC.balanceOf(user2.address)).to.be.closeTo(raacUser2Pending, DUST);
            expect(await mockUSDC.balanceOf(user3.address)).to.be.closeTo(rwaUser3Pending + raacUser3Pending, DUST);
            expect(await mockUSDC.balanceOf(user4.address)).to.be.closeTo(rwaUser4Pending + raacUser4Pending, DUST);

            // No pending rewards left after claiming
            expect(await rwaGauge.pendingRewards(rewardToken, user1.address)).to.equal(0);
            expect(await raacGauge.pendingRewards(rewardToken, user2.address)).to.equal(0);
            expect(await rwaGauge.pendingRewards(rewardToken, user3.address)).to.equal(0);
            expect(await raacGauge.pendingRewards(rewardToken, user3.address)).to.equal(0);
            expect(await rwaGauge.pendingRewards(rewardToken, user4.address)).to.equal(0);
            expect(await raacGauge.pendingRewards(rewardToken, user4.address)).to.equal(0);

            // The full deposit ended up with the stakers (gauges hold only rounding dust)
            expect(await mockUSDC.balanceOf(await rwaGauge.getAddress())).to.be.closeTo(0, DUST);
            expect(await mockUSDC.balanceOf(await raacGauge.getAddress())).to.be.closeTo(0, DUST);

            const totalUsdcBalance =
                await mockUSDC.balanceOf(user1.address) +
                await mockUSDC.balanceOf(user2.address) +
                await mockUSDC.balanceOf(user3.address) +
                await mockUSDC.balanceOf(user4.address);
            expect(totalUsdcBalance).to.be.closeTo(TOTAL_REWARDS, DUST);
        });

        it('should allow users to withdraw their tokens', async function () {
            const initialUser1Lp = await lpToken.balanceOf(user1.address);

            await rwaGauge.connect(user1).withdraw(USER1_RWA_STAKE);
            expect(await rwaGauge.rawBalanceOf(user1.address)).to.equal(0);
            expect(await rwaGauge.balanceOf(user1.address)).to.equal(0);
            expect(await lpToken.balanceOf(user1.address)).to.equal(initialUser1Lp + USER1_RWA_STAKE);

            await raacGauge.connect(user2).withdraw(USER2_RAAC_STAKE);
            expect(await raacGauge.rawBalanceOf(user2.address)).to.equal(0);

            await rwaGauge.connect(user3).withdraw(USER3_STAKE);
            expect(await rwaGauge.rawBalanceOf(user3.address)).to.equal(0);
            await raacGauge.connect(user3).withdraw(USER3_STAKE);
            expect(await raacGauge.rawBalanceOf(user3.address)).to.equal(0);

            await rwaGauge.connect(user4).withdraw(USER4_RWA_STAKE);
            expect(await rwaGauge.rawBalanceOf(user4.address)).to.equal(0);
            await raacGauge.connect(user4).withdraw(USER4_RAAC_STAKE);
            expect(await raacGauge.rawBalanceOf(user4.address)).to.equal(0);

            // All supplies back to 0
            expect(await rwaGauge.rawTotalSupply()).to.equal(0);
            expect(await raacGauge.rawTotalSupply()).to.equal(0);
            expect(await rwaGauge.totalSupply()).to.equal(0);
            expect(await raacGauge.totalSupply()).to.equal(0);

            // Withdrawing more than the staked balance fails
            await expect(rwaGauge.connect(user1).withdraw(USER1_RWA_STAKE))
                .to.be.revertedWithCustomError(rwaGauge, "InsufficientStakedBalance");
            await expect(raacGauge.connect(user2).withdraw(USER2_RAAC_STAKE))
                .to.be.revertedWithCustomError(raacGauge, "InsufficientStakedBalance");

            // Withdrawing 0 fails
            await expect(rwaGauge.connect(user1).withdraw(0))
                .to.be.revertedWithCustomError(rwaGauge, "InvalidAmount");
            await expect(raacGauge.connect(user2).withdraw(0))
                .to.be.revertedWithCustomError(raacGauge, "InvalidAmount");
        });
    });

    describe("Vote Weight System Tests", function () {
        // Users keep the veRAAC locks they created in the staking test above.
        it("should record vote allocations based on the voter's locks", async function () {
            const rwaAddr = await rwaGauge.getAddress();
            const weightBefore = await gaugeController.getGaugeWeight(rwaAddr);

            const expectedBias = await expectedVoteBias(user3.address, 5000);
            await gaugeController.connect(user3).vote(rwaAddr, 5000);

            // VoteSlope tracks the locked amount allocated to the gauge and the bps power
            const slope = await gaugeController.voteUserSlopes(user3.address, rwaAddr);
            expect(slope.power).to.equal(5000);
            // user3 locked 500k, voted 50% -> 250k allocated
            expect(slope.locked).to.equal(ethers.parseEther("250000"));

            expect(await gaugeController.voteUserPower(user3.address)).to.equal(5000);
            expect(await gaugeController.getUserVotePowerRemaining(user3.address)).to.equal(5000);
            expect(await gaugeController.getUserGaugeVotePower(user3.address, rwaAddr)).to.equal(5000);

            // Per-lock decay entries are scheduled at the lock's real expiry
            const entries = [];
            for (let i = 0; ; i++) {
                try {
                    entries.push(await gaugeController.voteUserLockEntries(user3.address, rwaAddr, i));
                } catch {
                    break;
                }
            }
            expect(entries.length).to.be.gte(1);
            let entriesLocked = 0n;
            for (const entry of entries) {
                entriesLocked += BigInt(entry.locked);
                expect(await gaugeController.changesWeight(rwaAddr, entry.unlockTime)).to.be.gte(entry.locked);
            }
            expect(entriesLocked).to.equal(slope.locked);

            // The vote lands at the next epoch with bias = allocated * remaining / maxTime
            const weightAfter = await gaugeController.getGaugeWeight(rwaAddr);
            expect(weightAfter - weightBefore).to.be.closeTo(expectedBias, expectedBias / 1000n + 10n);
        });

        it("should enforce vote weight bounds", async function () {
            const rwaAddr = await rwaGauge.getAddress();
            const raacAddr = await raacGauge.getAddress();

            // Above 100%
            await expect(gaugeController.connect(user4).vote(rwaAddr, 10001))
                .to.be.revertedWithCustomError(gaugeController, "InvalidWeight");

            // Below the 1% minimum (0 stays allowed as a vote reset)
            await expect(gaugeController.connect(user4).vote(rwaAddr, 99))
                .to.be.revertedWithCustomError(gaugeController, "VoteWeightTooLow");

            // user3 already allocated 5000 bps; 6000 more would exceed 100% of their power
            await expect(gaugeController.connect(user3).vote(raacAddr, 6000))
                .to.be.revertedWithCustomError(gaugeController, "InvalidWeight");
        });

        it("should enforce the 10-day per-gauge vote cooldown", async function () {
            const rwaAddr = await rwaGauge.getAddress();
            const raacAddr = await raacGauge.getAddress();

            // Re-voting the same gauge immediately is blocked
            await expect(gaugeController.connect(user3).vote(rwaAddr, 3000))
                .to.be.revertedWithCustomError(gaugeController, "VoteDelayNotElapsed");

            // The cooldown is per (user, gauge): a different gauge can be voted right away
            await gaugeController.connect(user3).vote(raacAddr, 2000);
            expect(await gaugeController.voteUserPower(user3.address)).to.equal(7000);

            // After the delay the same gauge can be re-voted, replacing the old allocation
            const WEIGHT_VOTE_DELAY = await gaugeController.WEIGHT_VOTE_DELAY();
            await time.increase(Number(WEIGHT_VOTE_DELAY) + 1);
            await gaugeController.connect(user3).vote(rwaAddr, 3000);

            const slope = await gaugeController.voteUserSlopes(user3.address, rwaAddr);
            expect(slope.power).to.equal(3000);
            expect(await gaugeController.voteUserPower(user3.address)).to.equal(5000); // 3000 + 2000
        });

        it("should apply new votes at the next weekly epoch", async function () {
            const rwaAddr = await rwaGauge.getAddress();

            const rwaBefore = await gaugeController.getGaugeWeight(rwaAddr);
            const totalBefore = await gaugeController.getTotalWeight();

            const expectedBias = await expectedVoteBias(user4.address, 4000);
            await gaugeController.connect(user4).vote(rwaAddr, 4000);

            // getGaugeWeight projects to the next epoch, so the fresh vote is visible there
            const rwaAfter = await gaugeController.getGaugeWeight(rwaAddr);
            const totalAfter = await gaugeController.getTotalWeight();

            expect(rwaAfter - rwaBefore).to.be.closeTo(expectedBias, expectedBias / 1000n + 10n);
            expect(totalAfter - totalBefore).to.be.closeTo(expectedBias, expectedBias / 1000n + 10n);
        });

        it("should decay gauge weights week over week", async function () {
            const rwaAddr = await rwaGauge.getAddress();
            const raacAddr = await raacGauge.getAddress();
            const TOLERANCE = ethers.parseEther("0.1");

            let total = await gaugeController.getTotalWeight();
            let rwa = await gaugeController.getGaugeWeight(rwaAddr);
            let raac = await gaugeController.getGaugeWeight(raacAddr);
            expect(rwa + raac).to.be.closeTo(total, TOLERANCE);
            expect(total).to.be.gt(0n);

            for (let i = 0; i < 3; i++) {
                await time.increase(WEEK);
                const totalNow = await gaugeController.getTotalWeight();
                const rwaNow = await gaugeController.getGaugeWeight(rwaAddr);
                const raacNow = await gaugeController.getGaugeWeight(raacAddr);

                expect(totalNow).to.be.lt(total);
                expect(rwaNow).to.be.lt(rwa);
                expect(raacNow).to.be.lte(raac);
                expect(rwaNow + raacNow).to.be.closeTo(totalNow, TOLERANCE);

                total = totalNow; rwa = rwaNow; raac = raacNow;
            }
        });
    });

    describe("Boost Amplification Tests", function () {
        const REWARD_AMOUNT = ethers.parseEther("10000");
        const STAKE_AMOUNT = ethers.parseEther("100");

        beforeEach(async function () {
            await deployAll();

            // Owner: small ve lock (so it barely dilutes users' boost share) + full vote
            await mintRaac(owner.address, ethers.parseEther("100000"));
            await lockRaac(owner, ethers.parseEther("100"));
            await gaugeController.connect(owner).vote(await rwaGauge.getAddress(), 10000);
            await time.increase(WEEK); // vote activates at the next weekly epoch

            // user1 has a big lock, user2 a small one (10x less)
            await raacToken.connect(owner).transfer(user1.address, ethers.parseEther("20000"));
            await raacToken.connect(owner).transfer(user2.address, ethers.parseEther("20000"));

            await lpToken.mint(owner.address, ethers.parseEther("10000"));
            await lpToken.mint(user1.address, ethers.parseEther("10000"));
            await lpToken.mint(user2.address, ethers.parseEther("10000"));
            await lpToken.connect(user1).approve(await rwaGauge.getAddress(), ethers.MaxUint256);
            await lpToken.connect(user2).approve(await rwaGauge.getAddress(), ethers.MaxUint256);
            await lpToken.connect(owner).approve(await rwaGauge.getAddress(), ethers.MaxUint256);

            await mockUSDC.mint(owner.address, REWARD_AMOUNT * 10n);
            await mockUSDC.connect(owner).approve(await rewardsDistributor.getAddress(), ethers.MaxUint256);
        });

        it("should properly amplify rewards based on veToken holdings", async function () {
            // Boost amplification is enabled by default on the controller when a gauge is added
            expect((await gaugeController.gauges(await rwaGauge.getAddress())).isBoostAmplificationEnabled).to.be.true;

            await lockRaac(user1, ethers.parseEther("10000"));
            await lockRaac(user2, ethers.parseEther("1000"));

            // Both users stake the same amount
            await rwaGauge.connect(user1).stake(STAKE_AMOUNT);
            await rwaGauge.connect(user2).stake(STAKE_AMOUNT);

            // user1 staked first, when rawTotalSupply was only its own stake; refresh its
            // working balance so the boost reflects the full staked supply
            await rwaGauge.connect(user1).updateUserRewards(user1.address);

            const user1Working = await rwaGauge.balanceOf(user1.address);
            const user2Working = await rwaGauge.balanceOf(user2.address);

            // user1's large ve share caps its working balance at 100% of the stake;
            // user2 gets the 40% base plus a small ve-share boost
            expect(user1Working).to.be.gt(user2Working);
            expect(user1Working).to.be.closeTo(STAKE_AMOUNT, ethers.parseEther("1"));
            expect(user2Working).to.be.gte(STAKE_AMOUNT * 4000n / 10000n);
            expect(user2Working).to.be.lt(STAKE_AMOUNT * 7000n / 10000n);

            // Stream rewards for the period and let it finish
            await rewardsDistributor.connect(owner).deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await rwaGauge.pullRewardsFromDistributor();
            await advancePastPeriod(rwaGauge);

            const user1Pending = await rwaGauge.pendingRewards(await mockUSDC.getAddress(), user1.address);
            const user2Pending = await rwaGauge.pendingRewards(await mockUSDC.getAddress(), user2.address);

            // Equal stakes, but user1's boost amplifies its share
            expect(user1Pending).to.be.gt(user2Pending);

            const workingSupply = user1Working + user2Working;
            const DUST = ethers.parseEther("0.01");
            expect(user1Pending).to.be.closeTo(REWARD_AMOUNT * user1Working / workingSupply, DUST);
            expect(user2Pending).to.be.closeTo(REWARD_AMOUNT * user2Working / workingSupply, DUST);

            await rwaGauge.connect(user1).claimRewardToken();
            await rwaGauge.connect(user2).claimRewardToken();

            const user1Rewards = await mockUSDC.balanceOf(user1.address);
            const user2Rewards = await mockUSDC.balanceOf(user2.address);
            expect(user1Rewards).to.be.above(user2Rewards);
            expect(user1Rewards + user2Rewards).to.be.closeTo(REWARD_AMOUNT, DUST);
        });

        it("should not amplify rewards when boost amplification is disabled", async function () {
            // Toggle lives on the controller now: setBoostAmplificationEnabled(gauge, bool)
            await gaugeController.connect(owner).setBoostAmplificationEnabled(await rwaGauge.getAddress(), false);

            await lockRaac(user1, ethers.parseEther("10000"));
            await lockRaac(user2, ethers.parseEther("1000"));

            await rwaGauge.connect(user1).stake(STAKE_AMOUNT);
            await rwaGauge.connect(user2).stake(STAKE_AMOUNT);

            // Without amplification everyone sits at the 40% base working balance
            expect(await rwaGauge.balanceOf(user1.address)).to.equal(STAKE_AMOUNT * 4000n / 10000n);
            expect(await rwaGauge.balanceOf(user2.address)).to.equal(STAKE_AMOUNT * 4000n / 10000n);

            await rewardsDistributor.connect(owner).deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await rwaGauge.pullRewardsFromDistributor();
            await advancePastPeriod(rwaGauge);

            const user1Pending = await rwaGauge.pendingRewards(await mockUSDC.getAddress(), user1.address);
            const user2Pending = await rwaGauge.pendingRewards(await mockUSDC.getAddress(), user2.address);

            // Same stakes and no boost -> equal halves regardless of ve holdings
            expect(user1Pending).to.be.closeTo(REWARD_AMOUNT / 2n, ethers.parseEther("0.01"));
            expect(user2Pending).to.be.closeTo(REWARD_AMOUNT / 2n, ethers.parseEther("0.01"));
        });

        it("should allow toggling boost amplification", async function () {
            const rwaAddr = await rwaGauge.getAddress();

            // Enabled by default when the gauge is added
            expect((await gaugeController.gauges(rwaAddr)).isBoostAmplificationEnabled).to.be.true;

            await gaugeController.connect(owner).setBoostAmplificationEnabled(rwaAddr, false);
            expect((await gaugeController.gauges(rwaAddr)).isBoostAmplificationEnabled).to.be.false;

            await gaugeController.connect(owner).setBoostAmplificationEnabled(rwaAddr, true);
            expect((await gaugeController.gauges(rwaAddr)).isBoostAmplificationEnabled).to.be.true;

            // Only GAUGE_ADMIN may toggle
            await expect(
                gaugeController.connect(user1).setBoostAmplificationEnabled(rwaAddr, false)
            ).to.be.revertedWithCustomError(gaugeController, "AccessControlUnauthorizedAccount");

            // Unknown/inactive gauges are rejected
            await expect(
                gaugeController.connect(owner).setBoostAmplificationEnabled(user1.address, false)
            ).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");
        });

        it("should calculate correct boost based on veToken balance", async function () {
            const amount = ethers.parseEther("100");
            const totalStaked = ethers.parseEther("1000");

            await lockRaac(user1, ethers.parseEther("10000")); // user1: big ve balance; user2: none

            await rwaGauge.connect(owner).stake(totalStaked);
            await rwaGauge.connect(user1).stake(amount);
            await rwaGauge.connect(user2).stake(amount);

            const [boost1, boostedAmount1] = await gaugeController.calculateBoost(
                user1.address, await rwaGauge.getAddress(), amount);
            const [boost2, boostedAmount2] = await gaugeController.calculateBoost(
                user2.address, await rwaGauge.getAddress(), amount);

            // Higher ve balance -> higher boost
            expect(boost1).to.be.gt(boost2);
            expect(boostedAmount1).to.be.gt(boostedAmount2);

            // Boost is bounded between MIN_BOOST (1x) and MAX_BOOST (2.5x)
            expect(boost1).to.be.lte(25000);
            expect(boost1).to.be.gt(10000);
            expect(boost2).to.equal(10000); // no ve balance -> exactly the minimum

            // user1's ve share dominates -> effectively max boost
            expect(boost1).to.be.closeTo(25000, 1000);

            // boostedAmount = amount * boost / MAX_BOOST (i.e. the working balance contribution)
            expect(boostedAmount1).to.equal(amount * boost1 / 25000n);
            expect(boostedAmount2).to.equal(amount * boost2 / 25000n);
        });
    });
});
