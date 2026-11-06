import { expect } from "chai";
import hre from "hardhat";
const { ethers, upgrades } = hre;

// Feature suite for the AMOUNT-BASED unlock variant: requestUnlock(amount) reserves soonest-maturing
// buckets first (FIFO) and partial-reserves the boundary bucket; a health check blocks over-requesting;
// the reserved portion withdraws while the open remainder auto-relocks; yield pays down debt.
describe("RAACLiquidLocker amount-based unlock (partial reservation)", () => {
    const WEEK = 7 * 24 * 3600;
    const E = (n) => ethers.parseEther(n.toString());

    let locker, raac, ve;
    let deployer, claimer, u1, treasury, clever, bot;

    const advanceWeeks = async (n) => {
        await ethers.provider.send("evm_increaseTime", [WEEK * n]);
        await ethers.provider.send("evm_mine", []);
    };
    const claim = async (u, amt) => locker.connect(claimer).depositOnBehalfOf(u.address, E(amt));
    const info = async (u) => {
        const [dep, pend, unl, bor] = await locker.getUserInfo(u.address);
        return { locked: dep, pending: pend, unlocked: unl, debt: bor };
    };

    beforeEach(async () => {
        [deployer, claimer, u1, treasury, clever, bot] = await ethers.getSigners();
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
        await raac.mint(claimer.address, E(100_000_000));
        await raac.connect(claimer).approve(await locker.getAddress(), ethers.MaxUint256);
        await raac.mint(deployer.address, E(10_000_000));
        await raac.connect(deployer).approve(await locker.getAddress(), ethers.MaxUint256);
    });

    it("FIFO + partial: reserves soonest-maturing first and splits the boundary bucket", async () => {
        // three weekly buckets: 1000, 2000, 5000
        await claim(u1, 1000); await advanceWeeks(1);
        await claim(u1, 2000); await advanceWeeks(1);
        await claim(u1, 5000);

        // reserve 3500 -> 1000 (bucket0) + 2000 (bucket1) + 500 of the 5000 (bucket2, partial)
        await locker.connect(u1).requestUnlock(E(3500));

        const arr = await locker.getUserLocks(u1.address);
        expect(arr[0].reservedAmount).to.equal(E(1000)); // fully reserved
        expect(arr[1].reservedAmount).to.equal(E(2000)); // fully reserved
        expect(arr[2].reservedAmount).to.equal(E(500));  // partially reserved
        expect(arr[2].pendingUnlock).to.equal(E(5000));

        // the OPEN (still-reservable) remainder lives in one bucket only: bucket2 has 4500 open
        const open = arr.map((e) => e.pendingUnlock - e.reservedAmount).filter((r) => r > 0n);
        expect(open.length).to.equal(1);
        expect(open[0]).to.equal(E(4500));
        expect((await info(u1)).pending).to.equal(E(3500)); // total scheduled to unlock
    });

    it("blocks requesting MORE THAN the user holds (no debt -> free == totalLocked)", async () => {
        await claim(u1, 1000);
        // requesting more than the 1000 held reverts (free == 1000 with no debt)
        await expect(locker.connect(u1).requestUnlock(E(1001)))
            .to.be.revertedWithCustomError(locker, "InsufficientToUnlock");
        await locker.connect(u1).requestUnlock(E(1000)); // reserving exactly the balance is fine
        expect((await info(u1)).pending).to.equal(E(1000));
    });

    it("health check blocks reserving into the debt's required collateral", async () => {
        await claim(u1, 1000);
        await locker.connect(u1).borrow(E(400), false); // debt 400 -> required 800 -> free = 200
        await expect(locker.connect(u1).requestUnlock(E(201)))
            .to.be.revertedWithCustomError(locker, "InsufficientCollateral");
        await locker.connect(u1).requestUnlock(E(200)); // within free
        const i = await info(u1);
        expect(i.locked - i.pending).to.be.gte(i.debt * 2n); // remaining locked still backs the debt
    });

    it("symmetric invariant: cannot BORROW against already-reserved collateral", async () => {
        await claim(u1, 1000);
        await locker.connect(u1).requestUnlock(E(600)); // reserve 600 -> only 400 unreserved
        // unreserved 400 backs at most 200 debt; borrowing 300 would need 600 unreserved -> revert
        await expect(locker.connect(u1).borrow(E(300), false))
            .to.be.revertedWithCustomError(locker, "InsufficientCollateral");
        await locker.connect(u1).borrow(E(200), false); // 400 unreserved backs 200 -> ok
        expect((await info(u1)).debt).to.equal(E(200));
    });

    it("partial reservation: reserved part withdraws, open remainder auto-relocks", async () => {
        await claim(u1, 1000);
        await locker.connect(u1).requestUnlock(E(600)); // 600 reserved, 400 open (no debt)

        await advanceWeeks(54);
        await locker.connect(deployer).processVaultExpiredLocks();
        const before = await raac.balanceOf(u1.address);
        await locker.connect(u1).withdrawUnlocked();
        expect((await raac.balanceOf(u1.address)) - before).to.equal(E(600)); // reserved paid out

        const i = await info(u1);
        expect(i.locked).to.equal(E(400)); // the open 400 relocked and stays locked
        expect(i.unlocked).to.equal(0n);
    });

    it("invariant: reserved buckets form a contiguous prefix with <=1 partial (early-exit safe)", async () => {
        await claim(u1, 1000); await advanceWeeks(1);
        await claim(u1, 2000); await advanceWeeks(1);
        await claim(u1, 3000);
        await locker.connect(u1).requestUnlock(E(2500)); // 1000 full + 1500-of-2000 partial
        await advanceWeeks(1);
        await claim(u1, 500);                             // new open bucket at the tail
        await locker.connect(u1).requestUnlock(E(1000)); // fills the 2000 partial, then into the 3000

        // getUserLocks already returns the live slice (from nextUnlockIndex, future epochs only)
        const arr = await locker.getUserLocks(u1.address);
        let seenOpen = false, partials = 0;
        for (let i = 0; i < arr.length; i++) {
            const r = arr[i].reservedAmount, p = arr[i].pendingUnlock;
            if (r === 0n) { seenOpen = true; continue; }
            expect(seenOpen, "a reserved bucket appears after an open one -> prefix broken").to.equal(false);
            if (r < p) partials++;
        }
        expect(partials, "more than one partially-reserved bucket").to.be.lte(1);
    });

    it("merge-into-reserved: a same-epoch deposit folds into a reserved bucket's OPEN portion (bounded)", async () => {
        await claim(u1, 1000);
        await locker.connect(u1).requestUnlock(E(1000)); // fully reserve the epoch-E bucket
        await claim(u1, 100);                            // same-epoch deposit -> merges, not a new bucket

        const live = (await locker.getUserLocks(u1.address)).filter((e) => e.pendingUnlock > 0n);
        expect(live.length).to.equal(1);                  // one bucket, not two
        expect(live[0].pendingUnlock).to.equal(E(1100));  // total grew
        expect(live[0].reservedAmount).to.equal(E(1000)); // the added 100 is OPEN, not reserved

        // open remainder still reservable
        expect(live[0].pendingUnlock - live[0].reservedAmount).to.equal(E(100));
    });

    it("end-to-end: borrow, reserve free amount, yield burns debt, withdraw more over time", async () => {
        await claim(u1, 6000);
        await locker.connect(u1).borrow(E(2500), false); // debt 2500 -> required 5000 -> free 1000
        // can only reserve the free 1000 right now
        await expect(locker.connect(u1).requestUnlock(E(1500)))
            .to.be.revertedWithCustomError(locker, "InsufficientCollateral");
        await locker.connect(u1).requestUnlock(E(1000));

        // yield pays the debt down -> free grows -> can reserve more
        await locker.connect(deployer).donate(E(1250)); // debt ~1250 -> required ~2500 -> free ~2500 more
        expect((await info(u1)).debt).to.be.closeTo(E(1250), E("0.001"));
        await locker.connect(u1).requestUnlock(E(2000)); // now allowed (was blocked before)
        expect((await info(u1)).pending).to.equal(E(3000));

        await locker.connect(deployer).donate(E(1250)); // debt -> ~0
        await advanceWeeks(54);
        await locker.connect(deployer).processVaultExpiredLocks();
        const before = await raac.balanceOf(u1.address);
        await locker.connect(u1).withdrawUnlocked();
        // reserved 3000 matured; debt burned to ~0 -> pays out ~3000
        expect((await raac.balanceOf(u1.address)) - before).to.be.closeTo(E(3000), E("0.01"));
    });
});
