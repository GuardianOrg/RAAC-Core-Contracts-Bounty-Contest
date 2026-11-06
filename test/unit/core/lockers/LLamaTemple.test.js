import { expect } from "chai";
import hre from "hardhat";
const { ethers, network } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe.skip("LLamaTemple", function () {
    let owner, user1, user2, user3, treasury;
    let llamaTemple, llamaLocker, raacNFT, crvUSD, housePrices;
    let EPOCH_DURATION, LOCK_DURATION_IN_EPOCH;
    const HOUSE_PRICE = ethers.parseEther("100");
    const TOKEN_IDS = [1, 2, 3, 4, 5, 6]; // We'll use these token IDs throughout tests


    async function waitForUnlockPeriod() {
        await time.increase(Number(EPOCH_DURATION) * Number(LOCK_DURATION_IN_EPOCH));
    }

    beforeEach(async function () {
        [owner, user1, user2, user3, treasury] = await ethers.getSigners();

        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvUSD = await CrvUSDToken.deploy(owner.address);
        await crvUSD.setMinter(owner.address);

        const HousePrices = await ethers.getContractFactory("RAACHousePrices");
        housePrices = await HousePrices.deploy(owner.address);
        await housePrices.setOracle(owner.address);

        for (const tokenId of TOKEN_IDS) {
            await housePrices.setHousePrice(tokenId, HOUSE_PRICE);
        }

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        const complianceRegistry = await ComplianceRegistry.deploy();

        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(
            crvUSD.target,
            housePrices.target,
            complianceRegistry.target,
            owner.address
        );

        const LlamaLocker = await ethers.getContractFactory("LlamaLocker");
        llamaLocker = await LlamaLocker.deploy(
            owner.address,
            raacNFT.target,
            ethers.ZeroHash // nerkle root
        );

        const LLamaTemple = await ethers.getContractFactory("LLamaTemple");
        llamaTemple = await LLamaTemple.deploy(
            raacNFT.target,
            llamaLocker.target,
            owner.address
        );

        await raacNFT.grantRole(await raacNFT.MINTER_ROLE(), owner.address);
        
        EPOCH_DURATION = await llamaLocker.EPOCH_DURATION();
        LOCK_DURATION_IN_EPOCH = await llamaLocker.LOCK_DURATION_IN_EPOCH();

        const OWNER_MINT_AMOUNT = ethers.parseEther("100000");
        await crvUSD.mint(owner.address, OWNER_MINT_AMOUNT);

        // Add reward token to locker and approve spending, this is from their code
        await llamaLocker.addRewardTokens([crvUSD.target]);
        await crvUSD.connect(owner).approve(llamaLocker.target, OWNER_MINT_AMOUNT);

        // Disable whitelist - once disabled, it cannot be re-enabled
        await llamaLocker.disableWhitelist();
    });

    describe("Class Selection", function () {
        beforeEach(async function () {
            await llamaTemple.connect(owner).addClass("PALADIN");
            await llamaTemple.connect(owner).addClass("HUNTER");
            await llamaTemple.connect(owner).addClass("WARRIOR");

            await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE);
            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[0], HOUSE_PRICE);
            await raacNFT.connect(user1).approve(llamaTemple.target, TOKEN_IDS[0]);
        });

        it("should allow manager to add and remove classes", async function () {
            const paladinHash = ethers.keccak256(ethers.toUtf8Bytes("PALADIN"));
            expect(await llamaTemple.availableClasses(paladinHash)).to.be.true;

            await llamaTemple.connect(owner).removeClass("PALADIN");
            expect(await llamaTemple.availableClasses(paladinHash)).to.be.false;
        });

        it("should allow users to select class at time of locking", async function () {
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("PALADIN"));
            const categoryCount = await llamaTemple.getCategoryCount(user1.address, await llamaTemple.getClassHash("PALADIN"))
            expect(categoryCount).to.equal(1);
            expect(await llamaTemple.getLockedTokenIds(user1.address)).to.deep.equal([TOKEN_IDS[0]])

            const nftLock = await llamaTemple.locks(TOKEN_IDS[0])
            expect(nftLock[0]).to.equal(user1.address)
            expect(nftLock[2]).to.equal(TOKEN_IDS[0])
            expect(nftLock[3]).to.equal(await llamaTemple.getClassHash("PALADIN"));
        });
    });

    describe("Locking and Unlocking", function () {
        beforeEach(async function () {
            await llamaTemple.connect(owner).addClass("HUNTER");
            for (let i = 0; i < 3; i++) {
                await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE);
                await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
                await raacNFT.connect(user1).mint(TOKEN_IDS[i], HOUSE_PRICE);
            }
            await raacNFT.connect(user1).setApprovalForAll(llamaTemple.target, true);
        });

        it("should allow users to lock multiple NFTs", async function () {
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0], TOKEN_IDS[1], TOKEN_IDS[2]], await llamaTemple.getClassHash("HUNTER"));

            const lockedTokens = await llamaTemple.getLockedTokenIds(user1.address);
            expect(lockedTokens.length).to.equal(3);
        });

        it("should track lock times correctly", async function () {
            const tx1 = await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("HUNTER"));
            const block1 = await ethers.provider.getBlock(tx1.blockNumber);

            await time.increase(EPOCH_DURATION);

            const tx2 = await llamaTemple.connect(user1).lock([TOKEN_IDS[1]], await llamaTemple.getClassHash("HUNTER"));
            const block2 = await ethers.provider.getBlock(tx2.blockNumber);

            const locks = await llamaTemple.getLocksByOwner(user1.address);
            expect(locks[0].lockedAt).to.equal(block1.timestamp);
            expect(locks[1].lockedAt).to.equal(block2.timestamp);
        });

        it("should prevent unlocking before lock duration", async function () {
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("HUNTER"));

            await expect(
                llamaTemple.connect(user1).unlock([TOKEN_IDS[0]])
            ).to.be.revertedWithCustomError(llamaLocker, "InvalidUnlockWindow");
        });

        it("should allow unlocking after lock duration", async function () {
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("HUNTER"));
            await waitForUnlockPeriod()

            await llamaTemple.connect(user1).unlock([TOKEN_IDS[0]]);
            expect(await raacNFT.ownerOf(TOKEN_IDS[0])).to.equal(user1.address);

            // check that the state has cleaned
        });
    });

    describe("Reward Distribution", function () {
        beforeEach(async function () {
            await llamaTemple.connect(owner).addClass("HUNTER");
            await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE);
            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[0], HOUSE_PRICE);

            await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE);
            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[1], HOUSE_PRICE);

            await crvUSD.connect(owner).transfer(user2.address, HOUSE_PRICE);
            await crvUSD.connect(user2).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user2).mint(TOKEN_IDS[2], HOUSE_PRICE);

            await raacNFT.connect(user1).setApprovalForAll(llamaTemple.target, true);
            await raacNFT.connect(user2).setApprovalForAll(llamaTemple.target, true);

            await llamaTemple.connect(user1).lock([TOKEN_IDS[0], TOKEN_IDS[1]], await llamaTemple.getClassHash("HUNTER"));
            await llamaTemple.connect(user2).lock([TOKEN_IDS[2]], await llamaTemple.getClassHash("HUNTER"));

            const rewardAmount = ethers.parseEther("3000");
            await crvUSD.connect(owner).approve(llamaLocker.target, rewardAmount);
            await llamaLocker.distributeRewardToken(crvUSD.target, rewardAmount);
        });

        it("should distribute rewards proportionally to shares", async function () {
            await llamaTemple.connect(user1).sync();

            const user1Rewards = await llamaTemple.claimable(user1.address, crvUSD.target);
            const user2Rewards = await llamaTemple.claimable(user2.address, crvUSD.target);

            expect(user1Rewards).to.be.closeTo(ethers.parseEther("2000"), ethers.parseEther("0.1"));
            expect(user2Rewards).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("0.1"));
        });

        it("should handle multiple claim cycles correctly", async function () {
            // await llamaTemple.connect(user1).sync();
            await llamaTemple.connect(user1).claim(user1.address);
            await llamaTemple.connect(user2).claim(user2.address);

            const rewardAmount = ethers.parseEther("3000");
            await crvUSD.connect(owner).approve(llamaLocker.target, rewardAmount);
            await llamaLocker.distributeRewardToken(crvUSD.target, rewardAmount);

            await llamaTemple.connect(user1).sync();

            const user1Rewards = await llamaTemple.claimable(user1.address, crvUSD.target);
            const user2Rewards = await llamaTemple.claimable(user2.address, crvUSD.target);

            expect(user1Rewards).to.be.closeTo(ethers.parseEther("2000"), ethers.parseEther("0.1"));
            expect(user2Rewards).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("0.1"));
        });

        it("should handle unlocks and new locks correctly", async function () {
            await llamaTemple.connect(user1).claim(user1.address);
            await llamaTemple.connect(user2).claim(user2.address);

            await waitForUnlockPeriod()

            const rewardAmount = ethers.parseEther("3000");
            await crvUSD.connect(owner).approve(llamaLocker.target, rewardAmount);
            await llamaLocker.distributeRewardToken(crvUSD.target, rewardAmount);

            await llamaTemple.connect(owner).sync();

            const lockedTokensUser1 = await llamaTemple.getLockedTokenIds(user1.address);
            expect(lockedTokensUser1.length).to.equal(2);
            expect(lockedTokensUser1[0]).to.equal(TOKEN_IDS[0]);
            expect(lockedTokensUser1[1]).to.equal(TOKEN_IDS[1]);

            const lockedTokensUser2 = await llamaTemple.getLockedTokenIds(user2.address);
            expect(lockedTokensUser2.length).to.equal(1);
            expect(lockedTokensUser2[0]).to.equal(TOKEN_IDS[2]);

            const user1BalanceBeforeUnlock = await crvUSD.balanceOf(user1.address);
            expect(user1BalanceBeforeUnlock).to.equal(ethers.parseEther("2000"));

            const user1ClaimableBeforeUnlock = await llamaTemple.claimable(user1.address, crvUSD.target);
            expect(user1ClaimableBeforeUnlock).to.equal(ethers.parseEther("2000"));

            // User1 unlocks 1 NFT, this will claim the reward
            await llamaTemple.connect(user1).unlock([TOKEN_IDS[0]]);

            const user1BalanceAfterUnlock = await crvUSD.balanceOf(user1.address);
            expect(user1BalanceAfterUnlock).to.equal(ethers.parseEther("4000"));

            const user1ClaimableAfterUnlock = await llamaTemple.claimable(user1.address, crvUSD.target);
            expect(user1ClaimableAfterUnlock).to.equal(ethers.parseEther("0"));

            const user2BalanceBeforeClaim = await crvUSD.balanceOf(user2.address);
            expect(user2BalanceBeforeClaim).to.equal(ethers.parseEther("1000"));

            // Check rewards after unlock
            const user2Rewards = await llamaTemple.claimable(user2.address, crvUSD.target);
            expect(user2Rewards).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("0.1"));

            // Claim the reward
            await llamaTemple.connect(user2).claim(user2.address);

            const user2BalanceAfterClaim = await crvUSD.balanceOf(user2.address);
            expect(user2BalanceAfterClaim).to.equal(ethers.parseEther("2000"));
        });
    });

    describe("Complete Scenarios", function () {
        it("should handle multiple users with different lock/unlock patterns", async function () {
            await llamaTemple.connect(owner).addClass("HUNTER");
            // Transfer and allow from owner to user1, user2, user3
            await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE * 3n);
            await crvUSD.connect(owner).transfer(user2.address, HOUSE_PRICE * 2n);
            await crvUSD.connect(owner).transfer(user3.address, HOUSE_PRICE);

            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE * 3n);
            await crvUSD.connect(user2).approve(raacNFT.target, HOUSE_PRICE * 2n);
            await crvUSD.connect(user3).approve(raacNFT.target, HOUSE_PRICE);

            // User1 locks 3 NFTs
            await raacNFT.connect(user1).mint(TOKEN_IDS[0], HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[1], HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[2], HOUSE_PRICE);

            await raacNFT.connect(user1).setApprovalForAll(llamaTemple.target, true);
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0], TOKEN_IDS[1], TOKEN_IDS[2]], await llamaTemple.getClassHash("HUNTER"));
            const lockedTokensUser1 = await llamaTemple.getLockedTokenIds(user1.address);
            expect(lockedTokensUser1.length).to.equal(3);
            expect(lockedTokensUser1[0]).to.equal(TOKEN_IDS[0]);
            expect(lockedTokensUser1[1]).to.equal(TOKEN_IDS[1]);
            expect(lockedTokensUser1[2]).to.equal(TOKEN_IDS[2]);

            // User2 locks 2 NFTs
            await raacNFT.connect(user2).mint(TOKEN_IDS[3], HOUSE_PRICE);
            await raacNFT.connect(user2).mint(TOKEN_IDS[4], HOUSE_PRICE);   
            await raacNFT.connect(user2).setApprovalForAll(llamaTemple.target, true);
            await llamaTemple.connect(user2).lock([TOKEN_IDS[3], TOKEN_IDS[4]], await llamaTemple.getClassHash("HUNTER"));
            const lockedTokensUser2 = await llamaTemple.getLockedTokenIds(user2.address);
            expect(lockedTokensUser2.length).to.equal(2);
            expect(lockedTokensUser2[0]).to.equal(TOKEN_IDS[3]);
            expect(lockedTokensUser2[1]).to.equal(TOKEN_IDS[4]);

            // User3 locks 1 NFT
            await raacNFT.connect(user3).mint(TOKEN_IDS[5], HOUSE_PRICE);
            await raacNFT.connect(user3).setApprovalForAll(llamaTemple.target, true);
            await llamaTemple.connect(user3).lock([TOKEN_IDS[5]], await llamaTemple.getClassHash("HUNTER"));
            const lockedTokensUser3 = await llamaTemple.getLockedTokenIds(user3.address);
            expect(lockedTokensUser3.length).to.equal(1);
            expect(lockedTokensUser3[0]).to.equal(TOKEN_IDS[5]);

            await waitForUnlockPeriod()

            // Distribute rewards to Locker
            const rewardAmount = ethers.parseEther("6000");
            await crvUSD.connect(owner).approve(llamaLocker.target, rewardAmount);
            await llamaLocker.distributeRewardToken(crvUSD.target, rewardAmount);

            // User1 unlocks 1 NFT, he will get the reward
            await llamaTemple.connect(user1).unlock([TOKEN_IDS[0]]);

            // Check rewards after unlock
            const user1Rewards = await llamaTemple.claimable(user1.address, crvUSD.target);
            const user1Balance = await crvUSD.balanceOf(user1.address);

            const user2Rewards = await llamaTemple.claimable(user2.address, crvUSD.target);
            const user2Balance = await crvUSD.balanceOf(user2.address);
            
            const user3Rewards = await llamaTemple.claimable(user3.address, crvUSD.target);
            const user3Balance = await crvUSD.balanceOf(user3.address);

            // User1 now has 2 NFTs but had 3 , User2 has 2 NFTs, User3 has 1 NFT
            // But user1 has got the reward for the NFT he unlocked so left 0
            expect(user1Rewards).to.be.equal(ethers.parseEther("0")); 
            expect(user1Balance).to.be.equal(ethers.parseEther("3000")); 

            expect(user2Rewards).to.be.equal(ethers.parseEther("2000")); 
            expect(user2Balance).to.be.equal(ethers.parseEther("0")); 

            expect(user3Rewards).to.be.equal(ethers.parseEther("1000")); 
            expect(user3Balance).to.be.equal(ethers.parseEther("0")); 

            // User2 claims the reward
            await llamaTemple.connect(user2).claim(user2.address);

            const user2BalanceAfterClaim = await crvUSD.balanceOf(user2.address);
            expect(user2BalanceAfterClaim).to.be.equal(ethers.parseEther("2000")); 
            expect(await llamaTemple.claimable(user2.address, crvUSD.target)).to.be.equal(ethers.parseEther("0")); 
        });

        it("should handle class changes with lock/unlock cycles and class modifiable true/false", async function () {
            await llamaTemple.connect(owner).addClass("PALADIN");
            await llamaTemple.connect(owner).addClass("WARRIOR");
            await llamaTemple.setClassModifiable(true);

            await crvUSD.connect(owner).transfer(user1.address, HOUSE_PRICE);
            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_IDS[0], HOUSE_PRICE);
            await raacNFT.connect(user1).setApprovalForAll(llamaTemple.target, true);

            await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("PALADIN"));
            
            let categoryCount = await llamaTemple.getCategoryCount(user1.address, await llamaTemple.getClassHash("PALADIN"))
            expect(categoryCount).to.equal(1);
            expect((await llamaTemple.locks(TOKEN_IDS[0]))[3]).to.equal(await llamaTemple.getClassHash("PALADIN"))


            await llamaTemple.connect(user1).changeClass(TOKEN_IDS[0], await llamaTemple.getClassHash("WARRIOR"))
            
            categoryCount = await llamaTemple.getCategoryCount(user1.address, await llamaTemple.getClassHash("WARRIOR"))
            expect(categoryCount).to.equal(1);
            expect((await llamaTemple.locks(TOKEN_IDS[0]))[3]).to.equal(await llamaTemple.getClassHash("WARRIOR"))

            const accountDetails = await llamaTemple.getAccountDetails(user1.address);
            expect(accountDetails.selectedClasses).to.deep.equal([ethers.keccak256(ethers.toUtf8Bytes("WARRIOR"))]);
            expect(accountDetails.selectedAts[0]).to.be.greaterThan(0);
            expect(accountDetails.tokenIds.length).to.equal(1);
            expect(accountDetails.tokenIds[0]).to.equal(TOKEN_IDS[0]);

            await llamaTemple.connect(owner).setClassModifiable(false);

            // Because class is not modifiable, this will revert
            await expect(
                llamaTemple.connect(user1).changeClass(TOKEN_IDS[0], await llamaTemple.getClassHash("PALADIN"))
            ).to.be.revertedWithCustomError(llamaTemple, "ClassNotModifiable");

            // Then unlock the nft
            await waitForUnlockPeriod()
            await llamaTemple.connect(user1).unlock([TOKEN_IDS[0]]);

            categoryCount = await llamaTemple.getCategoryCount(user1.address, await llamaTemple.getClassHash("WARRIOR"))
            expect(categoryCount).to.equal(0);

            // And relock the nft
            await llamaTemple.connect(user1).lock([TOKEN_IDS[0]], await llamaTemple.getClassHash("PALADIN"));

            categoryCount = await llamaTemple.getCategoryCount(user1.address, await llamaTemple.getClassHash("PALADIN"))
            expect(categoryCount).to.equal(1);
            expect((await llamaTemple.locks(TOKEN_IDS[0]))[3]).to.equal(await llamaTemple.getClassHash("PALADIN"))
        });
    });
});

describe.skip("Edge-case behaviours", function () {
    let owner, user1, user2;
    let llamaTemple, llamaLocker, raacNFT, crvUSD;
    const TOKEN_ID = 99n;
    const HOUSE_PRICE = ethers.parseEther("100");

    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();

        // Deploy full fixture identical to your original beforeEach:
        // (You can factor this out into a helper if you prefer.)
        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvUSD = await CrvUSDToken.deploy(owner.address);
        await crvUSD.setMinter(owner.address);

        const HousePrices = await ethers.getContractFactory("RAACHousePrices");
        const housePrices = await HousePrices.deploy(owner.address);
        await housePrices.setOracle(owner.address);
        await housePrices.setHousePrice(TOKEN_ID, HOUSE_PRICE);

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        const complianceRegistry = await ComplianceRegistry.deploy();

        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(
            crvUSD.target,
            housePrices.target,
            complianceRegistry.target,
            owner.address
        );

        await raacNFT.grantRole(await raacNFT.MINTER_ROLE(), owner.address);

        const LlamaLocker = await ethers.getContractFactory("LlamaLocker");
        llamaLocker = await LlamaLocker.deploy(
            owner.address,
            raacNFT.target,
            ethers.ZeroHash
        );

        const LLamaTemple = await ethers.getContractFactory("LLamaTemple");
        llamaTemple = await LLamaTemple.deploy(
            raacNFT.target,
            llamaLocker.target,
            owner.address
        );

        await llamaLocker.disableWhitelist();
        await llamaLocker.addRewardTokens([crvUSD.target]);

        // add a single class
        await llamaTemple.connect(owner).addClass("HUNTER");

        // mint NFT to user1
        await crvUSD.mint(user1.address, HOUSE_PRICE);
        await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
        await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
        await raacNFT.connect(user1).setApprovalForAll(llamaTemple.target, true);
    });

    it("reverts when locking with an unavailable class", async function () {
        const nonExistent = ethers.keccak256(ethers.toUtf8Bytes("ROGUE"));
        await expect(
            llamaTemple.connect(user1).lock([TOKEN_ID], nonExistent)
        ).to.be.revertedWithCustomError(llamaTemple, "InvalidClass");
    });

    it("reverts when the same token is locked twice", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);

        await expect(
            llamaTemple.connect(user1).lock([TOKEN_ID], hunter)
        ).to.be.reverted; // any revert is fine; duplicate is impossible
    });

    it("reverts changeClass when caller is not the owner", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);

        await expect(
            llamaTemple.connect(user2).changeClass(TOKEN_ID, hunter)
        ).to.be.revertedWithCustomError(llamaTemple, "InvalidAction");
    });

    it("respects pause modifier for lock and unlock", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(owner).pause();

        await expect(
            llamaTemple.connect(user1).lock([TOKEN_ID], hunter)
        ).to.be.revertedWithCustomError(llamaTemple, "EnforcedPause")

        await llamaTemple.connect(owner).unpause();

        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);
    });

    it("does not allow distributeRewardToken of zero amount", async function () {
        await expect(
            llamaLocker.distributeRewardToken(crvUSD.target, 0)
        ).to.be.revertedWithCustomError(llamaLocker, "InvalidRewardAmount");
    });

    it("claim returns zero when no rewards exist", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);

        const claimables = await llamaTemple.claimables(user1.address);
        expect(claimables[0].amount).to.equal(0);
    });

    it("share count tracks correctly across class changes", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(owner).addClass("PALADIN");
        const paladin = await llamaTemple.getClassHash("PALADIN");

        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);
        expect(await llamaTemple.getCategoryCount(user1.address, hunter)).to.equal(1);
        expect(await llamaTemple.getCategoryCount(user1.address, paladin)).to.equal(0);

        await llamaTemple.connect(user1).changeClass(TOKEN_ID, paladin);
        expect(await llamaTemple.getCategoryCount(user1.address, hunter)).to.equal(0);
        expect(await llamaTemple.getCategoryCount(user1.address, paladin)).to.equal(1);
    });

    it("cleans up category counts after the last NFT in class is unlocked", async function () {
        const hunter = await llamaTemple.getClassHash("HUNTER");
        await llamaTemple.connect(user1).lock([TOKEN_ID], hunter);

        // fast-forward unlock window
        const dur = await llamaLocker.EPOCH_DURATION();
        const mul = await llamaLocker.LOCK_DURATION_IN_EPOCH();
        await time.increase(Number(dur) * Number(mul));

        await llamaTemple.connect(user1).unlock([TOKEN_ID]);
        expect(await llamaTemple.getCategoryCount(user1.address, hunter)).to.equal(0);
    });
});
