/* eslint-disable node/no-missing-import */
import { expect } from "chai";
import hre from "hardhat";
import { ZAP_ROUTES } from "../../../utils/routes.js";
import { ADDRESS } from "../../../utils/address.js";
import { request_fork, mockETHBalance } from "../../../utils/utils.js";

const { ethers } = hre;

describe("RaacLiquidLockerZapFork.spec", function () {
    // Every test re-forks mainnet in beforeEach. With a cold cache/hardhat-network-fork
    // the state fetch alone blows past mocha's 40s default.
    this.timeout(180_000);
    const FORK_BLOCK_NUMBER = 23263475;
    const CVX = ADDRESS.CVX; // use CVX as RAAC sink on fork
    const CRV = ADDRESS.CRV;
    const CRVUSD = ADDRESS.crvUSD;
    const INTERMEDIATE_REWARD_TOKEN = ADDRESS.cvxCRV //cvxCRV

    // well-funded CRV-CVX, whale for direct seeding at the fork block 
    const WHALE = "0x28C6c06298d514Db089934071355E5743bf21d60";


    let raac;
    let leRAAC;
    let ve;
    let zap;
    let botLocker
    let locker;
    let maturityVault;
    let governance;
    let timelock;

    let deployer;
    let cleverFeeRecipient;
    let alice;
    let bob;

    async function timeIncreaseWithMining(seconds) {
        const timestamp = (await ethers.provider.getBlock("latest"))?.timestamp;
        await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp + seconds]);
        await hre.network.provider.send("evm_mine", []);
    }

    async function notifyRewardAmount(token, amount) {
        const tokenContract = await ethers.getContractAt("MockToken", token, alice);
        await tokenContract.transfer(deployer.address, amount);
        await tokenContract.connect(deployer).approve(await ve.getAddress(), amount)
        await ve.connect(deployer).distributeRewards(token, amount, 1)
    }


    const MAX_LOCK_EPOCHS = 53
    const DAY = 24 * 3600;
    const EPOCH = 7 * DAY;
    const LOCK_DURATION = EPOCH * 52
    const PLATFORM_FEE = 200_000_000n; // 20%
    const HARVEST_BOUNTY = 30_000_000n; // 3%
    const FEE_SHARES_BOT = 10_000_000n; // 1%
    const FEE_SHARES_CLEVER = 12_500_000n; // 1.25%
    const FEE_SHARES_TREASURY = 177_500_000n; // 17.75%
    const INITIAL_DEPOSIT = ethers.parseEther("1000");
    beforeEach(async () => {

        await request_fork(FORK_BLOCK_NUMBER, [WHALE,]);
        deployer = (await ethers.getSigners())[0];
        cleverFeeRecipient = (await ethers.getSigners())[2];
        bob = (await ethers.getSigners())[1];
        alice = await ethers.getSigner(WHALE);
        await mockETHBalance(alice.address, ethers.parseEther("10"));
        // set raac mainnet as CVX on mainnet
        raac = await ethers.getContractAt("MockToken", CVX, deployer)

        const LeRAAC = await ethers.getContractFactory("LiquidEscrowedRAAC", deployer);
        leRAAC = await LeRAAC.deploy();
        //deploy libraries
        //
        const LockManagerFactory = await ethers.getContractFactory("LockManager")
        const lockManagerLib = await LockManagerFactory.deploy();
        await lockManagerLib.waitForDeployment()
        
        const RagequitFactory = await ethers.getContractFactory("RagequitLib",{libraries: { LockManager: lockManagerLib.target }},)
        const ragequitLib = await RagequitFactory.deploy();
        await ragequitLib.waitForDeployment()

        const PowerCheckpointFactory = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target }
        })
        const powerCheckpointLib = await PowerCheckpointFactory.deploy();
        await powerCheckpointLib.waitForDeployment()
        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const rewardLib = await RewardLibFactory.deploy();
        await rewardLib.waitForDeployment();

        const libraries = {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target,
        }
        // console.log("HHHHH",await ve.getAddress())
        const Ve = await ethers.getContractFactory("VeRAACToken", { libraries });
        ve = await Ve.deploy(await raac.getAddress(), deployer.address, MAX_LOCK_EPOCHS);

        const BotLocker = await ethers.getContractFactory("MockLamaLocker")
        botLocker = await BotLocker.deploy()
        botLocker.waitForDeployment()

        const AladdinZap = await ethers.getContractFactory("AladdinZap", deployer);
        zap = await AladdinZap.deploy();
        await zap.initialize();
        // CRV => cvxCRV
        await zap.updateRoute(CRV, INTERMEDIATE_REWARD_TOKEN, ZAP_ROUTES.CRV.cvxCRV);

        // cvxCRV => RAAC(CVX)
        await zap.updateRoute(INTERMEDIATE_REWARD_TOKEN, await raac.getAddress(), ZAP_ROUTES.cvxCRV.CVX);

        const Vault = await ethers.getContractFactory("RAACMaturityVault", deployer);
        const vaultImpl = await Vault.deploy();
        const vaultInitData = Vault.interface.encodeFunctionData("initialize", [
            await raac.getAddress(),
            await leRAAC.getAddress(),
            await deployer.getAddress(),
            await deployer.getAddress(),
            PLATFORM_FEE, // platform fee
            HARVEST_BOUNTY // harvest bounty
        ]);
        const VaultProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
        const vaultProxy = await VaultProxyFactory.deploy(await vaultImpl.getAddress(), vaultInitData);
        maturityVault = Vault.attach(await vaultProxy.getAddress());

        const timelockFactory = await ethers.getContractFactory("TimelockController");
        const MIN_DELAY = 2 * DAY;
        timelock = await timelockFactory.deploy(
            MIN_DELAY,
            [], // proposers
            [], // executors
            deployer.address
        );
        await timelock.waitForDeployment();

        const governanceFactory = await ethers.getContractFactory("Governance");
        governance = await governanceFactory.deploy(
            await ve.getAddress(),
            await timelock.getAddress()
        );
        await governance.waitForDeployment();


        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
        await timelock.grantRole(PROPOSER_ROLE, await governance.getAddress());
        await timelock.grantRole(EXECUTOR_ROLE, await governance.getAddress());
        await timelock.grantRole(CANCELLER_ROLE, await governance.getAddress());

        const Locker = await ethers.getContractFactory("RAACLiquidLocker", deployer);
        const lockerImpl = await Locker.deploy();
        const lockerInitData = Locker.interface.encodeFunctionData("initialize", [
            await raac.getAddress(),
            await leRAAC.getAddress(),
            await ve.getAddress(),
            await maturityVault.getAddress(),
            await zap.getAddress(),
            CRV,
            await deployer.getAddress(),
            await cleverFeeRecipient.getAddress(),
            await botLocker.getAddress(),
            PLATFORM_FEE, // platform fee
            HARVEST_BOUNTY, // harvest bounty
            FEE_SHARES_BOT,
            FEE_SHARES_CLEVER,
            FEE_SHARES_TREASURY
        ]);
        const LockerProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
        const lockerProxy = await LockerProxyFactory.deploy(await lockerImpl.getAddress(), lockerInitData);
        locker = Locker.attach(await lockerProxy.getAddress());
        await locker.grantRole(await locker.HARVEST_ROLE(), await deployer.getAddress());
        await locker.updateIntermediateRewardToken(INTERMEDIATE_REWARD_TOKEN);
        //set the deployer as keeper
        await locker.updateWhitelist(deployer.address, true)

        // - leRAAC: set locker as minter with ceiling
        await leRAAC.updateMinters([await locker.getAddress()], [true]);
        await leRAAC.updateCeiling(await locker.getAddress(), ethers.toBeHex(ethers.parseUnits("1000000000", 18)));
        // - vault: whitelist locker to call distribute/harvest
        await maturityVault.updateWhitelists([await locker.getAddress()], [true]);
        // locking some token so we can notify reward amount
        await raac.connect(alice).transfer(deployer.address, INITIAL_DEPOSIT);
        await raac.connect(deployer).approve(await ve.getAddress(), INITIAL_DEPOSIT);
        await ve.lock(INITIAL_DEPOSIT, 5);// this is required to notify reward amount

        // Alice locks some tokens
        // await raac.connect(alice).approve(await ve.getAddress(), ethers.parseEther("50000"));
        // await ve.connect(alice).lock(ethers.parseEther("50000"), 5);
        // locks via locker so voter proxy can claim reward
        // FIXME: fix the behaviour when a user doesnt have ve a notify time but tries to claim reward
        // approve the locker to spend the token
        await raac.connect(alice).approve(await locker.getAddress(), ethers.parseEther("100"));
        // notify reward amount
        await ve.addRewardToken(ADDRESS.CRV);
        await notifyRewardAmount(ADDRESS.CRV, ethers.parseEther("500"));
        // claim alice reward
        await timeIncreaseWithMining(LOCK_DURATION * 6);
        // await ve.claimReward(await deployer.getAddress(), await deployer.getAddress());
    });

    describe("Deploy", async () => {

        it("deploys LiquidEscrowedRAAC with correct metadata and ownership", async () => {
            expect(await leRAAC.name()).to.equal("Liquid Escrowed RAAC");
            expect(await leRAAC.symbol()).to.equal("leRAAC");
            expect(await leRAAC.owner()).to.equal(await deployer.getAddress());
            expect(await leRAAC.totalSupply()).to.equal(0n);
            // Deployer is not a minter by default
            expect(await leRAAC.isMinter(await deployer.getAddress())).to.equal(false);
            expect(await leRAAC.isMinter(await locker.getAddress())).to.equal(true);
        });

        it("deploys VeRAACToken with correct config", async () => {
            expect(await ve.name()).to.equal("Vote Escrowed RAAC");
            expect(await ve.symbol()).to.equal("veRAAC");
            expect(await ve.raac()).to.equal(await raac.getAddress());
            const [totalLocked, maxLockEpochs, epochDuration] = await ve.getGlobalLockInfo();
            expect(totalLocked).to.equal(0n);
            expect(maxLockEpochs).to.equal(MAX_LOCK_EPOCHS);
            expect(epochDuration).to.equal(EPOCH);
            expect(await ve.paused()).to.equal(false);
        });

        it("reverts initialize with invalid parameters", async () => {
            // RAACLiquidLocker calls _disableInitializers() in its constructor,
            // so initialize() can only be exercised via a proxy deployment.
            const Locker = await ethers.getContractFactory("RAACLiquidLocker", deployer);
            const Proxy = await ethers.getContractFactory("ERC1967Proxy", deployer);

            // Valid parameters for reference
            const validParams = {
                raac: await raac.getAddress(),
                leRAAC: await leRAAC.getAddress(),
                veRAAC: await ve.getAddress(),
                maturityVault: await maturityVault.getAddress(),
                zap: await zap.getAddress(),
                intermediateRewardToken: INTERMEDIATE_REWARD_TOKEN,
                treasury: await deployer.getAddress(),
                cleverFeeRecipient: await cleverFeeRecipient.getAddress(),
                raacBotLocker: await botLocker.getAddress(),
                treasuryFeePercentage: PLATFORM_FEE,
                harvestBountyPercentage: HARVEST_BOUNTY,
                feeSharesBots: FEE_SHARES_BOT,
                feeSharesClever: FEE_SHARES_CLEVER,
                feeSharesTreasury: FEE_SHARES_TREASURY,
            };

            const paramKeys = [
                "raac", "leRAAC", "veRAAC", "maturityVault", "zap",
                "intermediateRewardToken", "treasury", "cleverFeeRecipient",
                "raacBotLocker", "treasuryFeePercentage", "harvestBountyPercentage",
                "feeSharesBots", "feeSharesClever", "feeSharesTreasury",
            ];

            async function deployLockerProxy(overrides = {}) {
                const params = { ...validParams, ...overrides };
                const impl = await Locker.deploy();
                const initData = Locker.interface.encodeFunctionData(
                    "initialize",
                    paramKeys.map((key) => params[key])
                );
                return Proxy.deploy(await impl.getAddress(), initData);
            }

            // Test: reverts initialize with zero raac address
            await expect(
                deployLockerProxy({ raac: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero veRAAC address
            await expect(
                deployLockerProxy({ veRAAC: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero leRAAC address
            await expect(
                deployLockerProxy({ leRAAC: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero maturityVault address
            await expect(
                deployLockerProxy({ maturityVault: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero zap address
            await expect(
                deployLockerProxy({ zap: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero intermediateRewardToken address
            await expect(
                deployLockerProxy({ intermediateRewardToken: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with zero treasury address
            await expect(
                deployLockerProxy({ treasury: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(Locker, "ZeroAddress");

            // Test: reverts initialize with treasury fee over maximum
            await expect(
                deployLockerProxy({ treasuryFeePercentage: 500_000_001n }) // MAX_TREASURY_FEE + 1
            ).to.be.revertedWithCustomError(Locker, "FeeTooLarge");

            // Test: reverts initialize with harvest bounty over maximum
            await expect(
                deployLockerProxy({ harvestBountyPercentage: 100_000_001n }) // MAX_HARVEST_BOUNTY + 1
            ).to.be.revertedWithCustomError(Locker, "FeeTooLarge");

            // Test: reverts initialize with fee shares not matching treasury fee
            await expect(
                deployLockerProxy({ feeSharesBots: validParams.feeSharesBots + 1n }) // Invalid sum
            ).to.be.revertedWithCustomError(Locker, "FeeSharesNotMatchingTreasuryFee");

            // Test: reverts initialize when already initialized
            const newLockerProxy = await deployLockerProxy();
            const newLocker = Locker.attach(await newLockerProxy.getAddress());
            await expect(
                newLocker.initialize(
                    validParams.raac,
                    validParams.leRAAC,
                    validParams.veRAAC,
                    validParams.maturityVault,
                    validParams.zap,
                    validParams.intermediateRewardToken,
                    validParams.treasury,
                    validParams.cleverFeeRecipient,
                    validParams.raacBotLocker,
                    validParams.treasuryFeePercentage,
                    validParams.harvestBountyPercentage,
                    validParams.feeSharesBots,
                    validParams.feeSharesClever,
                    validParams.feeSharesTreasury
                )
            ).to.be.reverted;
        });

        it("reverts requestUnlock when requesting more than is deposited", async () => {
            const depositAmount = ethers.parseEther("100");
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);

            // requestUnlock takes a RAAC amount: alice can reserve at most what she deposited
            await expect(locker.connect(alice).requestUnlock(depositAmount + 1n)).to.be.revertedWithCustomError(
                locker,
                "InsufficientToUnlock"
            );
        });

        it("reverts with InsufficientOutput when swap output is too low", async () => {
            // Setup: deposit and add rewards
            const depositAmount = ethers.parseEther("50000");
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            await notifyRewardAmount(ADDRESS.CRV, ethers.parseEther("500"));

            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // Call harvest with an impossibly high minimumOut to trigger InsufficientOutput
            const harvestRole = await locker.HARVEST_ROLE();
            console.log("harvestRole", harvestRole);
            const highMinimum = ethers.parseEther("1000000000000"); // Way more than possible
            await expect(
                locker.harvest(await deployer.getAddress(), highMinimum)
            ).to.be.revertedWithCustomError(locker, "InsufficientOutput");
        });


        it("reverts booster gauge deposit when token is RAAC", async () => {
            await locker.grantRole(await locker.BOOSTER_ROLE(), await deployer.getAddress());

            await expect(
                locker.depositToGauge(await raac.getAddress(), await bob.getAddress(), 1n)
            ).to.be.revertedWithCustomError(locker, "InvalidToken");
        });

        it("reverts booster gauge deposit when token is a reward token", async () => {
            await locker.grantRole(await locker.BOOSTER_ROLE(), await deployer.getAddress());

            await expect(
                locker.depositToGauge(CRV, await bob.getAddress(), 1n)
            ).to.be.revertedWithCustomError(locker, "InvalidToken");
        });
    })

    describe("Deposit", async () => {
        const depositAmount = ethers.parseEther("100");

        it("reverts when depositing zero RAAC", async () => {
            await expect(locker.connect(alice).deposit(0)).to.be.revertedWithCustomError(locker, "NonZeroValue");
        });

        it("deposits, creates locks and updates user info", async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            const lockerLockedBalanceAfter = await ve.lockedBalanceOf(await locker.getAddress())
            expect(lockerLockedBalanceAfter).to.be.equal(depositAmount);
            const [userTotalDeposited, userTotalPendingUnlocked] = await locker.getUserInfo(await alice.getAddress());
            expect(userTotalDeposited).to.equal(depositAmount);
            const veRAACBalance = await raac.balanceOf(await ve.getAddress());
            expect(veRAACBalance).to.be.equal(depositAmount + INITIAL_DEPOSIT);
            expect(userTotalPendingUnlocked).to.be.equal(0n);
            const totalLockedGlobal = await locker.totalLockedGlobal()
            expect(totalLockedGlobal).to.be.equal(depositAmount);
        });

    })

    describe("Borrow and Repay", async () => {
        const depositAmount = ethers.parseEther("1000");
        const half = ethers.parseEther("500");

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
        });

        it("reverts borrow zero", async () => {
            await expect(locker.connect(alice).borrow(0, false)).to.be.revertedWithCustomError(locker, "NonZeroValue");
        })

        it("reverts borrow over collateral limit", async () => {
            const tooMuch = ethers.parseEther("501"); // > 50% of 1000
            await expect(locker.connect(alice).borrow(tooMuch, false)).to.be.revertedWithCustomError(locker, "InsufficientCollateral");
        });

        it("borrows leRAAC to wallet and records debt", async () => {
            const balBefore = await leRAAC.balanceOf(await alice.getAddress());
            await locker.connect(alice).borrow(half, false);
            const balAfter = await leRAAC.balanceOf(await alice.getAddress());
            expect(balAfter - balBefore).to.equal(half);

            const [, , , totalBorrowed] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(half);
        });

        it("borrows using rewards", async () => {
            //give rewards to the contract 
            await notifyRewardAmount(ADDRESS.CRV, ethers.parseEther("500"));
            const [, , , , totalRewardB] = await locker.getUserInfo(await alice.getAddress())
            console.log("totalReard", totalRewardB)
            await timeIncreaseWithMining(LOCK_DURATION);
            await locker.harvest(await alice.getAddress(), 0);
            const [, , , , totalRewardA] = await locker.getUserInfo(await alice.getAddress())
            console.log("totalReard", totalRewardA)

            // Verify rewards are available after harvest
            expect(totalRewardA).to.be.gt(0n);

            const leRAACBalanceBefore = await leRAAC.balanceOf(await alice.getAddress());

            // Borrow using rewards - should not create debt
            await locker.connect(alice).borrow(totalRewardA, false);

            // Verify leRAAC was minted to user
            const leRAACBalanceAfter = await leRAAC.balanceOf(await alice.getAddress());
            expect(leRAACBalanceAfter - leRAACBalanceBefore).to.equal(totalRewardA);

            // Verify no debt was created (rewards were used instead)
            const [, , , totalBorrowed, totalRewardAfter] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(0n);

            // Verify rewards were reduced by the borrowed amount
            expect(totalRewardAfter).to.equal(totalRewardA - totalRewardA);
        });

        it("borrows and deposits into maturity vault", async () => {
            await locker.connect(alice).borrow(half, true);
            // Funds should be deposited for alice in maturity vault as unrealised initially
            const [unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(unrealised).to.equal(half);
            expect(realised).to.equal(0n);
        });

        it("repays debt fully and sends repay fee to treasury", async () => {
            await locker.connect(alice).borrow(half, false);

            const repayFeePercentage = await locker.repayFeePercentage();

            const treasuryAdd = await locker.treasury()
            const treasuryBefore = await leRAAC.balanceOf(treasuryAdd)

            const expectedFee = (half * repayFeePercentage) / 1_000_000_000n

            await leRAAC.connect(alice).approve(await locker.getAddress(), half);
            await locker.connect(alice).repay(half);
            const [, , , totalBorrowed] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(0n);

            const treasuryAfter = await leRAAC.balanceOf(treasuryAdd)
            const treasuryReceived = treasuryAfter - treasuryBefore
            expect(treasuryReceived).to.equal(expectedFee)
        });
        it("partially repays debt and sends repay fee to treasury", async () => {
            // repaying 80% of the borrowed amount
            const partialAmount = (half * 80n) / 100n
            await locker.connect(alice).borrow(half, false);

            const repayFeePercentage = await locker.repayFeePercentage();

            const treasuryAdd = await locker.treasury()
            const treasuryBefore = await leRAAC.balanceOf(treasuryAdd)

            const expectedFee = (partialAmount * repayFeePercentage) / 1_000_000_000n

            await leRAAC.connect(alice).approve(await locker.getAddress(), partialAmount);
            await locker.connect(alice).repay(partialAmount);
            const [, , , totalBorrowed] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(half - partialAmount);

            const treasuryAfter = await leRAAC.balanceOf(treasuryAdd)
            const treasuryReceived = treasuryAfter - treasuryBefore
            expect(treasuryReceived).to.equal(expectedFee)
        });
    });

    describe("On-behalf operations", async () => {
        const depositAmount = ethers.parseEther("100");
        let ON_BEHALF_OF_ROLE;

        beforeEach(async () => {
            ON_BEHALF_OF_ROLE = await locker.ON_BEHALF_OF_ROLE();
            // grant deployer the on-behalf role and ensure it is keeper-whitelisted
            await locker.grantRole(ON_BEHALF_OF_ROLE, await deployer.getAddress());
            await locker.updateWhitelist(await deployer.getAddress(), true);
            // fund deployer with RAAC to source on-behalf deposits
            await raac.connect(alice).transfer(await deployer.getAddress(), depositAmount);
            await raac.connect(deployer).approve(await locker.getAddress(), depositAmount);
        });

        it("reverts depositOnBehalfOf when caller lacks role", async () => {
            // revoke role first
            await locker.revokeRole(ON_BEHALF_OF_ROLE, await deployer.getAddress());
            await expect(
                locker.connect(deployer).depositOnBehalfOf(await alice.getAddress(), depositAmount)
            ).to.be.revertedWithCustomError(locker, "Unauthorized");
        });

        it("deposits on behalf of user when caller has role and keeper status", async () => {
            await locker.connect(deployer).depositOnBehalfOf(await alice.getAddress(), depositAmount);
            const [totalDeposited, totalPendingUnlocked] = await locker.getUserInfo(await alice.getAddress());
            expect(totalDeposited).to.equal(depositAmount);
            expect(totalPendingUnlocked).to.equal(0n);
        });

    });

    describe("Unlock and Withdraw", async () => {
        const depositAmount = ethers.parseEther("1000");

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            //transfer some raac to bob
            await raac.connect(alice).transfer(await bob.getAddress(), ethers.parseEther("10000"));
            // await timeIncreaseWithMining(1);
        });

        it("schedules unlock then withdraws after expiry", async () => {
            await locker.connect(alice).requestUnlock(depositAmount);
            // cannot withdraw immediately
            await expect(locker.connect(alice).withdrawUnlocked()).to.be.revertedWithCustomError(locker, "InsufficientUnlocked");

            // fast forward past lock duration to ensure maturity
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // bring expired RAAC back from veRAAC into the locker via keeper
            await locker.connect(deployer).processVaultExpiredLocks();

            const raacBefore = await raac.balanceOf(await alice.getAddress());
            await locker.connect(alice).withdrawUnlocked();
            const raacAfter = await raac.balanceOf(await alice.getAddress());
            expect(raacAfter - raacBefore).to.equal(depositAmount);

            const [, , totalUnlocked] = await locker.getUserInfo(await alice.getAddress());
            expect(totalUnlocked).to.equal(0n);
        });
        it("test borrowing with already matured deposit", async () => {
            const balBefore = await raac.balanceOf(alice.getAddress());
            await locker.connect(alice).requestUnlock(depositAmount);
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await locker.connect(deployer).processVaultExpiredLocks();
            // withdraw
            await locker.connect(alice).withdrawUnlocked();
            const balAfter = await raac.balanceOf(alice.getAddress());
            expect(balAfter - balBefore).to.equal(depositAmount);
        });

        it("auto-relocks non-reserved matured amounts (rolling lock)", async () => {
            const dep = ethers.parseEther("100");
            await raac.connect(bob).approve(await locker.getAddress(), dep);
            await locker.connect(bob).deposit(dep);

            let [totalDeposited, totalPendingUnlocked, totalUnlocked] = await locker.getUserInfo(await bob.getAddress());
            expect(totalDeposited).to.equal(dep);
            expect(totalPendingUnlocked).to.equal(0n);
            expect(totalPendingUnlocked).to.equal(0n);
            expect(totalUnlocked).to.equal(0n);

            // move beyond maturity
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // Without explicit user action, matured non-reserved entries should not appear as pending nor unlocked
            ;[totalDeposited, totalPendingUnlocked, totalUnlocked] = await locker.getUserInfo(await bob.getAddress());
            expect(totalDeposited).to.equal(dep);
            expect(totalPendingUnlocked).to.equal(0n);
            expect(totalUnlocked).to.equal(0n);
        });

        it("requestUnlock schedules and becomes withdrawable after expiry", async () => {
            // Split into two deposits so reserving `req` consumes exactly the first
            // (FIFO) entry, leaving the second (remainder) entry untouched.
            const req = ethers.parseEther("400");
            const remainder = ethers.parseEther("600");
            await raac.connect(bob).approve(await locker.getAddress(), req + remainder);
            await locker.connect(bob).deposit(req);
            await locker.connect(bob).deposit(remainder);

            await locker.connect(bob).requestUnlock(req);
            let [totalDeposited, totalPendingUnlocked, totalUnlocked] = await locker.getUserInfo(await bob.getAddress());
            expect(totalDeposited).to.equal(req + remainder);
            expect(totalPendingUnlocked).to.equal(req);
            expect(totalUnlocked).to.equal(0n);

            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await locker.connect(deployer).processVaultExpiredLocks();

            const balBefore = await raac.balanceOf(await bob.getAddress());
            await locker.connect(bob).withdrawUnlocked();
            const balAfter = await raac.balanceOf(await bob.getAddress());
            expect(balAfter - balBefore).to.equal(req);

            ;[, , totalUnlocked] = await locker.getUserInfo(await bob.getAddress());
            expect(totalUnlocked).to.equal(0n);
        });

        it("requestUnlock more than locked reverts", async () => {
            const dep = ethers.parseEther("100");
            await raac.connect(bob).approve(await locker.getAddress(), dep);
            await locker.connect(bob).deposit(dep);
            await expect(locker.connect(bob).requestUnlock(dep + 1n)).to.be.revertedWithCustomError(locker, "InsufficientToUnlock");
        });

        it("requestUnlock reverts when the reservation would leave the debt unbacked", async () => {
            const dep = ethers.parseEther("1000");
            await raac.connect(bob).approve(await locker.getAddress(), dep);
            await locker.connect(bob).deposit(dep);

            // Borrow up to the limit (reserveRate = 50%)
            const maxBorrow = ethers.parseEther("500");
            await locker.connect(bob).borrow(maxBorrow, false);

            // Reserved collateral can't back debt, so with zero free collateral even a
            // 1 wei reservation fails the health check at request time.
            await expect(locker.connect(bob).requestUnlock(1)).to.be.revertedWithCustomError(
                locker,
                "InsufficientCollateral"
            );
        });

        it("requestUnlock reserves up to the free collateral and no further", async () => {
            const dep = ethers.parseEther("1000");
            await raac.connect(bob).approve(await locker.getAddress(), dep);
            await locker.connect(bob).deposit(dep);

            // Borrowing 250 at reserveRate = 50% pins 500 of collateral, leaving 500 free
            await locker.connect(bob).borrow(ethers.parseEther("250"), false);

            const free = ethers.parseEther("500");
            await locker.connect(bob).requestUnlock(free);

            const [, totalPendingUnlocked] = await locker.getUserInfo(await bob.getAddress());
            expect(totalPendingUnlocked).to.equal(free);

            // The free amount is now fully reserved, so one more wei is unbacked
            await expect(locker.connect(bob).requestUnlock(1)).to.be.revertedWithCustomError(
                locker,
                "InsufficientCollateral"
            );
        });

        it("withdrawUnlocked reverts when no unlocked balance", async () => {
            await expect(locker.connect(alice).withdrawUnlocked()).to.be.revertedWithCustomError(locker, "InsufficientUnlocked");
        });

        it("multiple requestUnlock across different epochs withdraws full matured reserved amount", async () => {
            // Each deposit creates its own lock entry with an unlock epoch based on when
            // it was made, so two deposits made half a lock-duration apart mature at
            // different epochs; each requestUnlock reserves the amount just deposited.
            const r1 = ethers.parseEther("200");
            const r2 = ethers.parseEther("150");
            await raac.connect(bob).approve(await locker.getAddress(), r1 + r2);

            await locker.connect(bob).deposit(r1);
            await locker.connect(bob).requestUnlock(r1);

            await timeIncreaseWithMining(LOCK_DURATION / 2);
            await locker.connect(bob).deposit(r2);
            await locker.connect(bob).requestUnlock(r2);

            // fast forward beyond full duration so both reserved entries mature
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await locker.connect(deployer).processVaultExpiredLocks();

            const balBefore = await raac.balanceOf(await bob.getAddress());
            await locker.connect(bob).withdrawUnlocked();
            const balAfter = await raac.balanceOf(await bob.getAddress());
            expect(balAfter - balBefore).to.equal(r1 + r2);
        });

    });

    describe("Rewards Harvest", async () => {
        beforeEach(async () => {
            const depositAmount = ethers.parseEther("50000");
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            await notifyRewardAmount(ADDRESS.CRV, ethers.parseEther("500"));
        });
        it("charges treasury fee, distributes harvest bounty, clever and bot fee shares ", async () => {
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            const currentTreasuryFee = await locker.treasuryFeePercentage();
            console.log("currentTreasuryFee", currentTreasuryFee)

            const treasuryAddr = await locker.treasury();
            const cleverFeeRecipientAddr = await locker.cleverFeeRecipient();
            const botLockerAddr = await locker.raacBotLocker();
            const vaultAddr = await maturityVault.getAddress();
            console.log("vaultAddr", vaultAddr)

            const treasuryBefore = await raac.balanceOf(treasuryAddr);
            const cleverBefore = await raac.balanceOf(cleverFeeRecipientAddr);
            const botLockerBefore = await raac.balanceOf(await botLocker.getAddress());
            const aliceBefore = await raac.balanceOf(await alice.getAddress());
            const vaultBefore = await raac.balanceOf(vaultAddr);

            await locker.harvest(await alice.getAddress(), 0);

            const treasuryAfter = await raac.balanceOf(treasuryAddr);
            const cleverAfter = await raac.balanceOf(cleverFeeRecipientAddr);
            const botLockerAfter = await raac.balanceOf(await botLocker.getAddress());
            const aliceAfter = await raac.balanceOf(await alice.getAddress());
            const vaultAfter = await raac.balanceOf(vaultAddr);

            const treasuryGain = treasuryAfter - treasuryBefore;
            const cleverGain = cleverAfter - cleverBefore;
            const botLockerGain = botLockerAfter - botLockerBefore;
            const aliceGain = aliceAfter - aliceBefore;
            const vaultGain = vaultAfter - vaultBefore;

            // Total harvested is the sum of all recipients
            const totalHarvested = treasuryGain + cleverGain + botLockerGain + aliceGain + vaultGain;

            // Calculate expected fees based on contract logic
            // Platform fee is calculated first from totalHarvested
            const expectedPlatformFee = (totalHarvested * PLATFORM_FEE) / 1_000_000_000n;

            // Platform fee is split according to fee shares
            // IMPORTANT: Match contract's calculation order to avoid rounding differences
            const sumFeeShares = FEE_SHARES_BOT + FEE_SHARES_CLEVER + FEE_SHARES_TREASURY;
            const expectedClever = (expectedPlatformFee * FEE_SHARES_CLEVER) / sumFeeShares;
            const expectedBotLocker = (expectedPlatformFee * FEE_SHARES_BOT) / sumFeeShares;
            // Calculate treasury amount by subtraction (same as contract) to avoid rounding issues
            const expectedTreasury = expectedPlatformFee - expectedBotLocker - expectedClever;

            // Harvest bounty is calculated from amount AFTER platform fee
            const amountAfterPlatformFee = totalHarvested - expectedPlatformFee;
            const expectedBounty = (amountAfterPlatformFee * HARVEST_BOUNTY) / 1_000_000_000n;

            // Vault gets the remainder
            const expectedToVault = totalHarvested - expectedPlatformFee - expectedBounty;

            expect(treasuryGain).to.equal(expectedTreasury);
            expect(cleverGain).to.equal(expectedClever);
            expect(botLockerGain).to.equal(expectedBotLocker);
            expect(aliceGain).to.equal(expectedBounty);
            expect(vaultGain).to.equal(expectedToVault);
        });
        it("calculates fee distribution amounts correctly when fee shares are configured", async () => {
            // Test the fee calculation logic without requiring addresses to be set
            const FEE_SHARES_BOT = 10_000_000n; // 1%
            const FEE_SHARES_CLEVER = 12_500_000n; // 1.25%
            const FEE_SHARES_TREASURY = 177_500_000n; // 17.75%
            const sumFeeShares = FEE_SHARES_BOT + FEE_SHARES_CLEVER + FEE_SHARES_TREASURY;

            await locker.updateFeeShares(FEE_SHARES_BOT, FEE_SHARES_CLEVER, FEE_SHARES_TREASURY, PLATFORM_FEE);

            // Simulate fee calculation
            const mockHarvestedAmount = ethers.parseEther("1000");
            const totalFee = (mockHarvestedAmount * PLATFORM_FEE) / 1_000_000_000n;

            const expectedCleverAmount = (totalFee * FEE_SHARES_CLEVER) / sumFeeShares;
            const expectedBotLockerAmount = (totalFee * FEE_SHARES_BOT) / sumFeeShares;
            const expectedTreasuryAmount = totalFee - expectedBotLockerAmount - expectedCleverAmount;

            // Verify calculations are correct
            expect(sumFeeShares).to.equal(PLATFORM_FEE);
            expect(expectedCleverAmount + expectedBotLockerAmount + expectedTreasuryAmount).to.equal(totalFee);

            // Verify fee shares are stored correctly
            expect(await locker.feeSharesBots()).to.equal(FEE_SHARES_BOT);
            expect(await locker.feeSharesClever()).to.equal(FEE_SHARES_CLEVER);
            expect(await locker.feeSharesTreasury()).to.equal(FEE_SHARES_TREASURY);
        });
        it("sends remainder to RAACMaturityVault (distribution)", async () => {
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            const treasuryAddr = await locker.treasury();
            const vaultAddr = await maturityVault.getAddress();
            const cleverFeeRecipientAddr = await locker.cleverFeeRecipient();
            const botLockerAddr = await locker.raacBotLocker();

            const treasuryBefore = await raac.balanceOf(treasuryAddr);
            const aliceBefore = await raac.balanceOf(await alice.getAddress());
            const vaultBefore = await raac.balanceOf(vaultAddr);
            const cleverBefore = await raac.balanceOf(cleverFeeRecipientAddr);
            const botLockerBefore = await raac.balanceOf(await botLocker.getAddress());

            await locker.harvest(await alice.getAddress(), 0);

            const treasuryAfter = await raac.balanceOf(treasuryAddr);
            const aliceAfter = await raac.balanceOf(await alice.getAddress());
            const vaultAfter = await raac.balanceOf(vaultAddr);
            const cleverAfter = await raac.balanceOf(cleverFeeRecipientAddr);
            const botLockerAfter = await raac.balanceOf(await botLocker.getAddress());

            const treasuryGain = treasuryAfter - treasuryBefore;
            const aliceGain = aliceAfter - aliceBefore;
            const vaultGain = vaultAfter - vaultBefore;
            const cleverGain = cleverAfter - cleverBefore;
            const botLockerGain = botLockerAfter - botLockerBefore;

            const totalHarvested = treasuryGain + cleverGain + botLockerGain + aliceGain + vaultGain;

            const expectedTreasury = (totalHarvested * PLATFORM_FEE) / 1_000_000_000n;
            const expectedBounty = ((totalHarvested - expectedTreasury) * HARVEST_BOUNTY) / 1_000_000_000n;
            const expectedRemainder = totalHarvested - expectedTreasury - expectedBounty;

            expect(vaultGain).to.equal(expectedRemainder);
        });

        it("reverts on insufficient output (slippage guard)", async () => {
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await expect(locker.harvest(await alice.getAddress(), ethers.parseEther("1000000000000")))
                .to.be.revertedWithCustomError(locker, "InsufficientOutput");
        });

        it("updates intermediate reward token address", async () => {
            const prev = await locker.intermediateRewardToken();
            expect(prev).to.equal(INTERMEDIATE_REWARD_TOKEN);

            // updateIntermediateRewardToken validates routes from the new intermediate
            // token to RAAC, and from every existing reward token (CRV) to the new
            // intermediate token; register both before switching.
            await zap.updateRoute(CRVUSD, await raac.getAddress(), [1n]);
            await zap.updateRoute(CRV, CRVUSD, [1n]);

            await locker.updateIntermediateRewardToken(CRVUSD);
            expect(await locker.intermediateRewardToken()).to.equal(CRVUSD);
            // restore
            await locker.updateIntermediateRewardToken(INTERMEDIATE_REWARD_TOKEN);
        });

        it("vault.harvest tiny amount rounds fees to zero", async () => {
            // whitelist deployer to call vault.harvest directly
            await maturityVault.updateWhitelists([await deployer.getAddress()], [true]);
            // fund a tiny RAAC amount into the vault
            await raac.connect(alice).transfer(await maturityVault.getAddress(), 1n);

            const platform = await maturityVault.platform();
            const platformBefore = await raac.balanceOf(platform);
            const recipBefore = await raac.balanceOf(await deployer.getAddress());

            await maturityVault.harvest(await deployer.getAddress());

            const platformAfter = await raac.balanceOf(platform);
            const recipAfter = await raac.balanceOf(await deployer.getAddress());
            expect(platformAfter - platformBefore).to.equal(0n);
            expect(recipAfter - recipBefore).to.equal(0n);
        });
    });

    describe("Fee bounds and setters", async () => {
        it("locker rejects fee percentages over maxima", async () => {
            await expect(
                locker.updateFeeShares(0, 0, 500_000_001n, 500_000_001n)
            ).to.be.revertedWithCustomError(
                locker,
                "FeeTooLarge"
            );
            await expect(locker.updateHarvestBountyPercentage(100_000_001)).to.be.revertedWithCustomError(
                locker,
                "FeeTooLarge"
            );
            await expect(locker.updateRepayFeePercentage(100_000_001)).to.be.revertedWithCustomError(
                locker,
                "FeeTooLarge"
            );
        });

        it("vault rejects fee percentages over maxima", async () => {
            await expect(maturityVault.updatePlatformFeePercentage(500_000_001)).to.be.revertedWithCustomError(
                maturityVault,
                "InvalidPercentage"
            );
            await expect(maturityVault.updateHarvestBountyPercentage(100_000_001)).to.be.revertedWithCustomError(
                maturityVault,
                "InvalidPercentage"
            );
        });
    });

    describe("Keeper ops: processVaultExpiredLocks", async () => {
        const depositAmount = ethers.parseEther("500");

        beforeEach(async () => {
            await locker.updateWhitelist(await deployer.getAddress(), true);
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
        });

        it("releases expired locks to pool and may relock excess", async () => {
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            const poolBefore = await locker.totalRaacInPool();
            await locker.connect(deployer).processVaultExpiredLocks();
            const poolAfter = await locker.totalRaacInPool();
            expect(poolAfter).to.be.gte(poolBefore);
        });
    });
    describe("Edge cases & fees", async () => {
        const depositAmount = ethers.parseEther("1000");
        const rewardAmount = ethers.parseEther("500");

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            await raac.connect(alice).transfer(await deployer.getAddress(), ethers.parseEther("10000"));
        });

        it("donate distributes rewards; borrow consumes rewards before creating debt", async () => {
            // deployer funds donate to locker
            await raac.approve(await locker.getAddress(), rewardAmount);
            await locker.connect(deployer).donate(rewardAmount);

            // All rewards attributed to alice (only depositor)
            let [totalDeposited, , , totalBorrowed, totalReward] = await locker.getUserInfo(await alice.getAddress());
            expect(totalDeposited).to.equal(depositAmount);
            expect(totalBorrowed).to.equal(0n);
            expect(totalReward).to.equal(rewardAmount);

            // Borrow less than rewards: no debt should be created
            const borrowFromRewards = ethers.parseEther("200");
            await locker.connect(alice).borrow(borrowFromRewards, false);

            ;[, , , totalBorrowed, totalReward] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(0n);
            expect(totalReward).to.equal(rewardAmount - borrowFromRewards);
        });

        it("repay collects fee in leRAAC to platform", async () => {
            const half = ethers.parseEther("500");
            // Borrow to wallet (mint leRAAC to alice)
            await locker.connect(alice).borrow(half, false);

            // Set a 1% repay fee
            await locker.updateRepayFeePercentage(10_000_000);

            const repayAmount = ethers.parseEther("100");
            const fee = (repayAmount * 10_000_000n) / 1_000_000_000n;

            // Approve locker to burn repayAmount and transfer fee from alice
            await leRAAC.connect(alice).approve(await locker.getAddress(), repayAmount + fee);

            const treasuryAddr = await locker.treasury();
            const treasuryBalBefore = await leRAAC.balanceOf(treasuryAddr);

            await locker.connect(alice).repay(repayAmount);

            const treasuryBalAfter = await leRAAC.balanceOf(treasuryAddr);
            expect(treasuryBalAfter - treasuryBalBefore).to.equal(fee);

            const [, , , totalBorrowedAfter] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowedAfter).to.equal(half - repayAmount + fee);
        });

        it("processVaultExpiredLocks restricted to keeper", async () => {
            await expect(locker.connect(alice).processVaultExpiredLocks()).to.be.revertedWithCustomError(
                locker,
                "Unauthorized"
            );
        });

        it("vault whitelist required for locker distribution", async () => {
            // remove locker from vault whitelist
            await maturityVault.updateWhitelists([await locker.getAddress()], [false]);

            const donateAmount = ethers.parseEther("1");
            await raac.approve(await locker.getAddress(), donateAmount);
            await expect(locker.donate(donateAmount)).to.be.revertedWith("Distribution failed");
        });
    });

    describe("Fee shares distribution", async () => {
        let mockBotLocker;
        let mockCleverFeeRecipient;

        beforeEach(async () => {
            // Deploy mock contracts
            const MockBotLocker = await ethers.getContractFactory("MockToken", deployer);
            mockBotLocker = await MockBotLocker.deploy("MockBotLocker", "MBL", 18);
            await mockBotLocker.waitForDeployment();

            const MockCleverFeeRecipient = await ethers.getContractFactory("MockToken", deployer);
            mockCleverFeeRecipient = await MockCleverFeeRecipient.deploy("MockCleverFee", "MCF", 18);
            await mockCleverFeeRecipient.waitForDeployment();

            // Set fee shares: 20% total, split as 5% bots, 5% clever, 10% treasury
            const feeSharesBots = 50_000_000n; // 5%
            const feeSharesClever = 50_000_000n; // 5%
            const feeSharesTreasury = 100_000_000n; // 10%
            // Total = 20% = PLATFORM_FEE

            await locker.updateFeeShares(feeSharesBots, feeSharesClever, feeSharesTreasury, PLATFORM_FEE);
            // Note: In real implementation, raacBotLocker and cleverFeeRecipient need to be set
            // For testing, we'll test the fee share validation logic
        });

        it("reverts when fee shares don't sum to treasury fee percentage", async () => {
            await expect(
                locker.updateFeeShares(50_000_000n, 50_000_000n, 50_000_000n, PLATFORM_FEE) // sums to 15%, not 20%
            ).to.be.revertedWithCustomError(locker, "FeeSharesNotMatchingTreasuryFee");
        });

        it("allows zero fee shares when treasury fee is zero", async () => {
            await locker.updateFeeShares(0, 0, 0, 0);
            expect(await locker.feeSharesBots()).to.equal(0n);
            expect(await locker.feeSharesClever()).to.equal(0n);
            expect(await locker.feeSharesTreasury()).to.equal(0n);
            // Restore
            await locker.updateFeeShares(FEE_SHARES_BOT, FEE_SHARES_CLEVER, FEE_SHARES_TREASURY, PLATFORM_FEE);
        });

        it("updates fee shares correctly", async () => {
            const feeSharesBots = 50_000_000n;
            const feeSharesClever = 50_000_000n;
            const feeSharesTreasury = 100_000_000n;
            await locker.updateFeeShares(feeSharesBots, feeSharesClever, feeSharesTreasury, PLATFORM_FEE);
            expect(await locker.feeSharesBots()).to.equal(feeSharesBots);
            expect(await locker.feeSharesClever()).to.equal(feeSharesClever);
            expect(await locker.feeSharesTreasury()).to.equal(feeSharesTreasury);
        });
    });

    describe("Treasury and zap updates", async () => {
        it("updates treasury address", async () => {
            const newTreasury = await bob.getAddress();
            await locker.updateTreasury(newTreasury);
            expect(await locker.treasury()).to.equal(newTreasury);
            // Restore
            await locker.updateTreasury(await deployer.getAddress());
        });

        it("reverts updating treasury to zero address", async () => {
            await expect(locker.updateTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
                locker,
                "ZeroAddress"
            );
        });

        it("updates zap address", async () => {
            const newZap = await bob.getAddress();
            await locker.updateZap(newZap);
            expect(await locker.zap()).to.equal(newZap);
            // Restore
            await locker.updateZap(await zap.getAddress());
        });

        it("reverts updating zap to zero address", async () => {
            await expect(locker.updateZap(ethers.ZeroAddress)).to.be.revertedWithCustomError(
                locker,
                "ZeroAddress"
            );
        });
    });

    describe("View functions", async () => {
        const depositAmount = ethers.parseEther("1000");
        const firstChunk = ethers.parseEther("200");
        const secondChunk = depositAmount - firstChunk;

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(firstChunk);
            await locker.connect(alice).deposit(secondChunk);
        });

        it("getUserInfo returns correct values", async () => {
            const [totalDeposited, totalPendingUnlocked, totalUnlocked, totalBorrowed, totalReward] =
                await locker.getUserInfo(await alice.getAddress());
            expect(totalDeposited).to.equal(depositAmount);
            expect(totalPendingUnlocked).to.equal(0n);
            expect(totalUnlocked).to.equal(0n);
            expect(totalBorrowed).to.equal(0n);
            expect(totalReward).to.equal(0n);
        });

        it("getUserLocks returns pending unlock entries", async () => {
            await locker.connect(alice).requestUnlock(firstChunk); // reserves the first (firstChunk) entry

            const pendingUnlocks = await locker.getUserLocks(await alice.getAddress());

            // Both deposits mature in the same epoch, so _appendOrMergeUnlock collapses
            // them into one bucket that the request reserves only part of.
            expect(pendingUnlocks.length).to.equal(1);
            const [entry] = pendingUnlocks;
            expect(entry.pendingUnlock).to.equal(firstChunk + secondChunk);
            expect(entry.reservedAmount).to.equal(firstChunk);

            // The open remainder is the part that auto-relocks at maturity
            expect(entry.pendingUnlock - entry.reservedAmount).to.equal(secondChunk);
        });

        it("excludes past unlock entries", async () => {
            await locker.connect(alice).requestUnlock(firstChunk); // reserves the first (firstChunk) entry

            // Get locks before maturity - should include the unlock entry
            let pendingUnlocks = await locker.getUserLocks(await alice.getAddress());
            const reservedEntryBefore = pendingUnlocks.find((entry) => entry.reservedAmount === firstChunk);
            expect(reservedEntryBefore).to.not.be.undefined;

            // Fast forward past lock duration to ensure maturity
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // Process expired locks to update nextUnlockIndex
            await locker.connect(deployer).processVaultExpiredLocks();

            // Trigger user checkpoint to process matured entries
            await locker.connect(alice).borrow(1n, false);

            // Get locks after maturity - past entries should be excluded
            pendingUnlocks = await locker.getUserLocks(await alice.getAddress());
            const reservedEntryAfter = pendingUnlocks.find((entry) => entry.reservedAmount === firstChunk);
            expect(reservedEntryAfter).to.be.undefined; // Past entry should be excluded
        });

        it("handles getUserLocks when nextUnlockIndex is non-zero", async () => {
            const dep = ethers.parseEther("1000");
            await raac.connect(alice).transfer(await bob.getAddress(), dep);
            await raac.connect(bob).approve(await locker.getAddress(), dep);

            // Create an unlock request that will mature
            const unlock1 = ethers.parseEther("200");
            await locker.connect(bob).deposit(unlock1);
            await locker.connect(bob).requestUnlock(unlock1);

            // Fast forward past lock duration
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // Process expired locks
            await locker.connect(deployer).processVaultExpiredLocks();

            await locker.connect(bob).withdrawUnlocked();

            // Create new unlock requests after nextUnlockIndex has advanced
            const unlock2 = ethers.parseEther("150");
            const unlock3 = ethers.parseEther("100");
            await locker.connect(bob).deposit(unlock2);
            await locker.connect(bob).requestUnlock(unlock2);
            await locker.connect(bob).deposit(unlock3);
            await locker.connect(bob).requestUnlock(unlock3);

            // Get locks - should only return future entries (unlock2 and unlock3)
            // The past entry (unlock1) should be excluded even though it's in the list
            const pendingUnlocks = await locker.getUserLocks(await bob.getAddress());

            const reservedEntries = pendingUnlocks.filter((entry) => entry.reservedAmount > 0n);

            // Should not include the matured unlock1
            const unlock1Entry = reservedEntries.find((entry) => entry.pendingUnlock === unlock1);
            expect(unlock1Entry).to.be.undefined;

            // unlock2 and unlock3 share an unlock epoch, so they merge into a single
            // fully-reserved bucket rather than staying two separate entries.
            const totalReserved = reservedEntries.reduce((sum, entry) => sum + entry.reservedAmount, 0n);
            expect(totalReserved).to.equal(unlock2 + unlock3);

            const totalInReservedEntries = reservedEntries.reduce((sum, entry) => sum + entry.pendingUnlock, 0n);
            expect(totalInReservedEntries).to.equal(unlock2 + unlock3);
        });

        it("returns totalRaacInPool pool balance", async () => {
            const poolBalance = await locker.totalRaacInPool();
            expect(poolBalance).to.be.gte(0n);
        });
    });


    describe("Reserve rate and health checks", async () => {
        const depositAmount = ethers.parseEther("1000");

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
        });

        it("allows borrowing up to reserve rate limit", async () => {
            const maxBorrow = ethers.parseEther("500"); // 50% of 1000
            await locker.connect(alice).borrow(maxBorrow, false);
            const [, , , totalBorrowed] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(maxBorrow);
        });

        it("reverts borrowing over reserve rate limit", async () => {
            const tooMuch = ethers.parseEther("501"); // > 50% of 1000
            await expect(locker.connect(alice).borrow(tooMuch, false)).to.be.revertedWithCustomError(
                locker,
                "InsufficientCollateral"
            );
        });

        it("blocks reserving collateral that is backing an open borrow", async () => {
            const borrowAmount = ethers.parseEther("500");
            await locker.connect(alice).borrow(borrowAmount, false);

            // Health is enforced when the reservation is made: borrowing the maximum
            // leaves no free collateral, so nothing can be scheduled for unlock.
            await expect(locker.connect(alice).requestUnlock(1n)).to.be.revertedWithCustomError(
                locker,
                "InsufficientCollateral"
            );
        });
    });

    describe("Reward distribution and accounting", async () => {
        const depositAmount = ethers.parseEther("1000");
        const rewardAmount = ethers.parseEther("100");

        beforeEach(async () => {
            await raac.connect(alice).approve(await locker.getAddress(), depositAmount);
            await locker.connect(alice).deposit(depositAmount);
            await raac.connect(alice).transfer(await deployer.getAddress(), rewardAmount);
            await raac.connect(alice).transfer(await bob.getAddress(), ethers.parseEther("500"));
        });

        it("distributes rewards proportionally to locked amounts", async () => {
            // Bob also deposits
            const bobDeposit = ethers.parseEther("500");
            await raac.connect(bob).approve(await locker.getAddress(), bobDeposit);
            console.log("bob bal", await raac.balanceOf(bob.address))
            await locker.connect(bob).deposit(bobDeposit);

            // // Donate rewards
            await raac.approve(await locker.getAddress(), rewardAmount);
            await locker.connect(deployer).donate(rewardAmount);

            // // Alice should get 2/3 of rewards (1000 / 1500)
            const [, , , , aliceReward] = await locker.getUserInfo(await alice.getAddress());
            const [, , , , bobReward] = await locker.getUserInfo(await bob.getAddress());

            // // Approximate check
            expect(aliceReward).to.be.closeTo((rewardAmount * 1000n) / 1500n, ethers.parseEther("0.01"));
            expect(bobReward).to.be.closeTo((rewardAmount * 500n) / 1500n, ethers.parseEther("0.01"));
        });

        it("rewards offset debt when borrowing", async () => {
            // Donate rewards first
            await raac.approve(await locker.getAddress(), rewardAmount);
            await locker.connect(deployer).donate(rewardAmount);

            // Borrow less than rewards - should consume rewards, not create debt
            const borrowAmount = ethers.parseEther("50");
            await locker.connect(alice).borrow(borrowAmount, false);

            const [, , , totalBorrowed, totalReward] = await locker.getUserInfo(await alice.getAddress());
            expect(totalBorrowed).to.equal(0n);
            expect(totalReward).to.be.closeTo(rewardAmount - borrowAmount, ethers.parseEther("0.01"));
        });
    });

    describe("Reward tokens management", async () => {
        it("adds reward token", async () => {
            // Reward tokens are now registered on veRAAC, not the locker.
            const newToken = CRVUSD;
            // Should not revert
            await expect(ve.addRewardToken(newToken)).to.not.be.reverted;
            // Adding the same token twice reverts
            await expect(ve.addRewardToken(newToken)).to.be.revertedWithCustomError(
                ve,
                "TokenAlreadyAdded"
            );
        });
    });
    describe("Inactive user withdrawal protection", async () => {
        // Regression test for the vulnerability where scheduled withdrawals become
        // inaccessible if users remain inactive beyond the old 16-epoch backward
        // lookback window in processVaultExpiredLocks().
        //
        // The fix replaces the epoch-based loops with:
        //   minRequired = totalUnlockedGlobal + totalPendingUnlockGlobal
        // so requested amounts are always protected regardless of inactivity duration.

        const aliceDeposit = ethers.parseEther("1000");
        const bobDeposit = ethers.parseEther("500");

        beforeEach(async () => {
            await raac.connect(alice).transfer(await bob.getAddress(), bobDeposit);
        });

        it("protects scheduled withdrawal even after 16+ epochs of user inactivity", async () => {
            // 1. Alice deposits and immediately requests unlock of her whole position
            await raac.connect(alice).approve(await locker.getAddress(), aliceDeposit);
            await locker.connect(alice).deposit(aliceDeposit);
            await locker.connect(alice).requestUnlock(aliceDeposit);

            // Verify the reservation is tracked as pending
            const [, pendingAfterRequest] = await locker.getUserInfo(await alice.getAddress());
            expect(pendingAfterRequest).to.equal(aliceDeposit);

            // 2. Fast-forward past lock maturity (16 epochs + buffer)
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);

            // Keeper releases expired locks from veRAAC
            await locker.connect(deployer).processVaultExpiredLocks();

            // 3. Alice does NOT interact for another 18 epochs (past the old 16-epoch window)
            //    This is the crux of the bug: the old backward loop would stop protecting
            //    Alice's pendingUnlocked[epoch] entry after 16 epochs.
            await timeIncreaseWithMining(EPOCH * 18);

            // Keeper calls processVaultExpiredLocks again — under the old code Alice's
            // RAAC would be relocked here because it fell outside the backward window.
            await locker.connect(deployer).processVaultExpiredLocks();

            // 4. Even after 18+ epochs of inactivity, alice's matured reserved amount
            //    must still be fully accounted for as totalUnlocked (not silently lost
            //    or relocked), and the pool must hold enough RAAC to cover it.
            const [, , totalUnlockedAfterInactivity] = await locker.getUserInfo(await alice.getAddress());
            expect(totalUnlockedAfterInactivity).to.equal(aliceDeposit);

            const poolBalance = await locker.totalRaacInPool();
            expect(poolBalance).to.be.gte(aliceDeposit);

            // 5. Alice finally comes back and withdraws — must succeed
            const raacBefore = await raac.balanceOf(await alice.getAddress());
            await locker.connect(alice).withdrawUnlocked();
            const raacAfter = await raac.balanceOf(await alice.getAddress());
            expect(raacAfter - raacBefore).to.equal(aliceDeposit);

            const [, , totalUnlockedAfterWithdraw] = await locker.getUserInfo(await alice.getAddress());
            expect(totalUnlockedAfterWithdraw).to.equal(0n);
        });

        it("multiple users: inactive user does not steal liquidity from active user", async () => {
            // 1. Alice deposits and requests unlock of her whole position
            await raac.connect(alice).approve(await locker.getAddress(), aliceDeposit);
            await locker.connect(alice).deposit(aliceDeposit);
            await locker.connect(alice).requestUnlock(aliceDeposit);

            // 2. Bob deposits at roughly the same time and requests unlock of his whole position
            await raac.connect(bob).approve(await locker.getAddress(), bobDeposit);
            await locker.connect(bob).deposit(bobDeposit);
            await locker.connect(bob).requestUnlock(bobDeposit);

            // 3. Both locks mature
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await locker.connect(deployer).processVaultExpiredLocks();

            // 4. Alice stays inactive for 20 epochs past maturity; Bob also stays inactive
            await timeIncreaseWithMining(EPOCH * 20);
            await locker.connect(deployer).processVaultExpiredLocks();

            // 5. Pool must have enough for both withdrawals
            const poolBalance = await locker.totalRaacInPool();
            expect(poolBalance).to.be.gte(aliceDeposit + bobDeposit);

            // 6. Bob withdraws first — should succeed
            const bobRaacBefore = await raac.balanceOf(await bob.getAddress());
            await locker.connect(bob).withdrawUnlocked();
            const bobRaacAfter = await raac.balanceOf(await bob.getAddress());
            expect(bobRaacAfter - bobRaacBefore).to.equal(bobDeposit);

            // 7. Alice withdraws after Bob — should also succeed (not short on liquidity)
            const aliceRaacBefore = await raac.balanceOf(await alice.getAddress());
            await locker.connect(alice).withdrawUnlocked();
            const aliceRaacAfter = await raac.balanceOf(await alice.getAddress());
            expect(aliceRaacAfter - aliceRaacBefore).to.equal(aliceDeposit);
        });

        it("repeated processVaultExpiredLocks calls never relock reserved amounts", async () => {
            // 1. Alice deposits (split so the reservation consumes just the first half)
            //    and requests a partial unlock
            const unlockAmount = ethers.parseEther("500");
            await raac.connect(alice).approve(await locker.getAddress(), aliceDeposit);
            await locker.connect(alice).deposit(unlockAmount);
            await locker.connect(alice).deposit(aliceDeposit - unlockAmount);
            await locker.connect(alice).requestUnlock(unlockAmount);

            // 2. Mature and release
            await timeIncreaseWithMining(LOCK_DURATION + EPOCH);
            await locker.connect(deployer).processVaultExpiredLocks();

            // 3. Call processVaultExpiredLocks many times over a long span while Alice is inactive
            for (let i = 0; i < 5; i++) {
                await timeIncreaseWithMining(EPOCH * 20);
                await locker.connect(deployer).processVaultExpiredLocks();
            }
            // Total additional time: 100 epochs — well past the 52-epoch lock window

            // 4. Pool must still have enough for Alice
            const poolBalance = await locker.totalRaacInPool();
            expect(poolBalance).to.be.gte(unlockAmount);

            // 5. Alice withdraws successfully
            const raacBefore = await raac.balanceOf(await alice.getAddress());
            await locker.connect(alice).withdrawUnlocked();
            const raacAfter = await raac.balanceOf(await alice.getAddress());
            expect(raacAfter - raacBefore).to.equal(unlockAmount);
        });
    });

});
