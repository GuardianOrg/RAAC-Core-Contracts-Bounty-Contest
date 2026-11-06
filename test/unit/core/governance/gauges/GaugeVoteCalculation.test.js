import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * GaugeVoteCalculation — validates the GaugeController vote-weight math end to end.
 *
 * Covers:
 *   1. Baseline: with NO votes the system behaves correctly (gauges weigh 0, no reverts).
 *   2. Weekly (Thursday) correctness: a voted gauge's weight equals the true per-lock decay
 *      at every epoch, decays correctly with no further action, and reaches 0 at expiry.
 *   3. Aggregation + relative weights across multiple voters / gauges.
 *   4. Revote: changing weight / gauge / resetting updates the weights correctly with no
 *      phantom decay left behind.
 *
 * The on-chain gauge weight is produced by the lazy `_getWeight` walk (decay + scheduled
 * drops). We compare it to the independently-computed "true" bias = Σ allocatedᵢ·(endᵢ−t)/maxTime,
 * read from the user's actual on-chain locks. They must agree to within integer dust.
 */
describe("GaugeVoteCalculation", () => {
    const DAY = 24 * 3600;
    const WEEK = 7 * DAY;
    const MAX_LOCK_EPOCHS = 52;

    let owner, u1, u2, u3, controller, veToken, raac;
    let gA, gB, gC;
    let MAXTIME;

    // ---- integer-faithful expected math (mirrors the contract) ----
    // allocatedᵢ = floor(amountᵢ · weightBps / 10000); biasᵢ = floor(allocatedᵢ · (endᵢ − t) / maxTime)
    function allocBias(locks, weightBps, t) {
        let s = 0n;
        for (const { amount, unlock } of locks) {
            if (unlock <= t) continue;
            const allocated = (amount * BigInt(weightBps)) / 10000n;
            s += (allocated * (unlock - t)) / MAXTIME;
        }
        return s;
    }
    // a gauge's expected bias = sum over its contributors {locks, weightBps}
    function expectedGauge(contributors, t) {
        let s = 0n;
        for (const c of contributors) s += allocBias(c.locks, c.weightBps, t);
        return s;
    }
    // assert two big numbers agree within integer dust (0.1% relative + 1e12 wei floor) —
    // tight enough to catch any logic error, loose enough to ignore per-week rounding.
    function closeBig(actual, expected, msg) {
        const a = BigInt(actual), e = BigInt(expected);
        const diff = a > e ? a - e : e - a;
        const tol = e / 1000n + 10n ** 12n;
        expect(diff <= tol, `${msg}: got ${a} expected ${e} (diff ${diff} > tol ${tol})`).to.equal(true);
    }

    async function deploy() {
        const s = await ethers.getSigners();
        [owner, u1, u2, u3] = s;
        // addGauge probes IBaseGauge(gauge).isPaused(), so gauges must be contracts, not EOAs
        const GaugeStub = await ethers.getContractFactory("MockGaugeStub");
        const stubs = [];
        for (let i = 0; i < 3; i++) {
            const stub = await GaugeStub.deploy();
            await stub.waitForDeployment();
            stubs.push(await stub.getAddress());
        }
        [gA, gB, gC] = stubs;

        const MockRAAC = await ethers.getContractFactory("ERC20BurnableMock");
        raac = await MockRAAC.deploy("RAAC", "RAAC", 18); await raac.waitForDeployment();
        const LM = await (await ethers.getContractFactory("LockManager")).deploy(); await LM.waitForDeployment();
        const RQ = await (await ethers.getContractFactory("RagequitLib", { libraries: { LockManager: LM.target } })).deploy(); await RQ.waitForDeployment();
        const PC = await (await ethers.getContractFactory("PowerCheckpoint", { libraries: { LockManager: LM.target } })).deploy(); await PC.waitForDeployment();
        const RW = await (await ethers.getContractFactory("RewardLib", { libraries: { LockManager: LM.target } })).deploy(); await RW.waitForDeployment();
        const Ve = await ethers.getContractFactory("VeRAACToken", { libraries: { RagequitLib: RQ.target, PowerCheckpoint: PC.target, LockManager: LM.target, RewardLib: RW.target } });
        veToken = await Ve.deploy(await raac.getAddress(), owner.address, MAX_LOCK_EPOCHS); await veToken.waitForDeployment();
        const GC = await ethers.getContractFactory("GaugeController");
        controller = await GC.deploy(await veToken.getAddress()); await controller.waitForDeployment();
        await controller.grantRole(await controller.GAUGE_ADMIN(), owner.address);
        // addGauge requires a distributor to be configured on the controller
        const Dist = await ethers.getContractFactory("GaugeRewardsDistributor");
        const dist = await Dist.deploy(await controller.getAddress(), await raac.getAddress());
        await dist.waitForDeployment();
        await controller.setDistributor(await dist.getAddress());
        await controller.connect(owner).addGauge(gA);
        await controller.connect(owner).addGauge(gB);
        await controller.connect(owner).addGauge(gC);
        for (const u of [u1, u2, u3]) {
            await raac.mint(u.address, ethers.parseEther("10000000"));
            await raac.connect(u).approve(await veToken.getAddress(), ethers.MaxUint256);
        }
        const [, mle, ed] = await veToken.getGlobalLockInfo();
        MAXTIME = BigInt(mle) * BigInt(ed);
    }

    // create the given locks for `user`, return the on-chain snapshot [{amount, unlock}]
    async function lockFor(user, specs /* [{eth, epochs}] */) {
        for (const sp of specs) await veToken.connect(user).lock(ethers.parseEther(String(sp.eth)), sp.epochs);
        const raw = await veToken.getLocks(user.address);
        return raw.map((l) => ({ amount: BigInt(l.amount), unlock: BigInt(l.unlockTime) }));
    }

    // checkpoint a gauge to now and read (epoch, weight)
    async function gaugeWeightNow(gauge) {
        await controller.forceCompleteCheckpoint(gauge);
        return {
            tw: BigInt(await controller.timeWeight(gauge)),
            w: BigInt(await controller.getGaugeWeight(gauge)),
        };
    }

    // walk week-by-week up to `untilEpoch`, returning samples for one gauge
    async function weekly(gauge, untilEpoch) {
        const out = [];
        let guard = 0;
        while (guard++ < 70) {
            const { tw, w } = await gaugeWeightNow(gauge);
            out.push({ tw, w });
            if (tw >= untilEpoch) break;
            await time.increase(WEEK);
        }
        return out;
    }

    beforeEach(deploy);

    /* ───────────────────────── 1. baseline: no votes ───────────────────────── */
    describe("baseline — no one votes", () => {
        it("an unvoted gauge has zero weight, now and after weeks pass", async () => {
            let { w } = await gaugeWeightNow(gA);
            expect(w).to.equal(0n);
            await time.increase(WEEK * 8);
            ({ w } = await gaugeWeightNow(gA));
            expect(w).to.equal(0n);
        });

        it("total weight is 0 and relative weight returns (0,0) when nobody has voted", async () => {
            expect(await controller.getTotalWeight()).to.equal(0n);
            const epoch = await controller.getCurrentEpoch();
            const [rel, tot] = await controller.getGaugeRelativeWeight.staticCall(gA, epoch);
            expect(rel).to.equal(0n);
            expect(tot).to.equal(0n);
        });

        it("voting gauge A gives ZERO weight to the unvoted gauges B and C", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(WEEK * 2);
            expect((await gaugeWeightNow(gA)).w).to.be.gt(0n);
            expect((await gaugeWeightNow(gB)).w).to.equal(0n);
            expect((await gaugeWeightNow(gC)).w).to.equal(0n);
        });
    });

    /* ──────────────── 2. weekly (Thursday) correctness — passive decay ──────────────── */
    describe("weekly correctness — gauge weight tracks the true per-lock decay", () => {
        it("matches the true bias at EVERY Thursday and decays to 0 at expiry (no further action)", async () => {
            const L = await lockFor(u1, [{ eth: 500, epochs: 4 }, { eth: 500, epochs: 18 }]);
            await controller.connect(u1).vote(gA, 10000);
            const last = L.reduce((m, l) => (l.unlock > m ? l.unlock : m), 0n);
            const samples = await weekly(gA, last + BigInt(WEEK));

            // user does nothing after voting — every weekly weight must equal the true decay
            for (const { tw, w } of samples) {
                closeBig(w, expectedGauge([{ locks: L, weightBps: 10000 }], tw), `wk@${tw}`);
            }
            // and it must be exactly zero once both locks have expired
            expect(samples[samples.length - 1].w).to.equal(0n);
        });

        it("a partial-weight vote scales the gauge weight proportionally", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 10 }]);
            await controller.connect(u1).vote(gA, 3000); // 30%
            await time.increase(WEEK * 3);
            const { tw, w } = await gaugeWeightNow(gA);
            closeBig(w, expectedGauge([{ locks: L, weightBps: 3000 }], tw), "30% weight");
        });

        it("the lazy checkpoint over a long idle gap yields the same weight as stepping weekly", async () => {
            const L = await lockFor(u1, [{ eth: 800, epochs: 16 }]);
            await controller.connect(u1).vote(gA, 10000);
            // jump 9 weeks in one go, then checkpoint once
            await time.increase(WEEK * 9);
            const { tw, w } = await gaugeWeightNow(gA);
            closeBig(w, expectedGauge([{ locks: L, weightBps: 10000 }], tw), "long-gap checkpoint");
        });
    });

    /* ──────────────── 3. aggregation + relative weights ──────────────── */
    describe("aggregation across voters and gauges", () => {
        it("two voters on the SAME gauge sum their contributions", async () => {
            const L1 = await lockFor(u1, [{ eth: 600, epochs: 14 }]);
            const L2 = await lockFor(u2, [{ eth: 400, epochs: 8 }]);
            await controller.connect(u1).vote(gA, 10000);
            await controller.connect(u2).vote(gA, 10000);
            await time.increase(WEEK * 5);
            const { tw, w } = await gaugeWeightNow(gA);
            closeBig(w, expectedGauge([
                { locks: L1, weightBps: 10000 },
                { locks: L2, weightBps: 10000 },
            ], tw), "two voters same gauge");
        });

        it("relative weights split correctly across two gauges and the sum is consistent", async () => {
            const L1 = await lockFor(u1, [{ eth: 1000, epochs: 20 }]);          // gauge A
            const L2 = await lockFor(u2, [{ eth: 300, epochs: 6 }, { eth: 300, epochs: 16 }]); // gauge B
            await controller.connect(u1).vote(gA, 10000);
            await controller.connect(u2).vote(gB, 10000);
            await time.increase(WEEK * 4);

            const a = await gaugeWeightNow(gA);
            const b = await gaugeWeightNow(gB);
            await controller.forceCompleteCheckpoint(gA); // advance global sum (also runs _getSum; ZeroAddress is no longer accepted)
            const total = BigInt(await controller.getTotalWeight());

            closeBig(a.w, expectedGauge([{ locks: L1, weightBps: 10000 }], a.tw), "gauge A");
            closeBig(b.w, expectedGauge([{ locks: L2, weightBps: 10000 }], b.tw), "gauge B");
            // total == A + B (they're the only voted gauges)
            closeBig(total, a.w + b.w, "total == A + B");

            // relative weight of A from the controller matches A/(A+B)
            const [relA] = await controller.getGaugeRelativeWeight.staticCall(gA, a.tw);
            const expRelA = (a.w * 10n ** 18n) / (a.w + b.w);
            closeBig(relA, expRelA, "relWeight A");
        });

        it("a user can SPLIT their power across two gauges (60/40)", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 6000);
            await controller.connect(u1).vote(gB, 4000);
            await time.increase(WEEK * 3);
            const a = await gaugeWeightNow(gA);
            const b = await gaugeWeightNow(gB);
            closeBig(a.w, expectedGauge([{ locks: L, weightBps: 6000 }], a.tw), "split 60% A");
            closeBig(b.w, expectedGauge([{ locks: L, weightBps: 4000 }], b.tw), "split 40% B");
            // the two together equal a 100% vote of the same locks
            closeBig(a.w + b.w, expectedGauge([{ locks: L, weightBps: 10000 }], a.tw), "60+40 == 100%");
        });
    });

    /* ──────────────── 4. revote — changing the vote ──────────────── */
    describe("revote — changes update the weight correctly", () => {
        it("revoting the same gauge with a LOWER weight reduces it proportionally", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 16 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(11 * DAY); // clear the 10-day cooldown
            await controller.connect(u1).vote(gA, 4000); // revote to 40%
            await time.increase(WEEK * 2);
            const { tw, w } = await gaugeWeightNow(gA);
            closeBig(w, expectedGauge([{ locks: L, weightBps: 4000 }], tw), "after revote to 40%");
        });

        it("revoting to weight 0 removes the gauge's contribution entirely (now and forever)", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 14 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(11 * DAY);
            await controller.connect(u1).vote(gA, 0); // reset
            // immediately after reset the `locked` contribution is removed; at most integer
            // reconstruction dust (a few wei) may remain in `bias`, which the next walk zeroes.
            expect((await gaugeWeightNow(gA)).w, "reset leaves at most dust").to.be.lte(1000n);
            // and it is exactly zero once any time passes (no phantom decay left scheduled)
            await time.increase(WEEK * 12);
            expect((await gaugeWeightNow(gA)).w).to.equal(0n);
        });

        it("moving power from gauge A to gauge B shifts the weight across", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 18 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(11 * DAY);
            // free A, then put 100% on B
            await controller.connect(u1).vote(gA, 0);
            await controller.connect(u1).vote(gB, 10000);
            await time.increase(WEEK * 2);
            expect((await gaugeWeightNow(gA)).w).to.equal(0n);
            const b = await gaugeWeightNow(gB);
            closeBig(b.w, expectedGauge([{ locks: L, weightBps: 10000 }], b.tw), "moved to B");
        });

        it("after a revote there is NO phantom decay — weight still reaches exactly 0 at expiry", async () => {
            const L = await lockFor(u1, [{ eth: 500, epochs: 6 }, { eth: 500, epochs: 20 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(11 * DAY);
            await controller.connect(u1).vote(gA, 8000); // revote mid-life
            const last = L.reduce((m, l) => (l.unlock > m ? l.unlock : m), 0n);
            const samples = await weekly(gA, last + BigInt(WEEK));
            // never exceeds the 80%-of-true envelope, and ends at exactly 0
            for (const { tw, w } of samples) {
                const cap = expectedGauge([{ locks: L, weightBps: 8000 }], tw);
                expect(w <= cap + cap / 100n + 10n ** 15n, `wk@${tw}: ${w} > cap ${cap}`).to.equal(true);
            }
            expect(samples[samples.length - 1].w).to.equal(0n);
        });

        it("revoting the same gauge before the 10-day cooldown reverts", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(5 * DAY); // < 10 days
            await expect(controller.connect(u1).vote(gA, 5000))
                .to.be.revertedWithCustomError(controller, "VoteDelayNotElapsed");
        });
    });

    /* ─────────────── 5. K-bucket approximation path ─────────────── */
    describe("K-bucket path (maxVoteBuckets > 0)", () => {
        async function entryCount(user, gauge) {
            let n = 0;
            while (true) { try { await controller.voteUserLockEntries(user, gauge, n); n++; } catch { break; } }
            return n;
        }

        it("a user with <= K locks still uses the EXACT path (one entry per lock, 0 error)", async () => {
            await controller.connect(owner).setMaxVoteBuckets(3);
            const L = await lockFor(u1, [{ eth: 500, epochs: 6 }, { eth: 500, epochs: 18 }]); // 2 <= 3
            await controller.connect(u1).vote(gA, 10000);
            expect(await entryCount(u1.address, gA)).to.equal(2);
            await time.increase(WEEK * 4);
            const { tw, w } = await gaugeWeightNow(gA);
            closeBig(w, expectedGauge([{ locks: L, weightBps: 10000 }], tw), "exact under K=3");
        });

        it("a user with > K locks is bucketed (<= K entries) and stays within a small bounded error", async () => {
            await controller.connect(owner).setMaxVoteBuckets(3);
            const L = await lockFor(u1, [
                { eth: 200, epochs: 3 }, { eth: 200, epochs: 7 }, { eth: 200, epochs: 11 },
                { eth: 200, epochs: 15 }, { eth: 200, epochs: 19 }, { eth: 200, epochs: 23 },
            ]); // 6 > 3
            await controller.connect(u1).vote(gA, 10000);
            expect(await entryCount(u1.address, gA)).to.be.lte(3);

            const last = L.reduce((m, l) => (l.unlock > m ? l.unlock : m), 0n);
            const samples = await weekly(gA, last + BigInt(WEEK));
            let cumTrue = 0n, cumRec = 0n;
            for (const { tw, w } of samples) { cumTrue += expectedGauge([{ locks: L, weightBps: 10000 }], tw); cumRec += w; }
            const diff = cumRec > cumTrue ? cumRec - cumTrue : cumTrue - cumRec;
            expect(diff <= cumTrue / 20n, `bucketed cumulative within 5%: ${cumRec} vs ${cumTrue}`).to.equal(true);
            expect(samples[samples.length - 1].w).to.equal(0n); // still reaches 0 at expiry
        });

        it("a bucketed vote reverses cleanly on revote (no phantom decay, ends at 0)", async () => {
            await controller.connect(owner).setMaxVoteBuckets(3);
            const L = await lockFor(u1, [
                { eth: 200, epochs: 3 }, { eth: 200, epochs: 7 }, { eth: 200, epochs: 11 }, { eth: 200, epochs: 15 },
            ]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(11 * DAY);
            await controller.connect(u1).vote(gA, 5000);
            const last = L.reduce((m, l) => (l.unlock > m ? l.unlock : m), 0n);
            const samples = await weekly(gA, last + BigInt(WEEK));
            expect(samples[samples.length - 1].w).to.equal(0n);
        });
    });

    /* ─────────────── 6. kick — removing the votes of a ragequit user ─────────────── */
    describe("kick on ragequit", () => {
        it("reverts while the user still has power (no pending ragequit)", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 10000);
            await expect(controller.kick(u1.address))
                .to.be.revertedWithCustomError(controller, "UserStillHasPower");
        });

        it("after ragequit, kick removes the vote and zeroes the user's allocated power", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(WEEK);
            expect((await gaugeWeightNow(gA)).w).to.be.gt(0n);

            await veToken.connect(u1).ragequitAll();   // user exits -> pending ragequit
            await controller.kick(u1.address);          // anyone can kick

            closeBig((await gaugeWeightNow(gA)).w, 0n, "kicked gauge ~ 0");
            expect(await controller.voteUserPower(u1.address)).to.equal(0n);
        });

        it("kick clears the user across ALL gauges they voted", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 14 }]);
            await controller.connect(u1).vote(gA, 6000);
            await controller.connect(u1).vote(gB, 4000);
            await time.increase(WEEK);
            await veToken.connect(u1).ragequitAll();
            await controller.kick(u1.address);
            closeBig((await gaugeWeightNow(gA)).w, 0n, "gA ~ 0");
            closeBig((await gaugeWeightNow(gB)).w, 0n, "gB ~ 0");
            expect(await controller.voteUserPower(u1.address)).to.equal(0n);
        });
    });

    /* ─────────────── 7. gauge removal & releasing power ─────────────── */
    describe("gauge removal & removePowerFromGauge", () => {
        it("removeGauge strips the gauge's weight from the global total", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 16 }]);
            await lockFor(u2, [{ eth: 1000, epochs: 16 }]);
            await controller.connect(u1).vote(gA, 10000);
            await controller.connect(u2).vote(gB, 10000);
            await time.increase(WEEK);
            await controller.forceCompleteCheckpoint(gA);
            await controller.forceCompleteCheckpoint(gB);
            const totalBefore = BigInt(await controller.getTotalWeight());
            const bWeight = BigInt(await controller.getGaugeWeight(gB));
            expect(totalBefore).to.be.gt(0n);

            await controller.connect(owner).removeGauge(gB, owner.address);
            await controller.forceCompleteCheckpoint(gA); // ZeroAddress no longer accepted; gA is still active
            const totalAfter = BigInt(await controller.getTotalWeight());
            closeBig(totalAfter, totalBefore - bWeight, "total drops by gauge B");
            expect(await controller.isGaugeActive(gB)).to.equal(false);
        });

        it("removePowerFromGauge reverts while the gauge is still active", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 10000);
            await expect(controller.connect(u1).removePowerFromGauge(gA))
                .to.be.revertedWithCustomError(controller, "ActiveGauge");
        });

        it("after a gauge is removed the voter can release their allocated power", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 7000);
            expect(await controller.voteUserPower(u1.address)).to.equal(7000n);
            await controller.connect(owner).removeGauge(gA, owner.address);
            await controller.connect(u1).removePowerFromGauge(gA);
            expect(await controller.voteUserPower(u1.address)).to.equal(0n);
        });
    });

    /* ─────────────── 8. vote validation & guards ─────────────── */
    describe("vote validation & guards", () => {
        it("rejects weight above MAX_VOTE_WEIGHT", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await expect(controller.connect(u1).vote(gA, 10001))
                .to.be.revertedWithCustomError(controller, "InvalidWeight");
        });
        it("rejects a non-zero weight below MIN_VOTE_WEIGHT (1%)", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await expect(controller.connect(u1).vote(gA, 50))
                .to.be.revertedWithCustomError(controller, "VoteWeightTooLow");
        });
        it("rejects allocating more than 100% of your power across gauges", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            await controller.connect(u1).vote(gA, 6000);
            await expect(controller.connect(u1).vote(gB, 6000))
                .to.be.revertedWithCustomError(controller, "InvalidWeight");
        });
        it("rejects voting on an inactive/unknown gauge", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 12 }]);
            const ghost = (await ethers.getSigners())[15].address;
            await expect(controller.connect(u1).vote(ghost, 10000))
                .to.be.revertedWithCustomError(controller, "GaugeNotActive");
        });
        it("rejects voting with no live lock (user never locked)", async () => {
            await expect(controller.connect(u3).vote(gA, 10000))
                .to.be.revertedWithCustomError(controller, "LockExpiresSoon");
        });
    });

    /* ─────────────── 9. snapshot semantics (Curve-style, intended) ─────────────── */
    describe("vote uses a lock snapshot taken at vote time", () => {
        it("increasing a lock AFTER voting does not change the gauge weight until revote", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 16 }]);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(WEEK);

            // add more veRAAC to the same lock end
            await veToken.connect(u1).increase(ethers.parseEther("1000"), Number(L[0].unlock));
            const snap2 = (await veToken.getLocks(u1.address)).map((l) => ({ amount: BigInt(l.amount), unlock: BigInt(l.unlockTime) }));

            // gauge weight still reflects the ORIGINAL 1000, not the new 2000
            await time.increase(WEEK);
            const mid = await gaugeWeightNow(gA);
            const doubled = expectedGauge([{ locks: snap2, weightBps: 10000 }], mid.tw); // would be ~2x
            expect(mid.w < doubled, "weight must NOT include the post-vote increase").to.equal(true);

            // after a revote it picks up the larger amount
            await time.increase(11 * DAY);
            await controller.connect(u1).vote(gA, 10000);
            await time.increase(WEEK);
            const after = await gaugeWeightNow(gA);
            closeBig(after.w, expectedGauge([{ locks: snap2, weightBps: 10000 }], after.tw), "revote reflects 2000");
        });
    });

    /* ─────────────── 10. batchVote ─────────────── */
    describe("batchVote", () => {
        it("votes multiple gauges in one tx with correct per-gauge weights", async () => {
            const L = await lockFor(u1, [{ eth: 1000, epochs: 14 }]);
            await controller.connect(u1).batchVote([gA, gB], [7000, 3000]);
            await time.increase(WEEK * 3);
            const a = await gaugeWeightNow(gA);
            const b = await gaugeWeightNow(gB);
            closeBig(a.w, expectedGauge([{ locks: L, weightBps: 7000 }], a.tw), "batch A 70%");
            closeBig(b.w, expectedGauge([{ locks: L, weightBps: 3000 }], b.tw), "batch B 30%");
        });
        it("rejects a batch whose total weight exceeds 100%", async () => {
            await lockFor(u1, [{ eth: 1000, epochs: 14 }]);
            await expect(controller.connect(u1).batchVote([gA, gB], [6000, 5000]))
                .to.be.revertedWithCustomError(controller, "InvalidWeight");
        });
    });
});
