import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("FeeCollector", function () {
    let crvusd, rToken, debtToken, raacNFT, raacHousePrices, raacToken, feeCollector, veRAACToken, raacCorp, crvUSDToUSDOracle;
    let owner, user1, user2, treasury, newTreasury, repairFund, emergencyAdmin;
    let lendingPool;
    let distributableContract;
    let defaultFeeType;
    
    const BASIS_POINTS = 10000;
    const WEEK = 7 * 24 * 3600;
    const ONE_YEAR = 365 * 24 * 3600;
    const INITIAL_MINT = ethers.parseEther("10000");
    const SWAP_TAX_RATE = 100; // 1%
    const BURN_TAX_RATE = 50;  // 0.5%

    const ROYALTY_FEE = ethers.keccak256(ethers.toUtf8Bytes("ROYALTY_FEE"));
    const SWAP_FEE = ethers.keccak256(ethers.toUtf8Bytes("SWAP_FEE"));
    const INSURANCE_FEE = ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE"));
    const LENDING_FEE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE"));

    const TREASURY = ethers.keccak256(ethers.toUtf8Bytes("TREASURY"));
    const REPAIR_FUND = ethers.keccak256(ethers.toUtf8Bytes("REPAIR_FUND"));
    const BURN = ethers.keccak256(ethers.toUtf8Bytes("BURN"));
    const VERAAC = ethers.keccak256(ethers.toUtf8Bytes("VERAAC"));
    const RAAC_CORP = ethers.keccak256(ethers.toUtf8Bytes("RAAC_CORP"));
    const OTHER = ethers.keccak256(ethers.toUtf8Bytes("OTHER"));

    beforeEach(async function () {
        [owner, user1, user2, treasury, newTreasury, repairFund, emergencyAdmin, raacCorp] = await ethers.getSigners();
        const crvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvusd = await crvUSDToken.deploy(owner.address);
        await crvusd.setMinter(owner.address);

        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

        const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
        raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);
      
        // Deploy RAACToken
        const RAACToken = await ethers.getContractFactory("RAACToken");
        raacToken = await RAACToken.deploy(owner.address);
        await raacToken.waitForDeployment();

        // Deploy VeRAACToken
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
        veRAACToken = await VeRAACToken.deploy(await raacToken.getAddress(), owner.address, 52);
        await veRAACToken.waitForDeployment();

        // Deploy FeeCollector
        const FeeCollector = await ethers.getContractFactory("FeeCollector");

        const MockDistributableContract = await ethers.getContractFactory("MockDistributableContract");
        distributableContract = await MockDistributableContract.deploy();
        await distributableContract.waitForDeployment();

        feeCollector = await FeeCollector.deploy(
            owner.address
        );
        await feeCollector.waitForDeployment();

        const initialPrimeRate = ethers.parseUnits("0.1", 27);

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
        const complianceRegistry = await ComplianceRegistry.deploy()

        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address);
      
        const RToken = await ethers.getContractFactory("RToken");
        rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);
    
        const DebtToken = await ethers.getContractFactory("DebtToken");
        debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);
        
        const LendingPool = await ethers.getContractFactory("MockLendingPoolCollector");

        lendingPool = await LendingPool.deploy(
          crvusd.target
        );
    
        await lendingPool.setFeeCollector(await feeCollector.getAddress());

        // Setup initial configuration
        await raacToken.setMinter(owner.address);

        // Setup roles
        await feeCollector.grantRole(await feeCollector.FEE_MANAGER_ROLE(), owner.address);
        await feeCollector.grantRole(await feeCollector.EMERGENCY_ROLE(), emergencyAdmin.address);
        await feeCollector.grantRole(await feeCollector.DISTRIBUTOR_ROLE(), owner.address);

        // Mint initial tokens and approve
        await raacToken.mint(user1.address, INITIAL_MINT);
        await raacToken.mint(user2.address, INITIAL_MINT);
        await raacToken.connect(user1).approve(await feeCollector.getAddress(), ethers.MaxUint256);
        await raacToken.connect(user2).approve(await feeCollector.getAddress(), ethers.MaxUint256);
        await raacToken.connect(user1).approve(await veRAACToken.getAddress(), ethers.MaxUint256);
        await raacToken.connect(user2).approve(await veRAACToken.getAddress(), ethers.MaxUint256);
    });

    describe("Constructor & Initial Setup", function () {
        it('should create the various fee types', async function () {
            // 25% to treasury, 50% to repair, 25% to veraac, 0% to other (absolute from base before fee: 0.5% to treasury, 1% to repair, 0.5% to veraac, 0% to other)
            expect(await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);

            // RAAC Token Swap Fee collection, burn already done in RAACToken.sol so we just do 0.5% to veraac + 1% to repair
            expect(await feeCollector.addFeeType(SWAP_FEE, 0, 6667, 0, 3333, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);

            // RAAC Token Lending Fee collection
            expect(await feeCollector.addFeeType(LENDING_FEE, 0, 1000, 0, 0, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);

            // NFT Insurance Fee collection
            expect(await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);

            const feeTypes = await feeCollector.getFeeTypes();
            expect(feeTypes.length).to.equal(4);
            expect(feeTypes[0].feeType).to.equal(ROYALTY_FEE);
            expect(feeTypes[1].feeType).to.equal(SWAP_FEE);
            expect(feeTypes[2].feeType).to.equal(LENDING_FEE);
            expect(feeTypes[3].feeType).to.equal(INSURANCE_FEE);
        })

        it("should add a token correctly", async function () {
            expect(await feeCollector.addClaimableToken(crvusd.target)).to.emit(feeCollector, "TokenAdded").withArgs(crvusd.target);
        })

        it("should only add a fee type once", async function () {
            expect(await feeCollector.addFeeType(ROYALTY_FEE, 0, 0, 0, 0, 0, 0)).to.emit(feeCollector, "FeeTypeAlreadyExists");
        })

        it("should update an address correctly", async function () {
            // First verify the initial state
            const initialTreasury = await feeCollector.getTargetAddress(TREASURY);
            
            // Perform the update in a single transaction
            await expect(feeCollector.setTargetAddress(TREASURY, treasury.address))
                .to.emit(feeCollector, 'TargetAddressUpdated')
                .withArgs(TREASURY, treasury.address);
            
            // Verify the state immediately after
            const newTreasury = await feeCollector.getTargetAddress(TREASURY);
            
            // Verify the state matches what we expect
            expect(newTreasury).to.equal(treasury.address);
            
            // Double check by calling getAddress again
            const verifyTreasury = await feeCollector.getTargetAddress(TREASURY);
            expect(verifyTreasury).to.equal(treasury.address);
        })

    });
    describe("Update Fee Types", function () {
        beforeEach(async function () {
            await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0);
            await feeCollector.addFeeType(SWAP_FEE, 0, 6667, 0, 3333, 0, 0);
            await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
        })
        it("should not be able to set fee type that adds up to > 100%", async function () {
            const UNBALANCED_FEE = ethers.keccak256(ethers.toUtf8Bytes("UNBALANCED_FEE"));
            await expect(feeCollector.addFeeType(UNBALANCED_FEE, 0, 100_00, 1, 0, 0, 0)).to.be.revertedWithCustomError(feeCollector, "InvalidFeeType");
        })
        it("should update a fee type correctly", async function () {
            await feeCollector.connect(owner).updateFeeType(ROYALTY_FEE, {
                feeType: ROYALTY_FEE,
                treasuryShare: 10000,
                repairFundShare: 0,
                burnShare: 0,
                veRAACTokenShare: 0,
                raacCorpShare: 0,
                otherShare: 0
            });
            const feeType = await feeCollector.getFeeType(ROYALTY_FEE);
            expect(feeType.treasuryShare).to.equal(10000);
            expect(feeType.repairFundShare).to.equal(0);
            expect(feeType.burnShare).to.equal(0);
            expect(feeType.veRAACTokenShare).to.equal(0);
            expect(feeType.raacCorpShare).to.equal(0);
            expect(feeType.otherShare).to.equal(0);
        })
        it("should not be able to update a fee type that adds up to > 100%", async function () {
            await expect(feeCollector.connect(owner).updateFeeType(ROYALTY_FEE, {
                feeType: ROYALTY_FEE,
                treasuryShare: 10000,
                repairFundShare: 1,
                burnShare: 0,
                veRAACTokenShare: 0,
                raacCorpShare: 0,
                otherShare: 0
            })).to.be.revertedWithCustomError(feeCollector, "InvalidFeeType");
        })
    })
    describe("Remove Fee Types", function () {
        beforeEach(async function () {
            await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0);
            await feeCollector.addFeeType(SWAP_FEE, 0, 6667, 0, 3333, 0, 0);
            await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
        })
        it("should remove a fee type correctly", async function () {
            const feeTypeBefore = await feeCollector.getFeeTypes();
            expect(feeTypeBefore.length).to.equal(3);
            expect(feeTypeBefore[0].feeType).to.equal(ROYALTY_FEE);
            expect(feeTypeBefore[1].feeType).to.equal(SWAP_FEE);
            expect(feeTypeBefore[2].feeType).to.equal(INSURANCE_FEE);   

            await expect(feeCollector.connect(owner).removeFeeType(ROYALTY_FEE)).to.emit(feeCollector, "FeeTypeRemoved").withArgs(ROYALTY_FEE);

            const feeTypes = await feeCollector.getFeeTypes();
            expect(feeTypes.length).to.equal(2);
            // With swap-and-pop, the first element is now INSURANCE_FEE (last element before removal)
            // and the second element remains SWAP_FEE
            expect(feeTypes[0].feeType).to.equal(INSURANCE_FEE);
            expect(feeTypes[1].feeType).to.equal(SWAP_FEE);
        })
    })

    describe("Remove Token", function () {
        beforeEach(async function () {
            await feeCollector.addClaimableToken(crvusd.target);
        })
        it("should remove a token correctly", async function () {
            expect(await feeCollector.removeClaimableToken(crvusd.target)).to.emit(feeCollector, "TokenRemoved").withArgs(crvusd.target);
        })
    })

    describe("Collect & Distribute Fees", function () {
        beforeEach(async function () {
            await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0);
            await feeCollector.addFeeType(SWAP_FEE, 0, 6667, 0, 3333, 0, 0);
            await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
            await feeCollector.addFeeType(LENDING_FEE, 10000, 0, 0, 0, 0, 0);
            await feeCollector.addClaimableToken(crvusd.target);
            await feeCollector.addWhitelistedTarget(lendingPool.target);
        })

        it("should not allow claimCollectorRewards for unauthorized users", async function () {
            await expect(feeCollector.connect(user1).claimCollectorRewards(crvusd.target, lendingPool.target, LENDING_FEE)).to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        })
        it("should not allow claimNFTUnderlying for unauthorized users", async function () {
            await expect(feeCollector.connect(user1).claimNFTUnderlying(crvusd.target, lendingPool.target, ethers.parseEther("1"), LENDING_FEE)).to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        })

        it("should claim fees correctly", async function () {
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
            await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));
            // check 
            expect((await lendingPool.vaultRewards()).unclaimedRewards).to.equal(ethers.parseEther("1000"));

            await feeCollector.setTargetFeeType(lendingPool.target, LENDING_FEE);

            await feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, LENDING_FEE);
            const collectedFees = await feeCollector.getCollectedFees(crvusd.target, LENDING_FEE);
            expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("1000"));
            expect(collectedFees.repairFundAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.burnAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.veRAACTokenAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.raacCorpAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.otherAmount).to.equal(ethers.parseEther("0"));

            expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
            expect(await crvusd.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("1000"));
        })
        it("should collect fees correctly", async function () {
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
            await expect(feeCollector.connect(user1).collectFee(crvusd.target, user1.address, ethers.parseEther("1"), SWAP_FEE))
                .to.emit(feeCollector, "FeeCollected")
                .withArgs(crvusd.target, user1.address, SWAP_FEE, ethers.parseEther("1"), ethers.parseEther("1"));
            const collectedFees = await feeCollector.getCollectedFees(crvusd.target, SWAP_FEE);
            expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.repairFundAmount).to.equal(ethers.parseEther("0.6667"));
            expect(collectedFees.veRAACTokenAmount).to.equal(ethers.parseEther("0.3333")); 
            expect(collectedFees.burnAmount).to.equal(0);
            expect(collectedFees.raacCorpAmount).to.equal(0);
            expect(collectedFees.otherAmount).to.equal(0); 

            expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("999"));
            expect(await crvusd.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("1"));
        });
        it("should collect fee for a type that does not add up to 100%", async function () {
            // If a type does not add up to 100%, the remaining portion is sent to the treasury
            const UNBALANCED_FEE = ethers.keccak256(ethers.toUtf8Bytes("UNBALANCED_FEE"));
            await feeCollector.addFeeType(UNBALANCED_FEE, 0, 80_00, 0, 0, 0, 0); // does not add up to 100%
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
            await feeCollector.connect(user1).collectFee(crvusd.target, user1.address, ethers.parseEther("100"), UNBALANCED_FEE);
            const collectedFees = await feeCollector.getCollectedFees(crvusd.target, UNBALANCED_FEE);
            expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("20")); // 20% of 100 which was the remaining portion
            expect(collectedFees.repairFundAmount).to.equal(ethers.parseEther("80"));
            expect(collectedFees.burnAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.veRAACTokenAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.raacCorpAmount).to.equal(ethers.parseEther("0"));
            expect(collectedFees.otherAmount).to.equal(ethers.parseEther("0"));

            expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
        })
        it("should distribute fees correctly", async function () {
            // Set repair fund address (has the distributeRewards function)
            await feeCollector.setTargetAddress(REPAIR_FUND, distributableContract.target);
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
            await feeCollector.connect(user1).collectFee(crvusd.target, user1.address, ethers.parseEther("1"), SWAP_FEE);

            expect(await feeCollector.getTargetAmount(SWAP_FEE, REPAIR_FUND, crvusd.target)).to.equal(ethers.parseEther("0.6667"));
            const distributableContractBalanceBefore = await crvusd.balanceOf(distributableContract.target);
            expect(distributableContractBalanceBefore).to.equal(0);
            await feeCollector.connect(owner).distributeFees(SWAP_FEE, REPAIR_FUND, crvusd.target);
            const distributableContractBalanceAfter = await crvusd.balanceOf(distributableContract.target);
            expect(distributableContractBalanceAfter).to.equal(ethers.parseEther("0.6667"));

            const targetAddress = await feeCollector.getTargetAddress(VERAAC);
            expect(targetAddress).to.equal(owner.address);
            expect(await feeCollector.getTargetAmount(SWAP_FEE, VERAAC, crvusd.target)).to.equal(ethers.parseEther("0.3333"));

            // // This is admin, so no function distribute and only transfer should be done
            const ownerBalanceBefore = await crvusd.balanceOf(owner.address);
            expect(ownerBalanceBefore).to.equal(0);
            await feeCollector.connect(owner).distributeFees(SWAP_FEE, VERAAC, crvusd.target);

            const ownerBalanceAfter = await crvusd.balanceOf(owner.address);
            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther("0.3333"));

            expect(await feeCollector.getTargetAmount(SWAP_FEE, VERAAC, crvusd.target)).to.equal(0);
            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther("0.3333"));
        })
        it("should claim underlying NFTs correctly", async function () {
            // mock collectable underlying contract
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();
            await feeCollector.addWhitelistedTarget(mockCollectable.target);

            // Grant WITHDRAW_ROLE to FeeCollector
            const WITHDRAW_ROLE = await mockCollectable.WITHDRAW_ROLE();
            await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

            // Mint some tokens to the mock contract
            await crvusd.mint(mockCollectable.target, ethers.parseEther("1000"));

            if (!await feeCollector.isTokenSupported(crvusd.target)) {
                await feeCollector.addClaimableToken(crvusd.target);
            }

            await feeCollector.setTargetFeeType(mockCollectable.target, LENDING_FEE);

            // Claim underlying
            const amountToClaim = ethers.parseEther("1");
            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, amountToClaim, LENDING_FEE))
                .to.emit(mockCollectable, "WithdrawUnderlyingExecuted")
                .withArgs(crvusd.target, feeCollector.target, amountToClaim);


            const [withdrawnAmount, withdrawer, token] = await mockCollectable.getLastWithdrawal();
            expect(withdrawnAmount).to.equal(amountToClaim);
            expect(withdrawer).to.equal(feeCollector.target);
            expect(token).to.equal(crvusd.target);

            // Verify fees were collected correctly
            const collectedFees = await feeCollector.getCollectedFees(crvusd.target, LENDING_FEE);
            expect(collectedFees.treasuryAmount).to.equal(amountToClaim);
            expect(collectedFees.repairFundAmount).to.equal(0);
            expect(collectedFees.burnAmount).to.equal(0);
            expect(collectedFees.veRAACTokenAmount).to.equal(0);
            expect(collectedFees.raacCorpAmount).to.equal(0);
            expect(collectedFees.otherAmount).to.equal(0);

            expect(await crvusd.balanceOf(feeCollector.target)).to.equal(amountToClaim);
            expect(await crvusd.balanceOf(mockCollectable.target)).to.equal(ethers.parseEther("999"));
        });
        it("should fail to claim underlying NFTs when contract reverts", async function () {
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();

            // Whitelist the mock collectable contract
            await feeCollector.addWhitelistedTarget(mockCollectable.target);

            // Grant WITHDRAW_ROLE to FeeCollector
            const WITHDRAW_ROLE = await mockCollectable.WITHDRAW_ROLE();
            await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

            // Speicic to mock in order to similate reverting
            await mockCollectable.setShouldRevert(true);

            await feeCollector.setTargetFeeType(mockCollectable.target, LENDING_FEE);

            await expect(
                feeCollector.claimNFTUnderlying(
                    crvusd.target,
                    mockCollectable.target,
                    ethers.parseEther("1"),
                    LENDING_FEE
                )
            ).to.be.revertedWithCustomError(feeCollector, "ClaimCollectorUnderlyingFailed");
        });

        it("should distribute the fee correctly to the treasury", async function() {
            const Treasury = await ethers.getContractFactory("Treasury");
            const treasury = await Treasury.deploy(owner.address)

            // whitelist token in the treasury
            await treasury.addSupportedToken(crvusd.target);

            expect(await feeCollector.isValidDistributionTarget(treasury.target)).to.equal(true);
            expect(await feeCollector.isValidDistributionTarget(user1.address)).to.equal(false);

            await feeCollector.setTargetAddress(TREASURY, treasury.target);
            // send some crvusd to the fee collector
            await crvusd.mint(user1.address, ethers.parseEther("100"))
            await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("100"))
            await feeCollector.collectFee(crvusd.target, user1.address, ethers.parseEther("100"), ROYALTY_FEE)

            // check that the fee collector received the correct portion of the fees
            const portion = await feeCollector.getCollectedFees(crvusd.target, ROYALTY_FEE)
            const treasuryFee = portion[0]
            expect(treasuryFee).to.equal(ethers.parseEther("100") * 25_00n / 100_00n)

            const targetAmount = await feeCollector.getTargetAmount(ROYALTY_FEE, TREASURY, crvusd.target)
            expect(targetAmount).to.equal(treasuryFee)

            // distribute the fees
            await feeCollector.connect(owner).distributeFees(ROYALTY_FEE, TREASURY, crvusd.target); // owner = distributor

            // check the balance of crvusd in the treasury
            expect(await crvusd.balanceOf(treasury)).to.equal(treasuryFee);
            const newPortion = await feeCollector.getCollectedFees(crvusd.target, ROYALTY_FEE)
            expect(newPortion[0]).to.equal(0)
            const treasuryCrvusdBalance = await treasury.getBalance(crvusd.target)
            expect(treasuryCrvusdBalance).to.equal(treasuryFee);
            
            // take out the fees from treasury
            const user2BalanceBefore = await crvusd.balanceOf(user2.address)
            await treasury.connect(owner).withdraw(crvusd.target, treasuryFee, user2.address)
            expect(await crvusd.balanceOf(user2.address) - user2BalanceBefore).to.equal(treasuryFee)
        })

        it("should fail if the feeType does not exist", async function() {
            
            // Test for claimCollectorRewards()
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
            await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));
            // check 
            expect((await lendingPool.vaultRewards()).unclaimedRewards).to.equal(ethers.parseEther("1000"));
            
            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("DOES_NOT_EXIST")))).to.be.revertedWithCustomError(feeCollector, "FeeTypeDoesNotExist");

            // Test for claimNFTUnderlying()
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();

            // Grant WITHDRAW_ROLE to FeeCollector
            const WITHDRAW_ROLE = await mockCollectable.WITHDRAW_ROLE();
            await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

            // Mint some tokens to the mock contract
            await crvusd.mint(mockCollectable.target, ethers.parseEther("1000"));

            if (!await feeCollector.isTokenSupported(crvusd.target)) {
                await feeCollector.addClaimableToken(crvusd.target);
            }

            // Add target to whitelist
            await feeCollector.addWhitelistedTarget(mockCollectable.target);

            // Claim underlying with invalid feeType
            const amountToClaim = ethers.parseEther("1");
            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, amountToClaim, ethers.keccak256(ethers.toUtf8Bytes("DOES_NOT_EXIST"))))
                .to.be.revertedWithCustomError(feeCollector, "FeeTypeDoesNotExist");
        })
        it("Should fail it the token for fee distribution is not supported", async function (){
            await expect(feeCollector.connect(owner).distributeFees(SWAP_FEE, REPAIR_FUND, ethers.ZeroAddress)).to.be.revertedWithCustomError(feeCollector,"TokenNotSupported");
        })

        it("should handle rounding overflow for small values", async function() {
            const NEW_TYPE = ethers.keccak256(ethers.toUtf8Bytes("NEW_TYPE"));
            await feeCollector.addFeeType(NEW_TYPE, 0, 5000, 0, 5000, 0, 0);

            await feeCollector.setTargetAddress(REPAIR_FUND, distributableContract.target);
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
            await feeCollector.connect(user1).collectFee(crvusd.target, user1.address, 1, NEW_TYPE);
        })

        describe("Fee-on-transfer", function () {
            let raacToken;
            // Need to consider fee-on-transfer for the following function: 
            // - collectFee()
            // - claimCollectorRewards()
            // - claimNFTUnderlying()

            // We will deploy the RAACToken which is a fee-on-transfer token (burn 1% and swap 0.5%) on each transfer
            // If we send 1000 RAACToken, we will receive only 985 RAACToken., Basically deduct 1.5% on each transfer

            beforeEach(async function() {
                const RAACToken = await ethers.getContractFactory("RAACToken");
                raacToken = await RAACToken.deploy(owner.address);
                raacToken.setMinter(owner.address);
                await feeCollector.addClaimableToken(raacToken.target);
                await feeCollector.addWhitelistedTarget(user1.address);
            })
            it("should collectFee correctly when fee-on-transfer happens", async function () {
                await raacToken.mint(user1.address, ethers.parseEther("1000"));
                await raacToken.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
    
                await expect(feeCollector.connect(user1).collectFee(raacToken.target, user1.address, ethers.parseEther("1000"), LENDING_FEE)) // using lending fee because simple 100% goes to treasury
                    .to.emit(feeCollector, "FeeCollected")
                    .withArgs(raacToken.target, user1.address, LENDING_FEE, ethers.parseEther("1000"), ethers.parseEther("1000"));
    
                expect(await raacToken.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("1000"));
                const collectedFees = await feeCollector.getCollectedFees(raacToken.target, LENDING_FEE);
                expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("1000"));
                expect(collectedFees.repairFundAmount).to.equal(0);
                expect(collectedFees.burnAmount).to.equal(0);
                expect(collectedFees.veRAACTokenAmount).to.equal(0);
                expect(collectedFees.raacCorpAmount).to.equal(0);
                expect(collectedFees.otherAmount).to.equal(0);

            })
            it("should claimCollectorRewards correctly when fee-on-transfer happens", async function () {
                const MockLendingPoolCollector = await ethers.getContractFactory("MockLendingPoolCollector");
                const mockLendingPoolCollector = await MockLendingPoolCollector.deploy(raacToken.target);
                await feeCollector.addWhitelistedTarget(mockLendingPoolCollector.target);
                await mockLendingPoolCollector.setFeeCollector(feeCollector.target);

                await raacToken.mint(user1.address, ethers.parseEther("1000"));
                await raacToken.connect(user1).approve(mockLendingPoolCollector.target, ethers.parseEther("1000"));
                await mockLendingPoolCollector.connect(user1).depositToVault(ethers.parseEther("1000"));

                await feeCollector.setTargetFeeType(mockLendingPoolCollector.target, LENDING_FEE);

                // the mock lending pool collector just received only 985 raac tokens
                expect(await raacToken.balanceOf(mockLendingPoolCollector.target)).to.equal(ethers.parseEther("1000"));

                await expect(feeCollector.claimCollectorRewards(raacToken.target, mockLendingPoolCollector.target, LENDING_FEE))
                    .to.emit(feeCollector, "CollectorRewardsClaimed")
                    .withArgs(raacToken.target, mockLendingPoolCollector.target, ethers.parseEther("1000"), ethers.parseEther("1000"));

                const collectedFees = await feeCollector.getCollectedFees(raacToken.target, LENDING_FEE);
                expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("1000"));
                expect(collectedFees.repairFundAmount).to.equal(0);
                expect(collectedFees.burnAmount).to.equal(0);
                expect(collectedFees.veRAACTokenAmount).to.equal(0);
                expect(collectedFees.raacCorpAmount).to.equal(0);
                expect(collectedFees.otherAmount).to.equal(0);

                // check the balance of raac tokens in the fee collector
                expect(await raacToken.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("1000"));
                expect(await raacToken.balanceOf(mockLendingPoolCollector.target)).to.equal(ethers.parseEther("0"));

            })
            it("should claimNFTUnderlying correctly when fee-on-transfer happens", async function () {
                const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
                const mockCollectable = await MockCollectableUnderlying.deploy(raacToken.target);
                await feeCollector.addWhitelistedTarget(mockCollectable.target);
                const WITHDRAW_ROLE = await mockCollectable.WITHDRAW_ROLE();
                await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

                // since we mint to mock collector, it receives 1000 direcly
                await raacToken.mint(mockCollectable.target, ethers.parseEther("1000"));

                await feeCollector.setTargetFeeType(mockCollectable.target, LENDING_FEE);

                await expect(feeCollector.claimNFTUnderlying(raacToken.target, mockCollectable.target, ethers.parseEther("1000"), LENDING_FEE))
                    .to.emit(feeCollector, "CollectorUnderlyingClaimed")
                    .withArgs(raacToken.target, mockCollectable.target, ethers.parseEther("1000"), ethers.parseEther("1000"));

                const collectedFees = await feeCollector.getCollectedFees(raacToken.target, LENDING_FEE);
                expect(collectedFees.treasuryAmount).to.equal(ethers.parseEther("1000"));
                expect(collectedFees.repairFundAmount).to.equal(0);
                expect(collectedFees.burnAmount).to.equal(0);
                expect(collectedFees.veRAACTokenAmount).to.equal(0);
                expect(collectedFees.raacCorpAmount).to.equal(0);
                expect(collectedFees.otherAmount).to.equal(0);

                expect(await raacToken.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("1000"));
                expect(await raacToken.balanceOf(mockCollectable.target)).to.equal(ethers.parseEther("0"));
            })
        })
    })

     describe("Emergency Controls", function () {
        beforeEach(async function () {
            await feeCollector.connect(owner).grantRole(await feeCollector.EMERGENCY_ROLE(), owner.address);
            await feeCollector.addClaimableToken(crvusd.target);
            await feeCollector.addFeeType(SWAP_FEE, 0, 6667, 0, 3333, 0, 0);
        });

        it("should allow emergency withdrawal by admin", async function () {
            const AMOUNT_TO_COLLECT = ethers.parseEther("1");
            await crvusd.mint(user1.address, AMOUNT_TO_COLLECT);
            await crvusd.connect(user1).approve(feeCollector.target, AMOUNT_TO_COLLECT);
            await feeCollector.connect(user1).collectFee(crvusd.target, user1.address, AMOUNT_TO_COLLECT, SWAP_FEE);
            
            await feeCollector.connect(owner).pause();
            const initialBalance = await crvusd.balanceOf(feeCollector.target);
            const initialOwnerBalance = await crvusd.balanceOf(owner.address);
            expect(initialBalance).to.equal(AMOUNT_TO_COLLECT);
            expect(initialOwnerBalance).to.equal(0);

            await feeCollector.connect(owner).emergencyWithdraw(crvusd.target, owner.address);
        
            const finalTreasuryBalance = await crvusd.balanceOf(feeCollector.target);
            const finalOwnerBalance = await crvusd.balanceOf(owner.address);
            // The entire balance should be transferred to treasury
            expect(finalTreasuryBalance).to.equal(0);
            expect(finalOwnerBalance).to.equal(initialOwnerBalance + AMOUNT_TO_COLLECT);
        });

        it("should not allow emergency withdrawal when not paused", async function () {
            await expect(feeCollector.connect(user1).emergencyWithdraw(crvusd.target, owner.address))
            .to.be.revertedWithCustomError(feeCollector, "ExpectedPause");
        });

        it("should not allow emergency withdrawal by non-admin", async function () {
            await feeCollector.connect(owner).pause();
            await expect(feeCollector.connect(user1).emergencyWithdraw(crvusd.target, owner.address))
                .to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        });

        it("should not allow operations when paused", async function () {
            await feeCollector.connect(owner).pause();
            await expect(feeCollector.connect(owner).distributeFees(SWAP_FEE, REPAIR_FUND, crvusd.target))
                .to.be.revertedWithCustomError(feeCollector, "EnforcedPause");
        });

        it("should allow EMERGENCY_ROLE to pause", async function () {
            await expect(feeCollector.connect(owner).pause())
                .to.emit(feeCollector, "Paused")
                .withArgs(owner.address);
            expect(await feeCollector.paused()).to.be.true;
        });

        it("should allow EMERGENCY_ROLE to unpause", async function () {
            await feeCollector.connect(owner).pause();
            await expect(feeCollector.connect(owner).unpause())
                .to.emit(feeCollector, "Unpaused")
                .withArgs(owner.address);
            expect(await feeCollector.paused()).to.be.false;
        });

        it("should not allow non-EMERGENCY_ROLE to pause", async function () {
            await expect(feeCollector.connect(user1).pause())
                .to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        });

        it("should not allow non-EMERGENCY_ROLE to unpause", async function () {
            await feeCollector.connect(owner).pause();
            await expect(feeCollector.connect(user1).unpause())
                .to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        });
    });

    describe("Target Whitelist", function () {
        beforeEach(async function () {
            await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0);
            await feeCollector.connect(owner).addClaimableToken(crvusd.target);
        });

        it("should allow manager to add or remove target to whitelist", async function () {
            await expect(feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target))
                .to.emit(feeCollector, "TargetWhitelisted")
                .withArgs(lendingPool.target);
            
            expect(await feeCollector.isTargetWhitelisted(lendingPool.target)).to.be.true;

            await expect(feeCollector.connect(owner).removeWhitelistedTarget(lendingPool.target))
                .to.emit(feeCollector, "TargetRemovedFromWhitelist")
                .withArgs(lendingPool.target);
            
            expect(await feeCollector.isTargetWhitelisted(lendingPool.target)).to.be.false;

            // Revert if not whitelisted
            await expect(feeCollector.connect(owner).removeWhitelistedTarget(lendingPool.target))
                .to.be.revertedWithCustomError(feeCollector, "TargetNotWhitelisted");

            await feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target);

            // Revert if already whitelisted
            await expect(feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target))
                .to.be.revertedWithCustomError(feeCollector, "TargetAlreadyWhitelisted");

        });

        it("should not allow non-manager to add or remove target to whitelist", async function () {
            await expect(feeCollector.connect(user1).addWhitelistedTarget(lendingPool.target))
                .to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");

            await feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target);
        
            await expect(feeCollector.connect(user1).removeWhitelistedTarget(lendingPool.target))
                .to.be.revertedWithCustomError(feeCollector, "AccessControlUnauthorizedAccount");
        });

        it("should revert claimCollectorRewards when target is not whitelisted", async function () {
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
            await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));

            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ROYALTY_FEE))
                .to.be.revertedWithCustomError(feeCollector, "TargetNotWhitelisted");
        });

        it("should revert claimNFTUnderlying when target is not whitelisted", async function () {
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();

            const WITHDRAW_ROLE = await mockCollectable.WITHDRAW_ROLE();
            await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

            await crvusd.mint(mockCollectable.target, ethers.parseEther("1000"));

            await expect(feeCollector.claimNFTUnderlying(
                crvusd.target,
                mockCollectable.target,
                ethers.parseEther("1"),
                ROYALTY_FEE
            )).to.be.revertedWithCustomError(feeCollector, "TargetNotWhitelisted");

            await feeCollector.connect(owner).addWhitelistedTarget(mockCollectable.target);
            await feeCollector.setTargetFeeType(mockCollectable.target, ROYALTY_FEE);

            await mockCollectable.grantRole(WITHDRAW_ROLE, feeCollector.target);

            await crvusd.mint(mockCollectable.target, ethers.parseEther("1000"));

            await expect(feeCollector.claimNFTUnderlying(
                crvusd.target,
                mockCollectable.target,
                ethers.parseEther("1"),
                ROYALTY_FEE
            )).to.not.be.reverted;
        });

        it("should revert claimCollectorRewards when target fee type is not set", async function () {
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
            await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));

            await feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target);

            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ROYALTY_FEE))
                .to.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");

            await feeCollector.setTargetFeeType(lendingPool.target, ROYALTY_FEE);

            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ROYALTY_FEE))
                .to.not.be.reverted;
        })
        it("should revert claimCollectorRewards when target fee type is incorrect", async function () {
            await crvusd.mint(user1.address, ethers.parseEther("1000"));
            await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
            await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));

            await feeCollector.connect(owner).addWhitelistedTarget(lendingPool.target);

            // I set that ROYALTY_FEE is the target fee type, but I want to claim SWAP_FEE
            await feeCollector.setTargetFeeType(lendingPool.target, ROYALTY_FEE);
            await feeCollector.addFeeType(SWAP_FEE, 2500, 5000, 2500, 0, 0, 0);

            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, SWAP_FEE))
                .to.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");

            await expect(feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ROYALTY_FEE))
                .to.not.be.reverted;
        })
        it("should revert claimNFTUnderlying when target fee type is incorrect", async function () {
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();

            await feeCollector.connect(owner).addWhitelistedTarget(mockCollectable.target);

            // I set that ROYALTY_FEE is the target fee type, but I want to claim SWAP_FEE
            await feeCollector.setTargetFeeType(mockCollectable.target, ROYALTY_FEE);
            await feeCollector.addFeeType(SWAP_FEE, 2500, 5000, 2500, 0, 0, 0);

            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, ethers.parseEther("1"), SWAP_FEE))
                .to.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");

            await feeCollector.setTargetFeeType(mockCollectable.target, SWAP_FEE);

            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, ethers.parseEther("1"), SWAP_FEE))
                .to.not.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");
        })
        it("should revert claimNFTUnderlying when target fee type is not set", async function () {
            const MockCollectableUnderlying = await ethers.getContractFactory("MockCollectableUnderlying");
            const mockCollectable = await MockCollectableUnderlying.deploy(crvusd.target);
            await mockCollectable.waitForDeployment();

            await feeCollector.connect(owner).addWhitelistedTarget(mockCollectable.target);

            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, ethers.parseEther("1"), ROYALTY_FEE))
                .to.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");

            await feeCollector.setTargetFeeType(mockCollectable.target, ROYALTY_FEE);

            await expect(feeCollector.claimNFTUnderlying(crvusd.target, mockCollectable.target, ethers.parseEther("1"), ROYALTY_FEE))
                .to.not.be.revertedWithCustomError(feeCollector, "TargetFeeTypeMismatch");
        })
    });
});