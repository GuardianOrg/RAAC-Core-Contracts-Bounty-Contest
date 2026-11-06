import { expect } from "chai";
import hre from "hardhat";
const { ethers, upgrades } = hre;

// End-to-end / multi-user simulations for the amount-based unlock variant. Covers users doing different
// actions across many weeks: mixed deposits/borrows/reserves/yield/withdrawals, long inactivity, a
// two-year weekly cycle (entry-count bound), and the sync/getMaturedLocks idle-account flow.
describe("RAACLiquidLocker amount-based simulations (e2e / multi-user)", () => {
    const WEEK = 7 * 24 * 3600;
    const E = (n) => ethers.parseEther(n.toString());
    const f = (x) => ethers.formatEther(x);

    let locker, raac, ve;
    let deployer, claimer, u1, u2, u3, u4, u5, treasury, clever, bot;

    const advanceWeeks = async (n) => {
        await ethers.provider.send("evm_increaseTime", [WEEK * n]);
        await ethers.provider.send("evm_mine", []);
    };
    const claim = async (u, amt) => locker.connect(claimer).depositOnBehalfOf(u.address, E(amt));
    const info = async (u) => {
        const [dep, pend, unl, bor] = await locker.getUserInfo(u.address);
        return { locked: dep, pending: pend, unlocked: unl, debt: bor };
    };
    const tryReserve = async (u, amt) => { try { await locker.connect(u).requestUnlock(E(amt)); return true; } catch { return false; } };

    beforeEach(async () => {
        [deployer, claimer, u1, u2, u3, u4, u5, treasury, clever, bot] = await ethers.getSigners();
        const SimToken = await ethers.getContractFactory("SimToken");
        raac = await SimToken.deploy("RAAC", "RAAC");
        const leRAAC = await SimToken.deploy("leRAAC", "leRAAC");
        const inter = await SimToken.deploy("crvUSD", "crvUSD");
        const SimVe = await ethers.getContractFactory("SimVe");
        ve = await SimVe.deploy(await raac.getAddress());
        const SimVault = await ethers.getContractFactory("SimVault");
        const vault = await SimVault.deploy(await raac.getAddress());
        const SimStub = await ethers.getContractFactory("SimStub");
        const zap = await SimStub.deploy();

        const Locker = await ethers.getContractFactory("RAACLiquidLocker");
        locker = await upgrades.deployProxy(
            Locker,
            [
                await raac.getAddress(), await leRAAC.getAddress(), await ve.getAddress(),
                await vault.getAddress(), await zap.getAddress(), await inter.getAddress(),
                treasury.address, clever.address, bot.address, 0, 0, 0, 0, 0,
            ],
            { initializer: "initialize", unsafeAllow: ["constructor"] }
        );
        await locker.grantRole(await locker.ON_BEHALF_OF_ROLE(), claimer.address);
        await locker.updateWhitelist(deployer.address, true);
        await raac.mint(claimer.address, E(1_000_000_000));
        await raac.connect(claimer).approve(await locker.getAddress(), ethers.MaxUint256);
        await raac.mint(deployer.address, E(100_000_000));
        await raac.connect(deployer).approve(await locker.getAddress(), ethers.MaxUint256);
    });

    it("multi-user narrative: mixed deposits/borrows/reserves/yield/withdrawals stay consistent & backed", async () => {
        // wk0 deposits (u1 multi-claim merges)
        await claim(u1, 1000); await claim(u1, 500);
        await claim(u2, 3000);
        await claim(u3, 2000);
        await claim(u4, 4000);
        await advanceWeeks(1);
        await claim(u1, 2000); await claim(u2, 1000); await claim(u5, 1500);

        // borrows (u1, u2, u5)
        await locker.connect(u1).borrow(E(500), false);
        await locker.connect(u2).borrow(E(1500), false);
        await locker.connect(u5).borrow(E(500), false);

        // reserves (amount-based, within each user's free headroom)
        await locker.connect(u1).requestUnlock(E(1000)); // free 3500-1000=2500
        await locker.connect(u2).requestUnlock(E(1000)); // free 4000-3000=1000
        await locker.connect(u3).requestUnlock(E(2000)); // no debt
        await locker.connect(u4).requestUnlock(E(1500)); // no debt

        // a borrow against reserved must be rejected for u3 (fully reserved -> 0 unreserved)
        await expect(locker.connect(u3).borrow(E(100), false)).to.be.revertedWithCustomError(locker, "InsufficientCollateral");

        // yield twice
        await locker.connect(deployer).donate(E(600));
        await advanceWeeks(2);
        await locker.connect(deployer).donate(E(1200));

        // late deposit after reserving (merges/append)
        await claim(u1, 700);

        // advance to maturity, keeper processes, everyone withdraws
        await advanceWeeks(53);
        await locker.connect(deployer).processVaultExpiredLocks();
        for (const u of [u1, u2, u3, u4, u5]) {
            try { await locker.connect(u).withdrawUnlocked(); } catch { /* nothing matured */ }
        }

        // INVARIANTS: every user still backed (no bad debt); globals reconcile with per-user totals
        await locker.connect(deployer).processVaultExpiredLocks();
        let sumLocked = 0n, sumUnlocked = 0n;
        for (const u of [u1, u2, u3, u4, u5]) {
            const i = await info(u);
            expect(i.locked, `${u.address.slice(0, 6)} backed`).to.be.gte(i.debt * 2n); // reserveRate 50%
            sumLocked += i.locked; sumUnlocked += i.unlocked;
        }
        expect(await locker.totalLockedGlobal()).to.equal(sumLocked);
        expect(await locker.totalUnlockedGlobal()).to.equal(sumUnlocked);
        console.log("\n-- multi-user narrative: all positions backed & globals reconciled --");
    });

    it("five-year inactivity: reserved recovers in full, unreserved auto-relocks (nothing lost)", async () => {
        await claim(u1, 2000);                             // stays unreserved
        await claim(u2, 2000);
        await locker.connect(u2).requestUnlock(E(2000));   // u2 reserves all (no debt)

        await advanceWeeks(52 * 5);                        // 5 years idle
        await locker.connect(deployer).processVaultExpiredLocks();

        // u2's reserved matured -> fully withdrawable
        const b2 = await raac.balanceOf(u2.address);
        await locker.connect(u2).withdrawUnlocked();
        expect((await raac.balanceOf(u2.address)) - b2).to.equal(E(2000));

        // u1's unreserved rolls forward -> still locked, nothing lost. getUserInfo previews the
        // roll for an idle account, so no per-user checkpoint call is needed to observe it.
        expect((await info(u1)).locked).to.equal(E(2000));
        expect((await info(u1)).unlocked).to.equal(0n);
    });

    it("two-year weekly claim cycle: live entries stay bounded (~one bucket per future epoch)", async () => {
        for (let wk = 0; wk < 104; wk++) {
            await claim(u1, 100);                 // gauge-style weekly claim
            if (wk > 0 && wk % 8 === 0) await tryReserve(u1, 50); // occasionally reserve (merges, no new bucket)
            await advanceWeeks(1);
        }
        // the final claim above already checkpointed u1 (depositOnBehalfOf rolls matured entries)
        const live = (await locker.getUserLocks(u1.address)).filter((e) => e.pendingUnlock > 0n);
        expect(live.length, "live entries bounded to ~lockDurationEpochs").to.be.lte(54);
        console.log(`\n-- 2-year cycle: ${live.length} live entries after 104 weekly claims + periodic reserves --`);
    });

    it("rolls an idle account's matured unreserved entry back into a live bucket", async () => {
        await claim(u1, 1000);
        await advanceWeeks(60);                            // matures while idle
        await locker.connect(deployer).processVaultExpiredLocks();

        // Unreserved and matured: nothing is withdrawable, the position stays locked
        expect((await info(u1)).locked).to.equal(E(1000));
        expect((await info(u1)).unlocked).to.equal(0n);
        await expect(locker.connect(u1).withdrawUnlocked()).to.be.revertedWithCustomError(
            locker,
            "InsufficientUnlocked"
        );

        // Once rolled, the amount is reservable again at the new epoch
        await locker.connect(u1).requestUnlock(E(1000));
        expect((await info(u1)).pending).to.equal(E(1000));
        const live = (await locker.getUserLocks(u1.address)).filter((e) => e.pendingUnlock > 0n);
        expect(live.length).to.equal(1);
        expect(live[0].reservedAmount).to.equal(E(1000));
    });
});
