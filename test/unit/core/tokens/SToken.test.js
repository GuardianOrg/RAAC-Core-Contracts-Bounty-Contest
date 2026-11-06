import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("SToken", function () {
    this.timeout(50000);

    let sToken;

    let ionToken;
    let acmeGoldToken;
    let crvUSDToken;
    
    let deployer;

    let ionOwner;
    let acmeGoldOwner;
    let crvUSDOwner;

    let alice;
    let bob;
    let charlie;

    let treasuryAddress;

    let addrs;
    let rGold;

    before(async function () {
        [deployer, ionOwner, acmeGoldOwner, crvUSDOwner, alice, bob, charlie, treasuryAddress, ...addrs] = await ethers.getSigners();

        const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        ionToken = await ERC20Mock.deploy("ION Token", "ION", 18);
        await ionToken.waitForDeployment();

        acmeGoldToken = await ERC20Mock.deploy("Acme Gold Token", "AGOLD", 18);
        await acmeGoldToken.waitForDeployment();

        crvUSDToken = await ERC20Mock.deploy("CRVUSD Token", "CRVUSD", 18);
        await crvUSDToken.waitForDeployment();

        const STokenFactory = await ethers.getContractFactory("SToken");
        const sTokenImplementation = await STokenFactory.deploy();
        await sTokenImplementation.waitForDeployment();

        const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
        const initData = STokenFactory.interface.encodeFunctionData("initialize", [
            "RAAC Gold",
            "rGOLD",
            deployer.address,
        ]);
        const rGoldProxy = await TransparentUpgradeableProxy.deploy(
            await sTokenImplementation.getAddress(),
            deployer.address,
            initData
        );
        // RGold is one of the many possible STokens
        await rGoldProxy.waitForDeployment();
        rGold = STokenFactory.attach(await rGoldProxy.getAddress());

        // Grant MANAGER_ROLE to users who deposit/withdraw/transferWithdrawRights
        const MANAGER_ROLE = await rGold.MANAGER_ROLE();
        await rGold.grantRole(MANAGER_ROLE, ionOwner.address);
        await rGold.grantRole(MANAGER_ROLE, acmeGoldOwner.address);
        await rGold.grantRole(MANAGER_ROLE, alice.address);
        await rGold.grantRole(MANAGER_ROLE, bob.address);

        await ionToken.mint(ionOwner.address, 59549039800000000000000n); // 59.5490398 ION tokens (supply as of 2026-01-27)
        await acmeGoldToken.mint(acmeGoldOwner.address, ethers.parseEther("1000")); // 1000 AGOLD tokens (imaginary)

        await crvUSDToken.mint(crvUSDOwner.address, ethers.parseEther("10000000")); // 10M CRVUSD tokens

        // Some checks
        expect(await ionToken.balanceOf(ionOwner.address)).to.equal(59549039800000000000000n);
        expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));
    });

    describe("Setup", function () {
        it("should deploy RGold successfully", async function () {
            expect(await rGold.getAddress()).to.not.equal(ethers.ZeroAddress);
            expect(await rGold.name()).to.equal("RAAC Gold");
            expect(await rGold.symbol()).to.equal("rGOLD");
            
            // Check that owner has all roles
            const DEFAULT_ADMIN_ROLE = await rGold.DEFAULT_ADMIN_ROLE();
            const MANAGER_ROLE = await rGold.MANAGER_ROLE();
            const EMERGENCY_ROLE = await rGold.EMERGENCY_ROLE();
            
            expect(await rGold.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.be.true;
            expect(await rGold.hasRole(MANAGER_ROLE, deployer.address)).to.be.true;
            expect(await rGold.hasRole(EMERGENCY_ROLE, deployer.address)).to.be.true;
        });

        it("should add ION token", async function () {
            await rGold.addSupportedToken(await ionToken.getAddress());
            const supportedTokens = await rGold.getSupportedTokens();
            expect(supportedTokens.length).to.equal(1);
            expect(supportedTokens[0]).to.equal(await ionToken.getAddress());
        });
    });

    describe("Deposit", function () {
        it("should deposit ION tokens successfully", async function () {
            await ionToken.connect(ionOwner).approve(rGold.target, 9549039800000000000000n);
            const {grossAmount, netAmount, feeAmount} = await rGold.previewDeposit(await ionToken.getAddress(), 9549039800000000000000n);
            await rGold.connect(ionOwner).deposit(await ionToken.getAddress(), 9549039800000000000000n, netAmount);
           
            expect(grossAmount).to.equal(9549039800000000000000n);
            expect(netAmount).to.equal(9549039800000000000000n);
            expect(feeAmount).to.equal(0);
            expect(await rGold.balanceOf(ionOwner.address)).to.equal(9549039800000000000000n);
            expect(await ionToken.balanceOf(rGold.target)).to.equal(9549039800000000000000n);
            // The part that has not yet been deposited
            expect(await ionToken.balanceOf(ionOwner.address)).to.equal(50000000000000000000000n);
        });
        // TODO: We need to also test the case where added, deposit, and then removed.
        // Overall, we need to do the whole lifecycle of this case
        it('should NOT allow to deposit ACME Gold tokens before being added', async function () {
            await acmeGoldToken.connect(acmeGoldOwner).approve(rGold.target, ethers.parseEther("1000"));
            // Not added, so should revert with TokenNotSupported
            await expect(
                rGold.connect(acmeGoldOwner).deposit(await acmeGoldToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"))
            ).to.be.revertedWithCustomError(rGold, "TokenNotSupported");

            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(0);
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(0);
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));
        });
        it("should add ACME Gold token", async function () {
            await rGold.addSupportedToken(await acmeGoldToken.getAddress());
            const supportedTokens = await rGold.getSupportedTokens();
            expect(supportedTokens.length).to.equal(2);
            expect(supportedTokens[1]).to.equal(await acmeGoldToken.getAddress());
        });
        it("should deposit ACME Gold tokens successfully", async function () {
            await acmeGoldToken.connect(acmeGoldOwner).approve(rGold.target, ethers.parseEther("1000"));
            const {grossAmount, netAmount, feeAmount} = await rGold.previewDeposit(await acmeGoldToken.getAddress(), ethers.parseEther("1000"));
            await rGold.connect(acmeGoldOwner).deposit(await acmeGoldToken.getAddress(), ethers.parseEther("1000"), netAmount);
            expect(grossAmount).to.equal(ethers.parseEther("1000"));
            expect(netAmount).to.equal(ethers.parseEther("1000"));
            expect(feeAmount).to.equal(0);
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("1000"));
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(0);
        });
        it('should NOT allow to deposit CRVUSD tokens (not supported)', async function () {
            await crvUSDToken.connect(crvUSDOwner).approve(rGold.target, ethers.parseEther("10000000"));
            // Not added, so should revert with TokenNotSupported
            await expect(
                rGold.previewDeposit(await crvUSDToken.getAddress(), ethers.parseEther("10000000"))
            ).to.be.revertedWithCustomError(rGold, "TokenNotSupported");

            expect(await rGold.balanceOf(crvUSDOwner.address)).to.equal(0);
            expect(await crvUSDToken.balanceOf(rGold.target)).to.equal(0);
            expect(await crvUSDToken.balanceOf(crvUSDOwner.address)).to.equal(ethers.parseEther("10000000"));
        });

        it('should NOT allow non-MANAGER_ROLE user to deposit', async function () {
            await crvUSDToken.connect(crvUSDOwner).approve(rGold.target, ethers.parseEther("100"));
            // crvUSDOwner does not have MANAGER_ROLE
            await expect(
                rGold.connect(crvUSDOwner).deposit(await ionToken.getAddress(), ethers.parseEther("100"), 0)
            ).to.be.revertedWithCustomError(rGold, "AccessControlUnauthorizedAccount");
        });
        it("should deposit ION tokens successfully in tranches", async function () {
            const alreadyDeposited = 9549039800000000000000n; // previously
            const totalToDeposit = 50000000000000000000000n; // the remaining amount owned by the owner
            const numberOfTranches = 5n;
            const depositAmountPerTranche = totalToDeposit / numberOfTranches;

            // Deposit in tranches
            for (let i = 0n; i < numberOfTranches; i++) {
                await ionToken.connect(ionOwner).approve(rGold.target, depositAmountPerTranche);
                const {grossAmount, netAmount, feeAmount} = await rGold.previewDeposit(await ionToken.getAddress(), depositAmountPerTranche);

                expect(feeAmount).to.equal(0n);
                expect(netAmount).to.equal(depositAmountPerTranche);
                expect(grossAmount).to.equal(depositAmountPerTranche);

                await rGold.connect(ionOwner).deposit(await ionToken.getAddress(), depositAmountPerTranche, netAmount);

                const expectedRGoldBalance = alreadyDeposited + (depositAmountPerTranche * (i + 1n));
                expect(await rGold.balanceOf(ionOwner.address)).to.equal(expectedRGoldBalance);

                const expectedIonBalanceDeposited = alreadyDeposited + (depositAmountPerTranche * (i + 1n));
                expect(await ionToken.balanceOf(rGold.target)).to.equal(expectedIonBalanceDeposited);

                const expectedIonBalanceRemaining = totalToDeposit - (depositAmountPerTranche * (i + 1n));
                expect(await ionToken.balanceOf(ionOwner.address)).to.equal(expectedIonBalanceRemaining);
            }

            expect(await rGold.balanceOf(ionOwner.address)).to.equal(alreadyDeposited + totalToDeposit);
            expect(await ionToken.balanceOf(rGold.target)).to.equal(alreadyDeposited + totalToDeposit);
            expect(await ionToken.balanceOf(ionOwner.address)).to.equal(0);
        });
        it("should track user token deposits correctly", async function () {
            const ionDepositAmount = 9549039800000000000000n + 50000000000000000000000n;
            const acmeDepositAmount = ethers.parseEther("1000");
            
            expect(await rGold.getUserTokenDeposit(ionOwner.address, await ionToken.getAddress())).to.equal(ionDepositAmount);
            expect(await rGold.getUserTokenDeposit(ionOwner.address, await acmeGoldToken.getAddress())).to.equal(0);

            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(acmeDepositAmount);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await ionToken.getAddress())).to.equal(0);
        });
    });

    const totalIonDeposit = 9549039800000000000000n + 50000000000000000000000n;
    describe('Transfer', function () {
        it('should allow ACME user to transfer some RGOLD to Alice', async function () {
            // We will later use alice's rGold to try to withdraw
            const balanceAliceBefore = await rGold.balanceOf(await alice.getAddress());
            const balanceAcmeGoldOwnerBefore = await rGold.balanceOf(await acmeGoldOwner.getAddress());
            await rGold.connect(acmeGoldOwner).transfer(await alice.getAddress(), ethers.parseEther("1"));
            const balanceAliceAfter = await rGold.balanceOf(await alice.getAddress());
            const balanceAcmeGoldOwnerAfter = await rGold.balanceOf(await acmeGoldOwner.getAddress());
            expect(balanceAliceAfter).to.equal(balanceAliceBefore + ethers.parseEther("1"));
            expect(balanceAcmeGoldOwnerAfter).to.equal(balanceAcmeGoldOwnerBefore - ethers.parseEther("1"));
            expect(await rGold.getUserTokenDeposit(alice.address, await acmeGoldToken.getAddress())).to.equal(0n);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(balanceAcmeGoldOwnerBefore);
        });
    });

    describe("Withdraw", function () {
        it("should allow user to withdraw their own deposited tokens", async function () {
            // ION user has deposited some token, that he should be able to withdraw
            const withdrawAmount = 50000000000000000000000n;
            const maxAmountBurned = await rGold.previewWithdraw(await ionToken.getAddress(), withdrawAmount);
            
            const initialSupply = await rGold.totalSupply();
            await rGold.connect(ionOwner).withdraw(await ionToken.getAddress(), withdrawAmount, maxAmountBurned);
            
            expect(await ionToken.balanceOf(ionOwner.address)).to.equal(withdrawAmount);
            expect(await rGold.getUserTokenDeposit(ionOwner.address, await ionToken.getAddress())).to.equal(totalIonDeposit - withdrawAmount);
            // Supply should be decreased by the amount withdrawn
            const postWithdrawSupply = await rGold.totalSupply();
            expect(await rGold.totalSupply()).to.equal(initialSupply - withdrawAmount);
        });

        it("should NOT allow user to withdraw tokens they did not deposit", async function () {
            // Alice has some RGold (via transfer), but she did not deposit any tokens
            expect(await rGold.getUserTokenDeposit(alice.address, await acmeGoldToken.getAddress())).to.equal(0n);
            expect(await rGold.balanceOf(alice.address)).to.equal(ethers.parseEther("1"));

            // Alice tries to withdraw ACME Gold — has MANAGER_ROLE but no deposit rights
            await expect(
                rGold.connect(alice).withdraw(await acmeGoldToken.getAddress(), ethers.parseEther("1"), ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(rGold, "InsufficientDeposit");
        });

        it("should NOT allow user to withdraw more than they have", async function () {
            // ACME has 999 rGOLD (has sent 1 to Alice), but can withdraw 1000 rGOLD - this requires having 1000 rGOLD in hand to do so
            const acmeDepositAmount = await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress());
            expect(acmeDepositAmount).to.equal(ethers.parseEther("1000"));
            const acmeBalance = await rGold.balanceOf(acmeGoldOwner.address);
            expect(acmeBalance).to.equal(ethers.parseEther("999"));
            // ACME tries to withdraw 1000 rGOLD
            await expect(
                rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"))
            ).to.be.revertedWithCustomError(rGold, "ERC20InsufficientBalance");
        });

        it("should NOT allow user to withdraw more than they deposited", async function () {
            const acmeDepositAmount = await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress());
            expect(acmeDepositAmount).to.equal(ethers.parseEther("1000"));
            // Despite having only 999 rGOLD, ACME still has a right to withdraw 1000 rGOLD
            // For this test, let's have ion owner to send him 2 rGOLD (999 + 2 = 1001) and try to withdraw 1001, this should then fail (only 1000 has been deposited)

            await rGold.connect(ionOwner).transfer(acmeGoldOwner.address, ethers.parseEther("2"));

            const acmeBalanceAfter = await rGold.balanceOf(acmeGoldOwner.address);
            expect(acmeBalanceAfter).to.equal(ethers.parseEther("1001"));
            const maxAmountBurned = await rGold.previewWithdraw(await ionToken.getAddress(), ethers.parseEther("1001"));
            await expect(
                rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), ethers.parseEther("1001"), maxAmountBurned)
            ).to.be.revertedWithCustomError(rGold, "InsufficientDeposit");

            // Nothing then changed
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1001"));
        });

        it("should allow user to withdraw all their deposited tokens", async function () {
            const acmeDepositAmount = await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress());
            expect(acmeDepositAmount).to.equal(ethers.parseEther("1000"));
            const acmeBalance = await rGold.balanceOf(acmeGoldOwner.address);
            expect(acmeBalance).to.equal(ethers.parseEther("1001"));
            const withdrawAmount = acmeDepositAmount;
            const maxAmountBurned = await rGold.previewWithdraw(await acmeGoldToken.getAddress(), withdrawAmount);
            
            const initialSupply = await rGold.totalSupply();
            await rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), withdrawAmount, maxAmountBurned);
            
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(withdrawAmount);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(0);

            // Supply decreased
            expect(await rGold.totalSupply()).to.equal(initialSupply - withdrawAmount);

            // ACME balance decreased
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1"));
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(0);
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));

            // The last 1 rgold cannot be withdrawn
            await expect(
                rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), ethers.parseEther("1"), ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(rGold, "InsufficientDeposit");
        });
    });

    describe("Transfer Withdraw Rights", function () {
        it("should allow user to transfer withdraw rights to another address and withdraw them", async function () {
            // Ion will transfer 1 withdraw right to acme
            const ionWithdrawRight = ethers.parseEther("1");

            const initialIonWithdrawRight = await rGold.getUserTokenDeposit(await ionOwner.getAddress(), await ionToken.getAddress());
            const initialAcmeWithdrawRight = await rGold.getUserTokenDeposit(await acmeGoldOwner.getAddress(), await ionToken.getAddress());

            expect(initialIonWithdrawRight).to.equal(9549039800000000000000n);
            expect(initialAcmeWithdrawRight).to.equal(0n);

            await rGold.connect(ionOwner).transferWithdrawRights(await ionToken.getAddress(), await acmeGoldOwner.getAddress(), ionWithdrawRight);

            expect(await rGold.getUserTokenDeposit(await ionOwner.getAddress(), await ionToken.getAddress())).to.equal(initialIonWithdrawRight - ionWithdrawRight);
            expect(await rGold.getUserTokenDeposit(await acmeGoldOwner.getAddress(), await ionToken.getAddress())).to.equal(initialAcmeWithdrawRight + ionWithdrawRight);
        
            const priorBalance = await ionToken.balanceOf(acmeGoldOwner.address);
            expect(priorBalance).to.equal(0);

            // We now withdraw the 1 rGOLD from acme
            const withdrawAmount = ethers.parseEther("1");
            const maxAmountBurned = await rGold.previewWithdraw(await ionToken.getAddress(), withdrawAmount);
            const initialSupply = await rGold.totalSupply();
            await rGold.connect(acmeGoldOwner).withdraw(await ionToken.getAddress(), withdrawAmount, maxAmountBurned);

            expect(await ionToken.balanceOf(acmeGoldOwner.address)).to.equal(withdrawAmount + priorBalance);
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(0n);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await ionToken.getAddress())).to.equal(0n);

            // Supply decreased
            expect(await rGold.totalSupply()).to.equal(initialSupply - withdrawAmount);

            // No more right to withdraw
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await ionToken.getAddress())).to.equal(0n);
        });

        it("should allow new owner to withdraw transferred deposits", async function () {
            // Bob receive 1 RGold + 1 withdraw right from ionOwner
            await rGold.connect(ionOwner).transferWithdrawRights(await ionToken.getAddress(), await bob.getAddress(), ethers.parseEther("1"));

            expect(await rGold.getUserTokenDeposit(await bob.getAddress(), await ionToken.getAddress())).to.equal(ethers.parseEther("1"));
            // expect(await rGold.getUserTokenDeposit(await ionOwner.getAddress(), await ionToken.getAddress())).to.equal(initialIonWithdrawRight - ionWithdrawRight);

            // Send the rGold too
            await rGold.connect(ionOwner).transfer(await bob.getAddress(), ethers.parseEther("1"));

            expect(await rGold.balanceOf(bob.address)).to.equal(ethers.parseEther("1"));

            // Bob can then withdraw the 1 rGOLD for ION
            const maxAmountBurned = await rGold.previewWithdraw(await ionToken.getAddress(), ethers.parseEther("1"));
            await rGold.connect(bob).withdraw(await ionToken.getAddress(), ethers.parseEther("1"), maxAmountBurned);

            expect(await ionToken.balanceOf(bob.address)).to.equal(ethers.parseEther("1"));
            expect(await rGold.getUserTokenDeposit(await bob.getAddress(), await ionToken.getAddress())).to.equal(0n);
            expect(await rGold.balanceOf(bob.address)).to.equal(0n);
        });

        it("should NOT allow user to transfer more deposits than they have", async function () {
            const ionWithdrawRight = await rGold.getUserTokenDeposit(await ionOwner.getAddress(), await ionToken.getAddress());

            await expect(
                rGold.connect(ionOwner).transferWithdrawRights(await ionToken.getAddress(), await alice.getAddress(), ionWithdrawRight + ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(rGold, "InsufficientDeposit");
        });

        it("should NOT allow transfer to zero address", async function () {
            await expect(
                rGold.connect(ionOwner).transferWithdrawRights(await ionToken.getAddress(), ethers.ZeroAddress, ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(rGold, "InvalidAddress");
        });

        it("should NOT allow transfer of zero amount", async function () {
            await expect(
                rGold.connect(ionOwner).transferWithdrawRights(await ionToken.getAddress(), await alice.getAddress(), 0)
            ).to.be.revertedWithCustomError(rGold, "ZeroAmount");
        });

        // TODO: some events test would be awesome here
    });


    describe("Deposit Fee", function () {
        it("should have default fee of 0", async function () {
            expect(await rGold.depositFeeBps()).to.equal(0);
        });

        it("should allow admin to set deposit fee", async function () {
            await rGold.connect(deployer).setDepositFee(100); // 1%
            expect(await rGold.depositFeeBps()).to.equal(100);
        });

        it("should NOT allow non-admin to set deposit fee", async function () {
            await expect(
                rGold.connect(alice).setDepositFee(101)
            ).to.be.revertedWithCustomError(rGold, "AccessControlUnauthorizedAccount");
        });

        it("should NOT allow fee above MAX_FEE_BPS", async function () {
            await expect(
                rGold.connect(deployer).setDepositFee(2001) // > 20%
            ).to.be.revertedWithCustomError(rGold, "InvalidFee");
        });

        it("should NOT allow non-admin to set treasury", async function () {
            await expect(
                rGold.connect(alice).setTreasury(treasuryAddress)
            ).to.be.revertedWithCustomError(rGold, "AccessControlUnauthorizedAccount");
        });

        it("should NOT allow setting treasury to zero address", async function () {
            await expect(
                rGold.connect(deployer).setTreasury(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(rGold, "InvalidAddress");
        });
        it("should NOT collect fee when treasury is not set", async function () {
            await rGold.connect(deployer).setDepositFee(100); // 1% fee
            
            await acmeGoldToken.connect(acmeGoldOwner).approve(rGold.target, ethers.parseEther("100"));
            const { grossAmount, netAmount, feeAmount } = await rGold.previewDeposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"));
            expect(grossAmount).to.equal(ethers.parseEther("100"));
            expect(netAmount).to.equal(ethers.parseEther("100"));
            expect(feeAmount).to.equal(0);
            await rGold.connect(acmeGoldOwner).deposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"), netAmount);
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(netAmount);
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("100"));
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("900"));
            // With no treasury set, netAmount == grossAmount, so userTokenDeposits == 100
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(ethers.parseEther("100"));
            expect(await rGold.balanceOf(treasuryAddress)).to.equal(0);

            // Let's withdraw all the tokens in preparation for the next test
            // Note: withdraw uses amountOut against userTokenDeposits, so withdraw the tracked net amount
            const depositRights = await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress());
            const maxAmountBurned = await rGold.previewWithdraw(await acmeGoldToken.getAddress(), depositRights);
            await rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), depositRights, maxAmountBurned);
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(0);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(0);
            expect(await rGold.balanceOf(treasuryAddress)).to.equal(0);
        });
        it("should allow admin to set treasury address", async function () {
            await rGold.connect(deployer).setTreasury(treasuryAddress);
            expect(await rGold.treasury()).to.equal(treasuryAddress);
        });

        it("should NOT collect fee when fee is 0", async function () {
            await rGold.connect(deployer).setDepositFee(100); // 1% fee
           
            // Set back at 0
            await rGold.connect(deployer).setDepositFee(0);

            await acmeGoldToken.connect(acmeGoldOwner).approve(rGold.target, ethers.parseEther("100"));
            const { grossAmount, netAmount, feeAmount } = await rGold.previewDeposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"));
            expect(grossAmount).to.equal(ethers.parseEther("100"));
            expect(netAmount).to.equal(ethers.parseEther("100"));
            expect(feeAmount).to.equal(0);
            await rGold.connect(acmeGoldOwner).deposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"), netAmount);
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(netAmount);
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("100"));
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("900"));
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(ethers.parseEther("100"));
            expect(await rGold.balanceOf(treasuryAddress)).to.equal(0);

            // Let's withdraw all the tokens in preparation for the next test
            const depositRights2 = await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress());
            const maxAmountBurned = await rGold.previewWithdraw(await acmeGoldToken.getAddress(), depositRights2);
            await rGold.connect(acmeGoldOwner).withdraw(await acmeGoldToken.getAddress(), depositRights2, maxAmountBurned);
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("1000"));
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(0);
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(0);
            expect(await rGold.balanceOf(treasuryAddress)).to.equal(0);
        });

        it("should collect fee on deposit when fee is set", async function () {
            await rGold.connect(deployer).setTreasury(treasuryAddress);
            await rGold.connect(deployer).setDepositFee(100); // 1% fee

            // ACME has withdrawn all token so we can deposit again and fee will occur
            await acmeGoldToken.connect(acmeGoldOwner).approve(rGold.target, ethers.parseEther("100"));
            const { grossAmount, netAmount, feeAmount } = await rGold.previewDeposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"));
            expect(grossAmount).to.equal(ethers.parseEther("100"));
            expect(netAmount).to.equal(ethers.parseEther("99"));
            expect(feeAmount).to.equal(ethers.parseEther("1"));
            await rGold.connect(acmeGoldOwner).deposit(await acmeGoldToken.getAddress(), ethers.parseEther("100"), netAmount);
            expect(await rGold.balanceOf(acmeGoldOwner.address)).to.equal(netAmount);
            expect(await acmeGoldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("100"));
            expect(await acmeGoldToken.balanceOf(acmeGoldOwner.address)).to.equal(ethers.parseEther("900")); // 1000 - 100
            expect(await rGold.getUserTokenDeposit(acmeGoldOwner.address, await acmeGoldToken.getAddress())).to.equal(netAmount);
            expect(await rGold.getUserTokenDeposit(treasuryAddress.address, await acmeGoldToken.getAddress())).to.equal(feeAmount);
            expect(await rGold.balanceOf(treasuryAddress)).to.equal(feeAmount);
        });
    });
});
describe("Various STokens", function () {
    let deployer, user1, user2;


    let rGold, rSilver;
    
    let goldToken, silverToken;
    
    let sTokenImplementation;
    let TransparentUpgradeableProxy;
    let ERC20Mock;

    before(async function () {
        [deployer, user1, user2] = await ethers.getSigners();

        const STokenFactory = await ethers.getContractFactory("SToken");
        sTokenImplementation = await STokenFactory.deploy();
        await sTokenImplementation.waitForDeployment();

        TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");

        ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        goldToken = await ERC20Mock.deploy("Gold Token", "GOLD", 18);
        await goldToken.waitForDeployment();

        silverToken = await ERC20Mock.deploy("Silver Token", "SILVER", 18);
        await silverToken.waitForDeployment();

        await goldToken.mint(user1.address, ethers.parseEther("1000"));
        await silverToken.mint(user2.address, ethers.parseEther("5000"));

        const goldInitData = STokenFactory.interface.encodeFunctionData("initialize", [
            "RAAC Gold",
            "rGOLD",
            deployer.address,
        ]);
        const rGoldProxy = await TransparentUpgradeableProxy.deploy(
            await sTokenImplementation.getAddress(),
            deployer.address,
            goldInitData
        );
        await rGoldProxy.waitForDeployment();
        rGold = STokenFactory.attach(await rGoldProxy.getAddress());

        const silverInitData = STokenFactory.interface.encodeFunctionData("initialize", [
            "RAAC Silver",
            "rSILVER",
            deployer.address,
        ]);
        const rSilverProxy = await TransparentUpgradeableProxy.deploy(
            await sTokenImplementation.getAddress(),
            deployer.address,
            silverInitData
        );
        await rSilverProxy.waitForDeployment();
        rSilver = STokenFactory.attach(await rSilverProxy.getAddress());

        await rGold.connect(deployer).addSupportedToken(await goldToken.getAddress());
        await rSilver.connect(deployer).addSupportedToken(await silverToken.getAddress());

        // Grant MANAGER_ROLE to users
        const MANAGER_ROLE = await rGold.MANAGER_ROLE();
        await rGold.grantRole(MANAGER_ROLE, user1.address);
        await rGold.grantRole(MANAGER_ROLE, user2.address);
        await rSilver.grantRole(MANAGER_ROLE, user1.address);
        await rSilver.grantRole(MANAGER_ROLE, user2.address);
    });

    it("should allow separate deposits and track supply independently", async function () {
        // Approve and deposit GOLD to rGold from user1
        await goldToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));
        await rGold.connect(user1).deposit(await goldToken.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"));

        expect(await rGold.balanceOf(user1.address)).to.equal(ethers.parseEther("100"));
        expect(await goldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("100"));

        // Approve and deposit SILVER to rSilver from user2
        await silverToken.connect(user2).approve(rSilver.target, ethers.parseEther("2000"));
        await rSilver.connect(user2).deposit(await silverToken.getAddress(), ethers.parseEther("2000"), ethers.parseEther("2000"));

        expect(await rSilver.balanceOf(user2.address)).to.equal(ethers.parseEther("2000"));
        expect(await silverToken.balanceOf(rSilver.target)).to.equal(ethers.parseEther("2000"));
    });

    it("should not allow to deposit unsupported tokens in other vault", async function () {
        // deposit SILVER into rGold fail
        await silverToken.connect(user2).approve(rGold.target, ethers.parseEther("1"));
        await expect(
            rGold.connect(user2).deposit(await silverToken.getAddress(), ethers.parseEther("1"), ethers.parseEther("1"))
        ).to.be.revertedWithCustomError(rGold, "TokenNotSupported");

        // Try to deposit GOLD into rSilver fail
        await goldToken.connect(user1).approve(rSilver.target, ethers.parseEther("1"));
        await expect(
            rSilver.connect(user1).deposit(await goldToken.getAddress(), ethers.parseEther("1"), ethers.parseEther("1"))
        ).to.be.revertedWithCustomError(rSilver, "TokenNotSupported");
    });

    it("should allow parallel withdraws, balances, and preserve logic between two STokens", async function () {
        // withdraw from rGold
        const goldWithdrawPreview = await rGold.previewWithdraw(await goldToken.getAddress(), ethers.parseEther("50"));
        await rGold.connect(user1).withdraw(await goldToken.getAddress(), ethers.parseEther("50"), goldWithdrawPreview);

        expect(await rGold.balanceOf(user1.address)).to.equal(ethers.parseEther("50"));
        expect(await goldToken.balanceOf(user1.address)).to.equal(ethers.parseEther("950"));
        expect(await goldToken.balanceOf(rGold.target)).to.equal(ethers.parseEther("50"));

        // withdraw from rSilver
        const silverWithdrawPreview = await rSilver.previewWithdraw(await silverToken.getAddress(), ethers.parseEther("1000"));
        await rSilver.connect(user2).withdraw(await silverToken.getAddress(), ethers.parseEther("1000"), silverWithdrawPreview);

        expect(await rSilver.balanceOf(user2.address)).to.equal(ethers.parseEther("1000"));
        expect(await silverToken.balanceOf(user2.address)).to.equal(ethers.parseEther("4000"));
        expect(await silverToken.balanceOf(rSilver.target)).to.equal(ethers.parseEther("1000"));
    });

    it("should maintain independent admin controls and configs for each SToken", async function () {
        // Set deposit fee for rGold, but not rSilver
        await rGold.connect(deployer).setDepositFee(100); // 1%

        expect(await rGold.depositFeeBps()).to.equal(100);
        expect(await rSilver.depositFeeBps()).to.equal(0);

        // Set treasury for rSilver
        await rSilver.connect(deployer).setTreasury(deployer.address);
        expect(await rSilver.treasury()).to.equal(deployer.address);
        expect(await rGold.treasury()).to.not.equal(deployer.address);
    });

    describe("Fee-on-Transfer accounting", function () {
        let fotToken;

        beforeEach(async function () {
            if (await rGold.paused()) {
                await rGold.connect(deployer).unpause();
            }

            // Deploy a fee-on-transfer token (1% fee)
            const MockFeeOnTransferToken = await ethers.getContractFactory("MockFeeOnTransferToken");
            fotToken = await MockFeeOnTransferToken.deploy("FeeOnTransfer Token", "FOT", 100); // 1% fee
            await fotToken.waitForDeployment();

            await rGold.connect(deployer).addSupportedToken(await fotToken.getAddress());
        });

        it("should accept fee-on-transfer tokens and account based on received amount", async function () {
            await fotToken.mint(user1.address, ethers.parseEther("100"));
            await fotToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));

            // 1% transfer fee: 100 sent -> 99 received
            const expectedReceived = ethers.parseEther("99");
            const balanceBefore = await rGold.balanceOf(user1.address);

            await rGold.connect(user1).deposit(await fotToken.getAddress(), ethers.parseEther("100"), expectedReceived);

            expect(await rGold.balanceOf(user1.address)).to.equal(balanceBefore + expectedReceived);
            expect(await rGold.tokenReserves(await fotToken.getAddress())).to.equal(expectedReceived);
        });

        it("should correctly track accounting with normal tokens (received == amount)", async function () {
            const normalToken = await ERC20Mock.deploy("Normal Token", "NORM", 18);
            await normalToken.waitForDeployment();
            await rGold.connect(deployer).addSupportedToken(await normalToken.getAddress());

            await normalToken.mint(user1.address, ethers.parseEther("100"));
            await normalToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));

            await rGold.connect(user1).deposit(await normalToken.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"));

            const tracked = await rGold.tokenReserves(await normalToken.getAddress());
            const actual = await normalToken.balanceOf(rGold.target);
            expect(tracked).to.equal(actual);
            expect(tracked).to.equal(ethers.parseEther("100"));
        });
    });
    describe("Accounting", function () {
        let trackToken;

        beforeEach(async function () {
            if (await rGold.paused()) {
                await rGold.connect(deployer).unpause();
            }

            trackToken = await ERC20Mock.deploy("Track Token", "TRACK", 18);
            await trackToken.waitForDeployment();
            await rGold.connect(deployer).addSupportedToken(await trackToken.getAddress());
        });

        it("should track totalUserDeposits on deposit", async function () {
            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(0);

            await trackToken.mint(user1.address, ethers.parseEther("100"));
            await trackToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));
            await rGold.connect(user1).deposit(await trackToken.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"));

            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("100"));
        });

        it("should track totalUserDeposits on withdraw", async function () {
            await trackToken.mint(user1.address, ethers.parseEther("100"));
            await trackToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));
            await rGold.connect(user1).deposit(await trackToken.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"));

            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("100"));

            await rGold.connect(user1).withdraw(await trackToken.getAddress(), ethers.parseEther("40"), ethers.parseEther("40"));

            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("60"));
        });

        it("should track totalUserDeposits across multiple users", async function () {
            await trackToken.mint(user1.address, ethers.parseEther("100"));
            await trackToken.mint(user2.address, ethers.parseEther("50"));

            await trackToken.connect(user1).approve(rGold.target, ethers.parseEther("100"));
            await trackToken.connect(user2).approve(rGold.target, ethers.parseEther("50"));

            await rGold.connect(user1).deposit(await trackToken.getAddress(), ethers.parseEther("100"), ethers.parseEther("100"));
            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("100"));

            await rGold.connect(user2).deposit(await trackToken.getAddress(), ethers.parseEther("50"), ethers.parseEther("50"));
            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("100"));
            expect(await rGold.getUserTokenDeposit(user2.address, await trackToken.getAddress())).to.equal(ethers.parseEther("50"));
            // Total tokenReserves be 150
            expect(await rGold.tokenReserves(await trackToken.getAddress())).to.equal(ethers.parseEther("150"));

            await rGold.connect(user1).withdraw(await trackToken.getAddress(), ethers.parseEther("30"), ethers.parseEther("30"));
            expect(await rGold.getUserTokenDeposit(user1.address, await trackToken.getAddress())).to.equal(ethers.parseEther("70"));
            // Total tokenReserves now be 120 (70 + 50)
            expect(await rGold.tokenReserves(await trackToken.getAddress())).to.equal(ethers.parseEther("120"));
        });
    });
});