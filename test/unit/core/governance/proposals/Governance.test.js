import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const ProposalState = {
    Pending: 0,
    Active: 1,
    Canceled: 2,
    Defeated: 3,
    Succeeded: 4,
    Queued: 5,
    Executed: 6
};
const GovernanceParameter = {
    VotingDelay: 0,
    VotingPeriod: 1,
    ProposalThreshold: 2,
    Quorum: 3
};

const WEEK = 7 * 24 * 3600;
const DAY = 24 * 3600;
const YEAR = 365 * DAY;
const MAX_LOCK_EPOCHS = 52; // veRAAC locks are now expressed in weekly epochs

// Deploys VeRAACToken with its linked libraries (LockManager first, everything links it)
async function deployVeRAAC(raacTokenAddress, treasury) {
    const LockManagerFactory = await ethers.getContractFactory("LockManager");
    const lockManagerLib = await LockManagerFactory.deploy();
    await lockManagerLib.waitForDeployment();
    const RagequitLibFactory = await ethers.getContractFactory("RagequitLib", {
        libraries: { LockManager: lockManagerLib.target },
    });
    const ragequitLib = await RagequitLibFactory.deploy();
    await ragequitLib.waitForDeployment();
    const PowerCheckpointFactory = await ethers.getContractFactory("PowerCheckpoint", {
        libraries: { LockManager: lockManagerLib.target },
    });
    const powerCheckpointLib = await PowerCheckpointFactory.deploy();
    await powerCheckpointLib.waitForDeployment();
    const RewardLibFactory = await ethers.getContractFactory("RewardLib", {
        libraries: { LockManager: lockManagerLib.target },
    });
    const rewardLib = await RewardLibFactory.deploy();
    await rewardLib.waitForDeployment();

    const VeRAACToken = await ethers.getContractFactory("VeRAACToken", {
        libraries: {
            RagequitLib: ragequitLib.target,
            PowerCheckpoint: powerCheckpointLib.target,
            LockManager: lockManagerLib.target,
            RewardLib: rewardLib.target,
        },
    });
    const veToken = await VeRAACToken.deploy(raacTokenAddress, treasury, MAX_LOCK_EPOCHS);
    await veToken.waitForDeployment();
    return veToken;
}

// Helper clean block timestamp
async function moveToNextTimeframe() {
    const currentTime = await time.latest();
    const nextWeekStart = Math.floor((currentTime + WEEK) / WEEK) * WEEK;
    await time.setNextBlockTimestamp(nextWeekStart);
    await network.provider.send("evm_mine");
    return nextWeekStart;
}

describe("Governance", () => {
    let governance;
    let timelock;
    let veToken;
    let raacToken;
    let testTarget;
    let payableTestTarget;
    let owner;
    let user1;
    let user2;
    let users;

    // Constants
    const VOTING_DELAY = 1 * 24 * 3600; // 1 day
    const VOTING_PERIOD = 7 * 24 * 3600; // 1 week
    const PROPOSAL_THRESHOLD = ethers.parseEther("100000"); // 100k veRAAC
    const QUORUM = ethers.parseEther("1000000"); // 1M veRAAC

    beforeEach(async () => {
        [owner, user1, user2, ...users] = await ethers.getSigners();

        // Deploy test target first
        const TimelockTestTarget = await ethers.getContractFactory("TimelockTestTarget");
        testTarget = await TimelockTestTarget.deploy();
        await testTarget.waitForDeployment();

        // Deploy payable test target (for testing ETH value transfer and forwarding)
        const TimelockPayableTestTarget = await ethers.getContractFactory("TimelockPayableTestTarget");
        payableTestTarget = await TimelockPayableTestTarget.deploy();
        await payableTestTarget.waitForDeployment();

        // Deploy RAAC token
        const RAACToken = await ethers.getContractFactory("RAACToken");
        raacToken = await RAACToken.deploy(owner.address);
        await raacToken.waitForDeployment();

        // Deploy VeRAACToken
        veToken = await deployVeRAAC(await raacToken.getAddress(), owner.address);

        // Deploy timelock
        const TimelockController = await ethers.getContractFactory("TimelockController");
        timelock = await TimelockController.deploy(
            2 * 24 * 3600,
            [await owner.getAddress()],
            [await owner.getAddress()],
            await owner.getAddress()
        );
        await timelock.waitForDeployment();

        // Deploy governance
        const Governance = await ethers.getContractFactory("Governance");
        governance = await Governance.deploy(
            await veToken.getAddress(),
            await timelock.getAddress()
        );
        await governance.waitForDeployment();

        await raacToken.setMinter(owner.address);

        await raacToken.mint(owner.address, ethers.parseEther("1000000")); // 1M RAAC
        await raacToken.mint(user1.address, ethers.parseEther("600000")); // 0.6M RAAC
        await raacToken.mint(user2.address, ethers.parseEther("100000")); // 0.1M RAAC

        await raacToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));
        await raacToken.connect(user1).approve(await veToken.getAddress(), ethers.parseEther("600000"));
        await raacToken.connect(user2).approve(await veToken.getAddress(), ethers.parseEther("100000"));

        // Lock tokens for 1 year to get maximum voting power
        await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);
        await veToken.connect(user1).lock(ethers.parseEther("600000"), MAX_LOCK_EPOCHS);
        await veToken.connect(user2).lock(ethers.parseEther("100000"), MAX_LOCK_EPOCHS);

        await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governance.getAddress());
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), await governance.getAddress());
        await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governance.getAddress());
    });

    describe("Proposal Creation", () => {
        it("should create proposal when caller has sufficient voting power", async () => {
            const targets = [await testTarget.getAddress()];
            const values = [0];
            const calldatas = [testTarget.interface.encodeFunctionData("setValue", [42])];
            const description = "Test Proposal";

            await expect(governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                description,
                0 // ParameterChange
            )).to.emit(governance, "ProposalCreated");
        });

        it("should revert when caller has insufficient voting power", async () => {
            const [, , , lowPowerUser] = await ethers.getSigners();
            
            await raacToken.mint(lowPowerUser.address, ethers.parseEther("50000")); // Below threshold
            await raacToken.connect(lowPowerUser).approve(await veToken.getAddress(), ethers.parseEther("50000"));
            await veToken.connect(lowPowerUser).lock(ethers.parseEther("50000"), MAX_LOCK_EPOCHS);

            const targets = [await testTarget.getAddress()];
            const values = [0];
            const calldatas = [testTarget.interface.encodeFunctionData("setValue", [42])];
            const description = "Test Proposal";

            await expect(governance.connect(lowPowerUser).propose(
                targets,
                values,
                calldatas,
                description,
                0
            )).to.be.revertedWithCustomError(governance, "InsufficientProposerVotes");
        });

        it("should handle multiple actions in single proposal", async () => {
            const targets = [await testTarget.getAddress(), await testTarget.getAddress()];
            const values = [0, 0];
            const calldatas = [
                testTarget.interface.encodeFunctionData("setValue", [1]),
                testTarget.interface.encodeFunctionData("setValue", [2])
            ];
            const description = "Multiple Actions";

            // User1 has enough voting power from the initial setup
            await expect(governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                description,
                0 // ParameterChange
            )).to.emit(governance, "ProposalCreated");
        });
    });

    describe("Voting", () => {
        let proposalId;

        beforeEach(async () => {
            const targets = [await testTarget.getAddress()];
            const values = [0];
            const calldatas = [testTarget.interface.encodeFunctionData("setValue", [42])];
            const description = "Test Proposal";

            const tx = await governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                description,
                0
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            proposalId = event.args.proposalId;

            await time.increase(VOTING_DELAY);
        });

        it("should allow voting when proposal is active", async () => {
            await expect(governance.connect(user1).castVote(proposalId, true))
                .to.emit(governance, "VoteCast");
        });

        it("should prevent double voting", async () => {
            await governance.connect(user1).castVote(proposalId, true);
            await expect(governance.connect(user1).castVote(proposalId, true))
                .to.be.revertedWithCustomError(governance, "AlreadyVoted");
        });

        it("should track votes correctly", async () => {
            await governance.connect(user1).castVote(proposalId, true);
            const [forVotes, againstVotes] = await governance.getVotes(proposalId);
            
            const expectedVotingPower = await veToken.balanceOf(user1.address);
            expect(forVotes).to.be.closeTo(expectedVotingPower, expectedVotingPower / 1000n); // 0.1% tolerance
            expect(againstVotes).to.equal(0);
        });
    });

    describe("Proposal Execution", () => {
        let proposalId;

        beforeEach(async () => {
            // Create a proposal using user1 who has sufficient voting power
            const targets = [await testTarget.getAddress()];
            const values = [0];
            const calldatas = [
                testTarget.interface.encodeFunctionData("setValue", [42])
            ];
            
            const tx = await governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                "Test Proposal",
                0 // ParameterChange
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            proposalId = event.args.proposalId;

            // Advance time to voting period
            await time.increase(VOTING_DELAY);
        });

        it("should execute successful proposal", async () => {
            // User1 has enough voting power from initial setup
            const startTime = await moveToNextTimeframe();
            
            expect(await governance.state(proposalId)).to.equal(ProposalState.Active);
            
            // Cast vote
            await governance.connect(user1).castVote(proposalId, true);
            
            expect(await governance.state(proposalId)).to.equal(ProposalState.Active);
            
            // Wait for voting period to end
            await time.increaseTo(startTime + VOTING_PERIOD);
            await network.provider.send("evm_mine");
            
            // Verify state is Succeeded
            expect(await governance.state(proposalId)).to.equal(ProposalState.Succeeded);
            
            // Queue the proposal
            await governance.execute(proposalId);
            expect(await governance.state(proposalId)).to.equal(ProposalState.Queued);
            
            // Wait for timelock delay
            const timelockDelay = await timelock.getMinDelay();
            await time.increase(timelockDelay);
            await network.provider.send("evm_mine");
            
            // Execute the proposal
            await governance.execute(proposalId);
            await logProposalState(governance, proposalId);
            expect(await governance.state(proposalId)).to.equal(ProposalState.Executed);
            
            // Verify the change
            expect(await testTarget.value()).to.equal(42n);
        });

        it("should revert execution if quorum not met", async () => {
            const [, , , lowPowerUser] = await ethers.getSigners();
            
            // Amount is less than quorum
            await raacToken.mint(lowPowerUser.address, ethers.parseEther("1000"));// 1k RAAC won't be enough
            await raacToken.connect(lowPowerUser).approve(await veToken.getAddress(), ethers.parseEther("1000"));
            await veToken.connect(lowPowerUser).lock(ethers.parseEther("1000"), MAX_LOCK_EPOCHS);
            
            await governance.connect(lowPowerUser).castVote(proposalId, true);
            
            await time.increase(VOTING_PERIOD);

            await expect(governance.execute(proposalId))
                .to.be.revertedWithCustomError(governance, "InvalidProposalState");
        });

        it("should revert execution if proposal defeated", async () => {
            // Have users with significant voting power vote against
            await governance.connect(user1).castVote(proposalId, false); // 6M voting power
            await governance.connect(user2).castVote(proposalId, false); // 1M voting power
            
            await time.increase(VOTING_PERIOD);
            await time.increase(await timelock.getMinDelay());

            await expect(governance.execute(proposalId))
                .to.be.revertedWithCustomError(governance, "InvalidProposalState");
        });

        it("should execute payable proposal with proper ETH value", async () => {
            // Create a proposal with ETH transfer
            const targets = [await payableTestTarget.getAddress()];
            const values = [ethers.parseEther("1")]; // 1 ETH
            const calldatas = [payableTestTarget.interface.encodeFunctionData("setValue", [42])];
            
            const tx = await governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                "Payable Proposal Test",
                0
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const payableProposalId = event.args.proposalId;

            await time.increase(VOTING_DELAY);
            await governance.connect(user1).castVote(payableProposalId, true);
            
            await time.increase(VOTING_PERIOD + 1);
            await governance.execute(payableProposalId);
            await time.increase(await timelock.getMinDelay());

            // Execute with exact value
            await expect(governance.execute(payableProposalId, { value: ethers.parseEther("1") }))
                .to.emit(governance, "ProposalExecuted");
            
            expect(await payableTestTarget.value()).to.equal(42);
            expect(await payableTestTarget.getReceivedEth()).to.equal(ethers.parseEther("1"));
        });

        it("should revert execution if insufficient ETH value provided", async () => {
            // proposal includes ETH transfer
            const targets = [await payableTestTarget.getAddress()];
            const values = [ethers.parseEther("1")]; // 1 ETH
            const calldatas = [payableTestTarget.interface.encodeFunctionData("setValue", [42])];
            
            const tx = await governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                "Payable Proposal Test",
                0
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const payableProposalId = event.args.proposalId;

            await time.increase(VOTING_DELAY);
            await governance.connect(user1).castVote(payableProposalId, true);
            await time.increase(VOTING_PERIOD + 1);
            await governance.execute(payableProposalId);
            await time.increase(await timelock.getMinDelay());
            
            // Try to execute with insufficient ETH value
            await expect(governance.execute(payableProposalId, { value: ethers.parseEther("0.5") }))
                .to.be.revertedWithCustomError(governance, "InsufficientValueForExecution");
        });

        it("should handle excess ETH value and refund correctly", async () => {
            // Create a proposal that includes ETH transfer
            const targets = [await payableTestTarget.getAddress()];
            const values = [ethers.parseEther("1")]; // 1 ETH
            const calldatas = [payableTestTarget.interface.encodeFunctionData("setValue", [42])];
            
            const tx = await governance.connect(user1).propose(
                targets,
                values,
                calldatas,
                "Payable Proposal Test",
                0
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const payableProposalId = event.args.proposalId;

            await time.increase(VOTING_DELAY);
            await governance.connect(user1).castVote(payableProposalId, true);
            await time.increase(VOTING_PERIOD + 1);
            await governance.execute(payableProposalId);
            
            await time.increase(await timelock.getMinDelay());

            const initialUserBalance = await ethers.provider.getBalance(user1.address);
            const initialTargetBalance = await ethers.provider.getBalance(await payableTestTarget.getAddress());
            
            // Execute with excess ETH value (2 ETH when only 1 ETH is needed - we shall get 1 ETH back)
            const excessAmount = ethers.parseEther("2");
            const tx2 = await governance.connect(user1).execute(payableProposalId, { value: excessAmount });
            const receipt2 = await tx2.wait();
            const gasCost = receipt2.gasUsed * receipt2.gasPrice;
            const finalUserBalance = await ethers.provider.getBalance(user1.address);
            const finalTargetBalance = await ethers.provider.getBalance(await payableTestTarget.getAddress());
            
            expect(finalTargetBalance - initialTargetBalance).to.equal(ethers.parseEther("1"));
            // - Initial balance - 2 ETH sent + 1 ETH refunded - gas cost
            const expectedBalance = initialUserBalance - excessAmount + ethers.parseEther("1") - gasCost;
            expect(finalUserBalance).to.be.closeTo(expectedBalance, ethers.parseEther("0.0005"));
            expect(await payableTestTarget.value()).to.equal(42);
            expect(await payableTestTarget.getReceivedEth()).to.equal(ethers.parseEther("1"));
        });
    });

    describe("Parameter Management", () => {
        it("should allow owner to update voting delay", async () => {
            const newDelay = 2 * 24 * 3600; // 2 days
            
            await expect(governance.setParameter(GovernanceParameter.VotingDelay, newDelay))
                .to.emit(governance, "VotingDelaySet");
            
            expect(await governance.votingDelay()).to.equal(newDelay);
        });

        it("should validate voting delay bounds", async () => {
            // Test below minimum (1 hour)
            await expect(governance.setParameter(GovernanceParameter.VotingDelay, 3599)) // 1 hour - 1 second
                .to.be.revertedWithCustomError(governance, "InvalidVotingDelay");
            
            // Test above maximum (2 weeks)
            await expect(governance.setParameter(GovernanceParameter.VotingDelay, 2 * 7 * 24 * 3600 + 1)) // 2 weeks + 1 second
                .to.be.revertedWithCustomError(governance, "InvalidVotingDelay");
        });

        it("should allow owner to update voting period", async () => {
            const newPeriod = 10 * 24 * 3600; // 10 days
            
            await expect(governance.setParameter(GovernanceParameter.VotingPeriod, newPeriod))
                .to.emit(governance, "VotingPeriodSet");
            
            expect(await governance.votingPeriod()).to.equal(newPeriod);
        });
    });

    describe("Integration Scenarios", () => {
        beforeEach(async () => {
            // Reset proposal count and clear any existing proposals
            await network.provider.send("hardhat_reset");
            
            // Redeploy all contracts
            [owner, user1, user2, ...users] = await ethers.getSigners();

            // Deploy test target first
            const TimelockTestTarget = await ethers.getContractFactory("TimelockTestTarget");
            testTarget = await TimelockTestTarget.deploy();
            await testTarget.waitForDeployment();

            const RAACToken = await ethers.getContractFactory("RAACToken");
            raacToken = await RAACToken.deploy(owner.address);
            await raacToken.waitForDeployment();

            veToken = await deployVeRAAC(await raacToken.getAddress(), owner.address);

            const TimelockController = await ethers.getContractFactory("TimelockController");
            timelock = await TimelockController.deploy(
                2 * 24 * 3600,
                [await owner.getAddress()],
                [await owner.getAddress()],
                await owner.getAddress()
            );
            await timelock.waitForDeployment();

            const Governance = await ethers.getContractFactory("Governance");
            governance = await Governance.deploy(
                await veToken.getAddress(),
                await timelock.getAddress()
            );
            await governance.waitForDeployment();

            await raacToken.setMinter(owner.address);
            // Mint RAAC tokens
            await raacToken.mint(owner.address, ethers.parseEther("1000000")); // 1M RAAC
            await raacToken.mint(user1.address, ethers.parseEther("600000")); // 0.6M RAAC
            await raacToken.mint(user2.address, ethers.parseEther("100000")); // 0.1M RAAC

            // Lock RAAC tokens for voting power
            await raacToken.approve(await veToken.getAddress(), ethers.parseEther("1000000"));
            await raacToken.connect(user1).approve(await veToken.getAddress(), ethers.parseEther("600000"));
            await raacToken.connect(user2).approve(await veToken.getAddress(), ethers.parseEther("100000"));

            // Lock tokens for 1 year to get maximum voting power
            await veToken.lock(ethers.parseEther("1000000"), MAX_LOCK_EPOCHS);
            await veToken.connect(user1).lock(ethers.parseEther("600000"), MAX_LOCK_EPOCHS);
            await veToken.connect(user2).lock(ethers.parseEther("100000"), MAX_LOCK_EPOCHS);

            await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governance.getAddress());
            await timelock.grantRole(await timelock.EXECUTOR_ROLE(), await governance.getAddress());
            await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governance.getAddress());
        });

        it("should handle full proposal lifecycle", async () => {
            const targets = [await testTarget.getAddress()];
            const values = [0];
            const calldatas = [testTarget.interface.encodeFunctionData("setValue", [42])];
            
            const startTime = await moveToNextTimeframe();
            
            const tx = await governance.connect(owner).propose(
                targets,
                values,
                calldatas,
                "Full Lifecycle Test",
                0
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const proposalId = event.args.proposalId;

            // Initial state should be Pending
            expect(await governance.state(proposalId)).to.equal(ProposalState.Pending);

            // Wait for voting delay
            await time.increase(VOTING_DELAY);
            await network.provider.send("evm_mine");
            
            // Should be Active
            expect(await governance.state(proposalId)).to.equal(ProposalState.Active);

            // Cast votes
            await governance.connect(user1).castVote(proposalId, true);
            await governance.connect(user2).castVote(proposalId, true);

            // Wait for voting period to end
            await time.increaseTo(startTime + VOTING_DELAY + VOTING_PERIOD + 1);
            await network.provider.send("evm_mine");

            // Log state for debugging
            
            const currentState = await governance.state(proposalId);

            // Should be in Succeeded state
            expect(await governance.state(proposalId)).to.equal(ProposalState.Succeeded);

            // Queue and execute
            await governance.execute(proposalId);
            expect(await governance.state(proposalId)).to.equal(ProposalState.Queued);

            // Wait for timelock delay
            await time.increase(await timelock.getMinDelay());
            await network.provider.send("evm_mine");

            // Execute the proposal
            await governance.execute(proposalId);
            expect(await governance.state(proposalId)).to.equal(ProposalState.Executed);

            // Verify the change
            expect(await testTarget.value()).to.equal(42);
        });


        async function castVotesOnProposals(proposalId1, proposalId2) {
            await governance.connect(user1).castVote(proposalId1, true);
            await governance.connect(user2).castVote(proposalId1, true);
            await governance.connect(user1).castVote(proposalId2, true);
            await governance.connect(user2).castVote(proposalId2, true);
        }
        async function createTwoProposals() {
            // Create first proposal
            const tx1 = await governance.connect(owner).propose(
                [await testTarget.getAddress()],
                [0],
                [testTarget.interface.encodeFunctionData("setValue", [42])],
                "First Proposal",
                0
            );
            const receipt1 = await tx1.wait();
            const event1 = receipt1.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const proposalId1 = event1.args.proposalId;

            // Create second proposal
            const tx2 = await governance.connect(owner).propose(
                [await testTarget.getAddress()],
                [0],
                [testTarget.interface.encodeFunctionData("setValue", [84])],
                "Second Proposal",
                0
            );
            const receipt2 = await tx2.wait();
            const event2 = receipt2.logs.find(
                log => governance.interface.parseLog(log)?.name === 'ProposalCreated'
            );
            const proposalId2 = event2.args.proposalId;

            return [proposalId1, proposalId2];
        }

        it("should handle concurrent proposals", async () => {
            // Get current time and calculate next week boundary
            const currentTime = await time.latest();
            const startTime = Math.floor((currentTime + WEEK) / WEEK) * WEEK;
            
            // Move to start time
            await time.setNextBlockTimestamp(startTime);
            await network.provider.send("evm_mine");
            
            // Create proposals
            const [proposalId1, proposalId2] = await createTwoProposals();
            
            // Wait for voting delay
            await time.increase(VOTING_DELAY);
            await network.provider.send("evm_mine");
            
            // Both should be Active
            expect(await governance.state(proposalId1)).to.equal(ProposalState.Active);
            expect(await governance.state(proposalId2)).to.equal(ProposalState.Active);

            // Cast votes
            await castVotesOnProposals(proposalId1, proposalId2);

            // Wait for voting period to end
            await time.increaseTo(startTime + VOTING_DELAY + VOTING_PERIOD + 1);
            await network.provider.send("evm_mine");

            // Both should be Succeeded
            expect(await governance.state(proposalId1)).to.equal(ProposalState.Succeeded);
            expect(await governance.state(proposalId2)).to.equal(ProposalState.Succeeded);

            // Queue both proposals
            await governance.execute(proposalId1);
            await governance.execute(proposalId2);
            
            // Both should be Queued
            expect(await governance.state(proposalId1)).to.equal(ProposalState.Queued);
            expect(await governance.state(proposalId2)).to.equal(ProposalState.Queued);

            // Wait for timelock delay
            await time.increase(await timelock.getMinDelay());
            await network.provider.send("evm_mine");

            // Execute both proposals
            await governance.execute(proposalId1);
            await governance.execute(proposalId2);
            
            // Both should be Executed
            expect(await governance.state(proposalId1)).to.equal(ProposalState.Executed);
            expect(await governance.state(proposalId2)).to.equal(ProposalState.Executed);

            // Verify final state
            expect(await testTarget.value()).to.equal(84);
        });
    });
});
async function logProposalState(governance, proposalId) {
    const debug = await governance.getProposalInfo(proposalId);
    console.log('\nProposal Info:');
    const state = debug.currentState;

    console.log('\n  Timeline for Proposal:', proposalId);
    console.log('          = State :', Object.keys(ProposalState).find(key => ProposalState[key] === Number(state)).toUpperCase(), '| isExecuted:', debug.isExecuted, '| isCanceled:', debug.isCanceled);
    console.log('          Current                ', new Date(Number(debug.currentTime) * 1000).toISOString().padEnd(12));
    console.log('          Start                  ', new Date(Number(debug.startTime) * 1000).toISOString().padEnd(12));
    console.log('          End                    ', new Date(Number(debug.endTime) * 1000).toISOString());

    console.log('\nVoting Results:','\x1b[32mFor: ' + ethers.formatEther(debug.forVotes) + '\x1b[0m | \x1b[31mAgainst: ' + ethers.formatEther(debug.againstVotes) + '\x1b[0m');

    console.log('\nQuorum Status:');
    console.log('          Current:', ethers.formatEther(debug.currentQuorum), '/', ethers.formatEther(debug.requiredQuorum));
}
