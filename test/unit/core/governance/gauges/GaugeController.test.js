import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs.js";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("GaugeController", () => {
    let gaugeController;
    let rwaGauge;
    let raacGauge;
    let raacToken;
    let veToken;
    let mockUSDC;
    let owner;
    let gaugeAdmin;
    let emergencyAdmin;
    let feeAdmin;
    let user1;
    let user2;
    let distributor;
    let ragequitLib, powerCheckpointLib, lockManagerLib, libraries;

    const DAY = 24 * 3600;
    const WEEK = 7 * 24 * 3600;
    const WEIGHT_PRECISION = 10000;
    const MAX_LOCK_EPOCHS = 52; // GaugeController requires maxLockEpochs * epochDuration == 52 weeks
    const WEIGHT_VOTE_DELAY = 10 * DAY;
    const INITIAL_SUPPLY = ethers.parseEther("1000000000");

    async function getBlockTimestamp() {
        const block = await ethers.provider.getBlock("latest");
        return block.timestamp;
    }

    beforeEach(async () => {
        [owner, gaugeAdmin, emergencyAdmin, feeAdmin, user1, user2] = await ethers.getSigners();

        const raacTokenFactory = await ethers.getContractFactory("RAACToken");
        raacToken = await raacTokenFactory.deploy(owner.address);
        await raacToken.waitForDeployment();

        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        ragequitLib = await RagequitLibFactory.deploy();
        await ragequitLib.waitForDeployment();

        const PowerCheckpointLib = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target },
        });
        powerCheckpointLib = await PowerCheckpointLib.deploy();
        await powerCheckpointLib.waitForDeployment();

        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        libraries = {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target,
        };

        const veTokenFactory = await ethers.getContractFactory("VeRAACToken", { libraries });
        veToken = await veTokenFactory.deploy(
            await raacToken.getAddress(),
            owner.getAddress(),
            MAX_LOCK_EPOCHS
        );
        await veToken.waitForDeployment();
        await raacToken.setMinter(await veToken.getAddress());

        const mockUSDCFactory = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await mockUSDCFactory.deploy(INITIAL_SUPPLY);
        await mockUSDC.waitForDeployment();

        const gaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await gaugeControllerFactory.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        // Both gauges share one rewards distributor (same controller + reward token)
        const GaugeRewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
        distributor = await GaugeRewardsDistributor.deploy(
            await gaugeController.getAddress(),
            await mockUSDC.getAddress()
        );
        await distributor.waitForDeployment();
        await gaugeController.setDistributor(await distributor.getAddress());

        const RWAGauge = await ethers.getContractFactory("RWAGauge");
        rwaGauge = await RWAGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await distributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        const RAACGauge = await ethers.getContractFactory("RAACGauge");
        raacGauge = await RAACGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await distributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        const GAUGE_ADMIN_ROLE = await gaugeController.GAUGE_ADMIN();
        const EMERGENCY_ADMIN_ROLE = await gaugeController.EMERGENCY_ADMIN();
        await gaugeController.grantRole(GAUGE_ADMIN_ROLE, gaugeAdmin.address);
        await gaugeController.grantRole(EMERGENCY_ADMIN_ROLE, emergencyAdmin.address);

        await gaugeController.connect(gaugeAdmin).addGauge(await rwaGauge.getAddress());
        await gaugeController.connect(gaugeAdmin).addGauge(await raacGauge.getAddress());

        const CONTROLLER_ROLE = await rwaGauge.CONTROLLER_ROLE();
        await rwaGauge.grantRole(CONTROLLER_ROLE, owner.address);
        await raacGauge.grantRole(CONTROLLER_ROLE, owner.address);
        // gauges no longer have an EMERGENCY_ADMIN role; the controller pauses gauges
        // through its CONTROLLER_ROLE (granted in the gauge constructor)

        await raacToken.connect(owner).setMinter(owner.address);
        await raacToken.connect(owner).mint(owner.address, ethers.parseEther("10000000")); // RAACToken is capped at 21M now
        await raacToken.connect(owner).setMinter(await veToken.getAddress());

        await raacToken.connect(owner).transfer(user1.address, ethers.parseEther("1000000"));
        await raacToken.connect(owner).transfer(user2.address, ethers.parseEther("500000"));

        await raacToken.connect(user1).approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        await raacToken.connect(user2).approve(await veToken.getAddress(), ethers.parseEther("500000"));
        await veToken.connect(user1).lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);
        await veToken.connect(user2).lock(ethers.parseEther("500000"), MAX_LOCK_EPOCHS);

        const { periodStartTime: rwaPeriodStart } = await rwaGauge.getPeriodBoundaries();
        const { periodStartTime: raacPeriodStart } = await raacGauge.getPeriodBoundaries();
        const latestPeriodStart = rwaPeriodStart > raacPeriodStart ? rwaPeriodStart : raacPeriodStart;
        const currentTime = await time.latest();
        if (currentTime < latestPeriodStart) {
            await time.increaseTo(Number(latestPeriodStart));
        }
    });

    /* ═══════════════════════════════════════════════════════════
       DEPLOYMENT & INITIALIZATION
    ═══════════════════════════════════════════════════════════ */
    describe("Deployment & Initialization", () => {
        it("should set veToken correctly", async () => {
            expect(await gaugeController.veToken()).to.equal(await veToken.getAddress());
        });

        it("should grant DEFAULT_ADMIN_ROLE to deployer", async () => {
            const ADMIN_ROLE = await gaugeController.DEFAULT_ADMIN_ROLE();
            expect(await gaugeController.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("should expose correct constants", async () => {
            expect(await gaugeController.MAX_BOOST()).to.equal(25000);
            expect(await gaugeController.MIN_BOOST()).to.equal(10000);
            expect(await gaugeController.MAX_VOTE_WEIGHT()).to.equal(10000);
            expect(await gaugeController.WEIGHT_VOTE_DELAY()).to.equal(WEIGHT_VOTE_DELAY);
            expect(await gaugeController.WEEK()).to.equal(WEEK);
        });

        it("should register both test gauges as active", async () => {
            expect((await gaugeController.gauges(await rwaGauge.getAddress())).isActive).to.be.true;
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.true;
            expect((await gaugeController.gauges(await raacGauge.getAddress())).isActive).to.be.true;
            expect(await gaugeController.isGaugeActive(await raacGauge.getAddress())).to.be.true;
        });

        it("should initialise timeWeight for each gauge at deployment epoch", async () => {
            const tw = await gaugeController.timeWeight(await rwaGauge.getAddress());
            expect(tw).to.be.gt(0);
            // timeWeight should be <= current block timestamp (epoch-aligned)
            expect(tw).to.be.lte(await time.latest());
        });

        it("should initialise timeSum after first addGauge", async () => {
            expect(await gaugeController.timeSum()).to.be.gt(0);
        });

        it("should return correct getCurrentEpoch and getNextEpoch", async () => {
            const now = BigInt(await time.latest());
            const currentEpoch = await gaugeController.getCurrentEpoch();
            const nextEpoch = await gaugeController.getNextEpoch();
            expect(currentEpoch).to.equal((now / BigInt(WEEK)) * BigInt(WEEK));
            expect(nextEpoch).to.equal(currentEpoch + BigInt(WEEK));
        });
    });

    /* ═══════════════════════════════════════════════════════════
       GAUGE MANAGEMENT
    ═══════════════════════════════════════════════════════════ */
    describe("Gauge Management", () => {
        it("should revert addGauge for zero address", async () => {
            await expect(
                gaugeController.connect(gaugeAdmin).addGauge(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidGauge");
        });

        it("should revert addGauge for a duplicate gauge", async () => {
            // addGauge folds zero-address / paused / already-registered into one guard
            await expect(
                gaugeController.connect(gaugeAdmin).addGauge(await rwaGauge.getAddress())
            ).to.be.revertedWithCustomError(gaugeController, "InvalidGauge");
        });

        it("should revert addGauge when caller lacks GAUGE_ADMIN role", async () => {
            await expect(
                gaugeController.connect(user1).addGauge(await mockUSDC.getAddress())
            ).to.be.revertedWithCustomError(gaugeController, "AccessControlUnauthorizedAccount");
        });

        it("should emit GaugeAdded event", async () => {
            // Deploy a fresh gauge to add
            const RWAGauge = await ethers.getContractFactory("RWAGauge");
            const newGauge = await RWAGauge.deploy(
                await raacToken.getAddress(),
                await gaugeController.getAddress(),
                owner.address,
                await raacToken.getAddress(),
                await mockUSDC.getAddress(),
                await distributor.getAddress()
            );
            await newGauge.waitForDeployment();
            await expect(
                gaugeController.connect(gaugeAdmin).addGauge(await newGauge.getAddress())
            ).to.emit(gaugeController, "GaugeAdded").withArgs(await newGauge.getAddress());
        });

        it("removeGauge should deactivate the gauge (gauge record stays registered)", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            // The gauge record is retained (lastUpdateTime set) but the gauge is inactive
            const gauge = await gaugeController.gauges(await rwaGauge.getAddress());
            expect(gauge.lastUpdateTime).to.be.gt(0);
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.false;
        });

        it("removeGauge should remove gauge from active list", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            const [activeGauges] = await gaugeController.getActiveGauges();
            expect(activeGauges).to.not.include(await rwaGauge.getAddress());
        });

        it("removeGauge should deactivate an active gauge", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.false;
        });

        it("addGauge should reactivate a removed gauge", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            // addGauge rejects a re-add at the removal timestamp
            await time.increase(1);
            await gaugeController.connect(gaugeAdmin).addGauge(await rwaGauge.getAddress());
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.true;
        });

        it("addGauge should revert when re-adding a gauge at its removal timestamp", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            await hre.network.provider.send("evm_setNextBlockTimestamp", [await time.latest()]);
            await expect(
                gaugeController.connect(gaugeAdmin).addGauge(await rwaGauge.getAddress())
            ).to.be.revertedWithCustomError(gaugeController, "InvalidGauge");
        });

        it("setBoostAmplificationEnabled should update the flag", async () => {
            await gaugeController.connect(gaugeAdmin).setBoostAmplificationEnabled(
                await rwaGauge.getAddress(), false
            );
            const gauge = await gaugeController.gauges(await rwaGauge.getAddress());
            expect(gauge.isBoostAmplificationEnabled).to.be.false;
        });

        it("getActiveGauges should return both active gauges with weights", async () => {
            const [activeGauges, weights, total] = await gaugeController.getActiveGauges();
            expect(activeGauges.length).to.equal(2);
            expect(activeGauges).to.include(await rwaGauge.getAddress());
            expect(activeGauges).to.include(await raacGauge.getAddress());
            // No votes cast yet — all weights are 0
            expect(total).to.equal(0);
        });

        it("unknown addresses should not be registered as gauges", async () => {
            const gauge = await gaugeController.gauges(user1.address);
            expect(gauge.isActive).to.be.false;
            expect(gauge.lastUpdateTime).to.equal(0);
            expect(await gaugeController.isGaugeActive(user1.address)).to.be.false;
        });
    });

    /* ═══════════════════════════════════════════════════════════
       VOTE
    ═══════════════════════════════════════════════════════════ */
    describe("Vote", () => {
        it("should record voteUserSlopes correctly after a vote", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(slope.power).to.equal(5000);
            expect(slope.locked).to.be.gt(0);
            expect(slope.voteTs).to.be.closeTo(await time.latest(), 2);
            // The vote must be backed by locks expiring in the future
            const firstLockEntry = await gaugeController.voteUserLockEntries(user1.address, await rwaGauge.getAddress(), 0);
            expect(firstLockEntry.unlockTime).to.be.gt(await time.latest());
        });

        it("should add bias and locked amount to pointsWeight and pointsSum at nextEpoch", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const pw = await gaugeController.pointsWeight(await rwaGauge.getAddress(), nextEpoch);
            const ps = await gaugeController.pointsSum(nextEpoch);
            expect(pw.bias).to.be.gt(0);
            expect(pw.locked).to.be.gt(0);
            expect(ps.bias).to.equal(pw.bias);
            expect(ps.locked).to.equal(pw.locked);
        });

        it("should track voteUserPower for a single gauge", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 3000);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(3000);
        });

        it("should accumulate voteUserPower across multiple gauges", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 3000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 4000);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(7000);
        });

        it("should enforce WEIGHT_VOTE_DELAY cooldown per user per gauge", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            // Revoting the SAME gauge before the delay elapses reverts
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 1000)
            ).to.be.revertedWithCustomError(gaugeController, "VoteDelayNotElapsed");
            // The cooldown is per (user, gauge): voting a DIFFERENT gauge is allowed
            await expect(
                gaugeController.connect(user1).vote(await raacGauge.getAddress(), 1000)
            ).to.not.be.reverted;
        });

        it("should allow a second vote after the cooldown elapses", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await expect(
                gaugeController.connect(user1).vote(await raacGauge.getAddress(), 3000)
            ).to.not.be.reverted;
        });

        it("should replace old vote on revote and update voteUserPower", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 2000);
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(slope.power).to.equal(2000);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(2000);
        });

        it("should remove vote when weight is 0 and zero out voteUserPower", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 0);
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(slope.locked).to.equal(0);
            expect(slope.power).to.equal(0);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(0);
        });

        it("should revert when new vote would exceed MAX_VOTE_WEIGHT budget", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 6000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await expect(
                gaugeController.connect(user1).vote(await raacGauge.getAddress(), 5000)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidWeight");
        });

        it("should revert when voteWeight exceeds MAX_VOTE_WEIGHT (10000)", async () => {
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), WEIGHT_PRECISION + 1)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidWeight");
        });

        it("should revert when voting on an inactive gauge", async () => {
            await gaugeController.connect(gaugeAdmin).removeGauge(await rwaGauge.getAddress(), owner.address);
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000)
            ).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");
        });

        it("should revert when voting on an unknown gauge", async () => {
            await expect(
                gaugeController.connect(user1).vote(user2.address, 5000)
            ).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");
        });

        it("should revert when contract is paused", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(true);
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000)
            ).to.be.revertedWithCustomError(gaugeController, "EnforcedPause");
        });

        it("should add gauge to userVotedGauges on first vote", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const entry = await gaugeController.userVotedGauges(user1.address, 0);
            expect(entry).to.equal(await rwaGauge.getAddress());
        });

        it("should accumulate userVotedGauges across multiple gauges", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 3000);
            const g0 = await gaugeController.userVotedGauges(user1.address, 0);
            const g1 = await gaugeController.userVotedGauges(user1.address, 1);
            const voted = [g0, g1];
            expect(voted).to.include(await rwaGauge.getAddress());
            expect(voted).to.include(await raacGauge.getAddress());
        });

        it("should remove gauge from userVotedGauges on weight-0 vote", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 0);
            // Array is now empty; any index access should revert
            await expect(
                gaugeController.userVotedGauges(user1.address, 0)
            ).to.be.reverted;
        });

        it("should emit VoteWeightUpdated event", async () => {
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000)
            )
                .to.emit(gaugeController, "VoteWeightUpdated")
                .withArgs(user1.address, await rwaGauge.getAddress(), 5000, anyValue, anyValue);
        });

        it("should schedule changesWeight entries whose sum equals the committed locked amount", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const locks = await veToken.getLocks(user1.address);
            let totalScheduled = 0n;
            for (const lock of locks) {
                totalScheduled += await gaugeController.changesWeight(
                    await rwaGauge.getAddress(),
                    lock.unlockTime
                );
            }
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(totalScheduled).to.equal(slope.locked);
        });

        it("should schedule matching changesSum entries that equal the committed locked amount", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const locks = await veToken.getLocks(user1.address);
            let totalSum = 0n;
            for (const lock of locks) {
                totalSum += await gaugeController.changesSum(lock.unlockTime);
            }
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(totalSum).to.equal(slope.locked);
        });

        it("revote should correctly cancel old changesWeight entries before adding new", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const locksAfterVote1 = await veToken.getLocks(user1.address);
            const lockTime = locksAfterVote1[0].unlockTime;
            const changesBefore = await gaugeController.changesWeight(await rwaGauge.getAddress(), lockTime);

            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 2000);

            // Old locked amount removed, new one added; entry should reflect the new vote only
            const changesAfter = await gaugeController.changesWeight(await rwaGauge.getAddress(), lockTime);
            const newSlope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(changesAfter).to.equal(newSlope.locked);
        });

        it("should update lastVoteTime on each successful vote", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const ts = await time.latest();
            expect(
                await gaugeController.lastVoteTime(user1.address, await rwaGauge.getAddress())
            ).to.be.closeTo(ts, 2);
        });
    });

    describe("batchVote", () => {
        it("should revert when arrays have mismatched lengths", async () => {
            await expect(
                gaugeController.connect(user1).batchVote(
                    [await rwaGauge.getAddress()],
                    [5000, 3000]
                )
            ).to.be.revertedWithCustomError(gaugeController, "ArrayLengthMismatch");
        });

        it("should revert when array is empty", async () => {
            await expect(
                gaugeController.connect(user1).batchVote([], [])
            ).to.be.revertedWithCustomError(gaugeController, "ArrayLengthMismatch");
        });

        it("should revert when total weight exceeds MAX_VOTE_WEIGHT", async () => {
            await expect(
                gaugeController.connect(user1).batchVote(
                    [await rwaGauge.getAddress(), await raacGauge.getAddress()],
                    [6000, 5000]
                )
            ).to.be.revertedWithCustomError(gaugeController, "InvalidWeight");
        });

        it("should revert when contract is paused", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(true);
            await expect(
                gaugeController.connect(user1).batchVote(
                    [await rwaGauge.getAddress()],
                    [5000]
                )
            ).to.be.revertedWithCustomError(gaugeController, "EnforcedPause");
        });

        it("should revert when vote cooldown has not elapsed for a gauge in the batch", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 3000);
            // The cooldown is per (user, gauge): batching the SAME gauge too early reverts
            await expect(
                gaugeController.connect(user1).batchVote(
                    [await rwaGauge.getAddress()],
                    [3000]
                )
            ).to.be.revertedWithCustomError(gaugeController, "VoteDelayNotElapsed");
        });

        it("should apply votes to both gauges in a single call", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress(), await raacGauge.getAddress()],
                [6000, 4000]
            );
            const s1 = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            const s2 = await gaugeController.voteUserSlopes(user1.address, await raacGauge.getAddress());
            expect(s1.power).to.equal(6000);
            expect(s2.power).to.equal(4000);
        });

        it("should accumulate voteUserPower correctly across batch entries", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress(), await raacGauge.getAddress()],
                [3000, 2000]
            );
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(5000);
        });

        it("should set lastVoteTime after a successful batch", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress()],
                [5000]
            );
            const ts = await time.latest();
            expect(
                await gaugeController.lastVoteTime(user1.address, await rwaGauge.getAddress())
            ).to.be.closeTo(ts, 2);
        });

        it("should enforce a single cooldown window for the whole batch", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress(), await raacGauge.getAddress()],
                [5000, 3000]
            );
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await expect(
                gaugeController.connect(user1).batchVote(
                    [await rwaGauge.getAddress(), await raacGauge.getAddress()],
                    [4000, 2000]
                )
            ).to.not.be.reverted;
        });

        it("should behave identically to a single vote when given one entry", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress()],
                [7000]
            );
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(slope.power).to.equal(7000);
            expect(slope.locked).to.be.gt(0);
        });

        it("two independent users should have independent batch cooldowns", async () => {
            await gaugeController.connect(user1).batchVote(
                [await rwaGauge.getAddress()],
                [5000]
            );
            await expect(
                gaugeController.connect(user2).batchVote(
                    [await rwaGauge.getAddress()],
                    [3000]
                )
            ).to.not.be.reverted;
        });
    });

    /* ═══════════════════════════════════════════════════════════
       KICK
    ═══════════════════════════════════════════════════════════ */
    describe("Kick", () => {
        it("should revert when the user is not in ragequit cooldown", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await expect(
                gaugeController.connect(owner).kick(user1.address)
            ).to.be.revertedWithCustomError(gaugeController, "UserStillHasPower");
        });

        it("should revert kick when contract is paused", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(true);
            await expect(
                gaugeController.connect(owner).kick(user1.address)
            ).to.be.revertedWithCustomError(gaugeController, "EnforcedPause");
        });

        it("should succeed and clear all vote state via ragequit (early exit)", async () => {
            // user1 votes, then ragequits all locks — balance drops to 0 while lock end is still future.
            // This is the correct path for kick(): changesWeight entries survive because
            // _getWeight has not reached the still-future unlockTime.
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);

            // ragequitAll() exits all locks early; user forfeits some RAAC but ve-balance drops to 0.
            await time.increase(1); // mainnet blocks cannot share a timestamp with the lock checkpoint
            await veToken.connect(user1).ragequitAll();
            expect(await veToken.balanceOf(user1.address)).to.equal(0);

            await expect(
                gaugeController.connect(owner).kick(user1.address)
            ).to.not.be.reverted;

            // All per-gauge state cleared
            const slope = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            expect(slope.locked).to.equal(0);
            expect(slope.power).to.equal(0);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(0);
            await expect(gaugeController.userVotedGauges(user1.address, 0)).to.be.reverted;
        });

        it("should emit VotesKicked with correct gauge count", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 3000);

            await veToken.connect(user1).ragequitAll();

            await expect(gaugeController.connect(owner).kick(user1.address))
                .to.emit(gaugeController, "VotesKicked")
                .withArgs(user1.address, 2);
        });

        it("should be idempotent — second kick on same user is a no-op", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await veToken.connect(user1).ragequitAll();

            await gaugeController.connect(owner).kick(user1.address);
            // Power already 0 after first kick; second kick should succeed without error
            await expect(gaugeController.connect(owner).kick(user1.address)).to.not.be.reverted;
        });

        it("should cancel changesWeight entries so future _getWeight is not double-reduced", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            // Snapshot locks before ragequit clears them
            const locks = await veToken.getLocks(user1.address);
            const unlockTime = locks[0].unlockTime;

            const changesBefore = await gaugeController.changesWeight(await rwaGauge.getAddress(), unlockTime);
            expect(changesBefore).to.be.gt(0);

            await time.increase(1); // mainnet blocks cannot share a timestamp with the lock checkpoint
            await veToken.connect(user1).ragequitAll();
            await gaugeController.connect(owner).kick(user1.address);

            const changesAfter = await gaugeController.changesWeight(await rwaGauge.getAddress(), unlockTime);
            expect(changesAfter).to.equal(0);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       RELATIVE WEIGHT
    ═══════════════════════════════════════════════════════════ */
    describe("Relative Weight", () => {
        it("should return 0 when no votes have been cast", async () => {
            const epoch = await gaugeController.getCurrentEpoch();
            const [relWeight, totalWeight] = await gaugeController.getGaugeRelativeWeightView(
                await rwaGauge.getAddress(), epoch
            );
            expect(relWeight).to.equal(0);
            expect(totalWeight).to.equal(0);
        });

        it("should return 1e18 (100%) when only one gauge has all votes", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relWeight] = await gaugeController.getGaugeRelativeWeightView(
                await rwaGauge.getAddress(), nextEpoch
            );
            expect(relWeight).to.equal(ethers.parseEther("1"));
        });

        it("should split weight proportionally between two gauges", async () => {
            // user1 (1M locked) → rwaGauge 100%, user2 (500k locked) → raacGauge 100%
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            await gaugeController.connect(user2).vote(await raacGauge.getAddress(), 10000);

            const nextEpoch = await gaugeController.getNextEpoch();
            const [rwaW] = await gaugeController.getGaugeRelativeWeightView(await rwaGauge.getAddress(), nextEpoch);
            const [raacW] = await gaugeController.getGaugeRelativeWeightView(await raacGauge.getAddress(), nextEpoch);

            // Weights must sum to 100% (within rounding)
            expect(rwaW + raacW).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.001"));
            // user1 locked 2x more so rwaGauge gets the larger share
            expect(rwaW).to.be.gt(raacW);
        });

        it("getGaugeRelativeWeight (state-modifying) should match view variant at same epoch", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const nextEpoch = await gaugeController.getNextEpoch();

            const [viewWeight, viewTotal] = await gaugeController.getGaugeRelativeWeightView(
                await rwaGauge.getAddress(), nextEpoch
            );
            const [stateWeight, stateTotal] = await gaugeController.getGaugeRelativeWeight.staticCall(
                await rwaGauge.getAddress(), nextEpoch
            );
            expect(stateWeight).to.equal(viewWeight);
            expect(stateTotal).to.equal(viewTotal);
        });

        it("should return 0 relative weight for an unknown gauge (view)", async () => {
            // An unknown gauge has no checkpoint history, so its projected weight is always 0
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relWeight] = await gaugeController.getGaugeRelativeWeightView(user1.address, nextEpoch);
            expect(relWeight).to.equal(0);
        });

        it("getGaugeRelativeWeight should revert for the zero address and return 0 for an unknown gauge", async () => {
            const epoch = await gaugeController.getCurrentEpoch();
            await expect(
                gaugeController.getGaugeRelativeWeight(ethers.ZeroAddress, epoch)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidGauge");

            // Unknown (but non-zero) gauge accrues no weight
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relWeight] = await gaugeController.getGaugeRelativeWeight.staticCall(user1.address, nextEpoch);
            expect(relWeight).to.equal(0);
        });

        it("should return 0 for raacGauge when no votes were cast on it", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relWeight] = await gaugeController.getGaugeRelativeWeightView(
                await raacGauge.getAddress(), nextEpoch
            );
            expect(relWeight).to.equal(0);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       CHECKPOINTING
    ═══════════════════════════════════════════════════════════ */
    describe("Checkpointing", () => {
        it("forceCompleteCheckpoint() should advance timeWeight for each active gauge", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEEK * 3);

            await gaugeController.forceCompleteCheckpoint(await rwaGauge.getAddress());
            await gaugeController.forceCompleteCheckpoint(await raacGauge.getAddress());

            const currentEpoch = await gaugeController.getCurrentEpoch();
            const twRwa = await gaugeController.timeWeight(await rwaGauge.getAddress());
            const twRaac = await gaugeController.timeWeight(await raacGauge.getAddress());
            expect(twRwa).to.be.gte(currentEpoch);
            expect(twRaac).to.be.gte(currentEpoch);
        });

        it("forceCompleteCheckpoint() should return true for a valid gauge", async () => {
            const result = await gaugeController.forceCompleteCheckpoint.staticCall(
                await rwaGauge.getAddress()
            );
            expect(result).to.be.true;
        });

        it("forceCompleteCheckpoint() with address(0) should revert (only active gauges)", async () => {
            await expect(
                gaugeController.forceCompleteCheckpoint(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");
        });

        it("forceCompleteCheckpoint() should revert for an unknown non-zero address", async () => {
            await expect(
                gaugeController.forceCompleteCheckpoint(user1.address)
            ).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");
        });

        it("weight should decay over time after a vote (bias decreases week by week)", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const nextEpoch = await gaugeController.getNextEpoch();

            // Snapshot bias at nextEpoch right after vote
            const ptAtNext = await gaugeController.pointsWeight(await rwaGauge.getAddress(), nextEpoch);

            // Advance 5 weeks and checkpoint
            await time.increase(WEEK * 5);
            await gaugeController.forceCompleteCheckpoint(await rwaGauge.getAddress());

            const currentEpoch = await gaugeController.getCurrentEpoch();
            const ptNow = await gaugeController.pointsWeight(await rwaGauge.getAddress(), currentEpoch);

            // Bias should have decayed
            expect(ptNow.bias).to.be.lt(ptAtNext.bias);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       VOTE POWER REMAINING
    ═══════════════════════════════════════════════════════════ */
    describe("getUserVotePowerRemaining", () => {
        it("should return MAX_VOTE_WEIGHT when user has not voted", async () => {
            expect(await gaugeController.getUserVotePowerRemaining(user1.address)).to.equal(WEIGHT_PRECISION);
        });

        it("should decrease after voting", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 3000);
            expect(await gaugeController.getUserVotePowerRemaining(user1.address)).to.equal(7000);
        });

        it("should return 0 when all power is allocated", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 10000);
            expect(await gaugeController.getUserVotePowerRemaining(user1.address)).to.equal(0);
        });

        it("should increase again after removing a vote", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 0);
            expect(await gaugeController.getUserVotePowerRemaining(user1.address)).to.equal(WEIGHT_PRECISION);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       WEIGHT MANAGEMENT (existing, enhanced)
    ═══════════════════════════════════════════════════════════ */
    describe("Weight Management", () => {
        it("should return 0 weight before any votes", async () => {
            const weight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            expect(weight).to.equal(0);
        });

        it("getGaugeWeight should reflect weight after vote + checkpoint", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await gaugeController.forceCompleteCheckpoint(await rwaGauge.getAddress());
            const weight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            expect(weight).to.be.gt(0);
        });

        it("getTotalWeight should be at least as large as any single gauge weight", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await gaugeController.forceCompleteCheckpoint(await rwaGauge.getAddress());
            const total = await gaugeController.getTotalWeight();
            const gaugeW = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            expect(total).to.be.gte(gaugeW);
        });

        it("should respect maximum vote weight limits", async () => {
            await expect(
                gaugeController.connect(user1).vote(await rwaGauge.getAddress(), WEIGHT_PRECISION + 1)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidWeight");
        });

        it("relative weight should be 1e18 when only one gauge has votes", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [weight] = await gaugeController.getGaugeRelativeWeightView(
                await rwaGauge.getAddress(), nextEpoch
            );
            expect(weight).to.equal(ethers.parseEther("1"));
        });
    });

    /* ═══════════════════════════════════════════════════════════
       PERIOD MANAGEMENT
    ═══════════════════════════════════════════════════════════ */
    describe("Period Management", () => {
        beforeEach(async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await raacGauge.getAddress(), 5000);
            await time.increase(WEEK);
        });

        it("should handle RWA monthly periods", async () => {
            const periodDuration = await rwaGauge.periodDuration();
            const TWO_WEEKS = 14 * DAY;
            expect(periodDuration).to.equal(TWO_WEEKS);
            const { periodStartTime, periodEndTime } = await rwaGauge.getPeriodBoundaries();
            expect(periodEndTime - periodStartTime).to.equal(BigInt(TWO_WEEKS));
        });

        it("should handle RAAC weekly periods", async () => {
            const periodDuration = await raacGauge.periodDuration();
            expect(periodDuration).to.equal(WEEK);
            const { periodStartTime, periodEndTime } = await raacGauge.getPeriodBoundaries();
            expect(periodEndTime - periodStartTime).to.equal(BigInt(WEEK));
        });
    });

    /* ═══════════════════════════════════════════════════════════
       EMERGENCY CONTROLS
    ═══════════════════════════════════════════════════════════ */
    describe("Emergency Controls", () => {
        it("should pause the contract", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(true);
            expect(await gaugeController.paused()).to.be.true;
        });

        it("should unpause the contract", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(true);
            await gaugeController.connect(emergencyAdmin).setEmergencyPause(false);
            expect(await gaugeController.paused()).to.be.false;
        });

        it("should revert setEmergencyPause when caller lacks EMERGENCY_ADMIN", async () => {
            await expect(
                gaugeController.connect(user1).setEmergencyPause(true)
            ).to.be.revertedWithCustomError(gaugeController, "AccessControlUnauthorizedAccount");
        });

        it("setEmergencyGaugePause should pause the gauge without deactivating it", async () => {
            await gaugeController.connect(emergencyAdmin).setEmergencyGaugePause(await rwaGauge.getAddress(), true);
            expect(await rwaGauge.paused()).to.be.true;
            // pausing is non-destructive: the gauge stays registered, active and counted
            expect(await gaugeController.isGaugeActive(await rwaGauge.getAddress())).to.be.true;
            expect(await gaugeController.activeGaugeCount()).to.equal(2);
        });

        it("setEmergencyGaugePause should revert for an unknown gauge", async () => {
            // pausing requires a registered gauge; unregistered -> InvalidGauge
            await expect(
                gaugeController.connect(emergencyAdmin).setEmergencyGaugePause(user1.address, true)
            ).to.be.revertedWithCustomError(gaugeController, "InvalidGauge");
        });

        it("should revert setEmergencyGaugePause when caller lacks EMERGENCY_ADMIN", async () => {
            await expect(
                gaugeController.connect(user1).setEmergencyGaugePause(await rwaGauge.getAddress(), true)
            ).to.be.revertedWithCustomError(gaugeController, "AccessControlUnauthorizedAccount");
        });

        it("should emit EmergencyGaugePauseUpdated event", async () => {
            await expect(
                gaugeController.connect(emergencyAdmin).setEmergencyGaugePause(await rwaGauge.getAddress(), true)
            )
                .to.emit(gaugeController, "EmergencyGaugePauseUpdated")
                .withArgs(await rwaGauge.getAddress(), true, emergencyAdmin.address);
        });

        it("should emit EmergencyPauseUpdated on pause and unpause", async () => {
            await expect(gaugeController.connect(emergencyAdmin).setEmergencyPause(true))
                .to.emit(gaugeController, "EmergencyPauseUpdated")
                .withArgs(true);
            await expect(gaugeController.connect(emergencyAdmin).setEmergencyPause(false))
                .to.emit(gaugeController, "EmergencyPauseUpdated")
                .withArgs(false);
        });
    });

    describe("claimRewardsFor", () => {
        it("should revert when caller lacks DISTRIBUTOR_ROLE", async () => {
            await expect(
                rwaGauge.connect(user1).claimRewardsFor(user2.address)
            ).to.be.revertedWithCustomError(rwaGauge, "AccessControlUnauthorizedAccount");
        });

        it("should revert for zero address user", async () => {
            // claimRewardsFor is gated by DISTRIBUTOR_ROLE (normally held by the rewards
            // distributor contract); grant it to owner to exercise the zero-address check
            const DISTRIBUTOR_ROLE = await rwaGauge.DISTRIBUTOR_ROLE();
            await rwaGauge.connect(owner).grantRole(DISTRIBUTOR_ROLE, owner.address);
            await expect(
                rwaGauge.connect(owner).claimRewardsFor(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(rwaGauge, "InvalidAddress");
        });

        it("should not revert for a user with no staked balance (no-op)", async () => {
            const DISTRIBUTOR_ROLE = await rwaGauge.DISTRIBUTOR_ROLE();
            await rwaGauge.connect(owner).grantRole(DISTRIBUTOR_ROLE, owner.address);
            // user1 has nothing staked — should be a no-op
            await expect(
                rwaGauge.connect(owner).claimRewardsFor(user1.address)
            ).to.not.be.reverted;
        });
    });


    describe("Integration Tests", () => {
        beforeEach(async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 5000);
        });

        it("should integrate with veRAAC voting power via voteUserSlopes", async () => {
            const voteData = await gaugeController.voteUserSlopes(
                user1.address,
                await rwaGauge.getAddress()
            );
            expect(voteData.power).to.equal(5000);
            expect(voteData.locked).to.be.gt(0);
            // The committed locked amount must be half (5000 bps) of user1's total lock
            const locks = await veToken.getLocks(user1.address);
            let totalLocked = 0n;
            for (const lock of locks) totalLocked += lock.amount;
            expect(voteData.locked).to.equal(totalLocked / 2n);
            // The vote is backed by locks that expire in the future
            const firstLockEntry = await gaugeController.voteUserLockEntries(user1.address, await rwaGauge.getAddress(), 0);
            expect(firstLockEntry.unlockTime).to.be.gt(await time.latest());
        });

        it("should handle boost calculations for a staked user with veToken", async () => {
            await raacToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
            await raacToken.connect(user1).approve(await rwaGauge.getAddress(), ethers.parseEther("100"));
            await rwaGauge.connect(user1).stake(ethers.parseEther("100"));

            const amount = ethers.parseEther("100");
            const [boost, boostedAmount] = await gaugeController.calculateBoost(
                user1.address,
                await rwaGauge.getAddress(),
                amount
            );
            expect(boost).to.be.gt(10000);
            expect(boost).to.be.lte(25000);
            // Boosted amount is normalized by MAX_BOOST (Curve-style working balance):
            // boostedAmount = amount * boost / MAX_BOOST, so it exceeds the un-boosted
            // working amount (amount * MIN_BOOST / MAX_BOOST = 0.4x) but never `amount` itself
            expect(boostedAmount).to.equal((amount * boost) / 25000n);
            expect(boostedAmount).to.be.gt((amount * 10000n) / 25000n);
            expect(boostedAmount).to.be.lte(amount);
        });

        it("two independent users should have independent vote cooldowns", async () => {
            // user2 has not voted yet, so it should not be affected by user1's cooldown
            await expect(
                gaugeController.connect(user2).vote(await rwaGauge.getAddress(), 3000)
            ).to.not.be.reverted;
        });

        it("full vote lifecycle: vote → revote → remove", async () => {
            // Check initial power usage
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(5000);

            // Revote after cooldown
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 8000);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(8000);

            // Remove vote
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 0);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(0);

            // After removal, relative weight should be 0 at next epoch
            const nextEpoch = await gaugeController.getNextEpoch();
            const [w] = await gaugeController.getGaugeRelativeWeightView(await rwaGauge.getAddress(), nextEpoch);
            expect(w).to.equal(0);
        });

        it("two voters: combined weights at nextEpoch should reflect both slopes", async () => {
            await time.increase(WEIGHT_VOTE_DELAY + 1);
            await gaugeController.connect(user2).vote(await rwaGauge.getAddress(), 5000);

            const nextEpoch = await gaugeController.getNextEpoch();
            const ps = await gaugeController.pointsSum(nextEpoch);
            const pw = await gaugeController.pointsWeight(await rwaGauge.getAddress(), nextEpoch);

            // Both users voted the same gauge → sum bias should track gauge bias. The per-gauge
            // decay rounds up while the sum floors, so the sum (the denominator of relative
            // weight) is never below the gauge bias: a gauge's share can only be understated,
            // never overstated, so no one can over-claim. They agree up to that rounding dust.
            expect(ps.bias).to.be.gte(pw.bias);
            expect(ps.bias - pw.bias).to.be.lte(100n);

            // Combined locked amount should be the sum of both users' committed locked amounts
            const s1 = await gaugeController.voteUserSlopes(user1.address, await rwaGauge.getAddress());
            const s2 = await gaugeController.voteUserSlopes(user2.address, await rwaGauge.getAddress());
            expect(pw.locked).to.equal(s1.locked + s2.locked);
        });
    });
});
