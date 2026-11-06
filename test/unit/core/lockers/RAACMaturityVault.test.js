import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("RAACMaturityVault.spec", async () => {
    let deployer;
    let alice;
    let bob

    let raac
    let leRAAC;
    let maturityVault;

    const DAY = 24 * 3600;

    async function timeIncreaseWithMining(seconds) {
        const timestamp = (await ethers.provider.getBlock("latest"))?.timestamp;
        await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp + seconds]);
        await hre.network.provider.send("evm_mine", []);
    }

    beforeEach(async () => {
        [deployer, alice, bob] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockToken", deployer);
        raac = await MockERC20.deploy("RAAC", "RAAC", 18);

        const LeRAAC = await ethers.getContractFactory("LiquidEscrowedRAAC", deployer);
        leRAAC = await LeRAAC.deploy();

        // RAACMaturityVault now calls _disableInitializers() in its constructor,
        // so it must be deployed behind a proxy and initialized through it.
        // initialize(raac, leRAAC, platform, governor, platformFeePercentage, harvestBountyPercentage)
        const Vault = await ethers.getContractFactory("RAACMaturityVault", deployer);
        const vaultImpl = await Vault.deploy();
        const initData = Vault.interface.encodeFunctionData("initialize", [
            await raac.getAddress(),
            await leRAAC.getAddress(),
            await deployer.getAddress(),
            await deployer.getAddress(),
            0,
            0
        ]);
        const Proxy = await ethers.getContractFactory("ERC1967Proxy", deployer);
        const vaultProxy = await Proxy.deploy(await vaultImpl.getAddress(), initData);
        maturityVault = Vault.attach(await vaultProxy.getAddress());

        // Allow deployer to distribute/harvest
        await maturityVault.updateWhitelists([await deployer.getAddress()], [true]);

        // Enable deployer to mint leRAAC for tests
        await leRAAC.updateMinters([await deployer.getAddress()], [true]);
        await leRAAC.updateCeiling(await deployer.getAddress(), ethers.toBeHex(ethers.parseUnits("1000000000", 18)));

        // Fund deployer with RAAC
        await raac.mint(await deployer.getAddress(), ethers.parseEther("1000000"));
    });

    context("Vault has free RAAC in pool", async () => {
        it("fully realises deposit when pool has enough RAAC; then claim pays out", async () => {
            // Pre-fund vault with RAAC
            await raac.transfer(await maturityVault.getAddress(), ethers.parseEther("1000"));

            // Mint leRAAC to alice and deposit
            const dep = ethers.parseEther("100");
            await leRAAC.mint(await alice.getAddress(), dep);
            await leRAAC.connect(alice).approve(await maturityVault.getAddress(), dep);
            await maturityVault.connect(alice).deposit(dep);

            let [unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(realised).to.equal(dep);
            expect(unrealised).to.equal(0n);
            expect(await maturityVault.totalRealised()).to.equal(dep);
            expect(await maturityVault.totalUnrealised()).to.equal(0n);

            const balBefore = await raac.balanceOf(await alice.getAddress());
            await maturityVault.connect(alice).claim(await alice.getAddress());
            const balAfter = await raac.balanceOf(await alice.getAddress());
            expect(balAfter - balBefore).to.equal(dep);

            // Post-claim state
            ;[unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(realised).to.equal(0n);
            expect(unrealised).to.equal(0n);
            expect(await maturityVault.totalRealised()).to.equal(0n);
            expect(await maturityVault.totalUnrealised()).to.equal(0n);
        });
    });

    context("Vault has insufficient RAAC in pool", async () => {
        it("partially realises deposit and leaves unrealised; claim withdraws realised only; withdraw returns unrealised leRAAC", async () => {
            // Pre-fund vault with limited RAAC
            await raac.transfer(await maturityVault.getAddress(), ethers.parseEther("1000"));

            // Mint and deposit 1500 leRAAC
            const dep = ethers.parseEther("1500");
            await leRAAC.mint(await alice.getAddress(), dep);
            await leRAAC.connect(alice).approve(await maturityVault.getAddress(), dep);
            await maturityVault.connect(alice).deposit(dep);

            let [unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(realised).to.equal(ethers.parseEther("1000"));
            expect(unrealised).to.equal(ethers.parseEther("500"));
            expect(await maturityVault.totalRealised()).to.equal(ethers.parseEther("1000"));
            expect(await maturityVault.totalUnrealised()).to.equal(ethers.parseEther("500"));

            // Claim realised RAAC
            let before = await raac.balanceOf(await alice.getAddress());
            await maturityVault.connect(alice).claim(await alice.getAddress());
            let after = await raac.balanceOf(await alice.getAddress());
            expect(after - before).to.equal(ethers.parseEther("1000"));

            // Withdraw portion of unrealised leRAAC
            const withdrawAmt = ethers.parseEther("200");
            const leBefore = await leRAAC.balanceOf(await alice.getAddress());
            await maturityVault.connect(alice).withdraw(await alice.getAddress(), withdrawAmt);
            const leAfter = await leRAAC.balanceOf(await alice.getAddress());
            expect(leAfter - leBefore).to.equal(withdrawAmt);

            ;[unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(realised).to.equal(0n);
            expect(unrealised).to.equal(ethers.parseEther("300"));
            expect(await maturityVault.totalUnrealised()).to.equal(ethers.parseEther("300"));

            // Withdraw all remaining unrealised
            const leBeforeAll = await leRAAC.balanceOf(await alice.getAddress());
            await maturityVault.connect(alice).withdrawAll(await alice.getAddress());
            const leAfterAll = await leRAAC.balanceOf(await alice.getAddress());
            expect(leAfterAll - leBeforeAll).to.equal(ethers.parseEther("300"));

            ;[unrealised, realised] = await maturityVault.getUserInfo(await alice.getAddress());
            expect(realised).to.equal(0n);
            expect(unrealised).to.equal(0n);
            expect(await maturityVault.totalUnrealised()).to.equal(0n);
        });
    });

    context("Linear reward emission", async () => {
        it("distributes RAAC linearly over the period and updates realised over time", async () => {
            // Set linear emission period to 1000 seconds
            await maturityVault.updatePeriodLength(1000);
            await maturityVault.updateWhitelists([await deployer.getAddress()], [true]);

            // Mint and deposit 300 leRAAC (so we can realise 300)
            const dep = ethers.parseEther("300");
            await leRAAC.mint(await alice.getAddress(), dep);
            await leRAAC.connect(alice).approve(await maturityVault.getAddress(), dep);
            await maturityVault.connect(alice).deposit(dep);

            // Fund RAAC to origin (deployer) and distribute 300 over 1000s
            const distributeAmount = ethers.parseEther("300");
            await raac.approve(await maturityVault.getAddress(), distributeAmount);
            await maturityVault.distribute(await deployer.getAddress(), distributeAmount);

            // Half period (500 seconds)
            await timeIncreaseWithMining(500);
            await maturityVault.updatePendingDistribution();
            let [, realisedHalf] = await maturityVault.getUserInfo(await alice.getAddress());
            console.log("realisedHalf", ethers.formatEther(realisedHalf));
            expect(realisedHalf).to.be.gt(0n);
            // Should have approximately half of the deposit realised (150 out of 300)
            expect(realisedHalf).to.be.closeTo(ethers.parseEther("150"), ethers.parseEther("1"));

            // Full period (remaining 500 seconds)
            await timeIncreaseWithMining(500);
            await maturityVault.updatePendingDistribution();
            let [, realisedFull] = await maturityVault.getUserInfo(await alice.getAddress());
            console.log("realisedFull", ethers.formatEther(realisedFull));
            // After full period, all 300 leRAAC should be realised
            expect(realisedFull).to.be.closeTo(ethers.parseEther("300"), ethers.parseEther("0.000001"));

            // Verify claim works and pays out the full amount
            const balBefore = await raac.balanceOf(await alice.getAddress());
            await maturityVault.connect(alice).claim(await alice.getAddress());
            const balAfter = await raac.balanceOf(await alice.getAddress());
            const claimed = balAfter - balBefore;
            expect(claimed).to.be.closeTo(ethers.parseEther("300"), ethers.parseEther("0.000001"));
        });
    });
});

