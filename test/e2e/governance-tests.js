import { expect } from "chai";
import hre from 'hardhat';
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Governance System", function () {
    let owner, user1, user2, user3, user4;
    let raacToken, veToken, governance, timelock, gaugeController;
    let rewardToken, distributor;
    let mockLPToken;
    let newGauge; 
    
    const DAY = 24 * 60 * 60;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;
    
    const INITIAL_MINT = ethers.parseEther("1000000"); // 1M RAAC
    const USER1_TOKENS = ethers.parseEther("100000");  // 100k RAAC
    const USER2_TOKENS = ethers.parseEther("50000");   // 50k RAAC
    const USER3_TOKENS = ethers.parseEther("25000");   // 25k RAAC
    const USER4_TOKENS = ethers.parseEther("10000");   // 10k RAAC
    const TOTAL_DISTRIBUTED = USER1_TOKENS + USER2_TOKENS + USER3_TOKENS + USER4_TOKENS;

    const USER1_EXPECTED_POWER = USER1_TOKENS;  // ~100k veToken
    const USER2_EXPECTED_POWER = USER2_TOKENS;  // ~50k veToken
    const USER3_EXPECTED_POWER = USER3_TOKENS;  // ~25k veToken
    const USER4_EXPECTED_POWER = USER4_TOKENS;  // ~10k veToken
    const TOTAL_EXPECTED_POWER = USER1_EXPECTED_POWER + USER2_EXPECTED_POWER + USER3_EXPECTED_POWER + USER4_EXPECTED_POWER;

    before(async function () {
        [owner, user1, user2, user3, user4] = await ethers.getSigners();

        const RAACToken = await ethers.getContractFactory("RAACToken");
        raacToken = await RAACToken.deploy(owner.address); // tax parameters were removed
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

        const MAX_LOCK_EPOCHS = 52; // GaugeController requires 52 weekly epochs
        const VeRAACToken = await ethers.getContractFactory("VeRAACToken", {
            libraries: {
                RagequitLib: ragequitLib.target,
                PowerCheckpoint: powerCheckpointLib.target,
                LockManager: lockManagerLib.target,
                RewardLib: rewardLib.target,
            },
        });
        veToken = await VeRAACToken.deploy(await raacToken.getAddress(), owner.address, MAX_LOCK_EPOCHS);
        await veToken.waitForDeployment();

        const mockLPTokenFactory = await ethers.getContractFactory("LPToken");
        mockLPToken = await mockLPTokenFactory.deploy("Mock LP Token", "LP", owner.address);
        await mockLPToken.waitForDeployment();

        const gaugeControllerFactory = await ethers.getContractFactory("GaugeController");
        gaugeController = await gaugeControllerFactory.deploy(await veToken.getAddress());
        await gaugeController.waitForDeployment();

        // the controller needs a rewards distributor configured before gauges can be added
        const MockToken = await ethers.getContractFactory("MockToken");
        rewardToken = await MockToken.deploy("Reward", "RWD", 18);
        const GaugeRewardsDistributor = await ethers.getContractFactory("GaugeRewardsDistributor");
        distributor = await GaugeRewardsDistributor.deploy(
            await gaugeController.getAddress(),
            await rewardToken.getAddress()
        );
        await gaugeController.setDistributor(await distributor.getAddress());

        const timelockFactory = await ethers.getContractFactory("TimelockController");
        const MIN_DELAY = 2 * DAY;
        timelock = await timelockFactory.deploy(
            MIN_DELAY,
            [], // proposers
            [], // executors
            owner.address
        );
        await timelock.waitForDeployment();

        const governanceFactory = await ethers.getContractFactory("Governance");
        governance = await governanceFactory.deploy(
            await veToken.getAddress(),
            await timelock.getAddress()
        );
        await governance.waitForDeployment();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
        await timelock.grantRole(PROPOSER_ROLE, await governance.getAddress());
        await timelock.grantRole(EXECUTOR_ROLE, await governance.getAddress());
        await timelock.grantRole(CANCELLER_ROLE, await governance.getAddress());

        await raacToken.connect(owner).setMinter(owner.address); // whitelist/taxes were removed
        await raacToken.connect(owner).mint(owner.address, INITIAL_MINT);
        await raacToken.connect(owner).setMinter(await veToken.getAddress());

        // Distribute RAAC tokens to users
        await raacToken.transfer(user1.address, USER1_TOKENS);
        await raacToken.transfer(user2.address, USER2_TOKENS);
        await raacToken.transfer(user3.address, USER3_TOKENS);
        await raacToken.transfer(user4.address, USER4_TOKENS);

        // Users lock their RAAC tokens for maximum duration to get voting power
        // First approve veToken to spend RAAC
        await raacToken.connect(user1).approve(await veToken.getAddress(), USER1_TOKENS);
        await raacToken.connect(user2).approve(await veToken.getAddress(), USER2_TOKENS);
        await raacToken.connect(user3).approve(await veToken.getAddress(), USER3_TOKENS);
        await raacToken.connect(user4).approve(await veToken.getAddress(), USER4_TOKENS);

        // Lock tokens for the max 52 weekly epochs to get voting power
        await veToken.connect(user1).lock(USER1_TOKENS, 52);
        await veToken.connect(user2).lock(USER2_TOKENS, 52);
        await veToken.connect(user3).lock(USER3_TOKENS, 52);
        await veToken.connect(user4).lock(USER4_TOKENS, 52);

        const DEFAULT_ADMIN_ROLE = await gaugeController.DEFAULT_ADMIN_ROLE();
        const GAUGE_ADMIN = await gaugeController.GAUGE_ADMIN();
        const EMERGENCY_ADMIN = await gaugeController.EMERGENCY_ADMIN();
        // FEE_ADMIN no longer exists on the controller

        await gaugeController.grantRole(DEFAULT_ADMIN_ROLE, await timelock.getAddress());
        await gaugeController.grantRole(GAUGE_ADMIN, await timelock.getAddress());
        await gaugeController.grantRole(EMERGENCY_ADMIN, await timelock.getAddress());

        await gaugeController.renounceRole(DEFAULT_ADMIN_ROLE, owner.address);
        await gaugeController.renounceRole(GAUGE_ADMIN, owner.address);
        await gaugeController.renounceRole(EMERGENCY_ADMIN, owner.address);
    });

    describe("Governance Tests", function () {
        it("should allow a user with enough voting power to create a proposal", async function () {
            // First deploy a new RWA gauge that we'll add through governance
            const rwaGaugeFactory = await ethers.getContractFactory("RWAGauge");
            newGauge = await rwaGaugeFactory.deploy(
                await mockLPToken.getAddress(),          // staking token
                await gaugeController.getAddress(),
                owner.address,                            // stands in for the RAAC liquid locker
                await raacToken.getAddress(),
                await rewardToken.getAddress(),
                await distributor.getAddress()
            );
            await newGauge.waitForDeployment();

            const proposalTargets = [await gaugeController.getAddress()];
            const proposalValues = [0];
            const proposalCalldata = [
                gaugeController.interface.encodeFunctionData("addGauge", [
                    await newGauge.getAddress()
                ])
            ];
            const description = "Add new RWA gauge to controller";

            // User1 should have enough voting power to create proposal 
            await expect(governance.connect(user1).propose(
                proposalTargets,
                proposalValues,
                proposalCalldata,
                description,
                0 // Proposal type : standard
            )).to.emit(governance, "ProposalCreated");

            // User4 doesn't have enough voting power
            await expect(governance.connect(user4).propose(
                proposalTargets,
                proposalValues,
                proposalCalldata,
                description,
                0
            )).to.be.revertedWithCustomError(governance, "InsufficientProposerVotes");
        });

        it("should track voting period correctly", async function () {
            const proposalId = 0; 
            const votingDelay = await governance.votingDelay();
            
            // Should not allow voting before delay period
            await expect(governance.connect(user1).castVote(proposalId, true))
                .to.be.revertedWithCustomError(governance, "VotingNotStarted");

            await time.increase(votingDelay);

            // Now can vote
            await expect(governance.connect(user1).castVote(proposalId, true))
                .to.emit(governance, "VoteCast");
        });

        it("should allow users to vote and track votes correctly", async function () {
            const proposalId = 0;

            // User2 votes against
            await governance.connect(user2).castVote(proposalId, false);
            
            // User3 votes for
            await governance.connect(user3).castVote(proposalId, true);

            // Ensure user1 cannot vote twice
            await expect(governance.connect(user1).castVote(proposalId, true))
                .to.be.revertedWithCustomError(governance, "AlreadyVoted");

            const [forVotes, againstVotes] = await governance.getVotes(proposalId);
            
            const user1Power = await veToken.balanceOf(user1.address);
            const user2Power = await veToken.balanceOf(user2.address);
            const user3Power = await veToken.balanceOf(user3.address);
            
            // powers now decay over the 52-week lock window; compare against live balances
            expect(forVotes).to.be.closeTo(user1Power + user3Power, (user1Power + user3Power) * 5n / 100n);
            expect(againstVotes).to.be.closeTo(user2Power, user2Power * 5n / 100n);
        });

        it("should queue successful proposals", async function () {
            const proposalId = 0;
            const votingPeriod = await governance.votingPeriod();
            // the voting window is inclusive of endTime now, so move one second past it
            await time.increase(votingPeriod + 1n);
            await expect(governance.execute(proposalId))
                .to.emit(governance, "ProposalQueued");
        });

        it("should execute queued proposals after timelock", async function () {
            const proposalId = 0;
            const minDelay = await timelock.getMinDelay();
            await time.increase(minDelay);
            await expect(governance.execute(proposalId))
                .to.emit(governance, "ProposalExecuted");
            expect(await gaugeController.isGaugeActive(await newGauge.getAddress())).to.be.true;
        });

        it("should handle failed proposals correctly", async function () {
            const timeNow = BigInt(await time.latest());
            // Create a proposal that will fail due to insufficient support
            const newGaugeAddress = ethers.Wallet.createRandom().address;
            const proposalTargets = [await gaugeController.getAddress()];
            const proposalValues = [0];
            const proposalCalldata = [
                gaugeController.interface.encodeFunctionData("addGauge", [newGaugeAddress])
            ];
            const description = "Proposal that will fail";

            await governance.connect(user1).propose(
                proposalTargets,
                proposalValues,
                proposalCalldata,
                description,
                0
            );

            const proposalId = 1; 
            
            await time.increase(await governance.votingDelay());

            // User4 votes for, but users 1, 2, and 3 vote against
            await governance.connect(user4).castVote(proposalId, true);
            await governance.connect(user1).castVote(proposalId, false);
            await governance.connect(user2).castVote(proposalId, false);
            await governance.connect(user3).castVote(proposalId, false);

            await time.increase((await governance.votingPeriod()) + 1n);

            const proposalInfo = await governance.getProposalInfo(proposalId);
            const totalVotingPower = await veToken.totalSupply();
            
            // powers decay over the 52-week lock window; anchor on live balances instead
            const user1PowerNow = await veToken.balanceOf(user1.address);
            const user2PowerNow = await veToken.balanceOf(user2.address);
            const user3PowerNow = await veToken.balanceOf(user3.address);
            const othersPower = user1PowerNow + user2PowerNow + user3PowerNow;
            expect(proposalInfo.againstVotes).to.be.closeTo(othersPower, othersPower * 5n / 100n);
            // quorum = totalSupply * numerator / denominator; the proposal clearly met it
            const currentQuorum = proposalInfo.forVotes + proposalInfo.againstVotes;
            expect(await governance.quorum()).to.be.gt(0n);
            expect(currentQuorum).to.be.gt(await governance.quorum());
            expect(totalVotingPower).to.be.closeTo(currentQuorum, currentQuorum * 5n / 100n);

            const votingPeriod = await governance.votingPeriod();
            expect(votingPeriod).to.equal(604800n);
            const votingDelay = await governance.votingDelay();
            expect(votingDelay).to.equal(86400n);

            // The proposal is created in a later block than `timeNow`, and with
            // allowBlocksWithSameTimestamp that block's timestamp is either timeNow or timeNow+1
            // depending on whether the wall clock ticked — so anchor loosely, then assert the
            // exact relationship the contract guarantees (endTime = startTime + votingPeriod).
            expect(proposalInfo.startTime).to.closeTo(timeNow + votingDelay, 1);
            expect(proposalInfo.endTime).to.equal(proposalInfo.startTime + votingPeriod);
            
            expect(proposalInfo.currentState).to.equal(3); // Defeated
            expect(proposalInfo.isExecuted).to.be.false;
            expect(proposalInfo.isCanceled).to.be.false;

            const user4Power = await veToken.balanceOf(user4.address)
            // decayed but still positive
            expect(user4Power).to.be.gt(0n);
            expect(user4Power).to.be.lt(USER4_TOKENS);

            const powerVariance = USER4_TOKENS * 5n / 100n; // 5% of locked amount
            expect(proposalInfo.forVotes).to.be.closeTo(user4Power, powerVariance);
            expect(proposalInfo.againstVotes).to.be.gt(proposalInfo.forVotes);

            const state = await governance.state(proposalId);
            expect(state).to.equal(3); // Defeated

            // Should not be able to execute defeated proposal
            await expect(governance.execute(proposalId))
                .to.be.revertedWithCustomError(governance, "InvalidProposalState");
        });
    });
});
