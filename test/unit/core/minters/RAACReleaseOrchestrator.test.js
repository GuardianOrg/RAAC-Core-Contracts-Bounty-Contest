import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

const TEN_MILLION = ethers.parseEther("10000000");
const SIX_POINT_FIVE_MILLION = ethers.parseEther("6510000");
const ONE_MILLION = ethers.parseEther("1000000");
const ONE_POINT_EIGHT_MILLION = ethers.parseEther("1800000");
const ONE_MILLION_THIRTY_THOUSAND = ethers.parseEther("1030000");
const HALF_MILLION = ethers.parseEther("500000");
const THREE_HUNDRED_THOUSAND = ethers.parseEther("300000");

const DAY = 24 * 60 * 60; // 1 day in seconds
const VESTING_DURATION = 700 * DAY;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const FOUR_HOURS = 4 * 60 * 60; // 4 hours in seconds

const CLIFF_DURATION = 90 * DAY;

describe("RAACReleaseOrchestrator", function () {
  let RAACToken, RAACReleaseOrchestrator;
  let raacToken, releaseOrchestrator;
  let owner, beneficiary1, beneficiary2, advisor;
  let startTime;

  beforeEach(async function () {
    [owner, beneficiary1, beneficiary2, advisor] = await ethers.getSigners();

    // Deploy RAAC Token
    RAACToken = await ethers.getContractFactory("RAACToken");
    raacToken = await RAACToken.deploy(owner.address);
    
    // Mint TGE
    await raacToken.setMinter(owner.address);
    await raacToken.mint(owner.address, TEN_MILLION); // 10 million RAAC

    // Deploy Release Orchestrator
    RAACReleaseOrchestrator = await ethers.getContractFactory("RAACReleaseOrchestrator");
    releaseOrchestrator = await RAACReleaseOrchestrator.deploy(await raacToken.getAddress());

    // Transfer tokens to orchestrator
    await raacToken.transfer(await releaseOrchestrator.getAddress(), SIX_POINT_FIVE_MILLION); // 6.51 million RAAC or 65.1% of total supply

    // Set startTime to be 1 hour in the future to ensure it's always ahead of block.timestamp
    startTime = (await time.latest()) + 3600; // 1 hour in the future
  });

  describe("Initialization", function () {
    it("should initialize with correct token address", async function () {
      expect(await releaseOrchestrator.raacToken()).to.equal(await raacToken.getAddress());
    });

    it("should initialize category allocations correctly", async function () {
      const teamAllocation = await releaseOrchestrator.categoryAllocations(
        await releaseOrchestrator.TEAM_CATEGORY()
      );
      expect(teamAllocation).to.equal(ONE_POINT_EIGHT_MILLION); // 18%

      const advisorAllocation = await releaseOrchestrator.categoryAllocations(
        await releaseOrchestrator.ADVISOR_CATEGORY()
      );
      expect(advisorAllocation).to.equal(ONE_MILLION_THIRTY_THOUSAND); // 10.3%
    });

    it("should set correct roles", async function () {
      const orchestratorRole = await releaseOrchestrator.ORCHESTRATOR_ROLE();
      const emergencyRole = await releaseOrchestrator.EMERGENCY_ROLE();
      
      expect(await releaseOrchestrator.hasRole(orchestratorRole, owner.address)).to.be.true;
      expect(await releaseOrchestrator.hasRole(emergencyRole, owner.address)).to.be.true;
    });
  });

  describe("Vesting Schedule Creation", function () {
    it("should create vesting schedule correctly", async function () {
      await releaseOrchestrator.createVestingSchedule(
        beneficiary1.address,
        await releaseOrchestrator.TEAM_CATEGORY(),
        ONE_MILLION,
        startTime,
        VESTING_DURATION
      );

      const schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
      expect(schedule.totalAmount).to.equal(ONE_MILLION);
      expect(schedule.startTime).to.equal(startTime);
      expect(schedule.initialized).to.be.true;
    });

    it("should fail if category allocation exceeded", async function () {
      const excessAmount = ethers.parseEther("20000000"); // More than team allocation
      await expect(
        releaseOrchestrator.createVestingSchedule(
          beneficiary1.address,
          await releaseOrchestrator.TEAM_CATEGORY(),
          excessAmount,
          startTime,
          VESTING_DURATION
        )
      ).to.be.revertedWithCustomError(releaseOrchestrator, "CategoryAllocationExceeded");
    });

    it("should fail for invalid beneficiary", async function () {
      await expect(
        releaseOrchestrator.createVestingSchedule(
          ethers.ZeroAddress,
          await releaseOrchestrator.TEAM_CATEGORY(),
          ethers.parseEther("1000000"),
          startTime,
          VESTING_DURATION
        )
      ).to.be.revertedWithCustomError(releaseOrchestrator, "InvalidAddress");
    });
  });

  describe("Token Release", function () {
    beforeEach(async function () {
      await releaseOrchestrator.createVestingSchedule(
        beneficiary1.address,
        await releaseOrchestrator.TEAM_CATEGORY(),
        ethers.parseEther("1000000"),
        startTime,
        VESTING_DURATION
      );
    });

    it("should not release tokens before cliff", async function () {
      await expect(
        releaseOrchestrator.connect(beneficiary1).release()
      ).to.be.revertedWithCustomError(releaseOrchestrator, "NothingToRelease");
    });

    it("should release tokens after cliff", async function () {
      await time.increase(CLIFF_DURATION + 1);

      await releaseOrchestrator.connect(beneficiary1).release();
      const schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
      expect(schedule.releasedAmount).to.be.gt(0);
    });

    it("should release all tokens after vesting duration", async function () {
      await time.increase(VESTING_DURATION + 1);
      await releaseOrchestrator.connect(beneficiary1).release();
      const schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
      expect(schedule.releasedAmount).to.be.closeTo(ONE_MILLION, ethers.parseEther("100"));
    });
  });

  describe("Emergency Functions", function () {
    const vestingAmount = ethers.parseEther("1000000");

    beforeEach(async function () {
      await releaseOrchestrator.createVestingSchedule(
        beneficiary1.address,
        await releaseOrchestrator.TEAM_CATEGORY(),
        vestingAmount,
        startTime,
        VESTING_DURATION
      );
    });

    it("should allow emergency revoke by authorized role", async function () {
      await releaseOrchestrator.emergencyRevoke(beneficiary1.address);
      const schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
      expect(schedule.initialized).to.be.false;
    });

    it("should allow emergency shutdown", async function () {
      await releaseOrchestrator.setEmergencyShutdown(true);
      
      await expect(
        releaseOrchestrator.createVestingSchedule(
          beneficiary2.address,
          await releaseOrchestrator.TEAM_CATEGORY(),
          ethers.parseEther("1000000"),
          startTime,
          VESTING_DURATION
        )
      ).to.be.reverted;
    });

    it("should handle emergency revoke and withdraw", async function () {
      // Move past cliff but not full vesting
      await time.increase(CLIFF_DURATION + 100 * DAY);
      await releaseOrchestrator.connect(beneficiary1).release();

      const beneficiaryBalanceBefore = await raacToken.balanceOf(beneficiary1.address);
      const contractBalanceBefore = await raacToken.balanceOf(await releaseOrchestrator.getAddress());
      const ownerBalanceBefore = await raacToken.balanceOf(owner.address);

      // Perform emergency revoke (only revoke the amount, do not release tokens yet)
      await releaseOrchestrator.emergencyRevoke(beneficiary1.address);

      await expect(releaseOrchestrator.emergencyWithdrawRevoked()).to.be.revertedWithCustomError(releaseOrchestrator, "TooEarlyToRelease");

      // One day later, can be withdrawn by emergency role
      await time.increase(DAY);
      await releaseOrchestrator.emergencyWithdrawRevoked();

      const beneficiaryBalanceAfter = await raacToken.balanceOf(beneficiary1.address);
      const contractBalanceAfter = await raacToken.balanceOf(await releaseOrchestrator.getAddress());
      const ownerBalanceAfter = await raacToken.balanceOf(owner.address);

      // Balance the same (what they already claimed)
      expect(beneficiaryBalanceAfter).to.equal(beneficiaryBalanceBefore);

      const unreleasedAmount = vestingAmount - beneficiaryBalanceBefore;
      expect(contractBalanceAfter).to.equal(contractBalanceBefore - unreleasedAmount);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + unreleasedAmount);
    });
  });

  describe("Category Management", function () {
    it("should update category allocation correctly", async function () {
      const newAllocation = ethers.parseEther("20000000");
      await releaseOrchestrator.updateCategoryAllocation(
        await releaseOrchestrator.TEAM_CATEGORY(),
        newAllocation
      );

      const updatedAllocation = await releaseOrchestrator.categoryAllocations(
        await releaseOrchestrator.TEAM_CATEGORY()
      );
      expect(updatedAllocation).to.equal(newAllocation);
    });

    it("should return correct total allocation", async function () {
      const totalAllocation = await releaseOrchestrator.getTotalAllocation();
      expect(totalAllocation).to.equal(SIX_POINT_FIVE_MILLION); // 65.1% of total supply
    });
  });
}); 


describe("Vesting Schedule Release", function () {
  let RAACToken, RAACReleaseOrchestrator;
  let raacToken, releaseOrchestrator;
  let owner, beneficiary1, beneficiary2, advisor;
  let startTime;

  beforeEach(async function () {
    [owner, beneficiary1, beneficiary2, advisor] = await ethers.getSigners();

    // Deploy RAAC Token
    RAACToken = await ethers.getContractFactory("RAACToken");
    raacToken = await RAACToken.deploy(owner.address);
    
    // Mint TGE
    await raacToken.setMinter(owner.address);
    await raacToken.mint(owner.address, TEN_MILLION); // 10 million RAAC

    // Deploy Release Orchestrator
    RAACReleaseOrchestrator = await ethers.getContractFactory("RAACReleaseOrchestrator");
    releaseOrchestrator = await RAACReleaseOrchestrator.deploy(await raacToken.getAddress());

    // Transfer tokens to orchestrator
    await raacToken.transfer(await releaseOrchestrator.getAddress(), SIX_POINT_FIVE_MILLION); // 6.51 million RAAC, 65.1% of total supply

    startTime = (await time.latest()) + 3600; // 1 hour in the future
  });
    
    it("should calculate correct vested amounts at different time points", async function () {
        await releaseOrchestrator.createVestingSchedule(
            beneficiary1.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ONE_MILLION,
            startTime,
            VESTING_DURATION
        );

        // Cliff is at 90 days
        await time.increase(CLIFF_DURATION);
        
        await releaseOrchestrator.connect(beneficiary1).release();
        
        let schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        // 90/700 * 1M ≈ 128,571.43 tokens
        let expectedAmount = ethers.parseEther("128511.904761904761904761"); 

        expect(schedule.releasedAmount).to.be.closeTo(expectedAmount, ethers.parseEther("0.1"));
        expect(await raacToken.balanceOf(beneficiary1.address)).to.be.closeTo(expectedAmount, ethers.parseEther("0.1"));

        // halfway point (350 days)
        await time.increase(260 * DAY);

        await releaseOrchestrator.connect(beneficiary1).release();
        schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        expectedAmount = ethers.parseEther("500000"); // 350/700 * 1M = 0.5M
        expect(schedule.releasedAmount).to.be.closeTo(expectedAmount, ethers.parseEther("100"));

        // Test full vesting (700 days)
        await time.increase(350 * DAY + 1); // Increase by remaining days to end 
        await releaseOrchestrator.connect(beneficiary1).release();
        schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        // Full amount to beneficiary
        expect(schedule.releasedAmount).to.be.closeTo(ONE_MILLION, ethers.parseEther("100"));
    });

    it("should allow multiple claims within the same day", async function () {
        await releaseOrchestrator.createVestingSchedule(
            beneficiary1.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ONE_MILLION,
            startTime,
            VESTING_DURATION
        );

        // Move past cliff
        await time.increase(CLIFF_DURATION);
        
        // First claim
        await releaseOrchestrator.connect(beneficiary1).release();
        const firstBalance = await raacToken.balanceOf(beneficiary1.address);
        
        // Wait 4 hours and claim again
        await time.increase(FOUR_HOURS);
        await releaseOrchestrator.connect(beneficiary1).release();
        const secondBalance = await raacToken.balanceOf(beneficiary1.address);
        
        // Second claim should be higher due to additional vesting time
        expect(secondBalance).to.be.gt(firstBalance);
        
        // Calculate expected amount
        const currentTime = await time.latest();
        const timeFromStart = BigInt(currentTime - startTime);
        const timeRatio = (timeFromStart * BigInt(1e18)) / BigInt(VESTING_DURATION);
        const expectedAmount = (ONE_MILLION * timeRatio) / BigInt(1e18);
        
        expect(secondBalance).to.be.closeTo(expectedAmount, ethers.parseEther("0.1"));
    });

    it("should handle multiple releases with varying time gaps", async function () {
        await releaseOrchestrator.createVestingSchedule(
            beneficiary1.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ONE_MILLION,
            startTime,
            VESTING_DURATION
        );

        // Move to cliff + 100 days
        await time.increase(CLIFF_DURATION + 100 * DAY);
        
        // Release 1
        await releaseOrchestrator.connect(beneficiary1).release();
        let schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        const firstRelease = schedule.releasedAmount;

        await time.increase(30 * DAY);
        
        // Release 2
        await releaseOrchestrator.connect(beneficiary1).release();
        schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        const secondRelease = schedule.releasedAmount;
        
        expect(secondRelease).to.be.gt(firstRelease);
        
        // Move to end of vesting
        const currentTime = await time.latest();
        const remainingTime = VESTING_DURATION - (currentTime - startTime);
        await time.increase(remainingTime);
        
        // Final release
        await releaseOrchestrator.connect(beneficiary1).release();
        schedule = await releaseOrchestrator.getVestingSchedule(beneficiary1.address);
        expect(schedule.releasedAmount).to.equal(ONE_MILLION);
    });

    it("should correctly vest tokens for multiple beneficiaries across all categories", async function () {
        const VESTING_DURATION = 700 * DAY;
        
        startTime = await time.latest() + 2;
        
        const signers = await ethers.getSigners();
        const additionalSigners = await Promise.all(
            Array(30).fill(0).map(() => ethers.Wallet.createRandom().connect(ethers.provider))
        );
        
        // new wallets needs ETH for gas
        for (const signer of additionalSigners) {
            await owner.sendTransaction({
                to: signer.address,
                value: ethers.parseEther("1.0") 
            });
        }
        
        const allSigners = [...signers, ...additionalSigners];

        const [
            teamMember1, teamMember2, teamMember3, teamMember4,
            advisor1, advisor2,
            treasury,
            liquidityProvider,
            ...otherSigners
        ] = allSigners;

        // Split signers into private and public sale
        const privateSaleAddresses = otherSigners.slice(0, 10);
        const publicSaleAddresses = otherSigners.slice(10, 30);


        // Team allocations (1.8M total)
        await releaseOrchestrator.createVestingSchedule(
            teamMember1.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ethers.parseEther("800000"),
            startTime,
            VESTING_DURATION
        );
        await releaseOrchestrator.createVestingSchedule(
            teamMember2.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ethers.parseEther("200000"),
            startTime,
            VESTING_DURATION
        );
        await releaseOrchestrator.createVestingSchedule(
            teamMember3.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ethers.parseEther("400000"),
            startTime,
            VESTING_DURATION
        );
        await releaseOrchestrator.createVestingSchedule(
            teamMember4.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ethers.parseEther("400000"),
            startTime,
            VESTING_DURATION
        );

        // Advisor allocations (1.03M total)
        await releaseOrchestrator.createVestingSchedule(
            advisor1.address,
            await releaseOrchestrator.ADVISOR_CATEGORY(),
            ethers.parseEther("515000"),
            startTime,
            VESTING_DURATION
        );
        await releaseOrchestrator.createVestingSchedule(
            advisor2.address,
            await releaseOrchestrator.ADVISOR_CATEGORY(),
            ethers.parseEther("515000"),
            startTime,
            VESTING_DURATION
        );

        // Treasury allocation (500k)
        await releaseOrchestrator.createVestingSchedule(
            treasury.address,
            await releaseOrchestrator.TREASURY_CATEGORY(),
            HALF_MILLION,
            startTime,
            VESTING_DURATION
        );

        // Private sale allocations (1M split among 10 addresses)
        const privateSaleAmount = ethers.parseEther("100000"); // 100k each
        for (const addr of privateSaleAddresses) {
            await releaseOrchestrator.createVestingSchedule(
                addr.address,
                await releaseOrchestrator.PRIVATE_SALE_CATEGORY(),
                privateSaleAmount,
                startTime,
                VESTING_DURATION
            );
        }

        // Public sale allocations (1.5M split among 20 addresses)
        const publicSaleAmount = ethers.parseEther("75000"); // 75k each
        for (const addr of publicSaleAddresses) {
            await releaseOrchestrator.createVestingSchedule(
                addr.address,
                await releaseOrchestrator.PUBLIC_SALE_CATEGORY(),
                publicSaleAmount,
                startTime,
                VESTING_DURATION
            );
        }

        // Liquidity allocation (680k)
        await releaseOrchestrator.createVestingSchedule(
            liquidityProvider.address,
            await releaseOrchestrator.LIQUIDITY_CATEGORY(),
            ethers.parseEther("680000"),
            startTime,
            VESTING_DURATION
        );

        // Move to end of vesting period
        const currentTime = await time.latest();
        const remainingTime = VESTING_DURATION - (currentTime - startTime);
        await time.increase(remainingTime);
       
        async function releaseAndVerify(signer, expectedAmount) {
            const beforeBalance = await raacToken.balanceOf(signer.address);
            
            await releaseOrchestrator.connect(signer).release();
            
            const afterBalance = await raacToken.balanceOf(signer.address);
            const releasedAmount = afterBalance - beforeBalance;
            
            expect(releasedAmount).to.be.closeTo(expectedAmount, ethers.parseEther("0.1"));
        }

        await releaseAndVerify(teamMember1, ethers.parseEther("800000"));
        await releaseAndVerify(teamMember2, ethers.parseEther("200000"));
        await releaseAndVerify(teamMember3, ethers.parseEther("400000"));
        await releaseAndVerify(teamMember4, ethers.parseEther("400000"));

        await releaseAndVerify(advisor1, ethers.parseEther("515000"));
        await releaseAndVerify(advisor2, ethers.parseEther("515000"));

        await releaseAndVerify(treasury, HALF_MILLION);

        for (const addr of privateSaleAddresses) {
            await releaseAndVerify(addr, privateSaleAmount);
        }

        for (const addr of publicSaleAddresses) {
            await releaseAndVerify(addr, publicSaleAmount);
        }

        // Release and verify for liquidity
        await releaseAndVerify(liquidityProvider, ethers.parseEther("680000"));

        // Verify total allocations match expected values
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.TEAM_CATEGORY()))
            .to.equal(ethers.parseEther("1800000")); // 1.8M total team allocation
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.ADVISOR_CATEGORY()))
            .to.equal(ethers.parseEther("1030000")); // 1.03M total advisor allocation
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.TREASURY_CATEGORY()))
            .to.equal(HALF_MILLION); // 500k treasury
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.PRIVATE_SALE_CATEGORY()))
            .to.equal(ethers.parseEther("1000000")); // 1M private sale
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.PUBLIC_SALE_CATEGORY()))
            .to.equal(ethers.parseEther("1500000")); // 1.5M public sale
        expect(await releaseOrchestrator.categoryUsed(await releaseOrchestrator.LIQUIDITY_CATEGORY()))
            .to.equal(ethers.parseEther("680000")); // 680k liquidity
    });

    it("should handle different claiming patterns and frequencies", async function () {
        await releaseOrchestrator.createVestingSchedule(
            beneficiary1.address,
            await releaseOrchestrator.TEAM_CATEGORY(),
            ONE_MILLION,
            startTime,
            VESTING_DURATION
        );
        
        await releaseOrchestrator.createVestingSchedule(
            beneficiary2.address,
            await releaseOrchestrator.ADVISOR_CATEGORY(),
            HALF_MILLION,
            startTime,
            VESTING_DURATION
        );
        
        await releaseOrchestrator.createVestingSchedule(
            advisor.address,
            await releaseOrchestrator.TREASURY_CATEGORY(),
            THREE_HUNDRED_THOUSAND,
            startTime,
            VESTING_DURATION
        );

        // Move past cliff
        await time.increase(CLIFF_DURATION);
        
        // Test multiple claims per day
        for (let i = 0; i < 3; i++) {
            const beforeBalance = await raacToken.balanceOf(beneficiary1.address);
            await releaseOrchestrator.connect(beneficiary1).release();
            
            await time.increase(FOUR_HOURS);
            await releaseOrchestrator.connect(beneficiary1).release();
            
            const afterBalance = await raacToken.balanceOf(beneficiary1.address);
            expect(afterBalance).to.be.gt(beforeBalance);
            
            // Move to next day
            await time.increase(DAY);
        }
        
        // Test weekly claims
        for (let i = 0; i < 3; i++) {
            const beforeBalance = await raacToken.balanceOf(beneficiary2.address);
            await releaseOrchestrator.connect(beneficiary2).release();
            
            await time.increase(WEEK);
            
            const afterBalance = await raacToken.balanceOf(beneficiary2.address);
            expect(afterBalance).to.be.gt(beforeBalance);
        }
        
        // Test monthly claims
        for (let i = 0; i < 3; i++) {
            const beforeBalance = await raacToken.balanceOf(advisor.address);
            await releaseOrchestrator.connect(advisor).release();
            
            await time.increase(MONTH);
            
            const afterBalance = await raacToken.balanceOf(advisor.address);
            expect(afterBalance).to.be.gt(beforeBalance);
        }
        
        // Move to end of vesting
        const currentTime = await time.latest();
        const remainingTime = VESTING_DURATION - (currentTime - startTime);
        await time.increase(remainingTime);
        
        // Final claims should release all remaining tokens
        await releaseOrchestrator.connect(beneficiary1).release();
        await releaseOrchestrator.connect(beneficiary2).release();
        await releaseOrchestrator.connect(advisor).release();
        
        expect(await raacToken.balanceOf(beneficiary1.address)).to.equal(ONE_MILLION);
        expect(await raacToken.balanceOf(beneficiary2.address)).to.equal(HALF_MILLION);
        expect(await raacToken.balanceOf(advisor.address)).to.equal(THREE_HUNDRED_THOUSAND);
    });
});