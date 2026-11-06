import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("TokenBlender", function () {
    this.timeout(50000);

    let tokenBlender;
    let ionToken;
    let instruxiToken;
    let owner;
    let addrs;

    const ION_RATIO = 5n;
    const ION_MINT_AMOUNT = ethers.parseEther("10000000"); // 10M ION tokens

    async function printMetrics() {
        console.log("Reserve Balance: ", ethers.formatEther(await tokenBlender.getReserveBalance()));
        console.log("Total Supply: ", ethers.formatEther(await tokenBlender.totalSupply()));
        console.log("ION Balance: ", ethers.formatEther(await ionToken.balanceOf(tokenBlender.target)));
        console.log("Instruxi Balance: ", ethers.formatEther(await instruxiToken.balanceOf(tokenBlender.target)));
        console.log("================================================");
    }

    beforeEach(async function () {
        [owner, ...addrs] = await ethers.getSigners();

        const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        ionToken = await ERC20Mock.deploy("ION Token", "ION", 18);
        await ionToken.waitForDeployment();

        instruxiToken = await ERC20Mock.deploy("Instruxi Token", "INST", 18);
        await instruxiToken.waitForDeployment();

        const TokenBlenderFactory = await ethers.getContractFactory("TokenBlender");
        const tokenBlenderImplementation = await TokenBlenderFactory.deploy();
        await tokenBlenderImplementation.waitForDeployment();

        const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
        const initData = TokenBlenderFactory.interface.encodeFunctionData("initialize", [
            "TokenBlender",
            "TB",
            owner.address
        ]);
        const tokenBlenderProxy = await TransparentUpgradeableProxy.deploy(
            await tokenBlenderImplementation.getAddress(),
            owner.address,
            initData
        );
        await tokenBlenderProxy.waitForDeployment();

        tokenBlender = TokenBlenderFactory.attach(await tokenBlenderProxy.getAddress());

        await ionToken.mint(owner.address, ION_MINT_AMOUNT);
        await instruxiToken.mint(owner.address, ION_MINT_AMOUNT);
        await tokenBlender.addSupportedToken(await ionToken.getAddress(), ethers.parseEther(ION_RATIO.toString()));
        await tokenBlender.addSupportedToken(await instruxiToken.getAddress(), ethers.parseEther("1"));
    });

    describe("Setup", function () {
        it("should deploy TokenBlender successfully", async function () {
            expect(await tokenBlender.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await tokenBlender.name()).to.equal("TokenBlender");
            expect(await tokenBlender.symbol()).to.equal("TB");
            
            // Check that owner has all roles
            const DEFAULT_ADMIN_ROLE = await tokenBlender.DEFAULT_ADMIN_ROLE();
            const MANAGER_ROLE = await tokenBlender.MANAGER_ROLE();
            const EMERGENCY_ROLE = await tokenBlender.EMERGENCY_ROLE();
            
            expect(await tokenBlender.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
            expect(await tokenBlender.hasRole(MANAGER_ROLE, owner.address)).to.be.true;
            expect(await tokenBlender.hasRole(EMERGENCY_ROLE, owner.address)).to.be.true;
        });

        it("should mint 10M ION tokens to owner", async function () {
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);
        });

        it("should add ION token with ratio 5", async function () {
            expect(await tokenBlender.getTokenRatio(await ionToken.getAddress())).to.equal(ethers.parseEther(ION_RATIO.toString()));
            const supportedTokens = await tokenBlender.getSupportedTokens();
            expect(supportedTokens.length).to.equal(2);
            expect(supportedTokens[0]).to.equal(await ionToken.getAddress());
        });
    });

    describe("Deposit", function () {
        it("should deposit ION tokens successfully", async function () {
            await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT);
            const amountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT, amountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(amountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO);
        });
        it("should deposit ION tokens successfully in tranches", async function () {
            // deposit in 5 tranches
            const N = 5;
            for (let i = 0; i < N; i++) {
                await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / BigInt(N));
                const amountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT / BigInt(N));
                await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT / BigInt(N), amountOut);
                expect(await tokenBlender.balanceOf(owner.address)).to.equal(BigInt(i+1) * ION_MINT_AMOUNT / BigInt(N) / ION_RATIO);
            }
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO);
        });
    });
    describe("Withdraw", function () {
        beforeEach(async function () {
            await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT);
            const amountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT, amountOut);
        });
        it("should withdraw ION tokens successfully", async function () {
            const maxAmountBurned = await tokenBlender.previewWithdraw(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).withdraw(await ionToken.getAddress(), ION_MINT_AMOUNT, maxAmountBurned);
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(0);
        });
        it("should withdraw ION tokens successfully in tranches", async function () {
            const N = 5;
            for (let i = 0; i < N; i++) {
                const maxAmountBurned = await tokenBlender.previewWithdraw(await ionToken.getAddress(), ION_MINT_AMOUNT / BigInt(N));
                await tokenBlender.connect(owner).withdraw(await ionToken.getAddress(), ION_MINT_AMOUNT / BigInt(N), maxAmountBurned);
                expect(await tokenBlender.balanceOf(owner.address)).to.equal(BigInt(N-i-1) * ION_MINT_AMOUNT / BigInt(N) / ION_RATIO);
            }
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(0);
        });
        it("should mitigate any 1 wei deposit which would prevent token removal after withdraw of dust", async function () {
            // 1. deposit ION token: done in beforeEach
            // 2. withdraw all
            let maxAmountBurned = await tokenBlender.previewWithdraw(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).withdraw(await ionToken.getAddress(), ION_MINT_AMOUNT, maxAmountBurned);
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(0);

            // 3. transfer 1 wei of ION token to the contract
            await ionToken.connect(owner).transfer(tokenBlender.target, 1);
            expect(await ionToken.balanceOf(tokenBlender.target)).to.equal(1);

            // 4. try to remove the token
            await expect(tokenBlender.connect(owner).removeSupportedToken(await ionToken.getAddress())).to.be.revertedWithCustomError(tokenBlender, "TokenHasBalance");

            // 5.0. Tranfer 1 wei more but emergencyWithdraw just 1 wei
            await ionToken.connect(owner).transfer(tokenBlender.target, 1);

            // 5. emergency withdraw with forceRemove
            await tokenBlender.connect(owner).emergencyWithdraw(await ionToken.getAddress(), 1, true);

            // 6. expect no error
            expect(await ionToken.balanceOf(tokenBlender.target)).to.equal(1); // this is the dust that remains in system. Always collectable again.
            expect(await tokenBlender.getSupportedTokenCount()).to.equal(1);
            expect(await tokenBlender.getSupportedTokens()).to.deep.equal([await instruxiToken.getAddress()]);

            // Take the dust out
            await tokenBlender.connect(owner).emergencyWithdraw(await ionToken.getAddress(), 1, false);
        });
    });
    describe("Swap", function () {
        beforeEach(async function () {
            await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT);
            const ionAmountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT, ionAmountOut);

            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO); // 2M Instruxi tokens
            const instruxiAmountOut = await tokenBlender.previewDeposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO);
            await tokenBlender.connect(owner).deposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, instruxiAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
        });
        it("should swap ION tokens for Instruxi tokens successfully", async function () {
            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO);
            const amountOut = await tokenBlender.previewSwap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO);
            await tokenBlender.connect(owner).swap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, amountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
        });
        it("should swap ION tokens for Instruxi tokens successfully in tranches", async function () {
            const N = 5;
            for (let i = 0; i < N; i++) {
                await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO / 5n);
                const amountOut = await tokenBlender.previewSwap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO / BigInt(N));
                await tokenBlender.connect(owner).swap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO / BigInt(N), amountOut);
                // invariant: swap should not alter the total supply
                expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
            }
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
            expect(await tokenBlender.getTokenReserveBalance(await instruxiToken.getAddress())).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
            expect(await tokenBlender.getReserveBalance()).to.equal(await tokenBlender.totalSupply());
            expect(await tokenBlender.getTokenReserveBalance(await ionToken.getAddress())).to.equal(0);
        });
    });
    describe("Instruxi migration", function () {
        it("should migrate ION tokens to Instruxi tokens using deposit()", async function () {
            /**
             * withdraw: supose that there is 10M tokens deposited, 2M TB minted. 
                Then instruxi comes, has minted using more ION token around 2M worth of Instruxi tokens. 
                They deposit them in TB for 2M TB back. 
                Pool has not 10M ION and 2M instruxi with total of 4M TB minted. 
                We withdraw 10M ION tokens by returning the 2M that Instruxi just received. 
                This means: 10M ION are out, with remaining 2M Instruxi and 2M TB minted. 
                Instruxi now takes the 10M, deposit to their value to mint the 2M Instruxi. 
                Then bring that back and now the ION has been converted fully to instruxi and we end with 4M Instruxi and 4M TB. 
             */

            // 10M ION and 2M TB minted. 
            await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT);
            let ionAmountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT, ionAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO); // 2M TB minted. 
            await printMetrics();

            // Instruxi comes, has minted using more ION token around 2M worth of Instruxi tokens. 
            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO);
            let instruxiAmountOut = await tokenBlender.previewDeposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO);
            await tokenBlender.connect(owner).deposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, instruxiAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 4M TB minted so far.
            await printMetrics();
            // We withdraw 10M ION tokens by returning the 2M that Instruxi just received. 
            let maxAmountBurned = await tokenBlender.previewWithdraw(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).withdraw(await ionToken.getAddress(), ION_MINT_AMOUNT, maxAmountBurned);
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO); // 2M TB. 
            expect(await tokenBlender.getReserveBalance()).to.equal(await tokenBlender.totalSupply());
            await printMetrics();
            // Supppose that instruxi takes the ION and mints the Instruxi share token. There is already 8M minted so far.

            // Instruxi deposits the newly 2M Instruxi tokens into the pool.
            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO);
            instruxiAmountOut = await tokenBlender.previewDeposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO);
            await tokenBlender.connect(owner).deposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, instruxiAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 4M TB minted so far.
            await printMetrics();
            // At the end we have 4M Instruxi tokens in the pool and 4M TB minted.
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 2 * 10 / 5 = 4M TB.
            expect(await instruxiToken.balanceOf(tokenBlender.target)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 2 * 10 / 5 = 4M Instruxi tokens.
            expect(await tokenBlender.getReserveBalance()).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
            expect(await ionToken.balanceOf(tokenBlender.target)).to.equal(0);
            expect(await tokenBlender.getReserveBalance()).to.equal(await tokenBlender.totalSupply());
            // We will remove the support for ION token.
            await tokenBlender.connect(owner).removeSupportedToken(await ionToken.getAddress());
            expect(await tokenBlender.getSupportedTokenCount()).to.equal(1);
            expect((await tokenBlender.getSupportedTokens())[0]).to.equal(await instruxiToken.getAddress());
        });
        it("should migrate ION tokens to Instruxi tokens using swap()", async function () {
            /**
             * swap: 10M ION and 2M TB minted. 
             * Instruxi swaps ION for Instruxi entiely: swap(Instruxi, ION, 2M) -> 10M ION out. 
             * We end with 10M ION out and 2M Instruxi and 2M TB. 
             * Instruxi takes the 10M, mints the 2M Instruxi and deposit in the pool ending with 4M Instruxi and 4M TB.
             */

            await printMetrics();

            // 10M ION and 2M TB minted. 
            await ionToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT);
            let ionAmountOut = await tokenBlender.previewDeposit(await ionToken.getAddress(), ION_MINT_AMOUNT);
            await tokenBlender.connect(owner).deposit(await ionToken.getAddress(), ION_MINT_AMOUNT, ionAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO); // 2M TB minted. 
            await printMetrics();
            // Instruxi swaps ION for Instruxi entiely: swap(Instruxi, ION, 2M) -> 10M ION out. 
            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO);
            const amountOut = await tokenBlender.previewSwap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO); // 2M Instruxi tokens swapped for 10M ION.
            await tokenBlender.connect(owner).swap(await instruxiToken.getAddress(), await ionToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, amountOut);
            await printMetrics();
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT / ION_RATIO); // There is still 2M TB minted.
            expect(await ionToken.balanceOf(owner.address)).to.equal(ION_MINT_AMOUNT);            
            expect(await tokenBlender.getReserveBalance()).to.equal(await tokenBlender.totalSupply());
            // Instruxi takes the 10M ION token, mints 2M of Instruxi tokens and deposit them into the pool. 
            // Suppose that the conversion already happened.
            await instruxiToken.connect(owner).approve(tokenBlender.target, ION_MINT_AMOUNT / ION_RATIO);
            let instruxiAmountOut = await tokenBlender.previewDeposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO);
            await tokenBlender.connect(owner).deposit(await instruxiToken.getAddress(), ION_MINT_AMOUNT / ION_RATIO, instruxiAmountOut);
            expect(await tokenBlender.balanceOf(owner.address)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 4M TB minted so far.
            expect(await instruxiToken.balanceOf(tokenBlender.target)).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO); // 2 * 10 / 5 = 4M Instruxi tokens.
            expect(await ionToken.balanceOf(tokenBlender.target)).to.equal(0);
            expect(await tokenBlender.getReserveBalance()).to.equal(2n * ION_MINT_AMOUNT / ION_RATIO);
            expect(await tokenBlender.getReserveBalance()).to.equal(await tokenBlender.totalSupply());
            await printMetrics();

            // We will remove the support for ION token.
            await tokenBlender.connect(owner).removeSupportedToken(await ionToken.getAddress());
            expect(await tokenBlender.getSupportedTokenCount()).to.equal(1);
            expect((await tokenBlender.getSupportedTokens())[0]).to.equal(await instruxiToken.getAddress());
        });
    })
});

