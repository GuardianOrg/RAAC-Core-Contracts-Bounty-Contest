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

describe("Gauges with voting", function() {
    let owner;
    let alice;
    let bob;
    let carol;
    let david;
    let eve;

	let raacToken;
	let veRAACToken;

    let stakingToken;

	let rewardToken;
	let rewardToken2;


	let gaugeController;
    let gaugeRewardsDistributor;
    let rwaGauge;
    let raacGauge;

    const STABLE_MINT_AMOUNT = ethers.parseEther("100000");

    const WEIGHT_PRECISION = 10000;
    const MINUTE = 60;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;

    before(async () => {
		[owner, alice, bob, carol, david, eve] = await ethers.getSigners();

		const MockTokenFactory = await ethers.getContractFactory("MockToken");

		rewardToken = await MockTokenFactory.deploy("USD Coin", "USDC", 18);
        await rewardToken.waitForDeployment();

		rewardToken2 = await MockTokenFactory.deploy("Curve USD", "crvUD", 18);
        await rewardToken2.waitForDeployment();

        // Staking token can be a LP for instance (RToken <> DEToken)
        stakingToken = await MockTokenFactory.deploy("LP RToken <> DEToken", "LP", 18);
        await stakingToken.waitForDeployment();

		const RAACTokenFactory = await ethers.getContractFactory("RAACToken");
		raacToken = await RAACTokenFactory.deploy(owner.address); // tax parameters were removed
        await raacToken.waitForDeployment();

        // VeRAACToken requires linked libraries
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
        veRAACToken = await VETokenFactory.deploy(await raacToken.getAddress(), owner.address, 52);
        await veRAACToken.waitForDeployment();

		const GaugeControllerFactory = await ethers.getContractFactory("GaugeController");
		gaugeController = await GaugeControllerFactory.deploy(await veRAACToken.getAddress());
        await gaugeController.waitForDeployment();

        // single-reward-token distributor, wired into the controller before addGauge
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
            owner.address,                              // stands in for the RAAC liquid locker
            await raacToken.getAddress(),
            await rewardToken.getAddress(),
            await gaugeRewardsDistributor.getAddress()
        );
        await rwaGauge.waitForDeployment();

        const RAACGaugeFactory = await ethers.getContractFactory("RAACGauge");
        raacGauge = await RAACGaugeFactory.deploy(
            await stakingToken.getAddress(),
            await gaugeController.getAddress(),
            owner.address,
            await raacToken.getAddress(),
            await rewardToken.getAddress(),
            await gaugeRewardsDistributor.getAddress()
        );
        await raacGauge.waitForDeployment();

        // Set minter on RAAC
        await raacToken.connect(owner).setMinter(owner.address);

        // Mint RAAC to alice, bob, carol and david
        await raacToken.mint(alice.address, ethers.parseEther("1000"));
        await raacToken.mint(bob.address, ethers.parseEther("1000"));
        await raacToken.mint(carol.address, ethers.parseEther("500"));
        await raacToken.mint(david.address, ethers.parseEther("100"));
	});



    describe('Setup', function() {
        // locks are expressed in weekly epochs now (52 epochs = 1 year max)
        it('should allow alice to lock her RAAC tokens', async function() {
            await raacToken.connect(alice).approve(await veRAACToken.getAddress(), ethers.parseEther("1000"));
            await veRAACToken.connect(alice).lock(ethers.parseEther("1000"), 52);
        });
        it('should allow bob to lock his RAAC tokens', async function() {
            await raacToken.connect(bob).approve(await veRAACToken.getAddress(), ethers.parseEther("1000"));
            await veRAACToken.connect(bob).lock(ethers.parseEther("1000"), 26);
        });
        it('should allow carol to lock her RAAC tokens', async function() {
            await raacToken.connect(carol).approve(await veRAACToken.getAddress(), ethers.parseEther("500"));
            await veRAACToken.connect(carol).lock(ethers.parseEther("500"), 13);
        });
        it('should allow david to lock his RAAC tokens', async function() {
            await raacToken.connect(david).approve(await veRAACToken.getAddress(), ethers.parseEther("100"));
            await veRAACToken.connect(david).lock(ethers.parseEther("100"), 26);
        });
        it('should allow to add gauges in a controller', async function() {
            await gaugeController.addGauge(await rwaGauge.getAddress());
            await gaugeController.addGauge(await raacGauge.getAddress());
        });
        it('should allow to grant controller role to the gauge', async function() {
            await rwaGauge.grantRole(await rwaGauge.CONTROLLER_ROLE(), owner.address);
            await raacGauge.grantRole(await raacGauge.CONTROLLER_ROLE(), owner.address);
        });

        it('should allow to add a distributor to a gauges', async function() {
            await raacGauge.manageDistributor(await gaugeRewardsDistributor.getAddress(), true);
            await rwaGauge.manageDistributor(await gaugeRewardsDistributor.getAddress(), true);
        });
        it('should expose the reward token fixed at construction', async function() {
            // the distributor is single-reward-token now; per-gauge token registration is gone
            expect(await gaugeRewardsDistributor.rewardToken()).to.equal(await rewardToken.getAddress());
        });
    });
    // Time changes in our tests, so we won't be precise in the tests, we use a tolerance of 0.1 ethers.
    let TOLERANCE = ethers.parseEther('0.1');
    describe('Voting', function() {
        let gaugeTotalWeight;
        let rwaGaugeWeight;
        let raacGaugeWeight;
        let alicePowerAtVote;
        it('should allow alice to vote for a gauge', async function() {
            await gaugeController.connect(alice).vote(await rwaGauge.getAddress(), 6000);
            await gaugeController.connect(alice).vote(await raacGauge.getAddress(), 4000);

            const aliceVotingPower = await veRAACToken.balanceOf(alice);
            expect(aliceVotingPower).to.be.closeTo(ethers.parseEther('1000'), ethers.parseEther('20'));
            alicePowerAtVote = aliceVotingPower;

            // votes only take effect at the NEXT weekly epoch
            await time.increase(WEEK);

            gaugeTotalWeight = await gaugeController.getTotalWeight();
            // She voted 100% of her power (small decay across the epoch boundary)
            expect(gaugeTotalWeight).to.be.closeTo(aliceVotingPower, aliceVotingPower / 20n);
            rwaGaugeWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            raacGaugeWeight = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            expect(raacGaugeWeight+rwaGaugeWeight).to.be.closeTo(gaugeTotalWeight, TOLERANCE);
            expect(rwaGaugeWeight).to.be.closeTo(gaugeTotalWeight*6n/10n, gaugeTotalWeight / 20n);
            expect(raacGaugeWeight).to.be.closeTo(gaugeTotalWeight*4n/10n, gaugeTotalWeight / 20n);
        });
        it('should allow bob to vote for a gauge', async function() {
            const prevGaugeTotal = gaugeTotalWeight;
            const prevRaacWeight = raacGaugeWeight;
            await gaugeController.connect(bob).vote(await raacGauge.getAddress(), 10000);
            const bobVotingPower = await veRAACToken.balanceOf(bob);

            // 26 of 52 epochs -> roughly half of his 1000 locked, decayed since the lock
            expect(bobVotingPower).to.be.gt(0n);
            expect(bobVotingPower).to.be.lt(ethers.parseEther('520'));

            await time.increase(WEEK); // activate the vote

            gaugeTotalWeight = await gaugeController.getTotalWeight();
            // bob's power joins the total (everyone also decayed ~1 epoch meanwhile)
            expect(gaugeTotalWeight).to.be.gt(prevGaugeTotal / 2n);
            expect(gaugeTotalWeight).to.be.closeTo(prevGaugeTotal + bobVotingPower, (prevGaugeTotal + bobVotingPower) / 10n);

            rwaGaugeWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            raacGaugeWeight = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            expect(rwaGaugeWeight + raacGaugeWeight).to.be.closeTo(gaugeTotalWeight, TOLERANCE);
            // raac gauge gained bob's full vote
            expect(raacGaugeWeight).to.be.gt(prevRaacWeight);
        });
        it('should allow carol to vote for a gauge', async function() {
            const prevRwaWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());

            await gaugeController.connect(carol).vote(await rwaGauge.getAddress(), 10000);
            await time.increase(WEEK); // activate the vote

            gaugeTotalWeight = await gaugeController.getTotalWeight();
            rwaGaugeWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            raacGaugeWeight = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            // carol's 13-epoch lock adds more than one week of collective decay removes
            expect(rwaGaugeWeight).to.be.gte(prevRwaWeight);
            expect(rwaGaugeWeight + raacGaugeWeight).to.be.closeTo(gaugeTotalWeight, TOLERANCE);
        });
        it('should allow david to vote for a gauge', async function() {
            await gaugeController.connect(david).vote(await rwaGauge.getAddress(), 1000);
            await gaugeController.connect(david).vote(await raacGauge.getAddress(), 1000);
            await time.increase(WEEK); // activate the votes

            gaugeTotalWeight = await gaugeController.getTotalWeight();
            rwaGaugeWeight = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            raacGaugeWeight = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            expect(rwaGaugeWeight + raacGaugeWeight).to.be.closeTo(gaugeTotalWeight, TOLERANCE);
            expect(gaugeTotalWeight).to.be.gt(0n);
        });
    });
    describe('Voting weight decay', function() {
        let gaugeTotalWeight;
        let rwaGaugeWeight;
        let raacGaugeWeight;

        async function readWeights() {
            return [
                await gaugeController.getTotalWeight(),
                await gaugeController.getGaugeWeight(await rwaGauge.getAddress()),
                await gaugeController.getGaugeWeight(await raacGauge.getAddress()),
            ];
        }

        it('should keep weights stable within an epoch', async function() {
            [gaugeTotalWeight, rwaGaugeWeight, raacGaugeWeight] = await readWeights();
            await time.increase(DAY); // 1 day, same weekly epoch (we're just past a boundary)
            const [totalNow, rwaNow, raacNow] = await readWeights();
            // allow a boundary crossing if the test lands near the end of an epoch
            expect(totalNow).to.be.lte(gaugeTotalWeight);
            expect(rwaNow).to.be.lte(rwaGaugeWeight);
            expect(raacNow).to.be.lte(raacGaugeWeight);
        });
        it('should decay week over week', async function() {
            [gaugeTotalWeight, rwaGaugeWeight, raacGaugeWeight] = await readWeights();
            await time.increase(WEEK);
            const [totalNow, rwaNow, raacNow] = await readWeights();
            expect(totalNow).to.be.lt(gaugeTotalWeight);
            expect(rwaNow).to.be.lt(rwaGaugeWeight);
            expect(raacNow).to.be.lt(raacGaugeWeight);
            expect(rwaNow + raacNow).to.be.closeTo(totalNow, TOLERANCE);
        });
        it('should keep decaying over 4 more weeks', async function() {
            [gaugeTotalWeight, rwaGaugeWeight, raacGaugeWeight] = await readWeights();
            await time.increase(4 * WEEK);
            const [totalNow, rwaNow, raacNow] = await readWeights();
            expect(totalNow).to.be.lt(gaugeTotalWeight);
            expect(rwaNow).to.be.lt(rwaGaugeWeight);
            expect(raacNow).to.be.lt(raacGaugeWeight);
            expect(rwaNow + raacNow).to.be.closeTo(totalNow, TOLERANCE);
        });
    });
    describe('Voting rebalancing', function() {
        //Way to big, we need to improve TODO
        TOLERANCE = ethers.parseEther('50');
        it('should allow alice to rebalance votes', async function() {
            const rwaBefore = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            const raacBefore = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            await gaugeController.connect(alice).vote(await raacGauge.getAddress(), 2000);
            await gaugeController.connect(alice).vote(await rwaGauge.getAddress(), 8000);
            await time.increase(WEEK); // rebalance lands at the next epoch

            const totalAfter = await gaugeController.getTotalWeight();
            const rwaAfter = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            const raacAfter = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            expect(rwaAfter + raacAfter).to.be.closeTo(totalAfter, TOLERANCE);
            // alice moved 20% of her power from raac to rwa; despite one week of global
            // decay her shift dominates david's small votes on the raac side
            expect(raacAfter).to.be.lte(raacBefore);
        });
        it('should allow david to rebalance votes', async function() {
            const rwaBefore = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            const raacBefore = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            await gaugeController.connect(david).vote(await rwaGauge.getAddress(), 0);
            await gaugeController.connect(david).vote(await raacGauge.getAddress(), 0);
            await time.increase(WEEK);

            const totalAfter = await gaugeController.getTotalWeight();
            const rwaAfter = await gaugeController.getGaugeWeight(await rwaGauge.getAddress());
            const raacAfter = await gaugeController.getGaugeWeight(await raacGauge.getAddress());

            expect(rwaAfter + raacAfter).to.be.closeTo(totalAfter, TOLERANCE);
            expect(rwaAfter).to.be.lte(rwaBefore);
            expect(raacAfter).to.be.lte(raacBefore);
        });
    });

    describe('Distribution', function() {
        it('should allow to send rewards to the distributor', async function() {
            await rewardToken.mint(owner.address, STABLE_MINT_AMOUNT);
            await rewardToken.approve(await gaugeRewardsDistributor.getAddress(), STABLE_MINT_AMOUNT);
            await gaugeRewardsDistributor.deposit(await rewardToken.getAddress(), STABLE_MINT_AMOUNT);
        });
    });

});
