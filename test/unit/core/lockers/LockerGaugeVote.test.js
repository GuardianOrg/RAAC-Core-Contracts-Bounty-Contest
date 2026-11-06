import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers, upgrades } = hre;

// Covers the OPERATOR_ROLE / DELEGATE_ROLE split on RAACLiquidLocker against a REAL GaugeController
// and a REAL VeRAACToken, over the full gauge lifecycle: authorize a gauge, vote with the locker's
// veRAAC power, have the controller remove the gauge, then release the stranded power with
// removePowerFromGauge (vote(gauge, 0) is impossible once the gauge is inactive).
describe("RAACLiquidLocker gauge vote lifecycle", () => {
    const MAX_LOCK_EPOCHS = 52; // GaugeController requires maxLockEpochs * epochDuration == 52 weeks
    const MAX_VOTE_WEIGHT = 10000;
    const E = (n) => ethers.parseEther(n.toString());

    let locker, controller, ve, raac, gauge, gauge2;
    let lockerAddr, controllerAddr, gaugeAddr, gauge2Addr;
    let deployer, gaugeAdmin, governance, delegate, user1;
    let OPERATOR_ROLE, DELEGATE_ROLE, ON_BEHALF_OF_ROLE;

    beforeEach(async () => {
        [deployer, gaugeAdmin, governance, delegate, user1] = await ethers.getSigners();

        const RAACToken = await ethers.getContractFactory("RAACToken");
        raac = await RAACToken.deploy(deployer.address);

        const LockManager = await ethers.getContractFactory("LockManager");
        const lockManager = await LockManager.deploy();
        const withLockManager = { libraries: { LockManager: lockManager.target } };
        const RagequitLib = await ethers.getContractFactory("RagequitLib", withLockManager);
        const PowerCheckpoint = await ethers.getContractFactory("PowerCheckpoint", withLockManager);
        const RewardLib = await ethers.getContractFactory("RewardLib", withLockManager);
        const libraries = {
            LockManager: lockManager.target,
            RagequitLib: (await RagequitLib.deploy()).target,
            PowerCheckpoint: (await PowerCheckpoint.deploy()).target,
            RewardLib: (await RewardLib.deploy()).target,
        };

        const VeRAACToken = await ethers.getContractFactory("VeRAACToken", { libraries });
        ve = await VeRAACToken.deploy(await raac.getAddress(), deployer.address, MAX_LOCK_EPOCHS);
        await raac.setMinter(await ve.getAddress());

        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        const usdc = await MockUSDC.deploy(E(1_000_000));

        const GaugeController = await ethers.getContractFactory("GaugeController");
        controller = await GaugeController.deploy(await ve.getAddress());
        controllerAddr = await controller.getAddress();

        const GaugeRewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
        const distributor = await GaugeRewardsDistributor.deploy(controllerAddr, await usdc.getAddress());
        await controller.setDistributor(await distributor.getAddress());

        const RAACGauge = await ethers.getContractFactory("RAACGauge");
        const gaugeArgs = [
            await raac.getAddress(), controllerAddr, deployer.address,
            await raac.getAddress(), await usdc.getAddress(), await distributor.getAddress(),
        ];
        gauge = await RAACGauge.deploy(...gaugeArgs);
        gauge2 = await RAACGauge.deploy(...gaugeArgs);
        gaugeAddr = await gauge.getAddress();
        gauge2Addr = await gauge2.getAddress();

        await controller.grantRole(await controller.GAUGE_ADMIN(), gaugeAdmin.address);
        await controller.connect(gaugeAdmin).addGauge(gaugeAddr);
        await controller.connect(gaugeAdmin).addGauge(gauge2Addr);

        // Locker: real veRAAC, minimal stand-ins for the vault/zap/intermediate-token surface.
        const LeRAAC = await ethers.getContractFactory("LiquidEscrowedRAAC");
        const leRAAC = await LeRAAC.deploy();
        const SimToken = await ethers.getContractFactory("SimToken");
        const inter = await SimToken.deploy("crvUSD", "crvUSD");
        const SimVault = await ethers.getContractFactory("SimVault");
        const vault = await SimVault.deploy(await raac.getAddress());
        const SimStub = await ethers.getContractFactory("SimStub");
        const zap = await SimStub.deploy();

        const Locker = await ethers.getContractFactory("RAACLiquidLocker");
        locker = await upgrades.deployProxy(
            Locker,
            [
                await raac.getAddress(), await leRAAC.getAddress(), await ve.getAddress(),
                await vault.getAddress(), await zap.getAddress(), await inter.getAddress(),
                deployer.address, deployer.address, deployer.address, 0, 0, 0, 0, 0,
            ],
            { initializer: "initialize", unsafeAllow: ["constructor"] }
        );
        lockerAddr = await locker.getAddress();
        await leRAAC.updateMinters([lockerAddr], [true]);
        await leRAAC.updateCeiling(lockerAddr, ethers.toBeHex(E(1_000_000_000)));

        OPERATOR_ROLE = await locker.OPERATOR_ROLE();
        DELEGATE_ROLE = await locker.DELEGATE_ROLE();
        ON_BEHALF_OF_ROLE = await locker.ON_BEHALF_OF_ROLE();
        await locker.grantRole(OPERATOR_ROLE, governance.address);
        await locker.grantRole(DELEGATE_ROLE, delegate.address);

        // Fund a user and deposit, so the locker holds a live 52-epoch veRAAC lock to vote with.
        await raac.setMinter(deployer.address);
        await raac.mint(user1.address, E(1_000_000));
        await raac.setMinter(await ve.getAddress());
        await raac.connect(user1).approve(lockerAddr, ethers.MaxUint256);
        await locker.connect(user1).deposit(E(1_000_000));

        const { periodStartTime } = await gauge.getPeriodBoundaries();
        if ((await time.latest()) < Number(periodStartTime)) await time.increaseTo(Number(periodStartTime));
    });

    it("full lifecycle: authorize gauge, vote, gauge removed, release stranded power", async () => {
        // 1. OPERATOR authorizes the gauge on the locker (ON_BEHALF_OF_ROLE lets it lock claimed
        //    rewards for users via depositOnBehalfOf).
        expect(await locker.hasRole(ON_BEHALF_OF_ROLE, gaugeAddr)).to.be.false;
        await locker.connect(governance).addGauge(gaugeAddr);
        expect(await locker.hasRole(ON_BEHALF_OF_ROLE, gaugeAddr)).to.be.true;

        // 2. DELEGATE votes the locker's whole veRAAC power onto the gauge.
        await expect(locker.connect(delegate).voteGauge(controllerAddr, gaugeAddr, MAX_VOTE_WEIGHT))
            .to.emit(locker, "GaugeVote").withArgs(controllerAddr, gaugeAddr, MAX_VOTE_WEIGHT);
        expect(await controller.voteUserPower(lockerAddr)).to.equal(MAX_VOTE_WEIGHT);
        expect((await controller.voteUserSlopes(lockerAddr, gaugeAddr)).power).to.equal(MAX_VOTE_WEIGHT);
        expect(await controller.userVotedGauges(lockerAddr, 0)).to.equal(gaugeAddr);

        // All the power is committed: nothing left for another gauge.
        await expect(locker.connect(delegate).voteGauge(controllerAddr, gauge2Addr, 100))
            .to.be.revertedWithCustomError(controller, "InvalidWeight");

        // 3. While the gauge is still active, releasing power is rejected; vote(gauge, 0) is the path.
        await expect(locker.connect(delegate).removePowerFromGauge(controllerAddr, gaugeAddr))
            .to.be.revertedWithCustomError(controller, "ActiveGauge");

        // 4. The gauge is removed from the controller.
        await controller.connect(gaugeAdmin).removeGauge(gaugeAddr, deployer.address);
        expect(await controller.isGaugeActive(gaugeAddr)).to.be.false;

        // The locker can no longer zero its vote the normal way -- this is why the wrapper exists.
        // Immediately after voting the cooldown blocks it, and once the cooldown elapses the
        // gauge is inactive, so vote(gauge, 0) is rejected outright.
        await expect(locker.connect(delegate).voteGauge(controllerAddr, gaugeAddr, 0))
            .to.be.revertedWithCustomError(controller, "VoteDelayNotElapsed");
        await time.increase(Number(await controller.WEIGHT_VOTE_DELAY()) + 1);
        await expect(locker.connect(delegate).voteGauge(controllerAddr, gaugeAddr, 0))
            .to.be.revertedWithCustomError(controller, "GaugeNotActive");

        // 5. Release the stranded power.
        await expect(locker.connect(delegate).removePowerFromGauge(controllerAddr, gaugeAddr))
            .to.emit(locker, "GaugePowerRemoved").withArgs(controllerAddr, gaugeAddr);
        expect(await controller.voteUserPower(lockerAddr)).to.equal(0);
        expect((await controller.voteUserSlopes(lockerAddr, gaugeAddr)).power).to.equal(0);
        await expect(controller.userVotedGauges(lockerAddr, 0)).to.be.reverted; // list emptied

        // 6. The freed power is immediately reusable on a live gauge (no vote-delay carry-over).
        await locker.connect(delegate).voteGauge(controllerAddr, gauge2Addr, MAX_VOTE_WEIGHT);
        expect(await controller.voteUserPower(lockerAddr)).to.equal(MAX_VOTE_WEIGHT);
        expect((await controller.voteUserSlopes(lockerAddr, gauge2Addr)).power).to.equal(MAX_VOTE_WEIGHT);
    });

    it("removePowerFromGauge reverts when the locker never voted on the removed gauge", async () => {
        await controller.connect(gaugeAdmin).removeGauge(gaugeAddr, deployer.address);
        await expect(locker.connect(delegate).removePowerFromGauge(controllerAddr, gaugeAddr))
            .to.be.revertedWithCustomError(controller, "NoPower");
    });

    it("removePowerFromGauge rejects zero addresses", async () => {
        await expect(locker.connect(delegate).removePowerFromGauge(ethers.ZeroAddress, gaugeAddr))
            .to.be.revertedWithCustomError(locker, "ZeroAddress");
        await expect(locker.connect(delegate).removePowerFromGauge(controllerAddr, ethers.ZeroAddress))
            .to.be.revertedWithCustomError(locker, "ZeroAddress");
    });

    it("removePowerFromGauge is blocked while the locker is paused", async () => {
        await locker.connect(delegate).voteGauge(controllerAddr, gaugeAddr, MAX_VOTE_WEIGHT);
        await controller.connect(gaugeAdmin).removeGauge(gaugeAddr, deployer.address);
        await locker.grantRole(await locker.PAUSER_ROLE(), deployer.address);
        await locker.pause();
        await expect(locker.connect(delegate).removePowerFromGauge(controllerAddr, gaugeAddr))
            .to.be.revertedWithCustomError(locker, "EnforcedPause");
    });

    describe("role split", () => {
        it("only DELEGATE_ROLE may vote or release power", async () => {
            for (const caller of [deployer, governance]) {
                await expect(locker.connect(caller).voteGauge(controllerAddr, gaugeAddr, MAX_VOTE_WEIGHT))
                    .to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
                    .withArgs(caller.address, DELEGATE_ROLE);
                await expect(locker.connect(caller).removePowerFromGauge(controllerAddr, gaugeAddr))
                    .to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
                    .withArgs(caller.address, DELEGATE_ROLE);
            }
        });

        it("only OPERATOR_ROLE may authorize a gauge", async () => {
            for (const caller of [deployer, delegate]) {
                await expect(locker.connect(caller).addGauge(gaugeAddr))
                    .to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
                    .withArgs(caller.address, OPERATOR_ROLE);
            }
            await locker.connect(governance).addGauge(gaugeAddr);
            expect(await locker.hasRole(ON_BEHALF_OF_ROLE, gaugeAddr)).to.be.true;
        });

        it("addGauge rejects the zero address", async () => {
            await expect(locker.connect(governance).addGauge(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(locker, "ZeroAddress");
        });
    });
});
