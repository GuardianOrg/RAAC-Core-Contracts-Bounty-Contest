import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("GaugeRewardsDistributor", function () {
    let distributor;
    let gaugeController;
    let rwaGauge;
    let raacGauge;
    let raacToken;
    let veToken;
    let mockUSDC;
    let owner;
    let user1;
    let user2;

    const DAY = 24 * 60 * 60;

    const WEEK = 7 * 24 * 60 * 60;
    const YEAR = 365 * 24 * 60 * 60;
    const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // raw units
    const REWARD_AMOUNT = ethers.parseEther("10000");

    const MAX_LOCK_EPOCHS = 52; // GaugeController requires maxLockEpochs * epochDuration == 52 weeks

    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();

        const raacTokenFactory = await ethers.getContractFactory("RAACToken");
        raacToken = await raacTokenFactory.deploy(owner.address);
        await raacToken.waitForDeployment();

        // VeRAACToken requires linked libraries
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        const lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const ragequitLib = await RagequitLibFactory.deploy();
        await ragequitLib.waitForDeployment();

        const PowerCheckpointLib = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const powerCheckpointLib = await PowerCheckpointLib.deploy();
        await powerCheckpointLib.waitForDeployment();

        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        const veTokenFactory = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target,
            },
        });
        veToken = await veTokenFactory.deploy(
            await raacToken.getAddress(),
            owner.address,
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

        const rewardsDistributorFactory = await ethers.getContractFactory("GaugeRewardsDistributor");
        distributor = await rewardsDistributorFactory.deploy(
            await gaugeController.getAddress(),
            await mockUSDC.getAddress()
        );
        await distributor.waitForDeployment();

        await gaugeController.setDistributor(await distributor.getAddress());

        const RWAGauge = await ethers.getContractFactory("RWAGauge");
        rwaGauge = await RWAGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,                        // mock liquid locker
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await distributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        const RAACGauge = await ethers.getContractFactory("RAACGauge");
        raacGauge = await RAACGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,                        // mock liquid locker
            await raacToken.getAddress(),
            await mockUSDC.getAddress(),
            await distributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        // addGauge requires GAUGE_ADMIN role
        const GAUGE_ADMIN = await gaugeController.GAUGE_ADMIN();
        await gaugeController.grantRole(GAUGE_ADMIN, owner.address);
        await gaugeController.connect(owner).addGauge(await rwaGauge.getAddress());
        await gaugeController.connect(owner).addGauge(await raacGauge.getAddress());

        const CONTROLLER_ROLE = await rwaGauge.CONTROLLER_ROLE();
        await rwaGauge.grantRole(CONTROLLER_ROLE, owner.address);
        await raacGauge.grantRole(CONTROLLER_ROLE, owner.address);

        await raacToken.connect(owner).setMinter(owner.address);
        await raacToken.connect(owner).mint(owner.address, ethers.parseEther("10000000")); // capped at 21M
        await raacToken.connect(owner).setMinter(await veToken.getAddress());

        await mockUSDC.connect(owner).approve(await distributor.getAddress(), REWARD_AMOUNT * 10n);

        const DISTRIBUTOR_ADMIN = await distributor.DISTRIBUTOR_ADMIN();
        await distributor.grantRole(DISTRIBUTOR_ADMIN, owner.address);
    });

    // Gives user1 ve power and an active vote on `gauge` (votes register at the NEXT
    // weekly epoch, so we advance one week before depositing).
    async function voteAndActivate(gauge, amount = ethers.parseEther("100000")) {
        await raacToken.connect(owner).setMinter(owner.address);
        await raacToken.connect(owner).mint(user1.address, amount);
        await raacToken.connect(owner).setMinter(await veToken.getAddress());
        await raacToken.connect(user1).approve(await veToken.getAddress(), amount);
        await veToken.connect(user1).lock(amount, MAX_LOCK_EPOCHS);
        await gaugeController.connect(user1).vote(await gauge.getAddress(), 10000);
        await time.increase(WEEK);
    }

    describe("Initialization", function () {
        it("should initialize with correct state", async function () {
            expect(await distributor.gaugeController()).to.equal(await gaugeController.getAddress());
            expect(await distributor.rewardToken()).to.equal(await mockUSDC.getAddress());
            expect(await distributor.DISTRIBUTOR_ADMIN()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("DISTRIBUTOR_ADMIN")));
        });

        it("should align a gauge's lastClaimedEpoch on an epoch boundary", async function () {
            // the global startEpoch is gone: addGauge bootstraps a per-gauge claim checkpoint
            const lastClaimedEpoch = await distributor.lastClaimedEpoch(await rwaGauge.getAddress());
            expect(lastClaimedEpoch).to.be.gt(0n);
            expect(lastClaimedEpoch % BigInt(WEEK)).to.equal(0n);
        });

        it("should fail to initialize with zero address controller", async function () {
            const RewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
            await expect(
                RewardsDistributor.deploy(ethers.ZeroAddress, await mockUSDC.getAddress())
            ).to.be.revertedWithCustomError(distributor, "InvalidAddress");
        });

        it("should fail to initialize with zero address reward token", async function () {
            const RewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
            await expect(
                RewardsDistributor.deploy(await gaugeController.getAddress(), ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(distributor, "InvalidAddress");
        });
    });

    describe("Reward Token Configuration", function () {
        it("should only accept deposits of the configured reward token", async function () {
            const MockUSDC2 = await ethers.getContractFactory("MockUSDC");
            const mockUSDC2 = await MockUSDC2.deploy(ethers.parseEther("1000000"));
            await mockUSDC2.waitForDeployment();
            await mockUSDC2.approve(await distributor.getAddress(), REWARD_AMOUNT);
            await expect(
                distributor.deposit(await mockUSDC2.getAddress(), REWARD_AMOUNT)
            ).to.be.revertedWithCustomError(distributor, "TokenNotApproved");
        });

        it("should let DISTRIBUTOR_ADMIN toggle the max claim bound", async function () {
            await expect(distributor.setMaxClaimBound(true))
                .to.emit(distributor, "MaxClaimBoundUpdated")
                .withArgs(true);
            expect(await distributor.enableMaxClaimBound()).to.be.true;
        });

        it("should revert setMaxClaimBound for non-admin", async function () {
            await expect(
                distributor.connect(user1).setMaxClaimBound(true)
            ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
        });
    });

    describe("Reward Distribution", function () {
        it("should handle deposit", async function () {
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            const distributorBalance = await mockUSDC.balanceOf(await distributor.getAddress());
            expect(distributorBalance).to.equal(REWARD_AMOUNT);

            const { totalDeposited } = await distributor.getRewardTokenInfo();
            expect(totalDeposited).to.equal(REWARD_AMOUNT);
        });

        it("should handle multiple deposits", async function () {
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            await time.increase(WEEK / 2);

            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            const { totalDeposited } = await distributor.getRewardTokenInfo();
            expect(totalDeposited).to.equal(REWARD_AMOUNT * 2n);
        });

        it("should provide balance info correctly", async function () {
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            const { balance } = await distributor.getRewardTokenInfo();
            expect(balance).to.equal(REWARD_AMOUNT);
        });

        it("should emit RewardDeposited event with the deposit epoch", async function () {
            const currentEpoch = await gaugeController.getCurrentEpoch();
            await expect(distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT))
                .to.emit(distributor, "RewardDeposited")
                .withArgs(await mockUSDC.getAddress(), owner.address, REWARD_AMOUNT, currentEpoch);
        });

        it("should record deposit in the correct epoch bucket", async function () {
            const currentEpoch = await gaugeController.getCurrentEpoch();
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            expect(await distributor.depositedAtEpoch(await mockUSDC.getAddress(), currentEpoch)).to.equal(REWARD_AMOUNT);
        });

        it("should accumulate totalClaimable across multiple deposits", async function () {
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            const { totalClaimable } = await distributor.getRewardTokenInfo();
            expect(totalClaimable).to.equal(REWARD_AMOUNT * 2n);
        });
    });

    describe("Miscs", function () {
        it("should handle zero reward amount", async function () {
            await expect(
                distributor.deposit(await mockUSDC.getAddress(), 0)
            ).to.be.revertedWithCustomError(distributor, "InvalidAmount");
        });

        it("should handle non-approved reward token", async function () {
            const randomToken = ethers.Wallet.createRandom().address;
            await expect(
                distributor.deposit(randomToken, REWARD_AMOUNT)
            ).to.be.revertedWithCustomError(distributor, "TokenNotApproved");
        });
    });

    /* ═══════════════════════════════════════════════════════════
       claimAll
    ═══════════════════════════════════════════════════════════ */
    describe("claimAll", function () {
        const STAKE_AMOUNT = ethers.parseEther("10000");

        beforeEach(async function () {
            // Mint user1 RAAC for staking (voteAndActivate mints the lock amount)
            await raacToken.connect(owner).setMinter(owner.address);
            await raacToken.connect(owner).mint(user1.address, STAKE_AMOUNT);
            await raacToken.connect(owner).setMinter(await veToken.getAddress());

            // Advance to gauge period start so staking is allowed
            const { periodStartTime } = await rwaGauge.getPeriodBoundaries();
            const currentTime = await time.latest();
            if (currentTime < periodStartTime) {
                await time.increaseTo(Number(periodStartTime));
            }

            // Vote for rwaGauge and wait for the vote to activate
            await voteAndActivate(rwaGauge);

            // Stake, then stream a deposit into the gauge
            await raacToken.connect(user1).approve(await rwaGauge.getAddress(), STAKE_AMOUNT);
            await rwaGauge.connect(user1).stake(STAKE_AMOUNT);

            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await rwaGauge.pullRewardsFromDistributor();

            // Let rewards accrue for the staker
            await time.increase(WEEK);
        });

        it("should revert for an unregistered gauge", async function () {
            const fake = ethers.Wallet.createRandom().address;
            await expect(
                distributor.connect(user1).claimAll([fake])
            ).to.be.revertedWithCustomError(distributor, "GaugeNotActive");
        });

        it("should succeed with an empty array (no-op)", async function () {
            await expect(
                distributor.connect(user1).claimAll([])
            ).to.not.be.reverted;
        });

        it("should transfer accrued rewards from gauge to the caller", async function () {
            const balanceBefore = await mockUSDC.balanceOf(user1.address);
            await distributor.connect(user1).claimAll([await rwaGauge.getAddress()]);
            const balanceAfter = await mockUSDC.balanceOf(user1.address);
            expect(balanceAfter).to.be.gt(balanceBefore);
        });

        it("should claim from multiple gauges in a single call", async function () {
            // Deploy a second rwaGauge and wire it up
            const RWAGauge = await ethers.getContractFactory("RWAGauge");
            const rwaGauge2 = await RWAGauge.deploy(
                await raacToken.getAddress(),
                await gaugeController.getAddress(),
                owner.address,
                await raacToken.getAddress(),
                await mockUSDC.getAddress(),
                await distributor.getAddress()
            );
            await rwaGauge2.waitForDeployment();

            await gaugeController.connect(owner).addGauge(await rwaGauge2.getAddress());

            // claimAll across both gauges — user1 staked only in rwaGauge, rwaGauge2 is a no-op
            const balanceBefore = await mockUSDC.balanceOf(user1.address);
            await distributor.connect(user1).claimAll([
                await rwaGauge.getAddress(),
                await rwaGauge2.getAddress(),
            ]);
            const balanceAfter = await mockUSDC.balanceOf(user1.address);
            expect(balanceAfter).to.be.gt(balanceBefore);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       claimForGauge (pull-based: only the gauge itself may call)
    ═══════════════════════════════════════════════════════════ */
    describe("claimForGauge", function () {
        beforeEach(async function () {
            // the gauge only starts at the next Thursday boundary after deployment
            const { periodStartTime } = await rwaGauge.getPeriodBoundaries();
            if ((await time.latest()) < periodStartTime) {
                await time.increaseTo(Number(periodStartTime));
            }
        });

        it("should revert when the caller is not the gauge itself", async function () {
            await expect(
                distributor.claimForGauge(await rwaGauge.getAddress())
            ).to.be.revertedWithCustomError(distributor, "Unauthorized");
        });

        it("should revert for an unregistered gauge address", async function () {
            const fake = ethers.Wallet.createRandom().address;
            await expect(
                distributor.claimForGauge(fake)
            ).to.be.revertedWithCustomError(distributor, "Unauthorized");
        });

        it("should return 0 and not revert when no deposits exist", async function () {
            await time.increase(WEEK);
            const claimed = await rwaGauge.pullRewardsFromDistributor.staticCall();
            expect(claimed).to.equal(0);
        });

        it("should return 0 when gauge has no voting weight", async function () {
            // Deposit rewards but no one votes → gauge weight is 0
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await time.increase(WEEK);

            const claimed = await rwaGauge.pullRewardsFromDistributor.staticCall();
            expect(claimed).to.equal(0);
        });

        it("should transfer gauge's proportional share when it has weight", async function () {
            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            const gaugeBefore = await mockUSDC.balanceOf(await rwaGauge.getAddress());
            await rwaGauge.pullRewardsFromDistributor();
            const gaugeAfter = await mockUSDC.balanceOf(await rwaGauge.getAddress());

            expect(gaugeAfter).to.be.gt(gaugeBefore);
        });

        it("should emit RewardTransferred when tokens are sent", async function () {
            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            await expect(
                rwaGauge.pullRewardsFromDistributor()
            ).to.emit(distributor, "RewardTransferred");
        });

        it("should advance lastClaimedEpoch to currentEpoch after a call", async function () {
            const currentEpoch = await gaugeController.getCurrentEpoch();
            await rwaGauge.pullRewardsFromDistributor();
            expect(
                await distributor.lastClaimedEpoch(await rwaGauge.getAddress())
            ).to.equal(currentEpoch);
        });

        it("should not re-claim already processed epochs on a second call", async function () {
            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            // First claim captures the deposit
            await rwaGauge.pullRewardsFromDistributor();
            const gaugeBalanceAfterFirst = await mockUSDC.balanceOf(await rwaGauge.getAddress());
            expect(gaugeBalanceAfterFirst).to.be.gt(0n);

            // Second call in the same epoch — no new deposits, should send 0
            const secondClaimed = await rwaGauge.pullRewardsFromDistributor.staticCall();
            expect(secondClaimed).to.equal(0);
            const gaugeBalanceAfterSecond = await mockUSDC.balanceOf(await rwaGauge.getAddress());
            expect(gaugeBalanceAfterSecond).to.equal(gaugeBalanceAfterFirst);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       getClaimableForGauge
    ═══════════════════════════════════════════════════════════ */
    describe("getClaimableForGauge", function () {
        it("should return 0 when no deposits exist", async function () {
            expect(
                await distributor.getClaimableForGauge(await rwaGauge.getAddress())
            ).to.equal(0);
        });

        it("should return 0 when gauge has no voting weight", async function () {
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await time.increase(WEEK);
            expect(
                await distributor.getClaimableForGauge(await rwaGauge.getAddress())
            ).to.equal(0);
        });

        it("should return a positive amount when gauge has weight and deposits exist", async function () {
            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            expect(
                await distributor.getClaimableForGauge(await rwaGauge.getAddress())
            ).to.be.gt(0);
        });

        it("should match the amount actually pulled at the same epoch", async function () {
            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);

            const viewClaimable = await distributor.getClaimableForGauge(await rwaGauge.getAddress());
            const stateClaimed = await rwaGauge.pullRewardsFromDistributor.staticCall();
            expect(viewClaimable).to.equal(stateClaimed);
        });
    });

    /* ═══════════════════════════════════════════════════════════
       Dust sweeping: deposits no gauge will ever claim, i.e. epochs
       with zero total vote weight plus relative-weight truncation
    ═══════════════════════════════════════════════════════════ */
    describe("withdrawDust", function () {
        beforeEach(async function () {
            // Deposit while nobody has voted, then let every registered gauge walk past that
            // epoch: with zero total weight nothing is claimable, so the whole deposit stays
            // behind as dust. The sweep only covers epochs below the minimum lastClaimedEpoch
            // across registered gauges, so both gauges have to advance, not just one.
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await time.increase(WEEK);
            await rwaGauge.pullRewardsFromDistributor();
            await raacGauge.pullRewardsFromDistributor();
        });

        it("should transfer a zero-weight epoch's deposit to the recipient", async function () {
            const balanceBefore = await mockUSDC.balanceOf(user2.address);
            await expect(distributor.withdrawDust(user2.address))
                .to.emit(distributor, "DustWithdrawn")
                .withArgs(user2.address, await mockUSDC.getAddress(), REWARD_AMOUNT);
            const balanceAfter = await mockUSDC.balanceOf(user2.address);
            expect(balanceAfter - balanceBefore).to.equal(REWARD_AMOUNT);
        });

        it("should revert when caller lacks DEFAULT_ADMIN_ROLE", async function () {
            await expect(
                distributor.connect(user1).withdrawDust(user1.address)
            ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
        });

        it("should reject a zero address recipient", async function () {
            // withdrawDust has no explicit InvalidAddress guard; the ERC20 transfer rejects it.
            await expect(distributor.withdrawDust(ethers.ZeroAddress)).to.be.reverted;
        });

        it("should not pay out the same zero-weight deposit twice", async function () {
            const distributorBefore = await mockUSDC.balanceOf(await distributor.getAddress());
            await distributor.withdrawDust(user2.address);
            expect(await mockUSDC.balanceOf(await distributor.getAddress()))
                .to.equal(distributorBefore - REWARD_AMOUNT);

            // The cursor has caught up with the minimum lastClaimedEpoch: nothing left to sweep.
            await expect(
                distributor.withdrawDust(user2.address)
            ).to.be.revertedWithCustomError(distributor, "Unauthorized");
        });

        it("should not sweep an epoch until every registered gauge has settled it", async function () {
            await distributor.withdrawDust(user2.address);

            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            await time.increase(WEEK);
            await rwaGauge.pullRewardsFromDistributor();

            // raacGauge still points at the deposit epoch, so that epoch is not sweepable yet.
            await expect(
                distributor.withdrawDust(user2.address)
            ).to.be.revertedWithCustomError(distributor, "Unauthorized");

            await raacGauge.pullRewardsFromDistributor();

            const balanceBefore = await mockUSDC.balanceOf(user2.address);
            await distributor.withdrawDust(user2.address);
            const balanceAfter = await mockUSDC.balanceOf(user2.address);
            expect(balanceAfter - balanceBefore).to.equal(REWARD_AMOUNT);
        });

        it("should not sweep an entitlement a voting gauge has already claimed", async function () {
            await distributor.withdrawDust(user2.address);

            await voteAndActivate(rwaGauge);
            await distributor.deposit(await mockUSDC.getAddress(), REWARD_AMOUNT);
            const claimed = await rwaGauge.pullRewardsFromDistributor.staticCall();
            await rwaGauge.pullRewardsFromDistributor();
            expect(claimed).to.be.gt(0);

            await time.increase(WEEK);
            await rwaGauge.pullRewardsFromDistributor();
            await raacGauge.pullRewardsFromDistributor();

            const balanceBefore = await mockUSDC.balanceOf(user2.address);
            await distributor.withdrawDust(user2.address);
            const balanceAfter = await mockUSDC.balanceOf(user2.address);
            expect(balanceAfter - balanceBefore).to.equal(REWARD_AMOUNT - claimed);
        });
    });

});
