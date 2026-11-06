import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const DAY = 24 * 3600;
const WEEK = 7 * DAY;
const MAX_LOCK_EPOCHS = 52;
const INITIAL_SUPPLY = ethers.parseEther("1000000000");

/**
 * The gauge pause redesign: three gauge states (Active, Paused, Removed) and one global switch,
 * where a gauge operates only when both switches are off and neither switch can alter the other.
 *
 * Covers the decision tree and the invariants it rests on, plus the addGauge / removeGauge
 * bookkeeping and the meaning of isGaugeActive now that "active" means "registered".
 */
describe("Gauge pause redesign", () => {
    let owner, gaugeAdmin, emergencyAdmin, user1, user2, staker, treasury;
    let raacToken, veToken, mockUSDC, gaugeController, distributor, gaugeA, gaugeB, A, B;
    let deployGauge;

    const STAKE = ethers.parseEther("1000");
    const usdc = (n) => ethers.parseUnits(n, 6);

    /**
     * Controller, distributor and two gauges (A = RWA/28d, B = RAAC/7d), two veRAAC voters, one
     * plain staker and a treasury. Both gauges stake RAAC and are rewarded in mockUSDC, which is
     * also the distributor's reward token, so pulls and claims can be exercised end to end.
     */
    beforeEach(async () => {
        [owner, gaugeAdmin, emergencyAdmin, user1, user2, staker, treasury] = await ethers.getSigners();

        raacToken = await (await ethers.getContractFactory("RAACToken")).deploy(owner.address);

        const lockManagerLib = await (await ethers.getContractFactory("LockManager")).deploy();
        const libs = { LockManager: lockManagerLib.target };
        const ragequitLib = await (await ethers.getContractFactory("RagequitLib", { libraries: libs })).deploy();
        const powerCheckpointLib = await (await ethers.getContractFactory("PowerCheckpoint", { libraries: libs })).deploy();
        const rewardLib = await (await ethers.getContractFactory("RewardLib", { libraries: libs })).deploy();
        const libraries = {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target,
        };

        veToken = await (await ethers.getContractFactory("VeRAACToken", { libraries })).deploy(
            await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS
        );
        await raacToken.setMinter(await veToken.getAddress());

        mockUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy(INITIAL_SUPPLY);

        gaugeController = await (await ethers.getContractFactory("GaugeController")).deploy(await veToken.getAddress());
        distributor = await (await ethers.getContractFactory("GaugeRewardsDistributor")).deploy(
            await gaugeController.getAddress(), await mockUSDC.getAddress()
        );
        await gaugeController.setDistributor(await distributor.getAddress());

        deployGauge = async (kind) => (await ethers.getContractFactory(kind)).deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address, // liquid locker stand-in: holds CLAIM_FOR_ROLE and is NotKickable
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await distributor.getAddress()
        );

        gaugeA = await deployGauge("RWAGauge");
        gaugeB = await deployGauge("RAACGauge");
        A = await gaugeA.getAddress();
        B = await gaugeB.getAddress();

        await gaugeController.grantRole(await gaugeController.GAUGE_ADMIN(), gaugeAdmin.address);
        await gaugeController.grantRole(await gaugeController.EMERGENCY_ADMIN(), emergencyAdmin.address);
        await gaugeController.connect(gaugeAdmin).addGauge(A);
        await gaugeController.connect(gaugeAdmin).addGauge(B);

        await raacToken.connect(owner).setMinter(owner.address);
        await raacToken.connect(owner).mint(owner.address, ethers.parseEther("10000000"));
        await raacToken.connect(owner).setMinter(await veToken.getAddress());

        for (const [who, amount] of [[user1, "1000000"], [user2, "500000"], [staker, "100000"]]) {
            await raacToken.connect(owner).transfer(who.address, ethers.parseEther(amount));
        }
        for (const who of [user1, user2]) {
            await raacToken.connect(who).approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        }
        await veToken.connect(user1).lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);
        await veToken.connect(user2).lock(ethers.parseEther("500000"), MAX_LOCK_EPOCHS);

        await raacToken.connect(staker).approve(A, ethers.parseEther("100000"));
        await raacToken.connect(staker).approve(B, ethers.parseEther("100000"));
        await mockUSDC.connect(owner).approve(await distributor.getAddress(), INITIAL_SUPPLY);

        // Both gauges must have started before stake and claim are callable.
        const { periodStartTime: sA } = await gaugeA.getPeriodBoundaries();
        const { periodStartTime: sB } = await gaugeB.getPeriodBoundaries();
        const latest = sA > sB ? sA : sB;
        if ((await time.latest()) < Number(latest)) await time.increaseTo(Number(latest));
    });

    const pauseGauge = (addr, on) => gaugeController.connect(emergencyAdmin).setEmergencyGaugePause(addr, on);
    const pauseAll = (on) => gaugeController.connect(emergencyAdmin).setEmergencyPause(on);
    const deposit = (n) => distributor.connect(owner).deposit(mockUSDC.target, usdc(n));
    const removeGauge = (addr) => gaugeController.connect(gaugeAdmin).removeGauge(addr, treasury.address);

    async function addExtraGauge() {
        const g = await deployGauge("RAACGauge");
        const addr = await g.getAddress();
        await gaugeController.connect(gaugeAdmin).addGauge(addr);
        return addr;
    }

    async function voteBoth() {
        await gaugeController.connect(user1).vote(A, 5000);
        await gaugeController.connect(user1).vote(B, 5000);
        await time.increase(WEEK);
    }

    async function stakeAndFund() {
        await voteBoth();
        await gaugeA.connect(staker).stake(STAKE);
        await deposit("1000");
        await time.increase(WEEK);
        await gaugeA.pullRewardsFromDistributor();
        await time.increase(2 * DAY); // let some of the stream accrue to the staker
    }

    /* ═══════════════════════════════════════════════════════════
       Registry: addGauge, removeGauge and what "active" now means
    ═══════════════════════════════════════════════════════════ */
    describe("gauge registry", () => {
        it("removing the middle gauge keeps the list and index map consistent", async () => {
            const C = await addExtraGauge();
            expect(await gaugeController.activeGaugeCount()).to.equal(3);

            await removeGauge(B);
            const list = [...(await gaugeController.getRegisteredGaugeList())];
            expect(list.length).to.equal(2);
            expect(list).to.have.members([A, C]);
            expect(await gaugeController.activeGaugeCount()).to.equal(2);
            expect(await gaugeController.isGaugeActive(B)).to.be.false;

            // the gauge swapped into B's slot must still be removable (index map fixed up)
            await removeGauge(C);
            expect([...(await gaugeController.getRegisteredGaugeList())]).to.deep.equal([A]);
            await removeGauge(A);
            expect(await gaugeController.activeGaugeCount()).to.equal(0);
        });

        it("a paused gauge stays active, registered and counted", async () => {
            await pauseGauge(A, true);
            expect(await gaugeA.isPaused()).to.be.true;
            expect(await gaugeController.isGaugeActive(A)).to.be.true;
            expect((await gaugeController.gauges(A)).isActive).to.be.true;
            expect(await gaugeController.activeGaugeCount()).to.equal(2);
            expect([...(await gaugeController.getRegisteredGaugeList())]).to.have.members([A, B]);
        });

        it("addGauge rejects an already registered gauge", async () => {
            await expect(gaugeController.connect(gaugeAdmin).addGauge(A))
                .to.be.revertedWithCustomError(gaugeController, "InvalidGauge");
        });
    });

    /* ═══════════════════════════════════════════════════════════
       What users can do in each combination of the two switches
    ═══════════════════════════════════════════════════════════ */
    describe("state matrix", () => {
        beforeEach(stakeAndFund);

        it("controller running + gauge running: everything works", async () => {
            await expect(gaugeA.connect(staker).stake(STAKE)).to.not.be.reverted;
            await expect(gaugeA.connect(staker).claimRewardToken()).to.not.be.reverted;
            await expect(gaugeA.updateUserRewards(staker.address)).to.not.be.reverted;
            await expect(gaugeController.connect(user2).vote(A, 3000)).to.not.be.reverted;
            await expect(gaugeA.connect(staker).withdraw(STAKE)).to.not.be.reverted;
        });

        it("controller running + gauge paused: withdraw and vote(g,0) only", async () => {
            await gaugeController.connect(user2).vote(A, 3000);
            await pauseGauge(A, true);

            await expect(gaugeA.connect(staker).stake(STAKE)).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.connect(staker).claimRewardToken()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.pullRewardsFromDistributor()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.updateUserRewards(staker.address)).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.connect(staker).claimExtraRewards()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeController.connect(user1).vote(A, 4000)).to.be.revertedWithCustomError(gaugeController, "GaugePaused");
            // a paused gauge was never kicked, so this is not the exit for one
            await expect(gaugeController.connect(user2).removePowerFromGauge(A)).to.be.revertedWithCustomError(gaugeController, "ActiveGauge");

            await time.increase(11 * DAY);
            await expect(gaugeController.connect(user2).vote(A, 0)).to.not.be.reverted;
            await expect(gaugeA.connect(staker).withdraw(STAKE)).to.not.be.reverted;
        });

        it("controller running + gauge removed: withdraw, claim what is already in the gauge, free power", async () => {
            await gaugeController.connect(user2).vote(A, 3000);
            await removeGauge(A);

            await expect(gaugeA.connect(staker).stake(STAKE)).to.be.revertedWithCustomError(gaugeA, "GaugeNotActive");
            await expect(gaugeController.connect(user1).vote(A, 4000)).to.be.revertedWithCustomError(gaugeController, "GaugeNotActive");

            const before = await mockUSDC.balanceOf(staker.address);
            await expect(gaugeA.connect(staker).claimRewardToken()).to.not.be.reverted;
            expect(await mockUSDC.balanceOf(staker.address)).to.be.gt(before);

            await expect(gaugeController.connect(user2).removePowerFromGauge(A)).to.not.be.reverted;
            await expect(gaugeA.connect(staker).withdraw(STAKE)).to.not.be.reverted;
        });

        it("controller paused: withdraw only, in all three gauge states", async () => {
            await pauseAll(true);

            // gauge running
            await expect(gaugeA.connect(staker).stake(STAKE)).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.connect(staker).claimRewardToken()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeController.connect(user2).vote(A, 3000)).to.be.revertedWithCustomError(gaugeController, "EnforcedPause");
            await expect(gaugeA.connect(staker).withdraw(STAKE / 4n)).to.not.be.reverted;

            // gauge paused as well
            await pauseGauge(A, true);
            await expect(gaugeA.connect(staker).claimRewardToken()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeA.connect(staker).withdraw(STAKE / 4n)).to.not.be.reverted;

            // gauge removed (removeGauge is not pause-gated)
            await removeGauge(A);
            await expect(gaugeA.connect(staker).withdraw(STAKE / 4n)).to.not.be.reverted;
        });

        it("withdraw is never blocked, in every combination", async () => {
            const slice = STAKE / 8n;
            await gaugeA.connect(staker).withdraw(slice); // active, controller running
            await pauseGauge(A, true);
            await gaugeA.connect(staker).withdraw(slice); // gauge paused
            await pauseAll(true);
            await gaugeA.connect(staker).withdraw(slice); // both paused
            await pauseGauge(A, false);
            await gaugeA.connect(staker).withdraw(slice); // controller paused only
            await pauseAll(false);
            await removeGauge(A);
            await gaugeA.connect(staker).withdraw(slice); // removed
            expect(await gaugeA.rawBalanceOf(staker.address)).to.equal(STAKE - 5n * slice);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Branch A: global pause
    ═══════════════════════════════════════════════════════════ */
    describe("A. global pause", () => {
        it("is O(1): the same gas whether 2 or 12 gauges are registered", async () => {
            const small = await (await pauseAll(true)).wait();
            await pauseAll(false);

            for (let i = 0; i < 10; i++) await addExtraGauge();
            expect(await gaugeController.activeGaugeCount()).to.equal(12);

            const large = await (await pauseAll(true)).wait();
            expect(large.gasUsed - small.gasUsed).to.be.lt(1000n);
        });

        it("changes no gauge state: votes, weights, activity and per-gauge switches all survive", async () => {
            await voteBoth();
            const nextEpoch = await gaugeController.getNextEpoch();
            const weightBefore = await gaugeController.pointsWeight(A, nextEpoch);
            const sumBefore = await gaugeController.pointsSum(nextEpoch);
            const relBefore = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);

            await pauseAll(true);

            expect(await gaugeController.isGaugeActive(A)).to.be.true;
            expect(await gaugeController.isGaugeActive(B)).to.be.true;
            expect(await gaugeA.isPaused()).to.be.false;
            expect(await gaugeB.isPaused()).to.be.false;
            expect(await gaugeController.activeGaugeCount()).to.equal(2);
            expect(await gaugeController.pointsWeight(A, nextEpoch)).to.deep.equal(weightBefore);
            expect(await gaugeController.pointsSum(nextEpoch)).to.deep.equal(sumBefore);

            await pauseAll(false);
            expect(await gaugeController.getGaugeRelativeWeightView(A, nextEpoch)).to.deep.equal(relBefore);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(10000n);
        });

        it("deposits keep accumulating and removeGauge stays callable while globally paused", async () => {
            await voteBoth();
            await pauseAll(true);

            await expect(deposit("1000")).to.not.be.reverted;
            const epoch = await gaugeController.getCurrentEpoch();
            expect(await distributor.depositedAtEpoch(mockUSDC.target, epoch)).to.equal(usdc("1000"));

            await expect(removeGauge(A)).to.not.be.reverted;
            expect(await gaugeController.isGaugeActive(A)).to.be.false;
        });

        it("gauges can still be paused and unpaused individually during a global pause", async () => {
            await pauseAll(true);
            await expect(pauseGauge(A, true)).to.not.be.reverted;
            expect(await gaugeA.isPaused()).to.be.true;
            await expect(pauseGauge(A, false)).to.not.be.reverted;
            expect(await gaugeA.isPaused()).to.be.false;
            expect(await gaugeController.paused()).to.be.true;
        });

        it("global unpause resumes everything except individually paused gauges", async () => {
            await voteBoth();
            await gaugeB.connect(staker).stake(STAKE);
            await pauseAll(true);
            await pauseGauge(A, true);
            await pauseAll(false);

            expect(await gaugeA.isPaused()).to.be.true;
            await expect(gaugeA.connect(staker).stake(STAKE)).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(gaugeB.connect(staker).stake(STAKE)).to.not.be.reverted;
            await expect(gaugeController.connect(user2).vote(B, 3000)).to.not.be.reverted;
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Branch B: per-gauge pause
    ═══════════════════════════════════════════════════════════ */
    describe("B. per-gauge pause", () => {
        it("leaves other gauges untouched", async () => {
            await voteBoth();
            await pauseGauge(A, true);

            await expect(gaugeB.connect(staker).stake(STAKE)).to.not.be.reverted;
            await expect(gaugeB.pullRewardsFromDistributor()).to.not.be.reverted;
            await expect(gaugeController.connect(user2).vote(B, 3000)).to.not.be.reverted;
        });

        it("holds the paused gauge's share, and nobody can force it to claim", async () => {
            await voteBoth();
            await deposit("1000");
            await time.increase(WEEK);

            await pauseGauge(A, true);
            await deposit("1000");
            await time.increase(WEEK);

            await expect(gaugeA.pullRewardsFromDistributor()).to.be.revertedWithCustomError(gaugeA, "EnforcedPause");
            await expect(distributor.connect(owner).claimForGauge(A)).to.be.revertedWithCustomError(distributor, "Unauthorized");

            const held = await distributor.getClaimableForGauge(A);
            expect(held).to.be.gt(0);
            expect(await mockUSDC.balanceOf(A)).to.equal(0);

            await pauseGauge(A, false);
            await gaugeA.pullRewardsFromDistributor();
            expect(await mockUSDC.balanceOf(A)).to.be.closeTo(held, usdc("1"));
        });

        it("keeps accruing its own share without inflating the other gauge", async () => {
            await voteBoth();
            await deposit("1000");
            await time.increase(WEEK);
            const bFirst = await distributor.getClaimableForGauge(B);

            await pauseGauge(A, true);
            await deposit("1000");
            await time.increase(WEEK);

            const aAfter = await distributor.getClaimableForGauge(A);
            const bSecond = await distributor.getClaimableForGauge(B);
            // B earned its own half of the second deposit, not A's share on top of it
            expect(bSecond - bFirst).to.be.closeTo(bFirst, usdc("5"));
            expect(aAfter).to.be.gt(usdc("900"));
        });

        it("makes withdrawDust wait, and removal releases it", async () => {
            await voteBoth();
            await deposit("1000");
            await time.increase(WEEK);
            await gaugeB.pullRewardsFromDistributor();
            await pauseGauge(A, true);
            await time.increase(WEEK);

            // gauge A can never advance its pointer while paused, so the sweep stays pinned
            const pinned = await distributor.lastClaimedEpoch(A);
            await expect(distributor.connect(owner).withdrawDust(treasury.address))
                .to.be.revertedWithCustomError(distributor, "Unauthorized");
            expect(await distributor.lastClaimedEpoch(A)).to.equal(pinned);

            await removeGauge(A);
            await expect(distributor.connect(owner).withdrawDust(treasury.address)).to.not.be.reverted;
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Branch C: retiring or removing a gauge
    ═══════════════════════════════════════════════════════════ */
    describe("C. retiring a gauge", () => {
        it("unpause, pull, then remove: stakers keep what they earned and the rest takes over the weight", async () => {
            await stakeAndFund();
            await pauseGauge(A, true);
            await time.increase(WEEK);

            // the retirement proposal: unpause, pull the backlog for the stakers, then remove
            await pauseGauge(A, false);
            await gaugeA.pullRewardsFromDistributor();
            expect(await mockUSDC.balanceOf(A)).to.be.gt(0);

            await removeGauge(A);

            // the staker still collects from the gauge afterwards
            const before = await mockUSDC.balanceOf(staker.address);
            await gaugeA.connect(staker).claimRewardToken();
            expect(await mockUSDC.balanceOf(staker.address)).to.be.gt(before);

            // and the surviving gauge takes the whole weight from the next epoch
            await time.increase(WEEK);
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relB] = await gaugeController.getGaugeRelativeWeightView(B, nextEpoch);
            expect(relB).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.001"));
        });

        it("removing a paused gauge redirects exactly its held share to the recipient", async () => {
            await voteBoth();
            await deposit("1000");
            await time.increase(WEEK);
            await pauseGauge(A, true);
            await deposit("1000");
            await time.increase(WEEK);

            const held = await distributor.getClaimableForGauge(A);
            await removeGauge(A);
            expect(await mockUSDC.balanceOf(treasury.address)).to.be.closeTo(held, usdc("1"));
            expect(await distributor.getClaimableForGauge(A)).to.equal(0);
        });

        it("voters free their power with removePowerFromGauge once it is removed", async () => {
            await voteBoth();
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(10000n);
            await removeGauge(A);
            await gaugeController.connect(user1).removePowerFromGauge(A);
            expect(await gaugeController.voteUserPower(user1.address)).to.equal(5000n);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Branch D: bringing a removed gauge back
    ═══════════════════════════════════════════════════════════ */
    describe("D. re-adding a removed gauge", () => {
        it("requires it to be unpaused first, then starts from fresh votes", async () => {
            await voteBoth();
            await pauseGauge(A, true);
            await removeGauge(A);
            // move past the removal timestamp so the revert below comes from the pause, not the same-block guard
            await time.increase(1);

            await expect(gaugeController.connect(gaugeAdmin).addGauge(A))
                .to.be.revertedWithCustomError(gaugeController, "InvalidGauge");

            await pauseGauge(A, false); // unpausing a removed gauge is allowed, so it is never stranded
            await gaugeController.connect(gaugeAdmin).addGauge(A);

            const nextEpoch = await gaugeController.getNextEpoch();
            const [relA] = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);
            expect(relA).to.equal(0);

            await gaugeController.connect(user2).vote(A, 5000);
            await time.increase(WEEK);
            const later = await gaugeController.getNextEpoch();
            const [relAfter] = await gaugeController.getGaugeRelativeWeightView(A, later);
            expect(relAfter).to.be.gt(0);
        });

        it("accrues nothing while removed and cannot re-claim the epochs settled at removal", async () => {
            await voteBoth();
            await deposit("1000");
            await time.increase(WEEK);

            await removeGauge(A);
            expect(await mockUSDC.balanceOf(treasury.address)).to.be.gt(0);

            // idle weeks while removed: no entitlement may accrue
            await deposit("1000");
            await time.increase(2 * WEEK);
            expect(await distributor.getClaimableForGauge(A)).to.equal(0);

            await gaugeController.connect(gaugeAdmin).addGauge(A);
            expect(await distributor.getClaimableForGauge(A)).to.equal(0);
            await expect(gaugeA.pullRewardsFromDistributor()).to.not.be.reverted;
            expect(await mockUSDC.balanceOf(A)).to.equal(0);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Invariants the tree rests on
    ═══════════════════════════════════════════════════════════ */
    describe("invariants", () => {
        it("the two switches are independent in both directions", async () => {
            await pauseGauge(A, true);
            await pauseAll(true);
            await pauseAll(false);
            expect(await gaugeA.isPaused()).to.be.true; // global unpause did not clear the gauge switch

            await pauseAll(true);
            await pauseGauge(A, false);
            expect(await gaugeController.paused()).to.be.true; // gauge unpause did not clear the global switch
        });

        it("inactive is reachable only through removeGauge, and removal always kicks", async () => {
            await voteBoth();
            await pauseGauge(A, true);
            expect(await gaugeController.isGaugeActive(A)).to.be.true;
            await pauseAll(true);
            expect(await gaugeController.isGaugeActive(A)).to.be.true;
            await pauseAll(false);

            const nextEpoch = await gaugeController.getNextEpoch();
            const [relBefore] = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);
            expect(relBefore).to.be.gt(0);

            await removeGauge(A);
            expect(await gaugeController.isGaugeActive(A)).to.be.false;
            expect((await gaugeController.pointsWeight(A, nextEpoch)).bias).to.equal(0);
            const [relAfter] = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);
            expect(relAfter).to.equal(0);
        });

        it("a pause never destroys votes: the paused gauge keeps its exact share", async () => {
            await voteBoth();
            const nextEpoch = await gaugeController.getNextEpoch();
            const [relBefore] = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);

            await pauseGauge(A, true);
            const [relAfter] = await gaugeController.getGaugeRelativeWeightView(A, nextEpoch);
            expect(relAfter).to.equal(relBefore);
            expect(relAfter).to.be.closeTo(ethers.parseEther("0.5"), ethers.parseEther("0.01"));
        });
    });
});
