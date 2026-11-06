import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("RWAGauge", () => {
    let rwaGauge;
    let gaugeController;
    let veToken;
    let raacToken;
    let rewardToken;
    let owner;
    let user1;
    let user2;
    let emergencyAdmin;

    const TWO_WEEKS = 14 * 24 * 3600;
    const WEEK = 7 * 24 * 3600;
    const WEIGHT_PRECISION = 10000;
    const DAY = 24 * 3600;
    const MAX_LOCK_EPOCHS = 52; // GaugeController requires maxLockEpochs * epochDuration == 52 weeks

    let snapshotId;
    let INIT_TIME;
    beforeEach(async () => {
        snapshotId = await network.provider.send('evm_snapshot');

        [owner, user1, user2, emergencyAdmin] = await ethers.getSigners();

        INIT_TIME = await time.latest();
        const RaacToken = await ethers.getContractFactory("RAACToken");
        raacToken = await RaacToken.deploy(owner.address);
        await raacToken.waitForDeployment();

        // VeRAACToken requires linked libraries (LockManager first, everything links it)
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        const lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment();

        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target }
        });
        const ragequitLib = await RagequitLibFactory.deploy();
        await ragequitLib.waitForDeployment();

        const PowerCheckpointLib = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target }
        });
        const powerCheckpointLib = await PowerCheckpointLib.deploy();
        await powerCheckpointLib.waitForDeployment();

        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target }
        });
        const rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        const VeToken = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target
            }
        });
        veToken = await VeToken.deploy(await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veToken.waitForDeployment();

        // Minter role
        await raacToken.setMinter(owner.address);

        // Deploy reward token (using USDC mock for testing)
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

        const RWAGauge = await ethers.getContractFactory("RWAGauge");
        rwaGauge = await RWAGauge.deploy(
            await raacToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,                       
            await raacToken.getAddress(),
            await rewardToken.getAddress(),
            await distributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        // Get current time and ensure we're moving to a future period
        const currentTime = BigInt(await time.latest());
        const periodDuration = await rwaGauge.periodDuration();
        const nextPeriodStart = ((currentTime / periodDuration) + 2n) * periodDuration;

        // Move to next period start
        await time.increaseTo(Number(nextPeriodStart));

        // Setup initial token balances (RAACToken is capped at 21M)
        await raacToken.mint(owner.address, ethers.parseEther("10000000"));
        await raacToken.mint(user1.address, ethers.parseEther("1000000"));
        await raacToken.mint(user2.address, ethers.parseEther("500000"));
        await rewardToken.mint(owner.address, ethers.parseEther("1000000"));

        // Setup veToken balances by locking RAAC (locks are now in epochs)
        await raacToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);

        await raacToken.connect(user1).approve(await veToken.getAddress(), ethers.parseEther("100000"));
        await veToken.connect(user1).lock(ethers.parseEther("100000"), MAX_LOCK_EPOCHS);

        await raacToken.connect(user2).approve(await veToken.getAddress(), ethers.parseEther("50000"));
        await veToken.connect(user2).lock(ethers.parseEther("50000"), MAX_LOCK_EPOCHS);

        // Transfer rewards to gauge
        await rewardToken.connect(owner).transfer(rwaGauge.getAddress(), ethers.parseEther("100000"));

        // Setup roles and initial state + add gauge
        const CONTROLLER_ROLE = await rwaGauge.CONTROLLER_ROLE();
        await rwaGauge.grantRole(CONTROLLER_ROLE, owner.address);
        await rwaGauge.grantRole(CONTROLLER_ROLE, await gaugeController.getAddress());
        await gaugeController.grantRole(await gaugeController.GAUGE_ADMIN(), owner.address);
        await gaugeController.addGauge(await rwaGauge.getAddress());

        // Move to period start time
        const { periodStartTime } = await rwaGauge.getPeriodBoundaries();
        const currentTimeNow = await time.latest();
        if (currentTimeNow < periodStartTime) {
            await time.increaseTo(Number(periodStartTime));
        }
    });

    describe("Initialization", () => {
        it("should initialize with correct state", async () => {
            const gaugeData = await rwaGauge.gaugeData();
            expect(gaugeData.gaugeInitialStartTime).to.closeTo(INIT_TIME, 7 * DAY);
            expect(gaugeData.periodDuration).to.equal(TWO_WEEKS);
            expect(gaugeData.periodIndex).to.equal(0);
            expect(gaugeData.stakingToken).to.equal(await raacToken.getAddress());
            expect(gaugeData.rewardToken).to.equal(await rewardToken.getAddress());
            const controllerGauge = await gaugeController.gauges(await rwaGauge.getAddress());
            expect(controllerGauge.isBoostAmplificationEnabled).to.be.true;
            expect(gaugeData.totalSupply).to.equal(0);
            expect(gaugeData.workingSupply).to.equal(0);
            expect(gaugeData.lastUpdateTime).to.closeTo(INIT_TIME, 100);
        });

        it("should verify period boundaries", async () => {
            const { periodStartTime, periodEndTime } = await rwaGauge.getPeriodBoundaries();
            expect(periodStartTime).to.be.gt(0);
            expect(periodEndTime).to.be.gt(periodStartTime);
            expect(periodEndTime - periodStartTime).to.equal(BigInt(TWO_WEEKS));
        });
    });

    afterEach(async () => {
        await network.provider.send('evm_revert', [snapshotId]);
    });

    describe("Weight Voting", () => {
        beforeEach(async () => {
            const { periodEndTime } = await rwaGauge.getPeriodBoundaries();
            const nextPeriodTime = Number(periodEndTime) + 1;
            const currentTime = await time.latest();

            if (currentTime < nextPeriodTime) {
                await time.increaseTo(nextPeriodTime);
            }

            await time.increase(DAY);
        });

        it("should handle weight voting through controller", async () => {
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 2500); // 25%

            const user1Power = await veToken.balanceOf(user1.address);
            const weight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            expect(weight).to.be.gt(0n);
            expect(weight).to.be.closeTo(user1Power / 4n, user1Power * 3n / 100n);
        });

        it("should respect voting power in weight votes", async () => {
            // User1 and User2 vote with different voting power
            await gaugeController.connect(user1).vote(await rwaGauge.getAddress(), 2500); // 25%
            await gaugeController.connect(user2).vote(await rwaGauge.getAddress(), 2500); // 25%

            // User1 locked twice as much as user2 for the same duration
            const user1Power = await veToken.balanceOf(user1.address);
            const user2Power = await veToken.balanceOf(user2.address);
            expect(user1Power).to.be.gt(user2Power);
            expect(user1Power).to.be.closeTo(user2Power * 2n, user2Power / 100n);

            const combined = user1Power + user2Power;
            const gaugeWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            expect(gaugeWeight).to.be.gt(0n);
            expect(gaugeWeight).to.be.closeTo(combined / 4n, combined * 3n / 100n);
        });
    });

    describe("Period Management", () => {
        it("should handle monthly period transitions", async () => {
            const { periodStartTime, periodEndTime } = await rwaGauge.getPeriodBoundaries();
            const periodDuration = BigInt(await rwaGauge.periodDuration());

            // RWAGauge uses 14 days
            const expectedDuration = TWO_WEEKS;
            expect(periodDuration).to.equal(expectedDuration);


            expect(periodEndTime).to.be.gt(periodStartTime);
            expect(periodEndTime - periodStartTime).to.equal(periodDuration);
        });

        it("should have correct period duration", async () => {
            const periodDuration = await rwaGauge.periodDuration();
            expect(periodDuration).to.equal(TWO_WEEKS);
        });
    });
    describe("Emergency Controls", () => {
        it("should handle emergency pause", async () => {
            // pausing now goes through CONTROLLER_ROLE (the gauge has no EMERGENCY_ADMIN role)
            const CONTROLLER_ROLE = await rwaGauge.CONTROLLER_ROLE();
            await rwaGauge.grantRole(CONTROLLER_ROLE, emergencyAdmin.address);
            await rwaGauge.connect(emergencyAdmin).setEmergencyPaused(true);

            // Try to stake while paused which will fail
            const stakeAmount = ethers.parseEther("100");
            await raacToken.mint(user1.address, stakeAmount);
            await raacToken.connect(user1).approve(await rwaGauge.getAddress(), stakeAmount);

            await expect(
                rwaGauge.connect(user1).stake(stakeAmount)
            ).to.be.revertedWithCustomError(rwaGauge, "EnforcedPause");
        });
    });

    describe("Staking Functionality", () => {
        beforeEach(async () => {
            await raacToken.mint(user1.address, ethers.parseEther("1000"));
            await raacToken.mint(user2.address, ethers.parseEther("1000"));

            await raacToken.connect(user1).approve(rwaGauge.getAddress(), ethers.MaxUint256);
            await raacToken.connect(user2).approve(rwaGauge.getAddress(), ethers.MaxUint256);
        });

        it("should handle stake correctly", async () => {
            await rwaGauge.connect(user1).stake(ethers.parseEther("100"));
            // rawBalanceOf = actual staked amount
            const rawBalance = await rwaGauge.rawBalanceOf(user1.address);
            expect(rawBalance).to.equal(ethers.parseEther("100"));

            // balanceOf = working balance with boost
            const balance = await rwaGauge.balanceOf(user1.address);
            expect(balance).to.equal(ethers.parseEther("45.216"));
        });

        it("should handle withdraw correctly", async () => {
            await rwaGauge.connect(user1).stake(ethers.parseEther("100"));
            await rwaGauge.connect(user1).withdraw(ethers.parseEther("50"));

            const rawBalance = await rwaGauge.rawBalanceOf(user1.address);
            expect(rawBalance).to.equal(ethers.parseEther("50"));

            const balance = await rwaGauge.balanceOf(user1.address);
            expect(balance).to.equal(ethers.parseEther("22.608"));
        });

        it("should prevent withdrawing more than staked", async () => {
            await rwaGauge.connect(user1).stake(ethers.parseEther("100"));
            await expect(
                rwaGauge.connect(user1).withdraw(ethers.parseEther("101"))
            ).to.be.revertedWithCustomError(rwaGauge, "InsufficientStakedBalance");
        });
    });
});
