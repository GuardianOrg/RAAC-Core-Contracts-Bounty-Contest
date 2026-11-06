import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";
const { ethers } = hre;

describe("LockManager", () => {
    let lockManager;
    let mockUser;
    let lockLib;
    const WEEK = 7 * 24 * 60 * 60;
    const YEAR = 365 * 24 * 60 * 60;
    const MAX_TOTAL = ethers.parseEther("10000000");

    async function calcEpochEnd(epochs) {
        const now = await time.latest();
        const ts = now + epochs * WEEK;
        const rounded = Math.floor(ts / WEEK) * WEEK + (ts % WEEK === 0 ? 0 : WEEK);
        return BigInt(rounded);
    }

    // Read a user's lock amount for a given unlockTime by iterating the lock
    // array (the mock's findUserLockAmount getter takes uint32 which overflows
    // for large timestamps when the suite has advanced time far into the future)
    async function findUserLockAmount(user, unlockTime) {
        const count = await lockManager.getUserLocksCount(user);
        let total = 0n;
        for (let i = 0n; i < count; i++) {
            const [amount, lockEnd] = await lockManager.getUserLockAt(user, i);
            if (lockEnd === BigInt(unlockTime)) total += amount;
        }
        return total;
    }

    beforeEach(async () => {
        const [signer] = await ethers.getSigners();
        mockUser = signer;

        // Deploy and link LockManager library, then deploy mock
        const LockManagerLib = await ethers.getContractFactory("LockManager");
        lockLib = await LockManagerLib.deploy();
        const LockManagerMock = await ethers.getContractFactory("LockManagerMock", {
            libraries: { LockManager: await lockLib.getAddress() },
        });
        lockManager = await LockManagerMock.deploy();

        const maxLockEpochs = Math.floor((4 * YEAR) / WEEK);
        await lockManager.setLockParams(WEEK, maxLockEpochs);
    });

    describe("Basic Lock Operations", () => {
        it("should create a lock successfully", async () => {
            const amount = ethers.parseEther("100");
            const epochs = 1;

            await (await lockManager.createLock(mockUser.address, amount, epochs)).wait();

            const epochEnd = await calcEpochEnd(epochs);
            const stored = await findUserLockAmount(mockUser.address, epochEnd);
            expect(stored).to.equal(amount);
        });

        it("should increase lock amount", async () => {
            const initialAmount = ethers.parseEther("100");
            const additionalAmount = ethers.parseEther("50");

            const epochs = 1;
            await (await lockManager.createLock(mockUser.address, initialAmount, epochs)).wait();
            const epochEnd = await calcEpochEnd(epochs);
            await (await lockManager.increaseLock(mockUser.address, additionalAmount, Number(epochEnd))).wait();

            const stored = await findUserLockAmount(mockUser.address, epochEnd);
            expect(stored).to.equal(initialAmount + additionalAmount);
        });

        it("should extend lock duration", async () => {
            const amount = ethers.parseEther("100");
            const epochs = 1;
            await (await lockManager.createLock(mockUser.address, amount, epochs)).wait();
            const fromEpochEnd = await calcEpochEnd(epochs);

            const addEpochs = 2;
            await (await lockManager.extendLock(mockUser.address, Number(fromEpochEnd), addEpochs)).wait();

            const newEpochEnd = await calcEpochEnd(epochs + addEpochs);
            const storedNew = await findUserLockAmount(mockUser.address, newEpochEnd);
            expect(storedNew).to.equal(amount);
        });
    });

    describe("Validation and Edge Cases", () => {
        it("should revert on zero amount lock", async () => {
            await expect(
                lockManager.createLock(mockUser.address, 0, 1)
            ).to.be.revertedWithCustomError(lockLib, "InvalidAmount");
        });

        it("should revert on invalid duration", async () => {
            const amount = ethers.parseEther("100");
            await expect(
                lockManager.createLock(mockUser.address, amount, 0)
            ).to.be.revertedWithCustomError(lockLib, "InvalidEpoch");
        });

        it("should revert when increasing non-existent lock", async () => {
            await expect(
                lockManager.increaseLock(mockUser.address, ethers.parseEther("100"), Number(await calcEpochEnd(1)))
            ).to.be.revertedWithCustomError(lockLib, "MissingEpoch");
        });

        it("should revert when extending after withdrawal of expired lock", async () => {
            const amount = ethers.parseEther("100");
            const epochs = 1;
            await (await lockManager.createLock(mockUser.address, amount, epochs)).wait();
            const fromEpochEnd = await calcEpochEnd(epochs);

            await time.increaseTo(Number(fromEpochEnd) + 1);
            const [withdrawn, processed] = await lockManager.withdrawExpired.staticCall(mockUser.address);
            expect(withdrawn).to.be.gt(0n);
            await (await lockManager.withdrawExpired(mockUser.address)).wait();

            await expect(
                lockManager.extendLock(mockUser.address, Number(fromEpochEnd), 2)
            ).to.be.revertedWithCustomError(lockLib, "MissingEpoch");
        });

        it("should revert when extending with zero fromEpochEnd", async () => {
            await expect(
                lockManager.extendLock(mockUser.address, 0, 1)
            ).to.be.revertedWithCustomError(lockLib, "InvalidEpoch");
        });

        it("should revert withdrawExpired and emergencyWithdrawAll when no tokens locked", async () => {
            await expect(
                lockManager.withdrawExpired(mockUser.address)
            ).to.be.revertedWithCustomError(lockLib, "NoTokensLocked");

            await expect(
                lockManager.emergencyWithdrawAll(mockUser.address)
            ).to.be.revertedWithCustomError(lockLib, "NoTokensLocked");
        });

        it("should guard against ValueTooLargeToCast overflow when creating lock", async () => {
            // Construct an amount that forces slopeUint > MAX_CASTABLE_INT128 inside _calculateVotingPower
            const maxLockEpochs = BigInt(Math.floor((4 * YEAR) / WEEK));
            const maxTime = maxLockEpochs * BigInt(WEEK);
            const maxCastablePlusOne = (1n << 127n); // > int128 max
            const hugeAmount = maxCastablePlusOne * maxTime;

            await expect(
                lockManager.createLock(mockUser.address, hugeAmount, 1)
            ).to.be.revertedWithCustomError(lockLib, "ValueTooLargeToCast");
        });

        it("should withdraw a specific lock and update checkpoints", async () => {
            const amount = ethers.parseEther("100");
            await (await lockManager.createLock(mockUser.address, amount, 1)).wait();
            const end = await calcEpochEnd(1);

            const withdrawn = await lockManager.withdrawSpecificLock.staticCall(mockUser.address, Number(end));
            expect(withdrawn).to.equal(amount);
            await (await lockManager.withdrawSpecificLock(mockUser.address, Number(end))).wait();

            const stored = await findUserLockAmount(mockUser.address, end);
            expect(stored).to.equal(0n);
        });
    });

    describe("Lock State Management", () => {
        it("should track total locked amount correctly", async () => {
            const amount1 = ethers.parseEther("100");
            const amount2 = ethers.parseEther("50");

            await lockManager.createLock(mockUser.address, amount1, 1);
            const totalLocked1 = await lockManager.getTotalLocked();
            expect(totalLocked1).to.equal(amount1);

            const epochEnd = await calcEpochEnd(1);
            await lockManager.increaseLock(mockUser.address, amount2, Number(epochEnd));
            const totalLocked2 = await lockManager.getTotalLocked();
            expect(totalLocked2).to.equal(amount1 + amount2);
        });

        it("should handle multiple user locks", async () => {
            const [, user2] = await ethers.getSigners();
            const amount1 = ethers.parseEther("100");
            const amount2 = ethers.parseEther("200");

            await lockManager.createLock(mockUser.address, amount1, 1);
            await lockManager.createLock(user2.address, amount2, 1);

            const epochEnd = await calcEpochEnd(1);
            const lock1Amt = await findUserLockAmount(mockUser.address, epochEnd);
            const lock2Amt = await findUserLockAmount(user2.address, epochEnd);

            expect(lock1Amt).to.equal(amount1);
            expect(lock2Amt).to.equal(amount2);
        });

        it("should emergency withdraw all and zero voting power", async () => {
            const a1 = ethers.parseEther("100");
            const a2 = ethers.parseEther("50");
            await lockManager.createLock(mockUser.address, a1, 1);
            await lockManager.createLock(mockUser.address, a2, 2);

            const before = await lockManager.getUserTotalLocked(mockUser.address);
            expect(before).to.equal(a1 + a2);

            const [withdrawn] = await lockManager.emergencyWithdrawAll.staticCall(mockUser.address);
            expect(withdrawn).to.equal(a1 + a2);
            await (await lockManager.emergencyWithdrawAll(mockUser.address)).wait();

            const after = await lockManager.getUserTotalLocked(mockUser.address);
            expect(after).to.equal(0);

            const latestTs = await time.latest();
            const power = await lockManager.getVotingPowerAtTime(mockUser.address, latestTs);
            expect(power).to.equal(0);
        });
    });

    describe("View Functions and Helpers", () => {
        it("getTotalVotingPowerAt matches sum of user power for single-user case", async () => {
            const amount = ethers.parseEther("100");
            await (await lockManager.createLock(mockUser.address, amount, 4)).wait();

            await time.increase(WEEK); // move forward to avoid edge at creation
            const ts = await time.latest();

            const userPower = await lockManager.getVotingPowerAtTime(mockUser.address, ts);
            const totalPower = await lockManager.getTotalVotingPowerAt(ts);
            // The aggregate and the per-user walk round in opposite directions by design: the
            // total is never allowed to fall below the sum of user power, so a user's share can
            // never be overstated. They agree up to that rounding dust.
            expect(totalPower).to.be.gte(userPower);
            expect(totalPower - userPower).to.be.lte(10n);
        });

        it("getVotingPowerAtBlock handles past, exact, and future blocks", async () => {
            const amount = ethers.parseEther("100");
            const tx = await lockManager.createLock(mockUser.address, amount, 4);
            const receipt = await tx.wait();
            const createdBlock = receipt.blockNumber;
            await ethers.provider.send("evm_mine", []); // historical views reject the current block

            const atCreation = await lockManager.getVotingPowerAtBlock(mockUser.address, createdBlock);
            expect(atCreation).to.be.gt(0n);

            if (createdBlock > 0) {
                const before = await lockManager.getVotingPowerAtBlock(mockUser.address, createdBlock - 1);
                expect(before).to.equal(0n);
            }

            // historical lookups are strictly past: the current block and anything later revert
            const currentBlock = await ethers.provider.getBlockNumber();
            await expect(
                lockManager.getVotingPowerAtBlock(mockUser.address, currentBlock)
            ).to.be.revertedWithCustomError(lockLib, "NoPointHistory");
            await expect(
                lockManager.getVotingPowerAtBlock(mockUser.address, createdBlock + 1_000_000)
            ).to.be.revertedWithCustomError(lockLib, "NoPointHistory");
        });

        it("roundUpToWeek rounds timestamps correctly", async () => {
            const exact = 2 * WEEK;
            const roundedExact = await lockLib.roundUpToWeek(exact, WEEK);
            expect(roundedExact).to.equal(BigInt(exact));

            const plusOne = exact + 1;
            const roundedPlus = await lockLib.roundUpToWeek(plusOne, WEEK);
            expect(roundedPlus).to.equal(BigInt(exact + WEEK));
        });

        it("withdrawExpired returns zero when no locks have expired", async () => {
            const amount = ethers.parseEther("100");
            const epochs = 4;
            await (await lockManager.createLock(mockUser.address, amount, epochs)).wait();

            // Move time forward but keep it before the lock expiry
            await time.increase(WEEK);
            const [withdrawn, processed] = await lockManager.withdrawExpired.staticCall(mockUser.address);
            expect(withdrawn).to.equal(0n);
            expect(processed).to.equal(0);

            await (await lockManager.withdrawExpired(mockUser.address)).wait();
            const totalLocked = await lockManager.getUserTotalLocked(mockUser.address);
            expect(totalLocked).to.equal(amount);
        });
    });

    describe("Gas Optimization", () => {
        it("should be gas efficient for lock creation", async () => {
            const amount = ethers.parseEther("100");
            const tx = await lockManager.createLock.estimateGas(
                mockUser.address,
                amount,
                1
            );
            // Rewritten LockManager checkpoints user + global point history and
            // epoch-end tracking on lock creation (~451k gas observed)
            expect(tx).to.be.below(500000);
        });

        it("should be gas efficient for lock updates", async () => {
            await lockManager.createLock(mockUser.address, ethers.parseEther("100"), 1);
            const epochEnd = await calcEpochEnd(1);
            const gasEstimate = await lockManager.increaseLock.estimateGas(
                mockUser.address,
                ethers.parseEther("50"),
                Number(epochEnd)
            );
            // Rewritten LockManager checkpoints on increase as well (~249k gas observed)
            expect(gasEstimate).to.be.below(280000);
        });
    });
});
