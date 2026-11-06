import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const WAD = ethers.parseEther("1");
const RAY = ethers.parseUnits("1", 27);

describe("RToken", function () {
    let RToken;
    let rToken;
    let owner;
    let reservePool;
    let user1;
    let user2;
    let addrs;
    let mockAsset;
    let mockLendingPool;

    beforeEach(async function () {
        [owner, reservePool, user1, user2, ...addrs] = await ethers.getSigners();

        // Deploy crvUSD token for underlying asset
        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        mockAsset = await CrvUSDToken.deploy(owner.address);
        await mockAsset.setMinter(owner.address);

        // Deploy mock LendingPool first
        const MockLendingPool = await ethers.getContractFactory("MockLendingPool");
        mockLendingPool = await MockLendingPool.deploy();

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        const complianceRegistry = await ComplianceRegistry.deploy();
        
        // Deploy RToken
        RToken = await ethers.getContractFactory("RToken");
        rToken = await RToken.deploy("RToken", "RT", owner.address, mockAsset.target, complianceRegistry.target);

        // Set mock lending pool as reserve pool
        await rToken.setLendingPool(mockLendingPool.target);
        // await rToken.setMinter(reservePool.address);
        // await rToken.setBurner(reservePool.address);

        // Mock the getNormalizedIncome function to return RAY (1e27)
        await mockLendingPool.mockGetNormalizedIncome(ethers.parseUnits("1", 27));

        // Mint some mockAsset to users for testing
        await mockAsset.mint(user1.address, ethers.parseEther("1000"));
        await mockAsset.mint(user2.address, ethers.parseEther("1000"));
        await mockAsset.mint(reservePool.address, ethers.parseEther("1000"));
        await mockAsset.connect(reservePool).approve(rToken.target, ethers.parseEther("1000"));
        await mockAsset.connect(user1).approve(rToken.target, ethers.parseEther("1000"));
        await mockAsset.connect(user2).approve(rToken.target, ethers.parseEther("1000"));
    });

    describe("Basic functionality", function() {
        beforeEach(async function() {
            // Set rToken in mock 
            await mockLendingPool.setRToken(rToken.target);
        });

        it("should allow minter (ReservePool) to mint RToken", async function () {
            const mintAmount = ethers.parseEther("100");
            const mintOnBehalfOf = user1.address;
            const index = RAY;

            await expect(mockLendingPool.mockMint(reservePool.address, mintOnBehalfOf, mintAmount, index))
                .to.emit(rToken, "Mint")
                .withArgs(reservePool.address, mintOnBehalfOf, mintAmount, index);

            const scaledBalance = await rToken.rawBalanceOf(mintOnBehalfOf);
            expect(scaledBalance).to.equal(mintAmount);
        });

        it("should prevent non-minter from minting", async function () {
            const mintAmount = ethers.parseEther("100");
            const index = RAY;

            // Try to mint directly through rToken (will fail)
            await expect(
                rToken.connect(user1).mint(user1.address, user1.address, mintAmount, index)
            ).to.be.revertedWithCustomError(rToken, "OnlyLendingPool");
        });

        it("should allow burner (ReservePool) to burn RToken", async function () {
            const mintAmount = ethers.parseEther("100");
            const index = RAY;

            //crvUSD minted to user1
            await mockLendingPool.mockMint(reservePool.address, user1.address, mintAmount, index);

            // crvUSD minted to the rToken contract
            await mockAsset.mint(rToken.target, mintAmount);

            await expect(mockLendingPool.mockBurn(user1.address, user1.address, mintAmount, index))
                .to.emit(rToken, "Burn")
                .withArgs(user1.address, user1.address, mintAmount, index);

            const scaledBalance = await rToken.rawBalanceOf(user1.address);
            expect(scaledBalance).to.equal(0);
        });

        it("should prevent non-burner from burning", async function () {
            const mintAmount = ethers.parseEther("100");
            const index = RAY;

            //crvUSD minted to user1
            await mockLendingPool.mockMint(reservePool.address, user1.address, mintAmount, index);

            // Try to burn directly through rToken (should fail)
            await expect(
                rToken.connect(user1).burn(user1.address, user1.address, mintAmount, index)
            ).to.be.revertedWithCustomError(rToken, "OnlyLendingPool");
        });

        it("should allow transfers between users", async function () {
            const mintAmount = ethers.parseEther("100");
            const index = RAY;

            //crvUSD minted to user1
            await mockLendingPool.mockMint(reservePool.address, user1.address, mintAmount, index);

            const transferAmount = ethers.parseEther("50");
            await expect(rToken.connect(user1).transfer(user2.address, transferAmount))
                .to.emit(rToken, "Transfer")
                .withArgs(user1.address, user2.address, transferAmount);

            const scaledBalanceUser1 = await rToken.rawBalanceOf(user1.address);
            const scaledBalanceUser2 = await rToken.rawBalanceOf(user2.address);

            expect(scaledBalanceUser1).to.equal(mintAmount - transferAmount);
            expect(scaledBalanceUser2).to.equal(transferAmount);
        });
    });

    describe("Role management", function() {
        // it("should allow owner to set minter and burner", async function () {
        //     await rToken.setMinter(user1.address);
        //     await rToken.setBurner(user2.address);

        //     expect(await rToken._minter()).to.equal(user1.address);
        //     expect(await rToken._burner()).to.equal(user2.address);
        // });

        // it("should prevent non-owner from setting minter and burner", async function () {
        //     await expect(
        //         rToken.connect(user1).setMinter(user1.address)
        //     ).to.be.revertedWithCustomError(rToken, "OwnableUnauthorizedAccount");

        //     await expect(
        //         rToken.connect(user1).setBurner(user1.address)
        //     ).to.be.revertedWithCustomError(rToken, "OwnableUnauthorizedAccount");
        // });
    });

    describe("Dust handling", function() {
        beforeEach(async function() {
            // Setup initial state for dust tests
            const initialMint = ethers.parseEther("100");
            const index = RAY;
            
            // Set rToken in mock 
            await mockLendingPool.setRToken(rToken.target);
            // Set normalized income to RAY (1e27) for dust tests
            await mockLendingPool.mockGetNormalizedIncome(RAY); 
            
            //crvUSD minted to user1
            await mockLendingPool.mockMint(reservePool.address, user1.address, initialMint, index);

            //crvUSD minted to the rToken contract
            await mockAsset.mint(rToken.target, initialMint);
        });

        it("should correctly calculate dust amount", async function() {
            const dustAmount = ethers.parseEther("1");
            // Mint extra amount to create dust
            await mockAsset.mint(rToken.target, dustAmount);
            
            // Contract has more assets than the total supply
            const calculatedDust = await rToken.calculateDustAmount();
            expect(calculatedDust).to.equal(dustAmount);
        });
        
        it("should correctly calculate dust when contract balance exceeds total supply", async function() {
            const initialMint = ethers.parseEther("100");
            const index = RAY;
            
            // Initial mint of RTokens
            await mockLendingPool.mockMint(reservePool.address, user1.address, initialMint, index);
            
            // Send extra underlying tokens to create dust (more than total supply)
            const dustAmount = ethers.parseEther("10");
            await mockAsset.mint(rToken.target, initialMint + dustAmount);
            
            const calculatedDust = await rToken.calculateDustAmount();
            expect(calculatedDust).to.equal(dustAmount);
        });
    });

    describe("Interest exploitation prevention", function() {
        beforeEach(async function() {
            // Set rToken in mock 
            await mockLendingPool.setRToken(rToken.target);
            
            // Initial index at RAY (1.0)
            await mockLendingPool.mockGetNormalizedIncome(RAY);
        });

        it("should update user indices during transfers to prevent interest exploitation", async function() {
            const initialAmount = ethers.parseEther("100");
            const index = RAY;
            
            // Mint tokens to user1
            await mockLendingPool.mockMint(reservePool.address, user1.address, initialAmount, index);
            
            // Verify initial state
            expect(await rToken.rawBalanceOf(user1.address)).to.equal(initialAmount);
            expect(await rToken.balanceOf(user1.address)).to.equal(initialAmount);
            
            // Increase the liquidity index by 10% to simulate interest accrual
            const newIndex = RAY * 11n / 10n; // 1.1 * RAY
            await mockLendingPool.mockGetNormalizedIncome(newIndex);
            
            const interest = initialAmount * 1n / 10n;
            // After index increase, balance should include interest
            const balanceWithInterest = initialAmount + interest;
            expect(await rToken.rawBalanceOf(user1.address)).to.equal(initialAmount);
            expect(await rToken.balanceOf(user1.address)).to.equal(balanceWithInterest);
            
            // User1 transfers to user2
            // When transferring, both user indices get updated to the current index (1.1 * RAY)
            await rToken.connect(user1).transfer(user2.address, initialAmount);
            
            // After transfer, user1 should have 0 and user2 should have the transferred amount
            // Note: Upon transfer, the interest and index are both updated
            expect(await rToken.rawBalanceOf(user1.address)).to.equal(interest);
            expect(await rToken.balanceOf(user1.address)).to.equal(interest);
            expect(await rToken.rawBalanceOf(user2.address)).to.equal(initialAmount);
            expect(await rToken.balanceOf(user2.address)).to.equal(initialAmount);
            
            // Increase the index again by another 10%
            const newerIndex = newIndex * 11n / 10n; // 1.21 * RAY
            await mockLendingPool.mockGetNormalizedIncome(newerIndex);
            
            // After second index increase, user2's balance should include interest from the new index
            // The interest is calculated based on the difference between the current index (1.21)
            // and the user's stored index (1.1)
            const expectedInterest = initialAmount * newerIndex / newIndex - initialAmount; // 100 * 1.1 - 100 = 10
            const expectedInterestOnInterest = interest * newerIndex / newIndex - interest; // 10 * 1.1 - 10 = 1
            const expectedUser2Balance = initialAmount + expectedInterest;
            expect(await rToken.rawBalanceOf(user2.address)).to.equal(initialAmount);
            expect(await rToken.balanceOf(user2.address)).to.equal(expectedUser2Balance);
            
            // User2 transfers only the raw balance (without interest) back to user1
            // This is because the raw balance is what's actually stored in the ERC20 balances mapping
            await rToken.connect(user2).transfer(user1.address, initialAmount);
            
            // After transfer back, user2 should have 0 raw balance but may have some dust from interest rounding
            // User1 should have the raw balance that was transferred
            expect(await rToken.rawBalanceOf(user2.address)).to.equal(expectedInterest);
            expect(await rToken.balanceOf(user2.address)).to.equal(expectedInterest);
            expect(await rToken.rawBalanceOf(user1.address)).to.equal(initialAmount + interest + expectedInterestOnInterest);
            expect(await rToken.balanceOf(user1.address)).to.equal(initialAmount + interest + expectedInterestOnInterest);
         });
     });

    describe("Total Supply Calculation", function() {
        beforeEach(async function() {
            // Set rToken in mock 
            await mockLendingPool.setRToken(rToken.target);
            // Start with normalized income at RAY (1.0)
            await mockLendingPool.mockGetNormalizedIncome(RAY);
        });

        it("should correctly track raw deposits and calculate total supply", async function() {
            const depositAmount = ethers.parseEther("100");
            const index = RAY;

            // Initial deposit
            await mockLendingPool.mockMint(reservePool.address, user1.address, depositAmount, index);
            
            // Verify total supply equals deposit when index is 1.0
            expect(await rToken.totalSupply()).to.equal(depositAmount);
            expect(await rToken.getRawTotalDeposits()).to.equal(depositAmount);
            
            // Second deposit
            await mockLendingPool.mockMint(reservePool.address, user2.address, depositAmount, index);
            
            // Verify total supply equals sum of deposits
            const expectedTotalSupply = depositAmount + depositAmount; // Using BigInt addition
            expect(await rToken.totalSupply()).to.equal(expectedTotalSupply);
            expect(await rToken.getRawTotalDeposits()).to.equal(expectedTotalSupply);
        });

        it("should correctly calculate total supply after interest accrual", async function() {
            const depositAmount = ethers.parseEther("100");
            const index = RAY;

            // Initial deposit
            await mockLendingPool.mockMint(reservePool.address, user1.address, depositAmount, index);
            
            // Initial check
            expect(await rToken.totalSupply()).to.equal(depositAmount);
            
            // Increase normalized income by 10% (1.1 * RAY)
            const newIndex = RAY * 11n / 10n; 
            await mockLendingPool.mockGetNormalizedIncome(newIndex);
            
            // Verify total supply increased by 10%
            const expectedTotalSupply = depositAmount * 11n / 10n;
            expect(await rToken.totalSupply()).to.equal(expectedTotalSupply);
            // Raw deposits should remain unchanged
            expect(await rToken.getRawTotalDeposits()).to.equal(depositAmount);
        });
    });
});