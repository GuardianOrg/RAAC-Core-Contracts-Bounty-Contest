import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
const { ethers } = hre;
const { MaxUint256 } = ethers;
const WEEK = 7 * 24 * 60 * 60;
const YEAR = 365 * 24 * 60 * 60;
const MAX_TOTAL = ethers.parseEther("10000000");

describe("PowerCheckpoint", () => {
    let powerCheckpoint;
    let mockUser;
    let lockLib;
    let powerLib;

    beforeEach(async () => {
        const [signer] = await ethers.getSigners();
        mockUser = signer;

        // Deploy and link required libraries: PowerCheckpoint and LockManager
        const LockManagerLib = await ethers.getContractFactory("LockManager");
        lockLib = await LockManagerLib.deploy();
        const PowerCheckpointLib = await ethers.getContractFactory("PowerCheckpoint", {
            libraries: { LockManager: await lockLib.getAddress() },
        });
        powerLib = await PowerCheckpointLib.deploy();
        const PowerCheckpointMock = await ethers.getContractFactory("PowerCheckpointMock", {
            libraries: { PowerCheckpoint: await powerLib.getAddress(), LockManager: await lockLib.getAddress() },
        });
        powerCheckpoint = await PowerCheckpointMock.deploy();
        const maxLockEpochs = Math.floor((4 * YEAR) / WEEK);
        await powerCheckpoint.setLockParams(WEEK, maxLockEpochs);
    });

    describe("Basic Functionality", () => {
        it("should write and read checkpoints correctly", async () => {
            const power = ethers.parseEther("100");

            // Write checkpoint
            await powerCheckpoint.writeCheckpoint(mockUser.address, power);
            await ethers.provider.send("evm_mine", []);

            // Get the current block number
            const currentBlock = await powerCheckpoint.getCurrentBlockNumber();

            // Get power from the previous block
            const storedPower = await powerCheckpoint.getCheckpointValue(mockUser.address, 0);

            expect(storedPower).to.equal(power);
        });

        it("should handle multiple checkpoints for same user", async () => {
            const powers = [100, 200, 300].map(x => ethers.parseEther(x.toString()));

            // Create checkpoints
            for (const power of powers) {
                await powerCheckpoint.writeCheckpoint(mockUser.address, power);
                await ethers.provider.send("evm_mine", []);
            }

            // Verify each checkpoint
            for (let i = 0; i < powers.length; i++) {
                const storedPower = await powerCheckpoint.getCheckpointValue(mockUser.address, i);
                expect(storedPower).to.equal(powers[i]);
            }
        });

        it("findCheckpointIndex covers empty, exact, and nearest lower", async () => {
            // empty
            const idxEmpty = await powerCheckpoint.findIndex(mockUser.address, 1);
            expect(idxEmpty).to.equal(0);

            // create two checkpoints
            await powerCheckpoint.writeCheckpoint(mockUser.address, ethers.parseEther("10"));
            await ethers.provider.send("evm_mine", []);
            const b1 = await powerCheckpoint.getCheckpointBlock(0);
            // ensure a gap > 1 block before second checkpoint
            await ethers.provider.send("evm_mine", []);
            await powerCheckpoint.writeCheckpoint(mockUser.address, ethers.parseEther("20"));
            await ethers.provider.send("evm_mine", []);
            const b2 = await powerCheckpoint.getCheckpointBlock(1);

            // exact matches
            const i1 = await powerCheckpoint.findIndex(mockUser.address, b1);
            const i2 = await powerCheckpoint.findIndex(mockUser.address, b2);
            expect(i1).to.equal(0);
            expect(i2).to.equal(1);

            // nearest lower (between b1 and b2)
            const midBlock = b1 + 1n;
            const inBetween = await powerCheckpoint.findIndex(mockUser.address, midBlock);
            expect(inBetween).to.equal(0);
        });
    });

    describe("Property-based tests", () => {
        it("should maintain power history integrity", async () => {
            const powers = Array(5).fill(0).map(() =>
                ethers.parseEther((Math.random() * 1000).toFixed(18))
            );

            // Create checkpoints
            for (const power of powers) {
                await powerCheckpoint.writeCheckpoint(mockUser.address, power);
                await ethers.provider.send("evm_mine", []);
            }

            // Verify the last checkpoint
            const lastPower = await powerCheckpoint.getCheckpointValue(mockUser.address, powers.length - 1);
            expect(lastPower).to.equal(powers[powers.length - 1]);
        });
    });

    describe("Edge Cases", () => {
        it("should handle zero power updates", async () => {
            await powerCheckpoint.writeCheckpoint(mockUser.address, 0);
            await ethers.provider.send("evm_mine", []);

            const storedPower = await powerCheckpoint.getCheckpointValue(mockUser.address, 0);
            expect(storedPower).to.equal(0);
        });

        it("should handle max uint256 power", async () => {
            const maxPower = MaxUint256;
            await expect(
                powerCheckpoint.writeCheckpoint(mockUser.address, maxPower)
            ).to.be.revertedWithCustomError(powerLib, "PowerTooHigh");
        });

        it("should get voting power at specific block", async () => {
            const power1 = ethers.parseEther("100");
            const power2 = ethers.parseEther("200");

            // Write first checkpoint
            await powerCheckpoint.writeCheckpoint(mockUser.address, power1);
            await ethers.provider.send("evm_mine", []);
            const block1 = await powerCheckpoint.getCurrentBlockNumber();

            // Mine some blocks
            await ethers.provider.send("evm_mine", []);
            await ethers.provider.send("evm_mine", []);

            // Write second checkpoint
            await powerCheckpoint.writeCheckpoint(mockUser.address, power2);
            await ethers.provider.send("evm_mine", []);
            const block2 = await powerCheckpoint.getCurrentBlockNumber();

            // Verify checkpoints
            const power1Stored = await powerCheckpoint.getCheckpointValue(mockUser.address, 0);
            const power2Stored = await powerCheckpoint.getCheckpointValue(mockUser.address, 1);

            expect(power1Stored).to.equal(power1);
            expect(power2Stored).to.equal(power2);
        });

        it("setProposalSnapshot validations", async () => {
            const currentBlock = await powerCheckpoint.getCurrentBlockNumber();
            await expect(powerCheckpoint.setProposalSnapshot(0, currentBlock - 1n)).to.be.revertedWithCustomError(
                powerLib,
                "InvalidProposalId"
            );
            // use a block number guaranteed to be >= execution block to trigger revert
            await expect(powerCheckpoint.setProposalSnapshot(1, currentBlock + 1000n)).to.be.revertedWithCustomError(
                powerLib,
                "InvalidBlockNumber"
            );
        });

        it("getPastTotalSupply decays from global point when no exact cp", async () => {
            // Create a lock to generate a global point
            await powerCheckpoint.createLock(mockUser.address, ethers.parseEther("50"), 4);
            // Write a total supply checkpoint at current block
            await powerCheckpoint.writeCheckpoint(ethers.ZeroAddress, 0);
            // Mine to ensure target block is strictly after the cp.fromBlock
            await ethers.provider.send("evm_mine", []);
            await time.increase(60);
            await ethers.provider.send("evm_mine", []);

            // getPastTotalSupply is a strictly-past lookup, so target the previous block
            const targetBlock = (await powerCheckpoint.getCurrentBlockNumber()) - 1n;
            const [total] = await powerCheckpoint.getPastTotalSupply(targetBlock);
            expect(total).to.be.gt(0n);
        });
    });

    describe("Stress Testing", () => {
        it("should handle rapid checkpoint creation", async () => {
            const checkpointCount = 10;

            for (let i = 0; i < checkpointCount; i++) {
                const power = ethers.parseEther((i + 1).toString());
                await powerCheckpoint.writeCheckpoint(mockUser.address, power);
                await ethers.provider.send("evm_mine", []);
            }

            // Verify the last checkpoint
            const finalPower = await powerCheckpoint.getCheckpointValue(mockUser.address, checkpointCount - 1);
            expect(finalPower).to.equal(ethers.parseEther(checkpointCount.toString()));
        });
    });
});
