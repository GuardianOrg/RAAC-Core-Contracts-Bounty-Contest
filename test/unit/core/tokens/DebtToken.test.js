import { expect } from "chai";
import hre from "hardhat";
const { ethers, network } = hre;

describe("DebtToken", function () {
    this.timeout(50000); // Increase timeout to 50 seconds

    let DebtToken;
    let debtToken;
    let owner;
    let user1;
    let user2;
    let addrs;
    let MockLendingPool;
    let mockLendingPool;
    let mockLendingPoolSigner;
    const RAY = ethers.getBigInt("1000000000000000000000000000"); // 1e27

    let asset;

    beforeEach(async function () {
        [owner, user1, user2, ...addrs] = await ethers.getSigners();
        asset = new ethers.AbiCoder().encode(["address", "bytes"], [owner.address, new ethers.AbiCoder().encode(["uint256"], [1])])

        // Deploy mock lending pool first
        const MockLendingPoolFactory = await ethers.getContractFactory("MockLendingPoolDebtToken", owner);
        mockLendingPool = await MockLendingPoolFactory.deploy();
        await mockLendingPool.waitForDeployment();
        const mockLendingPoolAddress = await mockLendingPool.getAddress();

        const MockToken = await ethers.getContractFactory("ERC20Mock");
        const reserveAsset = await MockToken.deploy("Mock Reserve", "MRES", 18);
        await reserveAsset.waitForDeployment();

        // Set up mock lending pool
        await mockLendingPool.setNormalizedDebt(RAY); // Set initial normalized debt to 1

        // Deploy DebtToken
        const DebtTokenFactory = await ethers.getContractFactory("DebtToken", owner);
        debtToken = await DebtTokenFactory.deploy("DebtToken", "DT", owner.address, reserveAsset.target);
        await debtToken.waitForDeployment();
        const debtTokenAddress = await debtToken.getAddress();

        // Set up DebtToken
        await debtToken.setLendingPool(mockLendingPoolAddress);

        // Set up mock lending pool signer with enough ETH
        mockLendingPoolSigner = await ethers.getImpersonatedSigner(mockLendingPoolAddress);
        await owner.sendTransaction({
            to: mockLendingPoolAddress,
            value: ethers.parseEther("10.0") // Increase to 10 ETH
        });

        // Set gas limit for impersonated signer
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
        await network.provider.send("hardhat_setBalance", [
            mockLendingPoolAddress,
            "0x56BC75E2D63100000" // 100 ETH
        ]);
    });

    it('should test the balanceOf function', async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        // We need to notify the mock lending pool that the user has minted debt
        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);

        //Create usage index
        await mockLendingPool.setNormalizedDebt(RAY * 11n / 10n);

        const rawBalance = await debtToken.rawBalanceOf(user1.address);
        const balance = await debtToken.balanceOf(user1.address);
        expect(rawBalance).to.equal(mintAmount)
        expect(balance).to.equal(mintAmount * 11n / 10n)

        const supply = await debtToken.totalSupply();
        
        expect(supply).to.equal(mintAmount * 11n / 10n);

        // const scaledBalance = await debtToken.balanceOf(user1.address);
        // console.log("Scaled balance after mint:", scaledBalance.toString());
        // expect(scaledBalance).to.equal(mintAmount * 11n / 10n);
    })
    
    it("should allow ReservePool to mint debt tokens", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY; // Initial index

        console.log("Attempting to mint", mintAmount.toString(), "tokens with index", index.toString());
        
        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        
        const tx = await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);
        const receipt = await tx.wait();
        console.log("Mint transaction successful, gas used:", receipt.gasUsed.toString());

        const balance = await debtToken.rawBalanceOf(user1.address);
        console.log("User balance after mint:", balance.toString());
        expect(balance).to.equal(mintAmount);
    });

    it("should prevent non-ReservePool from minting", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        await expect(
            debtToken.connect(user1).mint(user1.address, user1.address, mintAmount, index, asset)
        ).to.be.revertedWithCustomError(debtToken, "OnlyLendingPool");
    });

    it("should allow ReservePool to burn debt tokens", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        console.log("Minting tokens before burn test");
        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);
        
        console.log("Attempting to burn tokens");
        await debtToken.connect(mockLendingPoolSigner).burn(user1.address, mintAmount, index, asset);
        await mockLendingPool.notifyBurn(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);

        const balance = await debtToken.rawBalanceOf(user1.address);
        console.log("Balance after burn:", balance.toString());
        expect(balance).to.equal(0n);
    });

    it("should prevent non-ReservePool from burning", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);

        await expect(
            debtToken.connect(user1).burn(user1.address, mintAmount, index, asset)
        ).to.be.revertedWithCustomError(debtToken, "OnlyLendingPool");
    });

    it("should prevent transfers via transfer method", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);

        await expect(
            debtToken.connect(user1).transfer(user2.address, mintAmount)
        ).to.be.revertedWithCustomError(debtToken, "TransfersNotAllowed");
    });

    it("should prevent transfers via transferFrom method", async function () {
        const mintAmount = ethers.parseEther("100");
        const index = RAY;

        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, index, asset);
        await debtToken.connect(user1).approve(user2.address, mintAmount);

        await expect(
            debtToken.connect(user2).transferFrom(user1.address, user2.address, mintAmount)
        ).to.be.revertedWithCustomError(debtToken, "TransfersNotAllowed");
    });

    it("should reflect accrued interest in user balance", async function () {
        const mintAmount = ethers.parseEther("100");
        const initialIndex = RAY;
        const newIndex = RAY * 11n / 10n; // 1.1 RAY = 10% increase

        console.log("Minting tokens for interest test");
        await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), mintAmount);
        await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, mintAmount, initialIndex, asset);
        
        console.log("Setting new normalized debt");
        await mockLendingPool.setNormalizedDebt(newIndex);

        const balance = await debtToken.balanceOf(user1.address);
        const expectedBalance = mintAmount * newIndex / RAY;
        console.log("Balance after interest:", balance.toString());
        console.log("Expected balance:", expectedBalance.toString());
        expect(balance).to.equal(expectedBalance);
    });

    describe("Total Supply Calculation", function() {
        beforeEach(async function() {
            // Start with normalized debt at RAY (1.0)
            await mockLendingPool.setNormalizedDebt(RAY);
        });

        it("should correctly track raw borrows and calculate total supply", async function() {
            const borrowAmount = ethers.parseEther("100");
            const index = RAY;

            // Initial borrow
            await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), borrowAmount);
            await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, borrowAmount, index, asset);
            
            // Verify total supply equals borrow when index is 1.0
            expect(await debtToken.totalSupply()).to.equal(borrowAmount);
            expect(await debtToken.getRawTotalBorrows()).to.equal(borrowAmount);
            
            // Second borrow
            await mockLendingPool.notifyMint(owner.address, user2.address, new ethers.AbiCoder().encode(["uint256"], [1]), borrowAmount);
            await debtToken.connect(mockLendingPoolSigner).mint(user2.address, user2.address, borrowAmount, index, asset);
            
            // Verify total supply equals sum of borrows
            const expectedTotalSupply = borrowAmount + borrowAmount; // Using BigInt addition
            expect(await debtToken.totalSupply()).to.equal(expectedTotalSupply);
            expect(await debtToken.getRawTotalBorrows()).to.equal(expectedTotalSupply);
        });

        it("should correctly calculate total supply after interest accrual", async function() {
            const borrowAmount = ethers.parseEther("100");
            const index = RAY;

            // Initial borrow
            await mockLendingPool.notifyMint(owner.address, user1.address, new ethers.AbiCoder().encode(["uint256"], [1]), borrowAmount);
            await debtToken.connect(mockLendingPoolSigner).mint(user1.address, user1.address, borrowAmount, index, asset);
            
            // Initial check
            expect(await debtToken.totalSupply()).to.equal(borrowAmount);
            
            // Increase normalized debt by 10% (1.1 * RAY)
            const newIndex = RAY * 11n / 10n; // Using BigInt arithmetic
            await mockLendingPool.setNormalizedDebt(newIndex);
            
            // Verify total supply increased by 10%
            const expectedTotalSupply = borrowAmount * 11n / 10n; // Using BigInt arithmetic
            expect(await debtToken.totalSupply()).to.equal(expectedTotalSupply);
            // Raw borrows should remain unchanged
            expect(await debtToken.getRawTotalBorrows()).to.equal(borrowAmount);
        });
    });
});
