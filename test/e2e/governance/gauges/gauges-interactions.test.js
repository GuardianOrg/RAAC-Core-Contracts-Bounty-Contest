import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

async function goToNextPeriod(gauge) {
    const {periodStartTime, periodEndTime} = await gauge.getPeriodBoundaries();
    // Might be lower than the previous block
    await time.setNextBlockTimestamp(periodEndTime > BigInt(await time.latest()) ? periodEndTime + 1n : BigInt(await time.latest()) + 1n);
    await network.provider.send("evm_mine");
}

describe("Gauges with multiple tokens and users", function() {
    let owner;
    let alice;
    let bob;
    let carol;
    let david;
    let eve;
    let frank; // dedicated gauge voter

    let raacToken;
    let veRAACToken;

    let stakingToken;

    let rewardToken;
    let rewardToken2;

    let gaugeController;
    let gaugeRewardsDistributor;
    let rwaGauge;

    const STABLE_MINT_AMOUNT = ethers.parseEther("100000");

    const MINUTE = 60;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const MAX_LOCK_EPOCHS = 52;

    // streaming/rounding dust tolerance
    const DUST = ethers.parseEther("0.005");

    async function depositMain(amount) {
        await rewardToken.approve(await gaugeRewardsDistributor.getAddress(), amount);
        await gaugeRewardsDistributor.deposit(await rewardToken.getAddress(), amount);
    }

    // rewardToken2 is an extra reward token on the gauge: deposits stream over 1 week
    // based on raw staked balances
    async function depositExtra(amount) {
        await rewardToken2.approve(await rwaGauge.getAddress(), amount);
        await rwaGauge.depositRewardToken(await rewardToken2.getAddress(), amount);
    }

    // claims main + extra reward tokens for a user (old claimRewards() claimed everything)
    async function claimAll(user) {
        await rwaGauge.connect(user).claimRewardToken();
        await rwaGauge.connect(user).claimExtraRewards();
    }

    // sends a user's reward balances back to owner so per-cycle balances start at 0
    async function sweep(user) {
        const b1 = await rewardToken.balanceOf(user.address);
        if (b1 > 0n) await rewardToken.connect(user).transfer(owner.address, b1);
        const b2 = await rewardToken2.balanceOf(user.address);
        if (b2 > 0n) await rewardToken2.connect(user).transfer(owner.address, b2);
    }

    before(async () => {
        [owner, alice, bob, carol, david, eve, frank] = await ethers.getSigners();

        const MockTokenFactory = await ethers.getContractFactory("MockToken");

        rewardToken = await MockTokenFactory.deploy("USD Coin", "USDC", 18);
        await rewardToken.waitForDeployment();

        rewardToken2 = await MockTokenFactory.deploy("Curve USD", "crvUD", 18);
        await rewardToken2.waitForDeployment();

        // Staking token can be a LP for instance (RToken <> DEToken)
        stakingToken = await MockTokenFactory.deploy("LP RToken <> DEToken", "LP", 18);
        await stakingToken.waitForDeployment();

        const RAACTokenFactory = await ethers.getContractFactory("RAACToken");
        raacToken = await RAACTokenFactory.deploy(owner.address); // tax params removed
        await raacToken.waitForDeployment();

        // VeRAACToken requires linked libraries (LockManager first, everything links it)
        const LockManagerFactory = await ethers.getContractFactory("LockManager");
        const lockManagerLib = await LockManagerFactory.deploy();
        const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const ragequitLib = await RagequitLibFactory.deploy();
        const PowerCheckpointFactory = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const powerCheckpointLib = await PowerCheckpointFactory.deploy();
        const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
            libraries: { LockManager: lockManagerLib.target },
        });
        const rewardLib = await RewardLibFactory.deploy();
        const VETokenFactory = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target,
            },
        });
        veRAACToken = await VETokenFactory.deploy(await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veRAACToken.waitForDeployment();

        const GaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await GaugeControllerFactory.deploy(await veRAACToken.getAddress());
        await gaugeController.waitForDeployment();

        const GaugeRewardsDistributorFactory = await ethers.getContractFactory("GaugeRewardsDistributor");
        gaugeRewardsDistributor = await GaugeRewardsDistributorFactory.deploy(
            await gaugeController.getAddress(),
            await rewardToken.getAddress()
        );
        await gaugeRewardsDistributor.waitForDeployment();
        await gaugeController.setDistributor(await gaugeRewardsDistributor.getAddress());

        const RWAGaugeFactory = await ethers.getContractFactory("RWAGauge");
        rwaGauge = await RWAGaugeFactory.deploy(
            await stakingToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,                           
            await raacToken.getAddress(),
            await rewardToken.getAddress(),
            await gaugeRewardsDistributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        // Set minter on RAAC
        await raacToken.connect(owner).setMinter(owner.address);

        // Mint RAAC to alice, bob and carol
        await raacToken.mint(alice.address, ethers.parseEther("1000"));
        await raacToken.mint(bob.address, ethers.parseEther("1000"));
        // Carol to have less
        await raacToken.mint(carol.address, ethers.parseEther("100"));
        await raacToken.mint(david.address, ethers.parseEther("100"));
        // Frank only votes; small lock so it barely dilutes the users' boost share
        await raacToken.mint(frank.address, ethers.parseEther("10"));

        // Mint LP tokens to users
        await stakingToken.mint(alice.address, ethers.parseEther("1000"));
        // All to have less, even bob
        await stakingToken.mint(bob.address, ethers.parseEther("100"));
        await stakingToken.mint(carol.address, ethers.parseEther("100"));
        await stakingToken.mint(david.address, ethers.parseEther("100"));
        await stakingToken.mint(eve.address, ethers.parseEther("100"));

        // Mint reward tokens to owner
        await rewardToken.mint(owner.address, STABLE_MINT_AMOUNT);
        await rewardToken2.mint(owner.address, STABLE_MINT_AMOUNT);
    });



    describe('Setup', function() {
        it('should advance to gauge start time', async function() {
            // Get the gauge start time
            const gaugeData = await rwaGauge.gaugeData();
            const gaugeStartTime = gaugeData.gaugeInitialStartTime;

            // Advance to the gauge start time (next Thursday midnight after deploy)
            if (BigInt(await time.latest()) < gaugeStartTime) {
                await time.setNextBlockTimestamp(gaugeStartTime);
                await network.provider.send("evm_mine");
            }
        });

        it('should allow to grant controller role to the gauge', async function() {
            await rwaGauge.grantRole(await rwaGauge.CONTROLLER_ROLE(), owner.address);
        });

        it('should allow to add a gauge in a controller', async function() {
            await gaugeController.addGauge(await rwaGauge.getAddress());
        });

        it('should allow to add a distributor to a gauge', async function() {
            // the main reward distributor is fixed in the constructor; manageDistributor
            // registers extra-reward depositors (owner deposits rewardToken2)
            await rwaGauge.manageDistributor(owner.address, true);
            const distributors = await rwaGauge.getDistributors();
            expect(distributors).to.include(owner.address);
        });

        it('should expose the main reward token fixed at construction', async function() {
            expect(await gaugeRewardsDistributor.rewardToken()).to.equal(await rewardToken.getAddress());
            expect((await rwaGauge.gaugeData()).rewardToken).to.equal(await rewardToken.getAddress());
        });

        it('should allow to add second reward token to the gauge', async function() {
            // second reward tokens are handled by the gauge's extra-reward streaming now
            await rwaGauge.addRewardToken(await rewardToken2.getAddress());
            expect(await rwaGauge.getExtraRewardTokens()).to.deep.equal([await rewardToken2.getAddress()]);
        });

        it('should let frank vote for the gauge so deposits can be claimed', async function() {
            // deposits at epochs with zero total vote weight become unallocated, so a
            // dedicated voter keeps the (single) gauge at 100% relative weight
            await raacToken.connect(frank).approve(await veRAACToken.getAddress(), ethers.parseEther("2"));
            await veRAACToken.connect(frank).lock(ethers.parseEther("2"), MAX_LOCK_EPOCHS);
            await gaugeController.connect(frank).vote(await rwaGauge.getAddress(), 10000);
            // votes activate at the NEXT weekly epoch
            await time.increase(WEEK);
        });
    });

    describe('Cycle 1: Single Token, Single User - Alice only', function() {
        it('should allow alice to stake', async function() {
            await stakingToken.connect(alice).approve(await rwaGauge.getAddress(), ethers.parseEther("1000"));
            await rwaGauge.connect(alice).stake(ethers.parseEther("100"));

            expect(await rwaGauge.rawBalanceOf(alice.address)).to.equal(ethers.parseEther("100"));
            // no veRAAC lock -> 40% base working balance
            expect(await rwaGauge.balanceOf(alice.address)).to.equal(ethers.parseEther("40"));
        });

        it('should deposit first reward token', async function() {
            await depositMain(ethers.parseEther("10"));
            // Distributor has the funds
            expect(await rewardToken.balanceOf(await gaugeRewardsDistributor.getAddress())).to.equal(ethers.parseEther("10"));
        });

        it('should pull rewards from the distributor', async function() {
            // syncRewardTokens() became pullRewardsFromDistributor()
            await rwaGauge.pullRewardsFromDistributor();
            // Should have pulled the funds from the distributor (100% relative weight)
            expect(await rewardToken.balanceOf(await rwaGauge.getAddress())).to.equal(ethers.parseEther("10"));
            expect(await rewardToken.balanceOf(await gaugeRewardsDistributor.getAddress())).to.equal(0n);
        });

        it('should let full period pass', async function() {
            await goToNextPeriod(rwaGauge);
        });

        it('should allow to see pending rewards', async function() {
            // pendingRewards is (user) now — main reward token only
            const pending = await rwaGauge.pendingRewards(alice.address);
            expect(pending).to.closeTo(ethers.parseEther("10"), DUST);
        });
        it('should claim rewards - alice gets 100%', async function() {
            const balanceBefore = await rewardToken.balanceOf(alice.address);
            await rwaGauge.connect(alice).claimRewardToken();
            const balanceAfter = await rewardToken.balanceOf(alice.address);

            const claimed = balanceAfter - balanceBefore;
            expect(claimed).to.closeTo(ethers.parseEther("10"), DUST);
            expect(await rewardToken.balanceOf(await rwaGauge.getAddress())).to.closeTo(0n, DUST);

            // To help with test, we donate all alice's reward to owner
            await sweep(alice);
        });
        it('should allow to see earned rewards', async function() {
            // earnedReward is (user) now — main token only
            const earned = await rwaGauge.earnedReward(alice.address);
            expect(earned).to.closeTo(ethers.parseEther("10"), DUST);
        });
        it('should allow user to see reward token data', async function() {
            const rewardTokenData = await rwaGauge.getUserRewardTokenData(await rewardToken.getAddress(), alice.address);

            // exact integral magic numbers depend on the streaming schedule; assert the
            // protective invariants instead
            expect(rewardTokenData.integral).to.be.gt(0n);
            expect(rewardTokenData.lastGaugeIntegral).to.be.gt(0n);
            expect(rewardTokenData.claimable).to.equal(0n);
            expect(rewardTokenData.claimed).to.closeTo(ethers.parseEther("10"), DUST);
            expect(rewardTokenData.lastUpdate).to.closeTo(await time.latest(), 1000);
        });
        it('should allow to see gauge reward token data', async function() {
            const rewardTokenData = await rwaGauge.getGaugeRewardTokenData(await rewardToken.getAddress());

            expect(rewardTokenData.isActive).to.be.true;
            expect(rewardTokenData.decimals).to.equal(18);
            expect(rewardTokenData.integral).to.be.gt(0n);
            expect(rewardTokenData.distributed).to.equal(ethers.parseEther("10"));
            expect(rewardTokenData.leftoverRewards).to.closeTo(0n, DUST);
        });
        it('should allow to see all pending rewards', async function() {
            expect(await rwaGauge.pendingRewards(alice.address)).to.equal(0n);
            const [tokens, pendingExtra] = await rwaGauge.allPendingExtraRewards(alice.address);
            expect(tokens).to.deep.equal([await rewardToken2.getAddress()]);
            expect(pendingExtra).to.deep.equal([0n]);
        });
        it('should allow to see all earned rewards', async function() {
            expect(await rwaGauge.earnedReward(alice.address)).to.closeTo(ethers.parseEther("10"), DUST);
            expect(await rwaGauge.earnedExtraReward(await rewardToken2.getAddress(), alice.address)).to.equal(0n);
        });
    });

    describe('Cycle 2: Single Token, Two Users - Alice + bob who joins with 10% of alice stake', function() {
        it('should allow bob to stake', async function() {
            await stakingToken.connect(bob).approve(await rwaGauge.getAddress(), ethers.parseEther("10"));
            await rwaGauge.connect(bob).stake(ethers.parseEther("10"));

            expect(await rwaGauge.rawBalanceOf(bob.address)).to.equal(ethers.parseEther("10"));
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("4"));
        });

        it('should deposit rewards for cycle 2', async function() {
            await depositMain(ethers.parseEther("10"));
        });

        it('should pull rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
            // Should have pulled the funds from the distributor
            expect(await rewardToken.balanceOf(await rwaGauge.getAddress())).to.closeTo(ethers.parseEther("10"), DUST);
        });

        it('should let full period pass', async function() {
            await goToNextPeriod(rwaGauge);
        });

        it('should claim rewards', async function() {
            await rwaGauge.connect(alice).claimRewardToken();
            await rwaGauge.connect(bob).claimRewardToken();

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);

            // bob's working balance is 10% of alice's
            expect(bobBalance).to.closeTo(aliceBalance * 10n / 100n, ethers.parseEther("0.001"));

            const deposited = ethers.parseEther("10");
            expect(await rewardToken.balanceOf(await rwaGauge.getAddress())).to.closeTo(0n, DUST);
            expect(bobBalance + aliceBalance).to.closeTo(deposited, DUST);

            const totalShares = await rwaGauge.totalSupply();
            const bobShares = await rwaGauge.balanceOf(bob.address);
            const aliceShares = await rwaGauge.balanceOf(alice.address);

            const bobExpectedReward = (deposited * bobShares) / totalShares;
            const aliceExpectedReward = (deposited * aliceShares) / totalShares;

            expect(bobBalance).to.closeTo(bobExpectedReward, DUST);
            expect(aliceBalance).to.closeTo(aliceExpectedReward, DUST);

            // Both send back to owner
            await sweep(alice);
            await sweep(bob);
        });
    });
    describe('Cycle 3: Single Token, Two Users - Alice lock raac mid period, which causes bob to stake all the rest he can', function() {
        it('should allow alice to lock raac', async function() {
            // Check initial state
            const workingBalanceBefore = await rwaGauge.balanceOf(alice.address);
            expect(workingBalanceBefore).to.equal(ethers.parseEther("40"));

            const rawBalance = await rwaGauge.rawBalanceOf(alice.address);
            const [boostBefore, ] = await gaugeController.calculateBoost(alice.address, await rwaGauge.getAddress(), rawBalance);
            expect(boostBefore).to.equal(10000n); // MIN_BOOST

            // locks are (amount, epochs) now; 26 epochs ~ 6 months
            await raacToken.connect(alice).approve(await veRAACToken.getAddress(), ethers.parseEther("25"));
            await veRAACToken.connect(alice).lock(ethers.parseEther("25"), 26);

            // veToken balance increased
            const veTokenBalance = await veRAACToken.balanceOf(alice.address);
            expect(veTokenBalance).to.be.gt(0);

            const [boostAfterLock, ] = await gaugeController.calculateBoost(alice.address, await rwaGauge.getAddress(), rawBalance);
            expect(boostAfterLock).to.be.gt(boostBefore);
            // the boost is time-weighted over a 7-day window now, so right after the
            // lock it sits slightly below MAX_BOOST
            expect(boostAfterLock).to.be.closeTo(25000n, 500n);

            // Update working balance to reflect the new boost (self-update, 1-arg now)
            await rwaGauge.connect(alice).updateUserRewards(alice.address);

            const workingBalanceAfter = await rwaGauge.balanceOf(alice.address);
            expect(workingBalanceAfter).to.be.gt(workingBalanceBefore);
            // boost ramps over 7 days: ~98.4 right after the lock, capped at 100 raw
            expect(workingBalanceAfter).to.be.closeTo(ethers.parseEther("100"), ethers.parseEther("2"));

            expect(await rwaGauge.rawBalanceOf(alice.address)).to.be.eq(ethers.parseEther("100"));
        });
        it('should deposit rewards for cycle 3', async function() {
            await depositMain(ethers.parseEther("10"));
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should advance mid period', async function() {
            const {periodStartTime, periodEndTime} = await rwaGauge.getPeriodBoundaries();
            // Mid period because full is 28
            await time.setNextBlockTimestamp(periodEndTime - BigInt(14 * DAY));
            await network.provider.send("evm_mine");
        });
        it('should allow both to claim rewards', async function() {
            await rwaGauge.connect(alice).claimRewardToken();
            await rwaGauge.connect(bob).claimRewardToken();

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);

            const totalShares = await rwaGauge.totalSupply();
            const bobShares = await rwaGauge.balanceOf(bob.address);
            const aliceShares = await rwaGauge.balanceOf(alice.address);

            const considered = ethers.parseEther("5"); // 10 but half period
            const bobExpectedReward = (considered * bobShares) / totalShares;
            const aliceExpectedReward = (considered * aliceShares) / totalShares;

            // alice's boost ramps up over the 7-day window, so her time-averaged share
            // during the stream sits below her final share (and bob's above his)
            expect(aliceBalance).to.closeTo(aliceExpectedReward, ethers.parseEther("0.35"));
            expect(bobBalance).to.closeTo(bobExpectedReward, ethers.parseEther("0.35"));
            expect(aliceBalance + bobBalance).to.closeTo(considered, ethers.parseEther("0.05"));

            // Transfer both rewards to owner
            await sweep(alice);
            await sweep(bob);
        });

        it('should allow bob to stake', async function() {
            const bobBalance = await stakingToken.balanceOf(bob.address);
            await stakingToken.connect(bob).approve(await rwaGauge.getAddress(), bobBalance);
            await rwaGauge.connect(bob).stake(bobBalance);
            expect(await rwaGauge.rawBalanceOf(bob.address)).to.equal(ethers.parseEther("100"));
        });

        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });

        it('should allow both to claim rewards', async function() {
            const totalShares = await rwaGauge.totalSupply();
            const bobShares = await rwaGauge.balanceOf(bob.address);
            const aliceShares = await rwaGauge.balanceOf(alice.address);

            await rwaGauge.connect(alice).claimRewardToken();
            await rwaGauge.connect(bob).claimRewardToken();

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);

            const considered = ethers.parseEther("5"); // 10 but half period
            const bobExpectedReward = (considered * bobShares) / totalShares;
            const aliceExpectedReward = (considered * aliceShares) / totalShares;

            expect(aliceBalance).to.closeTo(aliceExpectedReward, ethers.parseEther("0.05"));
            expect(bobBalance).to.closeTo(bobExpectedReward, ethers.parseEther("0.05"));

            // Transfer both rewards to owner
            await sweep(alice);
            await sweep(bob);
        });
    });
    describe('Cycle 4: Two tokens, three users (Carol joins + rewardToken2 added)', function() {
        it('should allow carol to stake', async function() {
            await stakingToken.connect(carol).approve(await rwaGauge.getAddress(), ethers.parseEther("100"));
            await rwaGauge.connect(carol).stake(ethers.parseEther("100"));
        });
        it('should deposit rewards for cycle 4', async function() {
            await depositMain(ethers.parseEther("10"));
            // second token streams over 1 week based on RAW staked balances
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should let full period pass', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow all to claim rewards', async function() {
            // working-balance shares for the main token (read before claims refresh them)
            const totalShares = await rwaGauge.totalSupply();
            const aliceShares = await rwaGauge.balanceOf(alice.address);
            const bobShares = await rwaGauge.balanceOf(bob.address);
            const carolShares = await rwaGauge.balanceOf(carol.address);

            await claimAll(alice);
            await claimAll(bob);
            await claimAll(carol);

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);
            const carolBalance = await rewardToken.balanceOf(carol.address);

            const aliceBalance2 = await rewardToken2.balanceOf(alice.address);
            const bobBalance2 = await rewardToken2.balanceOf(bob.address);
            const carolBalance2 = await rewardToken2.balanceOf(carol.address);

            // main token: proportional to working balances
            const deposited = ethers.parseEther("10");
            expect(aliceBalance).to.closeTo((deposited * aliceShares) / totalShares, ethers.parseEther("0.05"));
            expect(bobBalance).to.closeTo((deposited * bobShares) / totalShares, ethers.parseEther("0.05"));
            expect(carolBalance).to.closeTo((deposited * carolShares) / totalShares, ethers.parseEther("0.05"));
            expect(aliceBalance + bobBalance + carolBalance).to.closeTo(deposited, DUST);

            // extra token: proportional to RAW balances during the 1-week stream (100/100/100)
            expect(aliceBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));
            expect(bobBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));
            expect(carolBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));

            // Transfer all rewards to owner
            await sweep(alice);
            await sweep(bob);
            await sweep(carol);
        });
        it('should have correct total supply and working supply', async function() {
            // working supply is the sum of the users' (boosted) working balances
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("300"));
        });
    });
    describe('Cycle 5: Mid-period stake (David joins mid-period, he also lock, even more than alice (for longer - 1yr) but has less stake). Doing so, means that we gonna see alice starts decaying', function() {
        it('should deposit rewards for cycle 5', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should advance mid period', async function() {
            const {periodStartTime, periodEndTime} = await rwaGauge.getPeriodBoundaries();
            // Mid period because full is 28
            await time.setNextBlockTimestamp(periodEndTime - BigInt(14 * DAY));
            await network.provider.send("evm_mine");
        });
        it('should allow david to stake', async function() {
            await stakingToken.connect(david).approve(await rwaGauge.getAddress(), ethers.parseEther("50"));
            await rwaGauge.connect(david).stake(ethers.parseEther("50"));
        });
        it('should allow david to lock raac', async function() {
            // 52 epochs = 1 year: more ve than alice, for longer, but less stake
            await raacToken.connect(david).approve(await veRAACToken.getAddress(), ethers.parseEther("100"));
            await veRAACToken.connect(david).lock(ethers.parseEther("100"), 52);
            await rwaGauge.connect(david).updateUserRewards(david.address);

            // david's big lock boosts him to the raw-balance cap...
            expect(await rwaGauge.balanceOf(david.address)).to.closeTo(ethers.parseEther("50"), ethers.parseEther("0.5"));
        });
        it('should allow all to claim rewards mid period', async function() {
            await claimAll(alice);
            await claimAll(bob);
            await claimAll(carol);
            await claimAll(david);

            // ...and dilutes alice's ve share below the cap: she starts decaying
            expect(await rwaGauge.balanceOf(alice.address)).to.be.lt(ethers.parseEther("100"));
            expect(await rwaGauge.balanceOf(alice.address)).to.be.gt(ethers.parseEther("40"));
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow all to claim rewards', async function() {
            await claimAll(alice);
            await claimAll(bob);
            await claimAll(carol);
            await claimAll(david);

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);
            const carolBalance = await rewardToken.balanceOf(carol.address);
            const davidBalance = await rewardToken.balanceOf(david.address);

            const aliceBalance2 = await rewardToken2.balanceOf(alice.address);
            const bobBalance2 = await rewardToken2.balanceOf(bob.address);
            const carolBalance2 = await rewardToken2.balanceOf(carol.address);
            const davidBalance2 = await rewardToken2.balanceOf(david.address);

            // main token: the whole 10 was distributed across the cycle
            expect(aliceBalance + bobBalance + carolBalance + davidBalance).to.closeTo(ethers.parseEther("10"), DUST);
            // david joined mid-period with a max boost: he earns, but less than the
            // full-period stakers with comparable working balances
            expect(davidBalance).to.be.gt(0n);
            expect(davidBalance).to.be.lt(aliceBalance);

            // extra token: streamed over week 1 on raw balances (alice/bob/carol 100 each);
            // david staked after the stream ended -> nothing
            expect(aliceBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));
            expect(bobBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));
            expect(carolBalance2).to.closeTo(ethers.parseEther("3.3333"), ethers.parseEther("0.001"));
            expect(davidBalance2).to.equal(0n);

            for (const user of [alice, bob, carol, david]) await sweep(user);
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(david.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("350"));
        });
    });
    describe('Cycle 6: we see alice decaying', function() {
        let alicePreviousWorking;
        let davidPreviousWorking;

        it('should deposit rewards for cycle 6', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7.5 * DAY);
        });
        it('should allow alice to claim rewards', async function() {
            await claimAll(alice);
            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const aliceWorkingBalance = await rwaGauge.balanceOf(alice.address);

            expect(aliceBalance).to.be.gt(0n);
            // alice sits between base (40) and cap (100) now that david dilutes her share
            expect(aliceWorkingBalance).to.be.gt(ethers.parseEther("40"));
            expect(aliceWorkingBalance).to.be.lt(ethers.parseEther("100"));
            alicePreviousWorking = aliceWorkingBalance;

            await sweep(alice);
        });
        it('should allow bob to claim rewards', async function() {
            await claimAll(bob);
            const bobBalance = await rewardToken.balanceOf(bob.address);
            const bobWorkingBalance = await rwaGauge.balanceOf(bob.address);

            expect(bobBalance).to.be.gt(0n);
            // no lock: bob stays at the 40% base
            expect(bobWorkingBalance).to.equal(ethers.parseEther("40"));

            await sweep(bob);
        });
        it('should allow david to claim rewards', async function() {
            await claimAll(david);
            const davidBalance = await rewardToken.balanceOf(david.address);
            const davidWorkingBalance = await rwaGauge.balanceOf(david.address);

            expect(davidBalance).to.be.gt(0n);
            // david's 1-year lock keeps him at (or near) the raw-balance cap
            expect(davidWorkingBalance).to.closeTo(ethers.parseEther("50"), ethers.parseEther("0.5"));
            davidPreviousWorking = davidWorkingBalance;

            await sweep(david);
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7.5 * DAY);
        });
        it('should allow alice to claim rewards again - decaying', async function() {
            await claimAll(alice);
            const aliceWorkingBalance = await rwaGauge.balanceOf(alice.address);

            // alice's ve keeps decaying -> working balance strictly decreasing
            expect(aliceWorkingBalance).to.be.lt(alicePreviousWorking);
            alicePreviousWorking = aliceWorkingBalance;

            await sweep(alice);
        });
        it('should allow bob to claim rewards again', async function() {
            await claimAll(bob);
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("40"));
            await sweep(bob);
        });
        it('should allow david to claim rewards again', async function() {
            await claimAll(david);
            expect(await rwaGauge.balanceOf(david.address)).to.be.gte(davidPreviousWorking - ethers.parseEther("0.5"));
            await sweep(david);
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7.5 * DAY);
        });
        it('should allow alice to claim rewards a third time - still decaying', async function() {
            await claimAll(alice);
            const aliceWorkingBalance = await rwaGauge.balanceOf(alice.address);
            expect(aliceWorkingBalance).to.be.lt(alicePreviousWorking);
            await sweep(alice);
        });
        it('should allow bob to claim rewards a third time', async function() {
            await claimAll(bob);
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("40"));
            await sweep(bob);
        });
        it('should allow david to claim rewards a third time', async function() {
            await claimAll(david);
            expect(await rwaGauge.balanceOf(david.address)).to.closeTo(ethers.parseEther("50"), ethers.parseEther("0.5"));
            await sweep(david);
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(david.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("350"));
        });
    });
    describe('Cycle 7: Mid-period withdrawal (Bob withdraws mid-period)', function() {
        it('should start the cycle on a fresh period', async function() {
            // cycle 6 stopped 22.5 days into the 28-day period; without this roll the
            // deposit below would stream over the ~5 remaining days and finish before
            // bob's "second half" claim
            await goToNextPeriod(rwaGauge);
        });
        it('should deposit rewards for cycle 7', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7.5 * DAY);
        });
        it('should allow bob to withdraw', async function() {
            // withdraw() takes raw amounts: bob pulls out 40 of his 100 staked
            await rwaGauge.connect(bob).withdraw(ethers.parseEther("40"));
            expect(await rwaGauge.rawBalanceOf(bob.address)).to.equal(ethers.parseEther("60"));
        });
        it('should allow bob to claim rewards', async function() {
            await claimAll(bob);
            const bobBalance = await rewardToken.balanceOf(bob.address);
            const bobWorkingBalance = await rwaGauge.balanceOf(bob.address);

            expect(bobBalance).to.be.gt(0n);
            // 60 raw staked, no boost -> 24 working
            expect(bobWorkingBalance).to.equal(ethers.parseEther("24"));

            await sweep(bob);
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow bob to claim rewards for the second half', async function() {
            await claimAll(bob);
            const bobBalance = await rewardToken.balanceOf(bob.address);
            expect(bobBalance).to.be.gt(0n);
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("24"));
            await sweep(bob);
        });
        it('should let everyone else claim to close the cycle', async function() {
            for (const user of [alice, carol, david]) {
                await claimAll(user);
                await sweep(user);
            }
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(david.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("310"));
        });
    });
    describe('Cycle 8: Mid-period reward addition (Eve stakes + rewards added mid-period)', function() {
        it('should allow eve to stake', async function() {
            await stakingToken.connect(eve).approve(await rwaGauge.getAddress(), ethers.parseEther("100"));
            await rwaGauge.connect(eve).stake(ethers.parseEther("100"));
            expect(await rwaGauge.balanceOf(eve.address)).to.equal(ethers.parseEther("40"));
        });
        it('should move to mid period', async function() {
            await time.increase(15 * DAY);
        });
        it('should deposit rewards for cycle 8 (mid-period)', async function() {
            await depositMain(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            // mid-period pulls stream the amount over the REMAINING period time
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should end period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim rewards', async function() {
            // shares of the mid-period stream follow the working balances
            const totalShares = await rwaGauge.totalSupply();
            const shares = {};
            for (const user of [alice, bob, carol, david, eve]) {
                shares[user.address] = await rwaGauge.balanceOf(user.address);
            }

            for (const user of [alice, bob, carol, david, eve]) await claimAll(user);

            const deposited = ethers.parseEther("10");
            let totalClaimed = 0n;
            for (const user of [alice, bob, carol, david, eve]) {
                const claimed = await rewardToken.balanceOf(user.address);
                totalClaimed += claimed;
                // eve staked before the deposit, so unlike the old model she earns her share
                expect(claimed).to.closeTo((deposited * shares[user.address]) / totalShares, ethers.parseEther("0.15"));
            }
            expect(totalClaimed).to.closeTo(deposited, DUST);

            for (const user of [alice, bob, carol, david, eve]) await sweep(user);
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(david.address) +
                await rwaGauge.balanceOf(eve.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("410"));
        });
    });
    describe('Cycle 9: bob re-stake, 1/4 pass and alice increase stake, 1/4 pass and carol withdraw half, 1/2 pass and david withdraw completely, period end and claim rewards', function() {
        it('should deposit rewards for cycle 9', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should allow bob to re-stake', async function() {
            await stakingToken.connect(bob).approve(await rwaGauge.getAddress(), ethers.parseEther("100"));
            await rwaGauge.connect(bob).stake(ethers.parseEther("40"));
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("40"));
            expect(await rwaGauge.rawBalanceOf(bob.address)).to.equal(ethers.parseEther("100"));
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7 * DAY);
        });
        it('should allow alice to increase stake', async function() {
            const aliceStakingBalance = await stakingToken.balanceOf(alice.address);
            await stakingToken.connect(alice).approve(await rwaGauge.getAddress(), aliceStakingBalance);
            await rwaGauge.connect(alice).stake(aliceStakingBalance);
            expect(await rwaGauge.rawBalanceOf(alice.address)).to.equal(ethers.parseEther("1000"));
            // alice's ve share is small by now: working balance sits just above the 40% base
            const aliceWorking = await rwaGauge.balanceOf(alice.address);
            expect(aliceWorking).to.be.gte(ethers.parseEther("400"));
            expect(aliceWorking).to.be.lt(ethers.parseEther("500"));
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7 * DAY);
        });
        it('should allow carol to withdraw half', async function() {
            const carolBalance = await rwaGauge.rawBalanceOf(carol.address);
            await rwaGauge.connect(carol).withdraw(carolBalance / 2n);
            expect(await rwaGauge.balanceOf(carol.address)).to.equal(ethers.parseEther("20"));
            expect(await rwaGauge.rawBalanceOf(carol.address)).to.equal(ethers.parseEther("50"));
        });
        it('should advance 1/2 period', async function() {
            await time.increase(14 * DAY);
        });
        it('should allow david to withdraw completely', async function() {
            const davidBalance = await rwaGauge.rawBalanceOf(david.address);
            await rwaGauge.connect(david).withdraw(davidBalance);
            expect(await rwaGauge.balanceOf(david.address)).to.equal(ethers.parseEther("0"));
            expect(await rwaGauge.rawBalanceOf(david.address)).to.equal(ethers.parseEther("0"));
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim rewards', async function() {
            for (const user of [alice, bob, carol, david, eve]) await claimAll(user);

            const balances = {};
            const balances2 = {};
            for (const user of [alice, bob, carol, david, eve]) {
                balances[user.address] = await rewardToken.balanceOf(user.address);
                balances2[user.address] = await rewardToken2.balanceOf(user.address);
            }

            // the full main deposit was distributed across the cycle
            const totalClaimed = Object.values(balances).reduce((a, b) => a + b, 0n);
            expect(totalClaimed).to.closeTo(ethers.parseEther("10"), DUST);

            // alice's big raw stake dominates the later 3/4 of the stream
            expect(balances[alice.address]).to.be.gt(balances[bob.address]);
            expect(balances[alice.address]).to.be.gt(balances[carol.address]);
            // david left mid-cycle but earned while staked
            expect(balances[david.address]).to.be.gt(0n);

            // extra token: streamed over week 1 on raw balances
            // (alice 100, bob 100, carol 100, eve 100, david 50 -> total 450)
            const rt2Deposited = ethers.parseEther("10");
            expect(balances2[alice.address]).to.closeTo(rt2Deposited * 100n / 450n, ethers.parseEther("0.01"));
            expect(balances2[bob.address]).to.closeTo(rt2Deposited * 100n / 450n, ethers.parseEther("0.01"));
            expect(balances2[carol.address]).to.closeTo(rt2Deposited * 100n / 450n, ethers.parseEther("0.01"));
            expect(balances2[eve.address]).to.closeTo(rt2Deposited * 100n / 450n, ethers.parseEther("0.01"));
            expect(balances2[david.address]).to.closeTo(rt2Deposited * 50n / 450n, ethers.parseEther("0.01"));

            for (const user of [alice, bob, carol, david, eve]) await sweep(user);
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(eve.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("1250"));
        });
    });
    describe('Cycle 10: All users withdraw and re-stake mid period', function() {
        it('should refresh franks gauge vote before it decays out', async function() {
            // frank's original 52-epoch lock is over halfway through its decay; add a new
            // lock and re-vote so deposits keep landing on epochs with vote weight
            await raacToken.connect(frank).approve(await veRAACToken.getAddress(), ethers.parseEther("2"));
            await veRAACToken.connect(frank).lock(ethers.parseEther("2"), MAX_LOCK_EPOCHS);
            await gaugeController.connect(frank).vote(await rwaGauge.getAddress(), 10000);
        });
        it('should deposit rewards for cycle 10', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should advance to mid period', async function() {
            await time.increase(14 * DAY);
        });
        it('should allow all users to withdraw', async function() {
            const aliceRawBalance = await rwaGauge.rawBalanceOf(alice.address);
            const carolRawBalance = await rwaGauge.rawBalanceOf(carol.address);
            const eveRawBalance = await rwaGauge.rawBalanceOf(eve.address);

            await rwaGauge.connect(alice).withdraw(aliceRawBalance);
            await rwaGauge.connect(carol).withdraw(carolRawBalance);
            await rwaGauge.connect(eve).withdraw(eveRawBalance);

            expect(await rwaGauge.rawBalanceOf(alice.address)).to.equal(0n);
            expect(await rwaGauge.rawBalanceOf(carol.address)).to.equal(0n);
            expect(await rwaGauge.rawBalanceOf(eve.address)).to.equal(0n);
        });
        it('should allow all users to re-stake', async function() {
            const aliceStakingBalance = await stakingToken.balanceOf(alice.address);
            const carolStakingBalance = await stakingToken.balanceOf(carol.address);
            const eveStakingBalance = await stakingToken.balanceOf(eve.address);

            await stakingToken.connect(alice).approve(await rwaGauge.getAddress(), aliceStakingBalance);
            await rwaGauge.connect(alice).stake(aliceStakingBalance);
            await stakingToken.connect(carol).approve(await rwaGauge.getAddress(), carolStakingBalance);
            await rwaGauge.connect(carol).stake(carolStakingBalance);
            await stakingToken.connect(eve).approve(await rwaGauge.getAddress(), eveStakingBalance);
            await rwaGauge.connect(eve).stake(eveStakingBalance);

            // alice's 26-epoch lock has expired by now: everyone is back at the 40% base
            // (alice 1000 + bob 100 + carol 100 + eve 100 raw)
            expect(await rwaGauge.totalSupply()).to.equal(ethers.parseEther("520"));
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("1300"));
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim rewards', async function() {
            const totalShares = await rwaGauge.totalSupply();
            const shares = {};
            for (const user of [alice, bob, carol, david, eve]) {
                shares[user.address] = await rwaGauge.balanceOf(user.address);
            }

            for (const user of [alice, bob, carol, david, eve]) await claimAll(user);

            const deposited = ethers.parseEther("10");
            let totalClaimed = 0n;
            for (const user of [alice, bob, carol, david, eve]) {
                const claimed = await rewardToken.balanceOf(user.address);
                totalClaimed += claimed;
                // same-block withdraw+restake keeps the shares roughly constant
                expect(claimed).to.closeTo((deposited * shares[user.address]) / totalShares, ethers.parseEther("0.25"));
            }
            expect(totalClaimed).to.closeTo(deposited, DUST);

            // extra token: streamed over week 1 on raw balances (alice 1000, bob 100,
            // carol 50, eve 100 -> total 1250)
            const rt2Deposited = ethers.parseEther("10");
            expect(await rewardToken2.balanceOf(alice.address)).to.closeTo(rt2Deposited * 1000n / 1250n, ethers.parseEther("0.01"));
            expect(await rewardToken2.balanceOf(bob.address)).to.closeTo(rt2Deposited * 100n / 1250n, ethers.parseEther("0.01"));
            expect(await rewardToken2.balanceOf(carol.address)).to.closeTo(rt2Deposited * 50n / 1250n, ethers.parseEther("0.01"));
            expect(await rewardToken2.balanceOf(eve.address)).to.closeTo(rt2Deposited * 100n / 1250n, ethers.parseEther("0.01"));
            expect(await rewardToken2.balanceOf(david.address)).to.equal(0n);

            for (const user of [alice, bob, carol, david, eve]) await sweep(user);
        });
        it('should have correct total supply and working supply', async function() {
            expect(await rwaGauge.totalSupply()).to.equal(ethers.parseEther("520"));
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("1300"));
        });
    });
    describe('Cycle 11: Everyone gets out for the full cycle (test the leftover rewards)', function() {
        it('should deposit rewards for cycle 11', async function() {
            await depositMain(ethers.parseEther("10"));
            await depositExtra(ethers.parseEther("10"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should allow all users to withdraw completely', async function() {
            const aliceRawBalance = await rwaGauge.rawBalanceOf(alice.address);
            const bobRawBalance = await rwaGauge.rawBalanceOf(bob.address);
            const carolRawBalance = await rwaGauge.rawBalanceOf(carol.address);
            const eveRawBalance = await rwaGauge.rawBalanceOf(eve.address);

            await rwaGauge.connect(alice).withdraw(aliceRawBalance);
            await rwaGauge.connect(bob).withdraw(bobRawBalance);
            await rwaGauge.connect(carol).withdraw(carolRawBalance);
            await rwaGauge.connect(eve).withdraw(eveRawBalance);

            expect(await rwaGauge.totalSupply()).to.equal(0n);
            expect(await rwaGauge.rawTotalSupply()).to.equal(0n);
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should check leftover rewards in gauge', async function() {
            const gaugeRewardBalance = await rewardToken.balanceOf(await rwaGauge.getAddress());
            const gaugeRewardBalance2 = await rewardToken2.balanceOf(await rwaGauge.getAddress());

            // nobody was staked: the pulled 10 stays in the gauge as leftover
            expect(gaugeRewardBalance).to.closeTo(ethers.parseEther("10.0"), ethers.parseEther("0.05"));
            // the extra token stream also had nobody to pay
            expect(gaugeRewardBalance2).to.be.gte(ethers.parseEther("10") - DUST);
        });
        it('should allow everyone to claim rewards', async function() {
            for (const user of [alice, bob, carol, david, eve]) await claimAll(user);

            // Empty cycle, nothing distributed
            for (const user of [alice, bob, carol, david, eve]) {
                expect(await rewardToken.balanceOf(user.address)).to.equal(0n);
            }
        });
        it('should have correct total supply and working supply', async function() {
            expect(await rwaGauge.totalSupply()).to.equal(ethers.parseEther("0"));
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("0"));
        });
    });
    describe('Cycle 12: Rapid stake/unstake (same block operations)', function() {
        it('should allow alice to stake some tokens', async function() {
            await stakingToken.connect(alice).approve(await rwaGauge.getAddress(), ethers.parseEther("50"));
            await rwaGauge.connect(alice).stake(ethers.parseEther("50"));
            expect(await rwaGauge.balanceOf(alice.address)).to.equal(ethers.parseEther("20"));
        });
        it('should deposit rewards for cycle 12', async function() {
            await depositMain(ethers.parseEther("10"));
        });
        it('should pull rewards from the distributor (rolls cycle-11 leftover in)', async function() {
            await rwaGauge.pullRewardsFromDistributor();
            // cycle 11's undistributed 10 rolls into this period's stream on the pull
            expect(await rewardToken.balanceOf(await rwaGauge.getAddress())).to.closeTo(ethers.parseEther("20"), ethers.parseEther("0.05"));
        });
        it('should perform rapid stake/unstake operations in same block using multicall', async function() {
            // Disable automine to simulate same block operations
            await network.provider.send("evm_setAutomine", [false]);

            await stakingToken.connect(bob).approve(await rwaGauge.getAddress(), ethers.parseEther("40")); // 30 staked + 10 re-staked after the withdraw
            await rwaGauge.connect(bob).stake(ethers.parseEther("30"));
            await rwaGauge.connect(bob).withdraw(ethers.parseEther("10"));
            await rwaGauge.connect(bob).stake(ethers.parseEther("10"));
            // Mine the block
            await network.provider.send("evm_mine");
            // Re-enable automine
            await network.provider.send("evm_setAutomine", [true]);

            // same-block churn nets out: 30 raw staked, standard 40% working balance
            expect(await rwaGauge.rawBalanceOf(bob.address)).to.equal(ethers.parseEther("30"));
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("12"));
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim rewards', async function() {
            const aliceShares = await rwaGauge.balanceOf(alice.address);
            const bobShares = await rwaGauge.balanceOf(bob.address);
            const totalShares = await rwaGauge.totalSupply();

            await claimAll(alice);
            await claimAll(bob);

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);

            const streamed = ethers.parseEther("20");
            expect(aliceBalance + bobBalance).to.closeTo(streamed, ethers.parseEther("0.1"));
            expect(aliceBalance).to.closeTo(streamed * aliceShares / totalShares, ethers.parseEther("0.1"));
            expect(bobBalance).to.closeTo(streamed * bobShares / totalShares, ethers.parseEther("0.1"));

            await sweep(alice);
            await sweep(bob);
        });
        it('should have correct total supply and working supply', async function() {
            expect(await rwaGauge.totalSupply()).to.equal(ethers.parseEther("32"));
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("80"));
        });
    });
    describe('Cycle 13: No new rewards deposited', function() {
        it('should pull reward tokens (should be a no-op)', async function() {
            const pulled = await rwaGauge.pullRewardsFromDistributor.staticCall();
            expect(pulled).to.equal(0n);
            await rwaGauge.pullRewardsFromDistributor();
            const gaugeRewardBalance = await rewardToken.balanceOf(await rwaGauge.getAddress());
            expect(gaugeRewardBalance).to.closeTo(0n, ethers.parseEther("0.05"));
        });
        it('should move to end of period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim rewards', async function() {
            await claimAll(alice);
            await claimAll(bob);

            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const bobBalance = await rewardToken.balanceOf(bob.address);

            // no deposits this cycle -> no main-token payouts
            expect(aliceBalance).to.closeTo(0n, ethers.parseEther("0.05"));
            expect(bobBalance).to.closeTo(0n, ethers.parseEther("0.05"));

            await sweep(alice);
            await sweep(bob);
        });
        it('should have correct total supply and working supply', async function() {
            expect(await rwaGauge.totalSupply()).to.equal(ethers.parseEther("32"));
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("80"));
        });
    });
    describe('Cycle 14: Mix of everything above', function() {
        it('should deposit rewards for cycle 14', async function() {
            await depositMain(ethers.parseEther("20"));
            await depositExtra(ethers.parseEther("15"));
        });
        it('should pull main rewards from the distributor', async function() {
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should allow carol and eve to stake', async function() {
            const carolStakingBalance = await stakingToken.balanceOf(carol.address);
            const eveStakingBalance = await stakingToken.balanceOf(eve.address);

            await stakingToken.connect(carol).approve(await rwaGauge.getAddress(), carolStakingBalance);
            await rwaGauge.connect(carol).stake(carolStakingBalance);

            await stakingToken.connect(eve).approve(await rwaGauge.getAddress(), eveStakingBalance);
            await rwaGauge.connect(eve).stake(eveStakingBalance);

            expect(await rwaGauge.balanceOf(carol.address)).to.equal(ethers.parseEther("40"));
            expect(await rwaGauge.balanceOf(eve.address)).to.equal(ethers.parseEther("40"));
        });
        it('should advance 1/8 period', async function() {
            await time.increase(3.5 * DAY);
        });
        it('should allow bob to withdraw half', async function() {
            const bobRawBalance = await rwaGauge.rawBalanceOf(bob.address);
            await rwaGauge.connect(bob).withdraw(bobRawBalance / 2n);
            expect(await rwaGauge.balanceOf(bob.address)).to.equal(ethers.parseEther("6"));
        });
        it('should advance 1/8 period', async function() {
            await time.increase(3.5 * DAY);
        });
        it('should allow alice to claim mid-period', async function() {
            await claimAll(alice);
            const aliceBalance = await rewardToken.balanceOf(alice.address);
            const aliceBalance2 = await rewardToken2.balanceOf(alice.address);

            // ~1/4 of the 20-token stream elapsed; alice holds 20 of ~112 working
            expect(aliceBalance).to.be.gt(ethers.parseEther("0.5"));
            expect(aliceBalance).to.be.lt(ethers.parseEther("2"));
            // alice also collected her share of the (raw-based) extra stream
            expect(aliceBalance2).to.be.gt(0n);

            await sweep(alice);
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7 * DAY);
        });
        it('should deposit additional rewards mid-period', async function() {
            await depositMain(ethers.parseEther("5"));
            await rwaGauge.pullRewardsFromDistributor();
        });
        it('should allow david to re-stake', async function() {
            const davidStakingBalance = await stakingToken.balanceOf(david.address);
            await stakingToken.connect(david).approve(await rwaGauge.getAddress(), davidStakingBalance);
            await rwaGauge.connect(david).stake(davidStakingBalance);
            // david's year-long lock is still live -> boosted all the way to his raw stake
            expect(await rwaGauge.balanceOf(david.address)).to.closeTo(ethers.parseEther("100"), ethers.parseEther("1"));
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7 * DAY);
        });
        it('should allow eve to withdraw completely', async function() {
            const eveRawBalance = await rwaGauge.rawBalanceOf(eve.address);
            await rwaGauge.connect(eve).withdraw(eveRawBalance);
            expect(await rwaGauge.balanceOf(eve.address)).to.equal(0n);
        });
        it('should allow carol to increase lock', async function() {
            const carolRaacBalance = await raacToken.balanceOf(carol.address);
            await raacToken.connect(carol).approve(await veRAACToken.getAddress(), carolRaacBalance);
            await veRAACToken.connect(carol).lock(carolRaacBalance, 26);
            await rwaGauge.connect(carol).updateUserRewards(carol.address);
            // carol's new lock boosts her above the 40% base
            const carolWorking = await rwaGauge.balanceOf(carol.address);
            expect(carolWorking).to.be.gt(ethers.parseEther("40"));
            expect(carolWorking).to.be.lte(ethers.parseEther("100"));
        });
        it('should advance 1/4 period', async function() {
            await time.increase(7 * DAY);
        });
        it('should go to next period', async function() {
            await goToNextPeriod(rwaGauge);
        });
        it('should allow everyone to claim final rewards', async function() {
            for (const user of [alice, bob, carol, david, eve]) await claimAll(user);

            const balances = {};
            const balances2 = {};
            let totalRewards = 0n;
            let totalRewards2 = 0n;
            for (const user of [alice, bob, carol, david, eve]) {
                balances[user.address] = await rewardToken.balanceOf(user.address);
                balances2[user.address] = await rewardToken2.balanceOf(user.address);
                totalRewards += balances[user.address];
                totalRewards2 += balances2[user.address];
            }
            expect(totalRewards).to.be.gt(ethers.parseEther("22"));
            expect(totalRewards).to.be.lte(ethers.parseEther("25") + DUST);

            expect(totalRewards2).to.be.gt(ethers.parseEther("12"));
            expect(totalRewards2).to.be.lte(ethers.parseEther("15") + DUST);
            expect(balances2[david.address]).to.equal(0n);

            // everyone who was staked the whole cycle earned something
            expect(balances[bob.address]).to.be.gt(0n);
            expect(balances[carol.address]).to.be.gt(0n);
            expect(balances[david.address]).to.be.gt(0n);
            expect(balances[eve.address]).to.be.gt(0n);

            // carol (100 raw) out-earns bob (15 raw)
            expect(balances[carol.address]).to.be.gt(balances[bob.address]);

            for (const user of [alice, bob, carol, david, eve]) await sweep(user);
        });
        it('should have correct total supply and working supply', async function() {
            const workingSum =
                await rwaGauge.balanceOf(alice.address) +
                await rwaGauge.balanceOf(bob.address) +
                await rwaGauge.balanceOf(carol.address) +
                await rwaGauge.balanceOf(david.address);
            expect(await rwaGauge.totalSupply()).to.equal(workingSum);
            // alice 50 + bob 15 + carol 100 + david 100
            expect(await rwaGauge.rawTotalSupply()).to.equal(ethers.parseEther("265"));
        });
    });
});
