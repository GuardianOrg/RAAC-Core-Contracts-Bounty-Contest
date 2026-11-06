import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const BASE_WEEKLY_EMISSION = 23852798580398015692800n;
const PER_SECOND = BASE_WEEKLY_EMISSION / 604800n;
const WEEK = 7 * 24 * 3600;

describe("RAACMinter", function () {
  let RAACToken, RAACMinter, MockLendingPool, MockStabilityPool, MockRAACMinterRewardsReceiver;
  let raacToken, raacMinter, lendingPool, stabilityPool, mockRewardsReceiver, mockRewardsReceiverAddress;
  let owner, user1;

  before(async function () {
    [owner, user1] = await ethers.getSigners();

    RAACToken = await ethers.getContractFactory("RAACToken");
    raacToken = await RAACToken.deploy(owner.address);

    MockLendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await MockLendingPool.deploy();

    MockStabilityPool = await ethers.getContractFactory("MockStabilityPool");
    stabilityPool = await MockStabilityPool.deploy(await raacToken.getAddress());

    MockRAACMinterRewardsReceiver = await ethers.getContractFactory("MockRAACMinterRewardsReceiver");
    mockRewardsReceiver = await MockRAACMinterRewardsReceiver.deploy();
    mockRewardsReceiverAddress = await mockRewardsReceiver.getAddress();


    RAACMinter = await ethers.getContractFactory("RAACMinter");
    raacMinter = await RAACMinter.deploy(
      await raacToken.getAddress(),
      owner.address
    );

    await raacToken.setMinter(await raacMinter.getAddress());
  });

  let initialBlockTimestamp;
  describe('Initial state', function () {
    it('should start not minting', async function () {
      expect(await raacMinter.mintingStartAtTimestamp()).to.equal(0);
      expect(await raacMinter.lastUpdateBlockTimestamp()).to.equal(0);

      // Tick will do nothing (returns)
      await raacMinter.tick();

      expect(await raacMinter.mintingStartAtTimestamp()).to.equal(0);
      expect(await raacMinter.lastUpdateBlockTimestamp()).to.equal(0);

      const totalSupply = await raacToken.totalSupply();
      expect(totalSupply).to.equal(0);

      const maxMint = await raacMinter.MAX_SUPPLY();
      expect(maxMint).to.equal(ethers.parseEther("21000000"));
    });


    it('should allow to add distribution pool', async function () {

      const totalWeight = await raacMinter.totalWeight();
      expect(totalWeight).to.equal(0);

      await raacMinter.addDistributionPool(mockRewardsReceiverAddress, 2000);
      const poolInfo = await raacMinter.poolInfo(mockRewardsReceiverAddress);
      expect(poolInfo.weight).to.equal(2000);
      expect(poolInfo.exists).to.be.true;
      expect(poolInfo.pool).to.equal(mockRewardsReceiverAddress);
      expect(poolInfo.pendingRewards).to.equal(0);

      expect(await raacMinter.totalWeight()).to.equal(2000);
    });

    it('should allow to manage distribution pool', async function () {
      await raacMinter.manageDistributionPool(mockRewardsReceiverAddress, 1000);
      const poolInfo = await raacMinter.poolInfo(mockRewardsReceiverAddress);
      expect(poolInfo.weight).to.equal(1000);
      expect(poolInfo.exists).to.be.true;
      expect(poolInfo.pool).to.equal(mockRewardsReceiverAddress);
      expect(poolInfo.pendingRewards).to.equal(0);

      expect(await raacMinter.totalWeight()).to.equal(1000);

      expect(await raacMinter.distributionPools(0)).to.equal(mockRewardsReceiverAddress);
      // Test only 1 item in the array
      expect(() => raacMinter.distributionPools(1)).to.be.revertedWithoutReason();
    });
  });

  // describe("RAACToken Ownership Transfer", function () {
    // it("should allow owner to initiate RAACToken ownership transfer", async function () {
    //   const tx = await raacMinter.connect(owner).initiateRAACTokenOwnershipTransfer(user1.address);
    //   await expect(tx).to.emit(raacMinter, "RAACTokenOwnershipTransferInitiated")
    //     .withArgs(user1.address, await ethers.provider.getBlock('latest').then(b => b.timestamp + 7 * 24 * 60 * 60));
      
    //   expect(await raacMinter.pendingRAACTokenOwner()).to.equal(user1.address);
    // });

    // it("should not allow non-owner to initiate RAACToken ownership transfer", async function () {
    //   await expect(raacMinter.connect(user1).initiateRAACTokenOwnershipTransfer(user1.address))
    //     .to.be.revertedWithCustomError(raacMinter, "AccessControlUnauthorizedAccount");
    // });

    // it("should not allow completing RAACToken ownership transfer before delay period", async function () {
    //   await raacMinter.connect(owner).initiateRAACTokenOwnershipTransfer(user1.address);
    //   await expect(raacMinter.connect(owner).completeRAACTokenOwnershipTransfer())
    //     .to.be.revertedWithCustomError(raacMinter, "OwnershipTransferNotDue");
    // });

    // it("should allow completing RAACToken ownership transfer after delay period", async function () {
    //   await raacMinter.connect(owner).initiateRAACTokenOwnershipTransfer(user1.address);
      
    //   // Increase time by 7 days
    //   await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
    //   await ethers.provider.send("evm_mine");

    //   const tx = await raacMinter.connect(owner).completeRAACTokenOwnershipTransfer();
    //   await expect(tx).to.emit(raacMinter, "RAACTokenOwnershipTransferred")
    //     .withArgs(user1.address);

    //   expect(await raacToken.owner()).to.equal(user1.address);
    // });

    // it("should not allow completing RAACToken ownership transfer after window expires", async function () {
    //   await raacMinter.connect(owner).initiateRAACTokenOwnershipTransfer(user1.address);
      
    //   // Increase time by 8 days
    //   await ethers.provider.send("evm_increaseTime", [8 * 24 * 60 * 60]);
    //   await ethers.provider.send("evm_mine");

    //   await expect(raacMinter.connect(owner).completeRAACTokenOwnershipTransfer())
    //     .to.be.revertedWithCustomError(raacMinter, "OwnershipTransferExpired");
    // });

    // it("should not allow non-owner to complete RAACToken ownership transfer", async function () {
    //   await raacMinter.connect(owner).initiateRAACTokenOwnershipTransfer(user1.address);
      
    //   // Increase time by 7 days
    //   await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
    //   await ethers.provider.send("evm_mine");

    //   await expect(raacMinter.connect(user1).completeRAACTokenOwnershipTransfer())
    //     .to.be.revertedWithCustomError(raacMinter, "AccessControlUnauthorizedAccount");
    // });
  // });

  describe("RAAC Token Supply", function () {
    beforeEach(async function () {
      await raacToken.setMinter(owner.address);
      // leave a few RAAC of headroom below the hard cap (21M) for the scheduled emission
      await raacToken.mint(owner.address, ethers.parseEther("20999990") - (await raacToken.totalSupply()));

      await raacToken.setMinter(raacMinter.target);
    });

    it('should mint token when ticked and activated', async function () {
      await raacMinter.tick();
      expect(await mockRewardsReceiver.getDepositCount()).to.equal(0);

      await raacMinter.activate();
      initialBlockTimestamp = await time.latest();

      const beforeSupply = await raacToken.totalSupply();
      await time.setNextBlockTimestamp(initialBlockTimestamp + 1);
      await raacMinter.tick(); // exactly one second of scheduled emission
      const afterSupply = await raacToken.totalSupply();
      expect(afterSupply).to.be.gt(beforeSupply);
      expect(afterSupply - beforeSupply).to.equal(PER_SECOND); // exact value given the emission schedule for a second
      expect(await mockRewardsReceiver.getDepositCount()).to.equal(1);
      const lastDeposit = await mockRewardsReceiver.getLastDeposit();
      expect(lastDeposit.token).to.equal(await raacToken.getAddress());
      expect(lastDeposit.amount).to.equal(PER_SECOND);
      expect(lastDeposit.timestamp).to.be.gt(initialBlockTimestamp);

      await time.setNextBlockTimestamp(initialBlockTimestamp + 2);
      await raacMinter.tick();
      const afterSupply2 = await raacToken.totalSupply();
      expect(afterSupply2).to.equal(afterSupply + PER_SECOND);
      const lastDeposit2 = await mockRewardsReceiver.getLastDeposit();
      expect(lastDeposit2.token).to.equal(await raacToken.getAddress());
      expect(lastDeposit2.amount).to.equal(PER_SECOND);
      expect(lastDeposit2.timestamp).to.be.gt(lastDeposit.timestamp);
      expect(await mockRewardsReceiver.getDepositCount()).to.equal(2);

    });
  });
  describe("Emission Schedule", function () {
      before(async function () {
        // activation normally happens in the previous describe; make this one self-sufficient
        if ((await raacMinter.mintingStartAtTimestamp()) === 0n) {
          await raacMinter.activate();
        }
      });

      it("should follow the geometric schedule (flat for 104 weeks, then -5% every 13 weeks)", async function () {
        const activation = await raacMinter.mintingStartAtTimestamp();

        // week 1 emissions
        const week1 = await raacMinter.calculateScheduledMintableAmount(activation, activation + BigInt(WEEK));
        expect(week1).to.equal(PER_SECOND * BigInt(WEEK));

        // constant emission for the first 104 weeks
        const first104 = await raacMinter.calculateScheduledMintableAmount(activation, activation + BigInt(104 * WEEK));
        expect(first104).to.equal(PER_SECOND * BigInt(WEEK) * 104n);

        // week 105 is the first reduced week: rate * 0.95 (same integer math as the contract)
        const week105 = await raacMinter.calculateScheduledMintableAmount(
          activation + BigInt(104 * WEEK),
          activation + BigInt(105 * WEEK)
        );
        const reducedPerSecond = (PER_SECOND * 950000000000000000n) / 10n ** 18n;
        expect(week105).to.equal(reducedPerSecond * BigInt(WEEK));
      });

      it("should stop emitting after week 780 and keep total scheduled emission under MAX_SUPPLY", async function () {
        const activation = await raacMinter.mintingStartAtTimestamp();

        const fullSchedule = await raacMinter.calculateScheduledMintableAmount(
          activation, activation + BigInt(781 * WEEK));
        const wayBeyond = await raacMinter.calculateScheduledMintableAmount(
          activation, activation + BigInt(2000 * WEEK));

        expect(wayBeyond).to.equal(fullSchedule); // no emission after the schedule ends
        expect(fullSchedule).to.be.gt(0n);
        expect(fullSchedule).to.be.lt(await raacMinter.MAX_SUPPLY());
      });

    describe("Tick minting", function () {
      it("should mint the scheduled amount for the elapsed time", async function () {
        await raacMinter.manageDistributionPool(lendingPool.target, 1000);

        const last = Number(await raacMinter.lastUpdateBlockTimestamp());
        const now = await time.latest();
        const target = Math.max(now, last) + 10;

        const supplyBefore = await raacToken.totalSupply();
        await time.setNextBlockTimestamp(target);
        await raacMinter.tick();
        const supplyAfter = await raacToken.totalSupply();

        expect(supplyAfter - supplyBefore).to.equal(PER_SECOND * BigInt(target - last));
        expect(await raacMinter.lastUpdateBlockTimestamp()).to.equal(target);
      });

      it("should mint on every tick without any interval gating", async function () {
        const last = Number(await raacMinter.lastUpdateBlockTimestamp());
        const now = await time.latest();
        const t1 = Math.max(now, last) + 1;

        const supply0 = await raacToken.totalSupply();
        await time.setNextBlockTimestamp(t1);
        await raacMinter.tick();
        const supply1 = await raacToken.totalSupply();
        expect(supply1 - supply0).to.equal(PER_SECOND * BigInt(t1 - last));

        // an immediately following tick (next second) mints again — no interval check
        await time.setNextBlockTimestamp(t1 + 1);
        await raacMinter.tick();
        const supply2 = await raacToken.totalSupply();
        expect(supply2 - supply1).to.equal(PER_SECOND);
      });
    });
  });

  describe('Remove distribution pool', function () {
    it('should remove distribution pool and mint before doing so', async function () {

      // Time advance to the next block
      await ethers.provider.send("evm_increaseTime", [15]);
      await ethers.provider.send("evm_mine", []);

      const depositCountBefore = await mockRewardsReceiver.getDepositCount();
      expect(depositCountBefore).to.be.gt(0n);

      const lastUpdateBlockTimestamp = await raacMinter.lastUpdateBlockTimestamp();
      await raacMinter.removeDistributionPool(mockRewardsReceiverAddress, false);

      // the removal ticks first, flushing the accrued emission into one final deposit
      const depositCountAfter = await mockRewardsReceiver.getDepositCount();
      expect(depositCountAfter).to.equal(depositCountBefore + 1n);

      expect(await raacMinter.lastUpdateBlockTimestamp()).to.be.gt(lastUpdateBlockTimestamp);
      const poolInfo = await raacMinter.poolInfo(mockRewardsReceiverAddress);
      expect(poolInfo.exists).to.be.false;

      // only the lending pool remains registered
      expect(await raacMinter.distributionPools(0)).to.equal(lendingPool.target);
      await expect(raacMinter.distributionPools(1)).to.be.revertedWithoutReason();
    });
  });
  describe('Pausing and unpausing', function () {
    it('should pause and unpause', async function () {
      await raacMinter.pause();
      expect(await raacMinter.paused()).to.be.true;

      // Try to mint will fail
      await expect(raacMinter.tick()).to.be.revertedWithCustomError(raacMinter, "EnforcedPause");

      await raacMinter.unpause();
      expect(await raacMinter.paused()).to.be.false;
    });
  });

  describe('Supply cap', function () {
    it('should stop minting at MAX_SUPPLY and never exceed it', async function () {
      // jump beyond the full emission schedule
      await time.increase(800 * WEEK);
      await raacMinter.tick();

      const maxSupply = await raacMinter.MAX_SUPPLY();
      expect(await raacToken.totalSupply()).to.equal(maxSupply);

      // further ticks are no-ops (no revert, no extra mint)
      await time.increase(WEEK);
      await raacMinter.tick();
      expect(await raacToken.totalSupply()).to.equal(maxSupply);
    });
  });
});