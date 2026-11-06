import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("SToken Security & Invariant Tests", function () {
    this.timeout(60000);

    let sToken;
    let goldToken;
    let silverToken;
    let complianceRegistry;

    let deployer;
    let alice;
    let bob;
    let charlie;
    let treasury;
    let attacker;
    let addrs;

    const DEPOSIT_AMOUNT = ethers.parseEther("100");
    const MINT_AMOUNT = ethers.parseEther("10000");

    // Role hashes
    let ADMIN_ROLE;
    let EMERGENCY_ROLE;
    let MANAGER_ROLE;

    beforeEach(async function () {
        [deployer, alice, bob, charlie, treasury, attacker, ...addrs] = await ethers.getSigners();

        // Deploy mock ERC20 tokens
        const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
        goldToken = await ERC20Mock.deploy("Gold Token", "GOLD", 18);
        await goldToken.waitForDeployment();
        silverToken = await ERC20Mock.deploy("Silver Token", "SILVER", 18);
        await silverToken.waitForDeployment();

        // Deploy ComplianceRegistry
        const ComplianceRegistryFactory = await ethers.getContractFactory("ComplianceRegistry");
        complianceRegistry = await ComplianceRegistryFactory.deploy();
        await complianceRegistry.waitForDeployment();

        // Deploy SToken via proxy
        const STokenFactory = await ethers.getContractFactory("SToken");
        const sTokenImpl = await STokenFactory.deploy();
        await sTokenImpl.waitForDeployment();

        const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
        const initData = STokenFactory.interface.encodeFunctionData("initialize", [
            "RAAC Gold",
            "rGOLD",
            deployer.address,
        ]);
        const proxy = await TransparentUpgradeableProxy.deploy(
            await sTokenImpl.getAddress(),
            deployer.address,
            initData
        );
        await proxy.waitForDeployment();
        sToken = STokenFactory.attach(await proxy.getAddress());

        // Cache role hashes
        ADMIN_ROLE = await sToken.ADMIN_ROLE();
        EMERGENCY_ROLE = await sToken.EMERGENCY_ROLE();
        MANAGER_ROLE = await sToken.MANAGER_ROLE();

        // Setup: add supported token, set treasury, set fee
        await sToken.addSupportedToken(await goldToken.getAddress());
        await sToken.setTreasury(treasury.address);

        // Mint tokens to users
        await goldToken.mint(alice.address, MINT_AMOUNT);
        await goldToken.mint(bob.address, MINT_AMOUNT);
        await goldToken.mint(charlie.address, MINT_AMOUNT);
        await goldToken.mint(attacker.address, MINT_AMOUNT);

        // Grant MANAGER_ROLE to users who deposit/withdraw/transferWithdrawRights
        await sToken.grantRole(MANAGER_ROLE, alice.address);
        await sToken.grantRole(MANAGER_ROLE, bob.address);
        await sToken.grantRole(MANAGER_ROLE, charlie.address);
        await sToken.grantRole(MANAGER_ROLE, attacker.address);

        // Approve sToken for all users
        const sTokenAddr = await sToken.getAddress();
        await goldToken.connect(alice).approve(sTokenAddr, ethers.MaxUint256);
        await goldToken.connect(bob).approve(sTokenAddr, ethers.MaxUint256);
        await goldToken.connect(charlie).approve(sTokenAddr, ethers.MaxUint256);
        await goldToken.connect(attacker).approve(sTokenAddr, ethers.MaxUint256);
    });

    /* ========== 1. ACCOUNTING INVARIANTS ========== */
    describe("1. Accounting Invariants", function () {

        it("INV-1: tokenReserves == sum of all userTokenDeposits after deposits", async function () {
            // Multiple users deposit
            await sToken.connect(alice).deposit(await goldToken.getAddress(), DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(await goldToken.getAddress(), ethers.parseEther("50"), 0);

            const reserves = await sToken.tokenReserves(await goldToken.getAddress());
            const aliceDeposit = await sToken.getUserTokenDeposit(alice.address, await goldToken.getAddress());
            const bobDeposit = await sToken.getUserTokenDeposit(bob.address, await goldToken.getAddress());

            expect(reserves).to.equal(aliceDeposit + bobDeposit);
        });

        it("INV-1: tokenReserves == sum of all userTokenDeposits after deposits and withdrawals", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(goldAddr, ethers.parseEther("50"), 0);

            // Alice withdraws partial
            const withdrawAmount = ethers.parseEther("30");
            await sToken.connect(alice).withdraw(goldAddr, withdrawAmount, withdrawAmount);

            const reserves = await sToken.tokenReserves(goldAddr);
            const aliceDeposit = await sToken.getUserTokenDeposit(alice.address, goldAddr);
            const bobDeposit = await sToken.getUserTokenDeposit(bob.address, goldAddr);

            expect(reserves).to.equal(aliceDeposit + bobDeposit);
        });

        it("INV-2: totalSupply == sum of all balanceOf(users) (ERC20 invariant)", async function () {
            await sToken.connect(alice).deposit(await goldToken.getAddress(), DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(await goldToken.getAddress(), ethers.parseEther("50"), 0);

            const totalSupply = await sToken.totalSupply();
            const aliceBal = await sToken.balanceOf(alice.address);
            const bobBal = await sToken.balanceOf(bob.address);
            const treasuryBal = await sToken.balanceOf(treasury.address);

            expect(totalSupply).to.equal(aliceBal + bobBal + treasuryBal);
        });

        it("INV-3: After deposit, tokenReserves increases by exactly amount, userTokenDeposits increases by exactly amount", async function () {
            const goldAddr = await goldToken.getAddress();

            const reservesBefore = await sToken.tokenReserves(goldAddr);
            const depositsBefore = await sToken.getUserTokenDeposit(alice.address, goldAddr);

            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            const reservesAfter = await sToken.tokenReserves(goldAddr);
            const depositsAfter = await sToken.getUserTokenDeposit(alice.address, goldAddr);

            expect(reservesAfter - reservesBefore).to.equal(DEPOSIT_AMOUNT);
            expect(depositsAfter - depositsBefore).to.equal(DEPOSIT_AMOUNT);
        });

        it("INV-4: After withdraw, tokenReserves decreases by amountOut, user SToken balance decreases by amountBurned", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            const reservesBefore = await sToken.tokenReserves(goldAddr);
            const balanceBefore = await sToken.balanceOf(alice.address);
            const withdrawAmount = ethers.parseEther("40");

            await sToken.connect(alice).withdraw(goldAddr, withdrawAmount, withdrawAmount);

            const reservesAfter = await sToken.tokenReserves(goldAddr);
            const balanceAfter = await sToken.balanceOf(alice.address);

            expect(reservesBefore - reservesAfter).to.equal(withdrawAmount);
            expect(balanceBefore - balanceAfter).to.equal(withdrawAmount); // 1:1 burn
        });
    });

    /* ========== 2. COMPLIANCE INVARIANTS ========== */
    describe("2. Compliance Invariants", function () {

        beforeEach(async function () {
            // Set compliance registry on sToken
            await sToken.setComplianceRegistry(await complianceRegistry.getAddress());
        });

        it("INV-5: Blacklisted user CANNOT transfer() STokens", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Blacklist alice
            await complianceRegistry.blacklist(alice.address);

            await expect(
                sToken.connect(alice).transfer(bob.address, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("INV-6: Blacklisted user CANNOT receive STokens via transfer()", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Blacklist bob (the receiver)
            await complianceRegistry.blacklist(bob.address);

            await expect(
                sToken.connect(alice).transfer(bob.address, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("INV-7: Blacklisted user CANNOT deposit()", async function () {
            const goldAddr = await goldToken.getAddress();
            await complianceRegistry.blacklist(attacker.address);

            await expect(
                sToken.connect(attacker).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("INV-7: Blacklisted user CANNOT withdraw()", async function () {
            const goldAddr = await goldToken.getAddress();
            // Deposit first while not blacklisted
            await sToken.connect(attacker).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Now blacklist
            await complianceRegistry.blacklist(attacker.address);

            await expect(
                sToken.connect(attacker).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("INV-8: When registry is NOT set, all transfers proceed normally", async function () {
            // Disable compliance registry
            await sToken.setComplianceRegistry(ethers.ZeroAddress);

            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Blacklist alice on the registry (but registry is not set on sToken)
            await complianceRegistry.blacklist(alice.address);

            // Transfer should still work
            await expect(
                sToken.connect(alice).transfer(bob.address, ethers.parseEther("10"))
            ).to.not.be.reverted;
        });

        it("INV-8: When registry is NOT set, deposit/withdraw proceed normally even for blacklisted addresses", async function () {
            // Disable compliance registry
            await sToken.setComplianceRegistry(ethers.ZeroAddress);

            const goldAddr = await goldToken.getAddress();
            await complianceRegistry.blacklist(attacker.address);

            // Deposit and withdraw should work fine
            await expect(
                sToken.connect(attacker).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.not.be.reverted;

            await expect(
                sToken.connect(attacker).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.not.be.reverted;
        });

        it("INV-9: transferWithdrawRights IS blocked by compliance", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Blacklist alice
            await complianceRegistry.blacklist(alice.address);

            // transferWithdrawRights should be blocked (compliance check on msg.sender)
            await expect(
                sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");

            // Alice's deposit rights remain unchanged
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(DEPOSIT_AMOUNT);
            expect(await sToken.getUserTokenDeposit(bob.address, goldAddr)).to.equal(0);
        });
    });

    /* ========== 3. EMERGENCY & ACCESS CONTROL INVARIANTS ========== */
    describe("3. Emergency & Access Control Invariants", function () {

        it("INV-10: setEmergencyMode reverts for non-EMERGENCY_ROLE callers", async function () {
            await expect(
                sToken.connect(alice).setEmergencyMode(true)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-11: withdraw allowed when paused + emergencyMode", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.pause();
            await sToken.setEmergencyMode(true);

            // Withdraw should succeed in emergency mode
            await expect(
                sToken.connect(alice).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.not.be.reverted;
        });

        it("INV-11: deposit still blocked when paused + emergencyMode", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.pause();
            await sToken.setEmergencyMode(true);

            await expect(
                sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
        });

        it("INV-12: deposit reverts when paused", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.pause();

            await expect(
                sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
        });

        it("INV-12: withdraw reverts when paused (no emergency mode)", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.pause();

            await expect(
                sToken.connect(alice).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
        });


        it("INV-13: Only ADMIN_ROLE can call setComplianceRegistry", async function () {
            await expect(
                sToken.connect(alice).setComplianceRegistry(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-13: Only ADMIN_ROLE can call setTreasury", async function () {
            await expect(
                sToken.connect(alice).setTreasury(alice.address)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-13: Only ADMIN_ROLE can call setDepositFee", async function () {
            await expect(
                sToken.connect(alice).setDepositFee(100)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-13: Only EMERGENCY_ROLE can call pause", async function () {
            await expect(
                sToken.connect(alice).pause()
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-13: Only ADMIN_ROLE can call unpause", async function () {
            await sToken.pause();
            await expect(
                sToken.connect(alice).unpause()
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-14: Only MANAGER_ROLE can call deposit", async function () {
            const goldAddr = await goldToken.getAddress();
            const noRoleUser = addrs[0];
            await goldToken.mint(noRoleUser.address, MINT_AMOUNT);
            await goldToken.connect(noRoleUser).approve(await sToken.getAddress(), ethers.MaxUint256);

            await expect(
                sToken.connect(noRoleUser).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-14: Only MANAGER_ROLE can call withdraw", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Revoke MANAGER_ROLE from alice
            await sToken.revokeRole(MANAGER_ROLE, alice.address);

            await expect(
                sToken.connect(alice).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-14: Only MANAGER_ROLE can call transferWithdrawRights", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Revoke MANAGER_ROLE from alice
            await sToken.revokeRole(MANAGER_ROLE, alice.address);

            await expect(
                sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(sToken, "AccessControlUnauthorizedAccount");
        });

        it("INV-15: unpause auto-disables emergencyMode", async function () {
            await sToken.pause();
            await sToken.setEmergencyMode(true);
            expect(await sToken.emergencyMode()).to.be.true;

            await sToken.unpause();
            expect(await sToken.emergencyMode()).to.be.false;
            expect(await sToken.paused()).to.be.false;
        });

        it("INV-15: transferWithdrawRights blocked when paused (no emergency mode)", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.pause();

            await expect(
                sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
        });

        it("INV-15: transferWithdrawRights allowed when paused + emergencyMode", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.pause();
            await sToken.setEmergencyMode(true);

            await expect(
                sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, DEPOSIT_AMOUNT)
            ).to.not.be.reverted;

            expect(await sToken.getUserTokenDeposit(bob.address, goldAddr)).to.equal(DEPOSIT_AMOUNT);
        });

        it("INV-16: full lifecycle — pause → nothing works → emergencyMode → withdraw/transfer work → unpause → normal ops resume", async function () {
            const goldAddr = await goldToken.getAddress();

            // --- Normal operations ---
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(goldAddr, ethers.parseEther("50"), 0);

            // --- Pause: everything blocked ---
            await sToken.pause();
            expect(await sToken.paused()).to.be.true;
            expect(await sToken.emergencyMode()).to.be.false;

            await expect(
                sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
            await expect(
                sToken.connect(alice).withdraw(goldAddr, ethers.parseEther("10"), ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");
            await expect(
                sToken.connect(alice).transferWithdrawRights(goldAddr, charlie.address, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");

            // --- Enable emergencyMode: withdraw + transferWithdrawRights unblocked, deposit still blocked ---
            await sToken.setEmergencyMode(true);
            expect(await sToken.emergencyMode()).to.be.true;

            // Deposit still blocked
            await expect(
                sToken.connect(charlie).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(sToken, "EnforcedPause");

            // Alice transfers some withdraw rights to charlie
            await sToken.connect(alice).transferWithdrawRights(goldAddr, charlie.address, ethers.parseEther("30"));
            expect(await sToken.getUserTokenDeposit(charlie.address, goldAddr)).to.equal(ethers.parseEther("30"));
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(ethers.parseEther("70"));

            // Alice withdraws partial
            await sToken.connect(alice).withdraw(goldAddr, ethers.parseEther("20"), ethers.parseEther("20"));
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(ethers.parseEther("50"));

            // Bob withdraws all
            await sToken.connect(bob).withdraw(goldAddr, ethers.parseEther("50"), ethers.parseEther("50"));
            expect(await sToken.getUserTokenDeposit(bob.address, goldAddr)).to.equal(0);

            // --- Unpause: emergencyMode auto-disabled, everything back to normal ---
            await sToken.unpause();
            expect(await sToken.paused()).to.be.false;
            expect(await sToken.emergencyMode()).to.be.false;

            // Normal deposit works again
            await sToken.connect(alice).deposit(goldAddr, ethers.parseEther("10"), 0);
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(ethers.parseEther("60"));

            // Normal withdraw works
            await sToken.connect(alice).withdraw(goldAddr, ethers.parseEther("10"), ethers.parseEther("10"));
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(ethers.parseEther("50"));

            // Normal transferWithdrawRights works
            await sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, ethers.parseEther("5"));
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(ethers.parseEther("45"));
            expect(await sToken.getUserTokenDeposit(bob.address, goldAddr)).to.equal(ethers.parseEther("5"));
        });
    });

    /* ========== 4. FEE INVARIANTS ========== */
    describe("4. Fee Invariants", function () {

        it("INV-14: netAmount + feeAmount == grossAmount == depositAmount", async function () {
            await sToken.setDepositFee(500); // 5%

            const goldAddr = await goldToken.getAddress();
            const { grossAmount, netAmount, feeAmount } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);

            expect(grossAmount).to.equal(DEPOSIT_AMOUNT);
            expect(netAmount + feeAmount).to.equal(grossAmount);
        });

        it("INV-15: Treasury receives exactly feeAmount STokens on deposit", async function () {
            await sToken.setDepositFee(500); // 5%

            const goldAddr = await goldToken.getAddress();
            const { netAmount, feeAmount } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);

            const treasuryBalBefore = await sToken.balanceOf(treasury.address);
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, netAmount);
            const treasuryBalAfter = await sToken.balanceOf(treasury.address);

            expect(treasuryBalAfter - treasuryBalBefore).to.equal(feeAmount);
        });

        it("INV-15: Depositor receives exactly netAmount STokens", async function () {
            await sToken.setDepositFee(500); // 5%

            const goldAddr = await goldToken.getAddress();
            const { netAmount } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);

            const aliceBalBefore = await sToken.balanceOf(alice.address);
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, netAmount);
            const aliceBalAfter = await sToken.balanceOf(alice.address);

            expect(aliceBalAfter - aliceBalBefore).to.equal(netAmount);
        });

        it("INV-16: When treasury is address(0), no fee is charged regardless of depositFeeBps", async function () {
            // Deploy fresh sToken without treasury set
            const STokenFactory = await ethers.getContractFactory("SToken");
            const impl = await STokenFactory.deploy();
            await impl.waitForDeployment();

            const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy");
            const initData = STokenFactory.interface.encodeFunctionData("initialize", [
                "Test Token", "TEST", deployer.address
            ]);
            const proxy = await TransparentUpgradeableProxy.deploy(
                await impl.getAddress(), deployer.address, initData
            );
            await proxy.waitForDeployment();
            const freshSToken = STokenFactory.attach(await proxy.getAddress());

            await freshSToken.addSupportedToken(await goldToken.getAddress());
            // Set fee but don't set treasury (treasury is address(0))
            await freshSToken.setDepositFee(500);

            const goldAddr = await goldToken.getAddress();
            const { grossAmount, netAmount, feeAmount } = await freshSToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);

            // No fee when treasury is zero
            expect(feeAmount).to.equal(0);
            expect(netAmount).to.equal(grossAmount);
        });

        it("INV-17: Treasury can withdraw its collateral rights by burning STokens", async function () {
            await sToken.setDepositFee(1000); // 10%
            // Grant MANAGER_ROLE to treasury so it can withdraw
            await sToken.grantRole(MANAGER_ROLE, treasury.address);

            const goldAddr = await goldToken.getAddress();
            const { netAmount, feeAmount } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);
            // 10% of 100 = 10 fee, 90 net
            expect(feeAmount).to.equal(ethers.parseEther("10"));
            expect(netAmount).to.equal(ethers.parseEther("90"));

            // Alice deposits — treasury gets feeAmount STokens + feeAmount deposit rights
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, netAmount);

            const treasurySTokenBal = await sToken.balanceOf(treasury.address);
            const treasuryDepositRights = await sToken.getUserTokenDeposit(treasury.address, goldAddr);
            expect(treasurySTokenBal).to.equal(feeAmount);
            expect(treasuryDepositRights).to.equal(feeAmount);

            // Treasury withdraws its collateral by burning its STokens
            const treasuryGoldBefore = await goldToken.balanceOf(treasury.address);
            await sToken.connect(treasury).withdraw(goldAddr, feeAmount, feeAmount);
            const treasuryGoldAfter = await goldToken.balanceOf(treasury.address);

            // Treasury received the collateral
            expect(treasuryGoldAfter - treasuryGoldBefore).to.equal(feeAmount);
            // Treasury SToken balance and deposit rights are now 0
            expect(await sToken.balanceOf(treasury.address)).to.equal(0);
            expect(await sToken.getUserTokenDeposit(treasury.address, goldAddr)).to.equal(0);

            // Alice's deposit rights and reserves are unaffected
            expect(await sToken.getUserTokenDeposit(alice.address, goldAddr)).to.equal(netAmount);
            // tokenReserves decreased by feeAmount (treasury withdrew)
            expect(await sToken.tokenReserves(goldAddr)).to.equal(netAmount);
        });

        it("INV-17: Treasury deposit rights + depositor rights == tokenReserves (accounting invariant with fees)", async function () {
            await sToken.setDepositFee(500); // 5%

            const goldAddr = await goldToken.getAddress();

            // Multiple users deposit
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(goldAddr, ethers.parseEther("200"), 0);

            const reserves = await sToken.tokenReserves(goldAddr);
            const aliceDeposit = await sToken.getUserTokenDeposit(alice.address, goldAddr);
            const bobDeposit = await sToken.getUserTokenDeposit(bob.address, goldAddr);
            const treasuryDeposit = await sToken.getUserTokenDeposit(treasury.address, goldAddr);

            // Invariant: reserves == sum of all userTokenDeposits (including treasury)
            expect(reserves).to.equal(aliceDeposit + bobDeposit + treasuryDeposit);
        });
    });

    /* ========== 5. WITHDRAW RIGHTS INVARIANTS ========== */
    describe("5. Withdraw Rights Invariants", function () {

        it("INV-17: transferWithdrawRights is zero-sum: sender loses exactly what receiver gains", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            const transferAmount = ethers.parseEther("40");
            const aliceBefore = await sToken.getUserTokenDeposit(alice.address, goldAddr);
            const bobBefore = await sToken.getUserTokenDeposit(bob.address, goldAddr);

            await sToken.connect(alice).transferWithdrawRights(goldAddr, bob.address, transferAmount);

            const aliceAfter = await sToken.getUserTokenDeposit(alice.address, goldAddr);
            const bobAfter = await sToken.getUserTokenDeposit(bob.address, goldAddr);

            expect(aliceBefore - aliceAfter).to.equal(transferAmount);
            expect(bobAfter - bobBefore).to.equal(transferAmount);
            // Zero-sum: total unchanged
            expect(aliceAfter + bobAfter).to.equal(aliceBefore + bobBefore);
        });

        it("INV-18: User cannot withdraw more than their userTokenDeposits", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            const tooMuch = DEPOSIT_AMOUNT + 1n;
            await expect(
                sToken.connect(alice).withdraw(goldAddr, tooMuch, tooMuch)
            ).to.be.revertedWithCustomError(sToken, "InsufficientDeposit");
        });

        it("INV-19: User cannot withdraw if they don't have enough SToken balance to burn", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Transfer some STokens away so alice doesn't have enough to burn
            await sToken.connect(alice).transfer(bob.address, ethers.parseEther("80"));

            // Alice has deposit rights for 100 but only 20 STokens
            // Trying to withdraw 50 should fail because burn would underflow
            await expect(
                sToken.connect(alice).withdraw(goldAddr, ethers.parseEther("50"), ethers.parseEther("50"))
            ).to.be.revertedWithCustomError(sToken, "ERC20InsufficientBalance");
        });
    });

    /* ========== 6. ATTACK SCENARIO TESTS ========== */
    describe("6. Attack Scenario Tests", function () {

        it("ATK-1: Blacklisted user CANNOT perform deposit->withdraw cycle (C-1 fix)", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.setComplianceRegistry(await complianceRegistry.getAddress());

            // Blacklist attacker
            await complianceRegistry.blacklist(attacker.address);

            // Attempt deposit -> should be blocked
            await expect(
                sToken.connect(attacker).deposit(goldAddr, DEPOSIT_AMOUNT, 0)
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("ATK-1: Blacklisted user who deposited before blacklisting CANNOT withdraw (C-1 fix)", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.setComplianceRegistry(await complianceRegistry.getAddress());

            // Deposit while not blacklisted
            await sToken.connect(attacker).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Get blacklisted
            await complianceRegistry.blacklist(attacker.address);

            // Attempt withdraw -> should be blocked
            await expect(
                sToken.connect(attacker).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("ATK-2: emergencyMode preserves accounting — users can only withdraw their own deposits", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(goldAddr, ethers.parseEther("50"), 0);

            await sToken.pause();
            await sToken.setEmergencyMode(true);

            // Alice withdraws her deposit
            await sToken.connect(alice).withdraw(goldAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);

            // Alice cannot withdraw more than her deposit
            await expect(
                sToken.connect(alice).withdraw(goldAddr, 1n, 1n)
            ).to.be.revertedWithCustomError(sToken, "InsufficientDeposit");

            // Bob can still withdraw his
            const bobDeposit = await sToken.getUserTokenDeposit(bob.address, goldAddr);
            expect(bobDeposit).to.equal(ethers.parseEther("50"));
        });

        it("ATK-3: Fee manipulation - set fee, deposit, then change treasury", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.setDepositFee(1000); // 10%

            // Alice deposits with fee going to current treasury
            const { netAmount, feeAmount } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);
            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, netAmount);

            // Verify treasury got the fee
            expect(await sToken.balanceOf(treasury.address)).to.equal(feeAmount);

            // Admin changes treasury
            const newTreasury = addrs[0];
            await sToken.setTreasury(newTreasury.address);

            // Bob deposits - fee goes to new treasury
            const { netAmount: netAmount2, feeAmount: feeAmount2 } = await sToken.previewDeposit(goldAddr, DEPOSIT_AMOUNT);
            await sToken.connect(bob).deposit(goldAddr, DEPOSIT_AMOUNT, netAmount2);

            // Old treasury still has its fees, new treasury has new fees
            expect(await sToken.balanceOf(treasury.address)).to.equal(feeAmount);
            expect(await sToken.balanceOf(newTreasury.address)).to.equal(feeAmount2);
        });

        it("ATK-4: transferFrom to blacklisted address is blocked by _update", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.setComplianceRegistry(await complianceRegistry.getAddress());

            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Alice approves attacker
            await sToken.connect(alice).approve(attacker.address, ethers.MaxUint256);

            // Blacklist bob (the receiver)
            await complianceRegistry.blacklist(bob.address);

            // Attacker tries to use transferFrom to send to blacklisted bob
            await expect(
                sToken.connect(attacker).transferFrom(alice.address, bob.address, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });

        it("ATK-4: transferFrom FROM blacklisted address is also blocked", async function () {
            const goldAddr = await goldToken.getAddress();
            await sToken.setComplianceRegistry(await complianceRegistry.getAddress());

            await sToken.connect(alice).deposit(goldAddr, DEPOSIT_AMOUNT, 0);

            // Alice approves bob
            await sToken.connect(alice).approve(bob.address, ethers.MaxUint256);

            // Blacklist alice (the sender/token owner)
            await complianceRegistry.blacklist(alice.address);

            // Bob tries to use transferFrom to take from blacklisted alice
            await expect(
                sToken.connect(bob).transferFrom(alice.address, bob.address, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
        });
    });

    /* ========== 7. FEE-ON-TRANSFER TOKEN TESTS ========== */
    describe("7. Fee-on-Transfer Token Compatibility", function () {
        let feeToken;
        const FEE_BPS = 500; // 5% transfer fee

        beforeEach(async function () {
            // Deploy MockFeeOnTransferToken with 5% fee
            const FeeTokenFactory = await ethers.getContractFactory("MockFeeOnTransferToken");
            feeToken = await FeeTokenFactory.deploy("Fee Token", "FEE", FEE_BPS);
            await feeToken.waitForDeployment();

            // Add as supported token
            await sToken.addSupportedToken(await feeToken.getAddress());

            // Mint and approve for users
            const sTokenAddr = await sToken.getAddress();
            await feeToken.mint(alice.address, MINT_AMOUNT);
            await feeToken.mint(bob.address, MINT_AMOUNT);
            await feeToken.connect(alice).approve(sTokenAddr, ethers.MaxUint256);
            await feeToken.connect(bob).approve(sTokenAddr, ethers.MaxUint256);
        });

        it("FOT-1: deposit succeeds and accounts based on received amount (not declared amount)", async function () {
            const feeTokenAddr = await feeToken.getAddress();
            // 5% transfer fee: sending 100 means contract receives 95
            const expectedReceived = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);

            const reserves = await sToken.tokenReserves(feeTokenAddr);
            const userDeposit = await sToken.getUserTokenDeposit(alice.address, feeTokenAddr);
            const aliceSTokenBal = await sToken.balanceOf(alice.address);

            expect(reserves).to.equal(expectedReceived);
            expect(userDeposit).to.equal(expectedReceived);
            expect(aliceSTokenBal).to.equal(expectedReceived);
        });

        it("FOT-2: tokenReserves matches actual contract balance (no inflation)", async function () {
            const feeTokenAddr = await feeToken.getAddress();

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);

            const reserves = await sToken.tokenReserves(feeTokenAddr);
            const actualBalance = await feeToken.balanceOf(await sToken.getAddress());

            expect(reserves).to.equal(actualBalance);
        });

        it("FOT-3: multiple users deposit and accounting remains consistent", async function () {
            const feeTokenAddr = await feeToken.getAddress();
            const bobAmount = ethers.parseEther("50");

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);
            await sToken.connect(bob).deposit(feeTokenAddr, bobAmount, 0);

            const expectedAlice = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);
            const expectedBob = bobAmount - (bobAmount * BigInt(FEE_BPS) / 10000n);

            const reserves = await sToken.tokenReserves(feeTokenAddr);
            const aliceDeposit = await sToken.getUserTokenDeposit(alice.address, feeTokenAddr);
            const bobDeposit = await sToken.getUserTokenDeposit(bob.address, feeTokenAddr);

            expect(reserves).to.equal(expectedAlice + expectedBob);
            expect(aliceDeposit).to.equal(expectedAlice);
            expect(bobDeposit).to.equal(expectedBob);
            // Invariant: reserves == sum of user deposits
            expect(reserves).to.equal(aliceDeposit + bobDeposit);
        });

        it("FOT-4: SToken deposit fee applied on received amount, not declared amount", async function () {
            await sToken.setDepositFee(1000); // 10% SToken fee

            const feeTokenAddr = await feeToken.getAddress();
            // Transfer fee takes 5%: 100 → 95 received
            const expectedReceived = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);
            // SToken fee is 10% of received: 95 * 10% = 9.5
            const expectedSTokenFee = expectedReceived * 1000n / 10000n;
            const expectedNet = expectedReceived - expectedSTokenFee;

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);

            const aliceBal = await sToken.balanceOf(alice.address);
            const treasuryBal = await sToken.balanceOf(treasury.address);

            expect(aliceBal).to.equal(expectedNet);
            expect(treasuryBal).to.equal(expectedSTokenFee);
            // Total minted == received
            expect(aliceBal + treasuryBal).to.equal(expectedReceived);
        });

        it("FOT-5: minAmountOut correctly protects against excessive transfer fees", async function () {
            const feeTokenAddr = await feeToken.getAddress();
            // 5% fee: 100 → 95. If user expects at least 96, should revert
            const tooHighMinOut = ethers.parseEther("96");

            await expect(
                sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, tooHighMinOut)
            ).to.be.revertedWithCustomError(sToken, "InsufficientAmountOut");
        });

        it("FOT-6: minAmountOut passes when set to expected received amount", async function () {
            const feeTokenAddr = await feeToken.getAddress();
            const expectedReceived = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);

            await expect(
                sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, expectedReceived)
            ).to.not.be.reverted;
        });

        it("FOT-7: withdraw after fee-on-transfer deposit uses correct accounting", async function () {
            const feeTokenAddr = await feeToken.getAddress();
            const expectedReceived = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);

            // Alice can withdraw up to what was actually received. The slippage check now
            // measures what she receives after the outgoing transfer fee, so minAmountOut
            // must account for the 5% fee on the way out too.
            const withdrawAmount = expectedReceived;
            const minReceived = withdrawAmount - (withdrawAmount * BigInt(FEE_BPS) / 10000n);
            await sToken.connect(alice).withdraw(feeTokenAddr, withdrawAmount, minReceived);

            expect(await sToken.tokenReserves(feeTokenAddr)).to.equal(0);
            expect(await sToken.getUserTokenDeposit(alice.address, feeTokenAddr)).to.equal(0);
        });

        it("FOT-8: user cannot withdraw more than received amount", async function () {
            const feeTokenAddr = await feeToken.getAddress();

            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);

            // Try to withdraw the original amount (100), but only 95 was deposited
            await expect(
                sToken.connect(alice).withdraw(feeTokenAddr, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT)
            ).to.be.revertedWithCustomError(sToken, "InsufficientDeposit");
        });

        it("FOT-9: dynamic fee toggling — accounting tracks actual received each time", async function () {
            const feeTokenAddr = await feeToken.getAddress();

            // Deposit with 5% fee: 100 → 95 received
            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);
            const reservesAfterFirst = await sToken.tokenReserves(feeTokenAddr);
            const expectedFirst = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * BigInt(FEE_BPS) / 10000n);
            expect(reservesAfterFirst).to.equal(expectedFirst);

            // Disable fee, deposit again: 100 → 100 received
            await feeToken.setFeeBps(0);
            await sToken.connect(alice).deposit(feeTokenAddr, DEPOSIT_AMOUNT, 0);
            const reservesAfterSecond = await sToken.tokenReserves(feeTokenAddr);
            expect(reservesAfterSecond).to.equal(expectedFirst + DEPOSIT_AMOUNT);

            // Reserves still match actual balance
            const actualBalance = await feeToken.balanceOf(await sToken.getAddress());
            expect(reservesAfterSecond).to.equal(actualBalance);
        });
    });
});
