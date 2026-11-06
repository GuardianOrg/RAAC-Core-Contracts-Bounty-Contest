/* eslint-disable node/no-missing-import */
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("LiquidEscrowedRAAC.spec", async () => {
    let leRAAC;
    let deployer;
    let minter;
    let user;
    let other;

    beforeEach(async () => {
        [deployer, minter, user, other] = await ethers.getSigners();

        // Deploy the LiquidEscrowedRAAC contract
        const LeRAAC = await ethers.getContractFactory("LiquidEscrowedRAAC", deployer);
        leRAAC = await LeRAAC.deploy();
    });

    describe("Deployment", async () => {
        it("should have correct name and symbol", async () => {
            // Verify the token name and symbol
            expect(await leRAAC.name()).to.equal("Liquid Escrowed RAAC");
            expect(await leRAAC.symbol()).to.equal("leRAAC");
        });

        it("should set the correct owner", async () => {
            // Verify the deployer is the initial owner
            expect(await leRAAC.owner()).to.equal(deployer.address);
        });
    });

    describe("Admin Functions", async () => {
        it("should allow owner to update minters", async () => {
            // Owner adds a minter
            await expect(leRAAC.updateMinters([minter.address], [true]))
                .to.emit(leRAAC, "UpdateMinter")
                .withArgs(minter.address, true);

            // Verify minter status
            expect(await leRAAC.isMinter(minter.address)).to.be.true;

            // Owner removes a minter
            await expect(leRAAC.updateMinters([minter.address], [false]))
                .to.emit(leRAAC, "UpdateMinter")
                .withArgs(minter.address, false);

            // Verify minter status
            expect(await leRAAC.isMinter(minter.address)).to.be.false;
        });

        it("should revert when non-owner tries to update minters", async () => {
            // Non-owner tries to add a minter
            await expect(leRAAC.connect(user).updateMinters([minter.address], [true]))
                .to.be.revertedWithCustomError(leRAAC, "OwnableUnauthorizedAccount")
                .withArgs(user.address);
        });

        it("should revert when setting zero address as minter", async () => {
            // Try to add zero address as minter
            await expect(leRAAC.updateMinters([ethers.ZeroAddress], [true]))
                .to.be.revertedWithCustomError(leRAAC, "ZeroMinterAddress");
        });

        it("should allow owner to update ceiling", async () => {
            // First must be a minter
            await leRAAC.updateMinters([minter.address], [true]);

            const ceiling = ethers.parseEther("1000");
            // Owner updates ceiling for the minter
            await expect(leRAAC.updateCeiling(minter.address, ceiling))
                .to.emit(leRAAC, "UpdateCeiling")
                .withArgs(minter.address, ceiling);

            // Verify ceiling
            const info = await leRAAC.minterInfo(minter.address);
            expect(info.ceiling).to.equal(ceiling);
        });

        it("should revert when updating ceiling for non-minter", async () => {
            const ceiling = ethers.parseEther("1000");
            await expect(leRAAC.updateCeiling(user.address, ceiling))
                .to.be.revertedWithCustomError(leRAAC, "NotMinter");
        });

        it("should revert when non-owner tries to update ceiling", async () => {
            await leRAAC.updateMinters([minter.address], [true]);
            const ceiling = ethers.parseEther("1000");

            await expect(leRAAC.connect(user).updateCeiling(minter.address, ceiling))
                .to.be.revertedWithCustomError(leRAAC, "OwnableUnauthorizedAccount")
                .withArgs(user.address);
        });
    });

    describe("Minting", async () => {
        const ceiling = ethers.parseEther("1000");

        beforeEach(async () => {
            // Setup: Add minter and set ceiling
            await leRAAC.updateMinters([minter.address], [true]);
            await leRAAC.updateCeiling(minter.address, ceiling);
        });

        it("should allow minter to mint within ceiling", async () => {
            const amount = ethers.parseEther("100");
            // Minter mints tokens to user
            await leRAAC.connect(minter).mint(user.address, amount);

            // Verify balance and minted amount
            expect(await leRAAC.balanceOf(user.address)).to.equal(amount);

            const info = await leRAAC.minterInfo(minter.address);
            expect(info.minted).to.equal(amount);
        });

        it("should revert when minting exceeds ceiling", async () => {
            const amount = ceiling + 1n;
            // Try to mint more than the ceiling
            await expect(leRAAC.connect(minter).mint(user.address, amount))
                .to.be.revertedWithCustomError(leRAAC, "MintCeilingExceeded")
                .withArgs(0, amount, ceiling);
        });

        it("should revert when non-minter tries to mint", async () => {
            const amount = ethers.parseEther("100");
            // Non-minter tries to mint
            await expect(leRAAC.connect(user).mint(user.address, amount))
                .to.be.revertedWithCustomError(leRAAC, "OnlyMinter");
        });

        it("should track minted amount correctly across multiple mints", async () => {
            const amount1 = ethers.parseEther("100");
            const amount2 = ethers.parseEther("200");

            // Mint twice
            await leRAAC.connect(minter).mint(user.address, amount1);
            await leRAAC.connect(minter).mint(user.address, amount2);

            // Verify total minted amount
            const info = await leRAAC.minterInfo(minter.address);
            expect(info.minted).to.equal(amount1 + amount2);
        });
    });

    describe("Burning", async () => {
        const amount = ethers.parseEther("100");

        beforeEach(async () => {
            // Setup: Mint tokens to user
            await leRAAC.updateMinters([minter.address], [true]);
            await leRAAC.updateCeiling(minter.address, amount * 10n);
            await leRAAC.connect(minter).mint(user.address, amount);
        });

        it("should allow user to burn their own tokens", async () => {
            // User burns their own tokens
            await leRAAC.connect(user).burn(amount);
            expect(await leRAAC.balanceOf(user.address)).to.equal(0);
        });

        it("should allow spender to burn from user with allowance", async () => {
            // User approves spender
            await leRAAC.connect(user).approve(other.address, amount);
            // Spender burns from user
            await leRAAC.connect(other).burnFrom(user.address, amount);
            expect(await leRAAC.balanceOf(user.address)).to.equal(0);
        });

        it("should revert burnFrom if allowance is insufficient", async () => {
            // User approves less than burn amount
            await leRAAC.connect(user).approve(other.address, amount - 1n);
            // Spender tries to burn more than allowance
            await expect(leRAAC.connect(other).burnFrom(user.address, amount))
                .to.be.revertedWithCustomError(leRAAC, "BurnAmountExceedsAllowance")
                .withArgs(amount - 1n, amount);
        });
    });
});
