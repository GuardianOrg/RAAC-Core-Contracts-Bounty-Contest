import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("RagequitLib", () => {
    let lib;

    beforeEach(async () => {
        // The harness only uses internal RagequitLib functions, so no library linking is needed
        const RagequitHarness = await ethers.getContractFactory("RagequitHarness");
        lib = await RagequitHarness.deploy();
    });

    it("cappedRemaining caps correctly", async () => {
        const now = Math.floor(Date.now() / 1000);
        const week = 7 * 24 * 60 * 60;
        const max = 4 * week;

        const r0 = await lib.cappedRemaining(now - week, now, max);
        expect(r0).to.equal(0);

        const r1 = await lib.cappedRemaining(now + week, now, max);
        expect(r1).to.equal(week);

        const r2 = await lib.cappedRemaining(now + 10 * week, now, max);
        expect(r2).to.equal(max);
    });

    it("computeFeesForLock handles math and edges", async () => {
        const amount = ethers.parseEther("1000");
        const maxDur = 4n * 7n * 24n * 60n * 60n; // 4 weeks
        const remain = maxDur / 2n; // half remaining
        const fixedBps = 500n; // 5%
        const varMaxBps = 2000n; // up to 20%
        const BPS = 10000n;

        const [fixed, variable] = await lib.computeFeesForLock(amount, remain, maxDur, fixedBps, varMaxBps, BPS);
        expect(fixed).to.equal((amount * fixedBps) / BPS);
        const expectedVarBps = (remain * BPS) / maxDur * varMaxBps / BPS;
        expect(variable).to.equal((amount * expectedVarBps) / BPS);

        // zero remaining -> only fixed applies
        const [fixed2, variable2] = await lib.computeFeesForLock(amount, 0, maxDur, fixedBps, varMaxBps, BPS);
        expect(fixed2).to.equal((amount * fixedBps) / BPS);
        expect(variable2).to.equal(0);

        // zero maxDuration -> remaining ratio = 0
        const [fixed3, variable3] = await lib.computeFeesForLock(amount, remain, 0, fixedBps, varMaxBps, BPS);
        expect(fixed3).to.equal((amount * fixedBps) / BPS);
        expect(variable3).to.equal(0);
    });

    it("splitVariable splits 33/67 and preserves sum", async () => {
        const fee = ethers.parseEther("123.4567");
        const [toTreasury, toStream] = await lib.splitVariable(fee);
        expect(toTreasury + toStream).to.equal(fee);
        // rounding down on treasury part ok, check proportion roughly
        expect(toTreasury).to.equal((fee * 33n) / 100n);
        expect(toStream).to.equal(fee - (fee * 33n) / 100n);
    });
});


