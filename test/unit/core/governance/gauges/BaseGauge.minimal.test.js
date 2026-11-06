import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

// Smallest possible test case for BaseGauge + distributor + controller.
describe("BaseGauge minimal case", () => {
    let gaugeController, distributor, gauge1, gauge2;
    let stakingToken, veToken, rewardToken;
    let ragequitLib, powerCheckpointLib, lockManagerLib, libraries;
    let owner, user1;

    const DAY = 24 * 3600;
    const WEEK = 7 * DAY;

    const REWARD_AMOUNT = ethers.parseEther("1000");
    const STAKE_AMOUNT = ethers.parseEther("100");
    const MAX_LOCK_EPOCHS = 52;
    beforeEach(async () => {
        [owner, user1] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        rewardToken = await MockToken.deploy("Reward A", "RWA", 18);
        await rewardToken.waitForDeployment();

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

        const RAACToken = await ethers.getContractFactory("RAACToken");
        stakingToken = await RAACToken.deploy(owner.address);
        await stakingToken.waitForDeployment();

        const VeRAACToken = await ethers.getContractFactory("VeRAACToken", { libraries });
        veToken = await VeRAACToken.deploy(await stakingToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veToken.waitForDeployment();

        const GaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await GaugeControllerFactory.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        const GaugeRewardsDistributorFactory = await ethers.getContractFactory("GaugeRewardsDistributor");
        distributor = await GaugeRewardsDistributorFactory.deploy(
            await gaugeController.getAddress(),
            await rewardToken.getAddress()
        );
        await distributor.waitForDeployment();
        await gaugeController.setDistributor(await distributor.getAddress());

        const RWAGaugeFactory = await ethers.getContractFactory("RWAGauge");
        const raacAddress = await stakingToken.getAddress();
        const controllerAddr = await gaugeController.getAddress();
        const distributorAddr = await distributor.getAddress();
        const rewardAddr = await rewardToken.getAddress();

        gauge1 = await RWAGaugeFactory.deploy(raacAddress, controllerAddr, owner.address, raacAddress, rewardAddr, distributorAddr);
        gauge2 = await RWAGaugeFactory.deploy(raacAddress, controllerAddr, owner.address, raacAddress, rewardAddr, distributorAddr);

        await gauge1.waitForDeployment();
        await gauge2.waitForDeployment();

        const CONTROLLER_ROLE = await gauge1.CONTROLLER_ROLE();
        const GAUGE_ADMIN = await gaugeController.GAUGE_ADMIN();

        for (const gauge of [gauge1, gauge2]) {
            await gauge.grantRole(CONTROLLER_ROLE, owner.address);
        }

        await gaugeController.grantRole(GAUGE_ADMIN, owner.address);
        await gaugeController.addGauge(await gauge1.getAddress());
        await gaugeController.addGauge(await gauge2.getAddress());

        await rewardToken.mint(owner.address, REWARD_AMOUNT * 10n);
        await rewardToken.approve(distributorAddr, REWARD_AMOUNT * 10n);

        // owner is the minter for sake of simplicity
        await stakingToken.connect(owner).setMinter(owner.address);

        await stakingToken.mint(owner.address, ethers.parseEther("1000000"));
        await stakingToken.mint(user1.address, STAKE_AMOUNT * 20n);

        await stakingToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));

        await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);

        await stakingToken.connect(owner).setMinter(await veToken.getAddress());

        await stakingToken.connect(user1).approve(await gauge1.getAddress(), STAKE_AMOUNT * 10n);
        await stakingToken.connect(user1).approve(await gauge2.getAddress(), STAKE_AMOUNT * 10n);

        const { periodStartTime } = await gauge1.getPeriodBoundaries();

        const currentTime = await time.latest();

        if (currentTime < periodStartTime) {
            await time.increaseTo(Number(periodStartTime));
        }
    });

    it("should have the proper deposits on the distributor", async () => {
        const addr = await rewardToken.getAddress();

        const epoch = await gaugeController.getCurrentEpoch();

        await distributor.deposit(addr, REWARD_AMOUNT);
        await distributor.deposit(addr, REWARD_AMOUNT);

        expect(await distributor.depositedAtEpoch(addr, epoch)).to.equal(REWARD_AMOUNT * 2n);

        const info = await distributor.getRewardTokenInfo();
        expect(info.totalDeposited).to.equal(REWARD_AMOUNT * 2n);
        expect(info.balance).to.equal(REWARD_AMOUNT * 2n);
    });

    it("should report zero relative weights when nobody has voted", async () => {
        const gauge1Addr = await gauge1.getAddress();
        const gauge2Addr = await gauge2.getAddress();
        const epoch = await gaugeController.getCurrentEpoch();

        const [rel1, total1] = await gaugeController.getGaugeRelativeWeightView(gauge1Addr, epoch);
        expect(rel1).to.equal(0n);
        expect(total1).to.equal(0n);

        const [rel2, total2] = await gaugeController.getGaugeRelativeWeightView(gauge2Addr, epoch);
        expect(rel2).to.equal(0n);
        expect(total2).to.equal(0n);
    });

    it("should not stream rewards when nobody voted (deposit is left as dust)", async () => {
        await distributor.deposit(await rewardToken.getAddress(), REWARD_AMOUNT);

        await gauge1.pullRewardsFromDistributor();
        await gauge2.pullRewardsFromDistributor();

        await gauge1.connect(user1).stake(STAKE_AMOUNT);
        await gauge2.connect(user1).stake(STAKE_AMOUNT);

        await time.increase(DAY);

        // With zero total vote weight at the deposit epoch nothing is claimable, so the deposit
        // stays in the distributor for withdrawDust to sweep instead of being split between gauges.
        expect(await gauge1.pendingRewards(await rewardToken.getAddress(), user1.address)).to.equal(0n);
        expect(await gauge2.pendingRewards(await rewardToken.getAddress(), user1.address)).to.equal(0n);
        expect(await rewardToken.balanceOf(await gauge1.getAddress())).to.equal(0n);
        expect(await rewardToken.balanceOf(await gauge2.getAddress())).to.equal(0n);
    });

    it("should stream rewards to the voted gauge", async () => {
        await gaugeController.connect(owner).vote(await gauge1.getAddress(), 10000);
        await time.increase(WEEK); // vote becomes active at the next weekly epoch

        await distributor.deposit(await rewardToken.getAddress(), REWARD_AMOUNT);
        await gauge1.pullRewardsFromDistributor();

        await gauge1.connect(user1).stake(STAKE_AMOUNT);
        await time.increase(DAY);

        expect(await gauge1.pendingRewards(await rewardToken.getAddress(), user1.address)).to.be.gt(0n);
        expect(await rewardToken.balanceOf(await gauge1.getAddress())).to.equal(REWARD_AMOUNT);
    });

    it("should apply vote at the next epoch", async () => {
        const gauge1Addr = await gauge1.getAddress();
        const gauge2Addr = await gauge2.getAddress();

        const epochAtDeposit = await gaugeController.getCurrentEpoch();
        const nextEpoch = await gaugeController.getNextEpoch();

        await distributor.deposit(await rewardToken.getAddress(), REWARD_AMOUNT);

        await gaugeController.connect(owner).vote(gauge1Addr, 10000);

        // the vote is not active at the epoch it was cast in
        const [rel1Same] = await gaugeController.getGaugeRelativeWeightView(gauge1Addr, epochAtDeposit);
        const [rel2Same] = await gaugeController.getGaugeRelativeWeightView(gauge2Addr, epochAtDeposit);
        expect(rel1Same).to.equal(0n);
        expect(rel2Same).to.equal(0n);

        await time.increase(WEEK);

        const [rel1Next] = await gaugeController.getGaugeRelativeWeight.staticCall(gauge1Addr, nextEpoch);
        const [rel2Next] = await gaugeController.getGaugeRelativeWeight.staticCall(gauge2Addr, nextEpoch);
        expect(rel1Next).to.be.gt(rel2Next);
        expect(rel1Next).to.equal(ethers.parseEther("1")); // 100% of the vote weight
        expect(rel2Next).to.equal(0n);
    });
});
