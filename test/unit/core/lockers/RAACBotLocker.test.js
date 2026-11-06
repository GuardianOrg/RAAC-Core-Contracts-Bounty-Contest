import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RAACBotLocker", function () {
  let owner, user1, user2, user3;
  let nft;
  let usdc, pmusd;
  let locker;

  let EPOCH_DURATION;
  let LOCK_DURATION_IN_EPOCH;

  const TOKEN_IDS_USER1 = [1, 2];
  const TOKEN_IDS_USER2 = [3];

  async function increaseToFirstValidUnlockWindow() {
    // Valid when (lockedDuration / EPOCH_DURATION) % LOCK_DURATION_IN_EPOCH == 0 i.e. after 4 epochs (28 days)
    await time.increase(Number(EPOCH_DURATION) * Number(LOCK_DURATION_IN_EPOCH));
  }

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    const MockERC721 = await ethers.getContractFactory("ERC721Mock");
    nft = await MockERC721.deploy("RAAC Bot", "RBOT");

    for (const tid of TOKEN_IDS_USER1) {
      await nft.mint(user1.address, tid);
    }
    for (const tid of TOKEN_IDS_USER2) {
      await nft.mint(user2.address, tid);
    }

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 18);
    pmusd = await MockERC20.deploy("PMUSD", "PMUSD", 18);

    const RAACBotLocker = await ethers.getContractFactory("RAACBotLocker");
    locker = await RAACBotLocker.deploy(nft.target, owner.address);

    EPOCH_DURATION = await locker.EPOCH_DURATION();
    LOCK_DURATION_IN_EPOCH = await locker.LOCK_DURATION_IN_EPOCH();

    await nft.connect(user1).setApprovalForAll(locker.target, true);
    await nft.connect(user2).setApprovalForAll(locker.target, true);
  });

  describe("constructor / roles", function () {
    it("sets nft and grants initial roles to owner", async function () {
      expect(await locker.nft()).to.equal(nft.target);

      const DEFAULT_ADMIN_ROLE = await locker.DEFAULT_ADMIN_ROLE();
      const PAUSER_ROLE = await locker.PAUSER_ROLE();
      const MANAGER_ROLE = await locker.MANAGER_ROLE();
      const DISTRIBUTOR_ROLE = await locker.DISTRIBUTOR_ROLE();

      expect(await locker.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(true);
      expect(await locker.hasRole(PAUSER_ROLE, owner.address)).to.equal(true);
      expect(await locker.hasRole(MANAGER_ROLE, owner.address)).to.equal(true);
      expect(await locker.hasRole(DISTRIBUTOR_ROLE, owner.address)).to.equal(true);
    });
  });

  describe("lock()", function () {
    it("reverts on empty tokenIds", async function () {
      await expect(locker.connect(user1).lock([])).to.be.revertedWithCustomError(
        locker,
        "InvalidTokenCount"
      );
    });

    it("locks NFTs, transfers ownership to locker, records lock structs", async function () {
      await expect(locker.connect(user1).lock([1, 2]))
        .to.emit(locker, "NewLocks");

      expect(await nft.ownerOf(1)).to.equal(locker.target);
      expect(await nft.ownerOf(2)).to.equal(locker.target);

      const lock1 = await locker.locks(1);
      expect(lock1.owner).to.equal(user1.address);
      expect(lock1.tokenId).to.equal(1n);
      expect(lock1.lockedAt).to.be.gt(0n);

      const ids = await locker.getLockedTokenIds(user1.address);
      expect(ids.map((x) => Number(x)).sort()).to.deep.equal([1, 2]);
    });

    it("respects pause: lock() reverts when paused", async function () {
      await locker.connect(owner).pause();

      await expect(locker.connect(user1).lock([1])).to.be.revertedWithCustomError(
        locker,
        "EnforcedPause"
      );
    });
  });

  describe("unlockAndClaim()", function () {
    it("reverts on empty tokenIds", async function () {
      await expect(locker.connect(user1).unlockAndClaim([])).to.be.revertedWithCustomError(
        locker,
        "InvalidTokenCount"
      );
    });

    it("reverts if caller is not the lock owner", async function () {
      await locker.connect(user1).lock([1]);

      await expect(locker.connect(user2).unlockAndClaim([1])).to.be.revertedWithCustomError(
        locker,
        "InvalidLockOwner"
      );
    });

    it("reverts if trying to unlock before the first epoch passes", async function () {
      await locker.connect(user1).lock([1]);

      // Just under 1 epoch => lockedDurationInEpoch == 0
      await time.increase(Number(EPOCH_DURATION) - 1);

      await expect(locker.connect(user1).unlockAndClaim([1])).to.be.revertedWithCustomError(
        locker,
        "InvalidUnlockWindow"
      );
    });

    it("reverts if not at a valid modulo window (must be multiple of 4 epochs)", async function () {
      await locker.connect(user1).lock([1]);

      // 1 epoch => 1 % 4 != 0
      await time.increase(Number(EPOCH_DURATION));

      await expect(locker.connect(user1).unlockAndClaim([1])).to.be.revertedWithCustomError(
        locker,
        "InvalidUnlockWindow"
      );
    });

    it("unlocks at 4 epochs: returns NFT and clears lock", async function () {
      await locker.connect(user1).lock([1]);

      await increaseToFirstValidUnlockWindow();

      await expect(locker.connect(user1).unlockAndClaim([1]))
        .to.emit(locker, "NewUnlocks");

      expect(await nft.ownerOf(1)).to.equal(user1.address);

      const lock1 = await locker.locks(1);
      expect(lock1.owner).to.equal(ethers.ZeroAddress);
      expect(lock1.tokenId).to.equal(0n);
      expect(lock1.lockedAt).to.equal(0n);

      const ids = await locker.getLockedTokenIds(user1.address);
      expect(ids.length).to.equal(0);
    });

    it("unlockAndClaim() reverts while paused and succeeds after unpause", async function () {
      await locker.connect(user1).lock([1]);

      await locker.connect(owner).pause();
      await increaseToFirstValidUnlockWindow();

      // unlockAndClaim now has whenNotPaused (the plain unlock() exit hatch was removed)
      await expect(locker.connect(user1).unlockAndClaim([1])).to.be.revertedWithCustomError(
        locker,
        "EnforcedPause"
      );

      await locker.connect(owner).unpause();
      await locker.connect(user1).unlockAndClaim([1]);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
    });
  });

  describe("reward token management", function () {
    it("only MANAGER_ROLE can addRewardTokens", async function () {
      const MANAGER_ROLE = await locker.MANAGER_ROLE();

      await expect(locker.connect(user1).addRewardTokens([usdc.target]))
        .to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, MANAGER_ROLE);

      await locker.connect(owner).addRewardTokens([usdc.target]);
      expect(await locker.getRewardTokenCount()).to.equal(1n);
      expect((await locker.getRewardTokens())[0]).to.equal(usdc.target);
    });

    it("reverts when adding an already-added reward token", async function () {
      await locker.connect(owner).addRewardTokens([usdc.target]);

      await expect(locker.connect(owner).addRewardTokens([usdc.target]))
        .to.be.revertedWithCustomError(locker, "InvalidRewardToken");
    });
  });

  describe("distributor management & distributeRewardToken()", function () {
    it("cannot distribute if token is not a registered reward token", async function () {
      await locker.connect(user1).lock([1]);

      await usdc.mint(owner.address, ethers.parseEther("100"));
      await usdc.connect(owner).approve(locker.target, ethers.parseEther("100"));

      await expect(
        locker.connect(owner).distributeRewardToken(usdc.target, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(locker, "InvalidRewardToken");
    });

    it("reverts if totalShares == 0 (no lockers)", async function () {
      await locker.connect(owner).addRewardTokens([usdc.target]);

      await usdc.mint(owner.address, ethers.parseEther("10"));
      await usdc.connect(owner).approve(locker.target, ethers.parseEther("10"));

      await expect(
        locker.connect(owner).distributeRewardToken(usdc.target, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(locker, "InvalidTotalShares");
    });

    it("only admin can add/remove distributor; only distributor can distribute", async function () {
      const DISTRIBUTOR_ROLE = await locker.DISTRIBUTOR_ROLE();
      const DEFAULT_ADMIN_ROLE = await locker.DEFAULT_ADMIN_ROLE();

      await locker.connect(owner).addRewardTokens([usdc.target]);
      await locker.connect(user1).lock([1]);

      // Remove owner as distributor (only admin can do)
      await locker.connect(owner).revokeRole(DISTRIBUTOR_ROLE, owner.address);
      expect(await locker.hasRole(DISTRIBUTOR_ROLE, owner.address)).to.equal(false);

      await usdc.mint(owner.address, ethers.parseEther("10"));
      await usdc.connect(owner).approve(locker.target, ethers.parseEther("10"));

      await expect(
        locker.connect(owner).distributeRewardToken(usdc.target, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
       .withArgs(owner.address, DISTRIBUTOR_ROLE);

      // Non-admin cannot add distributor
      await expect(locker.connect(user1).grantRole(DISTRIBUTOR_ROLE, user2.address))
        .to.be.revertedWithCustomError(locker, "AccessControlUnauthorizedAccount")
        .withArgs(user1.address, DEFAULT_ADMIN_ROLE);

      // Only admin can add user2 as distributor (is not a distributor)
      await locker.connect(owner).grantRole(DISTRIBUTOR_ROLE, user2.address);
      expect(await locker.hasRole(DISTRIBUTOR_ROLE, user2.address)).to.equal(true);

      // User2 can distribute (is a distributor)
      await usdc.mint(user2.address, ethers.parseEther("10"));
      await usdc.connect(user2).approve(locker.target, ethers.parseEther("10"));

      await expect(
        locker.connect(user2).distributeRewardToken(usdc.target, ethers.parseEther("10"))
      ).to.emit(locker, "RewardDistributed");
    });
  });

  describe("claim / claimable accounting", function () {
    beforeEach(async function () {
      await locker.connect(owner).addRewardTokens([usdc.target, pmusd.target]);
    });

    it("users earn pro-rata rewards and can claim to an arbitrary recipient", async function () {
      // user1 locks 2 NFTs, user2 locks 1 NFT => totalShares = 3
      await locker.connect(user1).lock([1, 2]);
      await locker.connect(user2).lock([3]);

      const amount = ethers.parseEther("100");

      // Owner distributes 100 RWA
      await usdc.mint(owner.address, amount);
      await usdc.connect(owner).approve(locker.target, amount);
      await locker.connect(owner).distributeRewardToken(usdc.target, amount);

      // user1 = 66, user2 = 33
      const expectedUser1 = amount * 2n / 3n;
      const expectedUser2 = amount * 1n / 3n;

      expect(await locker.claimable(user1.address, usdc.target)).to.equal(expectedUser1);
      expect(await locker.claimable(user2.address, usdc.target)).to.equal(expectedUser2);

      // Claim user1 to user3
      const before = await usdc.balanceOf(user3.address);
      await locker.connect(user1).claim(user3.address);
      const after = await usdc.balanceOf(user3.address);

      expect(after - before).to.equal(expectedUser1);

      // Claiming again should yield 0
      expect(await locker.claimable(user1.address, usdc.target)).to.equal(0n);
      await locker.connect(user1).claim(user1.address);
      expect(await locker.claimable(user1.address, usdc.target)).to.equal(0n);
    });

    it("new lockers do NOT get rewards distributed before they locked", async function () {
      // user1 locks first
      await locker.connect(user1).lock([1]);

      const first = ethers.parseEther("90");
      await usdc.mint(owner.address, first);
      await usdc.connect(owner).approve(locker.target, first);
      await locker.connect(owner).distributeRewardToken(usdc.target, first);

      // user2 locks after distribution
      await locker.connect(user2).lock([3]);

      // user2 is not entitled to first distribution
      expect(await locker.claimable(user2.address, usdc.target)).to.equal(0n);

      // second distribution with 2 shares total => split 50/50 if 100
      const second = ethers.parseEther("100");
      await usdc.mint(owner.address, second);
      await usdc.connect(owner).approve(locker.target, second);
      await locker.connect(owner).distributeRewardToken(usdc.target, second);

      // user1 claimable = 90 + 50 = 140, user2 claimable = 50
      expect(await locker.claimable(user1.address, usdc.target)).to.equal(
        first + (second / 2n)
      );
      expect(await locker.claimable(user2.address, usdc.target)).to.equal(second / 2n);
    });

    it("claim reverts for zero recipient", async function () {
      await locker.connect(user1).lock([1]);

      const amount = ethers.parseEther("10");
      await usdc.mint(owner.address, amount);
      await usdc.connect(owner).approve(locker.target, amount);
      await locker.connect(owner).distributeRewardToken(usdc.target, amount);

      await expect(locker.connect(user1).claim(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(locker, "InvalidRecipient");
    });

    it("unlock + claim rewards to user", async function () {
      await locker.connect(user1).lock([1]);

      const amount = ethers.parseEther("50");
      await usdc.mint(owner.address, amount);
      await usdc.connect(owner).approve(locker.target, amount);
      await locker.connect(owner).distributeRewardToken(usdc.target, amount);

      const before = await usdc.balanceOf(user1.address);

      await increaseToFirstValidUnlockWindow();
      await locker.connect(user1).unlockAndClaim([1]);

      const after = await usdc.balanceOf(user1.address);

      expect(after - before).to.equal(amount);
      expect(await nft.ownerOf(1)).to.equal(user1.address);
    });
  });

  describe("getLocks() / getLocksByOwner()", function () {
    it("returns accurate lock info across users", async function () {
      await locker.connect(user1).lock([1, 2]);
      await locker.connect(user2).lock([3]);

      const all = await locker.getLocks();
      expect(all.length).to.equal(3);

      // Build tokenId => owner map
      const byToken = {};
      for (const l of all) {
        byToken[String(l.tokenId)] = l.owner;
      }

      expect(byToken["1"]).to.equal(user1.address);
      expect(byToken["2"]).to.equal(user1.address);
      expect(byToken["3"]).to.equal(user2.address);

      const u1 = await locker.getLocksByOwner(user1.address);
      expect(u1.length).to.equal(2);
      const u1TokenIds = u1.map((x) => Number(x.tokenId)).sort();
      expect(u1TokenIds).to.deep.equal([1, 2]);
    });
  });

  describe("rescueTokens()", function () {
    it("DEFAULT_ADMIN_ROLE can rescue ERC20 balances", async function () {
      await locker.connect(owner).addRewardTokens([usdc.target]);

      const amount = ethers.parseEther("123");
      await usdc.mint(owner.address, amount);
      await usdc.connect(owner).transfer(locker.target, amount);

      const before = await usdc.balanceOf(user3.address);
      await locker.connect(owner).rescueTokens(usdc.target, user3.address);
      const after = await usdc.balanceOf(user3.address);

      expect(after - before).to.equal(amount);
      expect(await usdc.balanceOf(locker.target)).to.equal(0n);
    });
  });
});
