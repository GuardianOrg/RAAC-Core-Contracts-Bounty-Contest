// SPDX-License-Identifier: MIT
//
// Fresh Zeno test suite — scenario-based with a decimals matrix.
//
// Covers:
//   1.  Constructor validation (zero addrs, time/price/maturity ordering, prefill check)
//   2.  Decimals matrix (D_pay, D_zeno) ∈ {(6,6), (6,18), (18,6), (18,18)}
//   3.  Rounding invariants (every division must favor the protocol)
//   4.  Dutch price curve (boundaries + linear interpolation)
//   5.  Fixed-price mode (startingPrice == reservePrice)
//   6.  Buy flow (slippage, insufficient, sold-out, lifecycle)
//   7.  Self-buy (ION scenario — issuer == buyer)
//   8.  Redemption (pre/post maturity, solvency check, cross-decimal)
//   9.  sweepSurplus (gating, surplus calc, ownership)
//   10. Counters (totalMinted monotonic, totalRemaining survives burns)
//   11. End-to-end product scenarios (discount bond, fixed-price, prefilled self-buy)
//
// No mainnet fork. Pure local hardhat-network.

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & enums
// ─────────────────────────────────────────────────────────────────────────────

const FundingMode = { Prefilled: 0, Float: 1 };
const DAY = 24n * 3600n;
const YEAR = 365n * DAY;

// ─────────────────────────────────────────────────────────────────────────────
// BigInt math helpers — mirror exactly what the contract does so tests can
// predict zenoOut, price, surplus etc. without relying on the contract.
// ─────────────────────────────────────────────────────────────────────────────

/// Linear price at timestamp `t`, matching Auction.getPrice() exactly.
function priceAt(startTime, endTime, startingPrice, reservePrice, t) {
    const T = BigInt(t);
    const s = BigInt(startTime);
    const e = BigInt(endTime);
    if (T < s) return startingPrice;
    if (T >= e) return reservePrice;
    return startingPrice - (startingPrice - reservePrice) * (T - s) / (e - s);
}

/// Floor-div used by Auction.buy() to compute zenoOut from paymentAmount.
function zenoOutFor(paymentAmount, price, zenoDecimals) {
    return paymentAmount * (10n ** BigInt(zenoDecimals)) / price;
}

/// Ceiling paymentAmount needed to receive *at least* `zenoAmount` ZENO at `price`.
function paymentForExact(zenoAmount, price, zenoDecimals) {
    const scale = 10n ** BigInt(zenoDecimals);
    return (price * zenoAmount + scale - 1n) / scale;
}

/// Helper: deploy an ERC20Mock with the given decimals and pre-mint to recipients.
async function deployToken(name, symbol, decimals, mints = []) {
    const Mock = await ethers.getContractFactory("ERC20Mock");
    const token = await Mock.deploy(name, symbol, decimals);
    for (const [to, amount] of mints) {
        await token.mint(to, amount);
    }
    return token;
}

/// Helper: build a full Zeno + Auction stack with chosen params.
async function deployStack({
    underlying,
    payment,
    issuer,
    owner,
    startingPrice,
    reservePrice,
    totalAllocated,
    durationSec = 3600,
    startOffsetSec = 60,
    maturityOffsetSec = Number(YEAR),
    fundingMode = FundingMode.Float,
    prefillAmount = 0n,
}) {
    const ZENO = await ethers.getContractFactory("ZENO");
    const Auction = await ethers.getContractFactory("Auction");

    const now = await time.latest();
    const startTime = now + startOffsetSec;
    const endTime = startTime + durationSec;
    const maturity = now + maturityOffsetSec;

    const zeno = await ZENO.deploy(
        underlying.target,
        maturity,
        "ZENO Bond",
        "ZENO",
        owner.address
    );

    // Optional prefill (for Prefilled mode test cases)
    if (prefillAmount > 0n) {
        await underlying.mint(zeno.target, prefillAmount);
    }

    const auction = await Auction.deploy(
        zeno.target,
        payment.target,
        issuer.address,
        startTime,
        endTime,
        startingPrice,
        reservePrice,
        totalAllocated,
        fundingMode,
        owner.address
    );

    await zeno.connect(owner).setAuction(auction.target);

    return { zeno, auction, startTime, endTime, maturity };
}

/// Pin the next mined block to `t` so price at buy is deterministic.
async function setNextBlock(t) {
    await time.setNextBlockTimestamp(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Constructor validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — constructor validation", () => {
    let owner, issuer, alice;
    let underlying, payment;

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Underlying", "UND", 6);
        payment = await deployToken("Pay", "PAY", 6);
    });

    it("rejects zero zeno/token/issuer addresses", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const zeno = await ZENO.deploy(underlying.target, now + Number(YEAR), "Z", "Z", owner.address);

        const baseArgs = [
            zeno.target,
            payment.target,
            issuer.address,
            now + 60,
            now + 3600,
            ethers.parseUnits("1", 6),
            ethers.parseUnits("0.9", 6),
            ethers.parseUnits("10", 6),
            FundingMode.Float,
            owner.address,
        ];

        for (const idx of [0, 1, 2]) {
            const bad = [...baseArgs];
            bad[idx] = ethers.ZeroAddress;
            await expect(Auction.deploy(...bad)).to.be.revertedWithCustomError(Auction, "ZeroAddress");
        }
    });

    it("rejects endTime <= startTime", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const zeno = await ZENO.deploy(underlying.target, now + Number(YEAR), "Z", "Z", owner.address);

        await expect(Auction.deploy(
            zeno.target, payment.target, issuer.address,
            now + 100, now + 100, // equal
            ethers.parseUnits("1", 6), ethers.parseUnits("0.9", 6),
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.be.revertedWithCustomError(Auction, "InvalidEndTime");
    });

    it("rejects reservePrice == 0 (would allow infinite ZENO per pay-wei + div-by-zero at endTime)", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const zeno = await ZENO.deploy(underlying.target, now + Number(YEAR), "Z", "Z", owner.address);

        await expect(Auction.deploy(
            zeno.target, payment.target, issuer.address,
            now + 60, now + 3600,
            ethers.parseUnits("1", 6), 0, // reserve = 0
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.be.revertedWithCustomError(Auction, "InvalidReservePrice");
    });

    it("rejects startingPrice < reservePrice but accepts startingPrice == reservePrice (fixed)", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const zeno = await ZENO.deploy(underlying.target, now + Number(YEAR), "Z", "Z", owner.address);

        await expect(Auction.deploy(
            zeno.target, payment.target, issuer.address,
            now + 60, now + 3600,
            ethers.parseUnits("0.5", 6), ethers.parseUnits("0.6", 6), // start < reserve
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.be.revertedWithCustomError(Auction, "InvalidStartingPrice");

        // Equal (fixed-price) is valid.
        await expect(Auction.deploy(
            zeno.target, payment.target, issuer.address,
            now + 60, now + 3600,
            ethers.parseUnits("0.95", 6), ethers.parseUnits("0.95", 6),
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.not.be.reverted;
    });

    it("rejects maturity <= auction endTime", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const endTime = now + 3600;
        // Maturity equal to endTime — too early.
        const zenoEqual = await ZENO.deploy(underlying.target, endTime, "Z", "Z", owner.address);
        await expect(Auction.deploy(
            zenoEqual.target, payment.target, issuer.address,
            now + 60, endTime,
            ethers.parseUnits("1", 6), ethers.parseUnits("0.9", 6),
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.be.revertedWithCustomError(Auction, "MaturityBeforeAuctionEnd");

        // Maturity strictly after endTime works.
        const zenoOk = await ZENO.deploy(underlying.target, endTime + 1, "Z", "Z", owner.address);
        await expect(Auction.deploy(
            zenoOk.target, payment.target, issuer.address,
            now + 60, endTime,
            ethers.parseUnits("1", 6), ethers.parseUnits("0.9", 6),
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        )).to.not.be.reverted;
    });

    it("Prefilled mode reverts when ZENO underbacked, succeeds at exact boundary", async () => {
        const totalAllocated = ethers.parseUnits("10", 6);
        const stackArgs = {
            underlying, payment, issuer, owner,
            startingPrice: ethers.parseUnits("1", 6),
            reservePrice: ethers.parseUnits("1", 6),
            totalAllocated,
            fundingMode: FundingMode.Prefilled,
        };

        // Under by 1 wei.
        await expect(deployStack({ ...stackArgs, prefillAmount: totalAllocated - 1n }))
            .to.be.revertedWithCustomError(
                await ethers.getContractFactory("Auction"),
                "NotPrefilled",
            );

        // Exact match passes.
        const { auction } = await deployStack({ ...stackArgs, prefillAmount: totalAllocated });
        expect(await auction.totalRemaining()).to.equal(totalAllocated);
    });

    it("Float mode does not require prefill", async () => {
        const { auction } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: ethers.parseUnits("1", 6),
            reservePrice: ethers.parseUnits("0.9", 6),
            totalAllocated: ethers.parseUnits("10", 6),
            fundingMode: FundingMode.Float,
        });
        expect(await auction.fundingMode()).to.equal(FundingMode.Float);
    });

    it("setAuction rejects an Auction wired to a different ZENO (InvalidAuctionBinding)", async () => {
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();

        // Two independent ZENOs and an Auction that points at zenoB.
        const zenoA = await ZENO.deploy(underlying.target, now + Number(YEAR), "ZA", "ZA", owner.address);
        const zenoB = await ZENO.deploy(underlying.target, now + Number(YEAR), "ZB", "ZB", owner.address);
        const auctionForB = await Auction.deploy(
            zenoB.target, payment.target, issuer.address,
            now + 60, now + 3600,
            ethers.parseUnits("1", 6), ethers.parseUnits("0.9", 6),
            ethers.parseUnits("10", 6), FundingMode.Float, owner.address,
        );

        // Wiring zenoA to auctionForB must revert — the auction's zeno() != zenoA.
        await expect(zenoA.connect(owner).setAuction(auctionForB.target))
            .to.be.revertedWithCustomError(zenoA, "InvalidAuctionBinding");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Decimals matrix — buy & redeem must work for every (D_pay, D_zeno) combo
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — decimals matrix", () => {
    const combos = [
        { dPay: 6, dZeno: 6 },
        { dPay: 6, dZeno: 18 },
        { dPay: 18, dZeno: 6 },
        { dPay: 18, dZeno: 18 },
    ];

    for (const { dPay, dZeno } of combos) {
        describe(`D_pay=${dPay}, D_zeno=${dZeno}`, () => {
            let owner, issuer, alice;
            let underlying, payment;
            let zeno, auction, startTime, endTime, maturity;
            const totalAllocated = 100n * 10n ** BigInt(dZeno); // 100 whole ZENO
            // Price: 0.95 whole-pay per whole-ZENO, in pay-small.
            const price = (95n * 10n ** BigInt(dPay)) / 100n;

            beforeEach(async () => {
                [owner, issuer, alice] = await ethers.getSigners();
                underlying = await deployToken("Under", "UND", dZeno, [
                    [issuer.address, 1000n * 10n ** BigInt(dZeno)],
                ]);
                payment = await deployToken("Pay", "PAY", dPay, [
                    [alice.address, 1000n * 10n ** BigInt(dPay)],
                ]);

                ({ zeno, auction, startTime, endTime, maturity } = await deployStack({
                    underlying, payment, issuer, owner,
                    startingPrice: price,
                    reservePrice: price, // fixed-price keeps math deterministic
                    totalAllocated,
                    fundingMode: FundingMode.Float,
                }));

                await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
            });

            it("ZENO.decimals == underlying.decimals", async () => {
                expect(await zeno.decimals()).to.equal(dZeno);
            });

            it("buy: zenoOut = floor(paymentAmount * 10^D_zeno / price), favors protocol", async () => {
                await setNextBlock(startTime + 1);

                // Buy with paymentAmount = 1 whole pay-token.
                const paymentAmount = 10n ** BigInt(dPay);
                const expectedZeno = zenoOutFor(paymentAmount, price, dZeno);

                const balanceBefore = await zeno.balanceOf(alice.address);
                await auction.connect(alice).buy(paymentAmount, 0);
                const balanceAfter = await zeno.balanceOf(alice.address);

                expect(balanceAfter - balanceBefore).to.equal(expectedZeno);

                // Invariant: zenoOut * price <= paymentAmount * 10^D_zeno  (rounding favors protocol).
                expect(expectedZeno * price).to.be.lte(paymentAmount * 10n ** BigInt(dZeno));
            });

            it("redemption is 1:1 in zeno-smallest-units (== underlying-smallest)", async () => {
                await setNextBlock(startTime + 1);
                const paymentAmount = 10n ** BigInt(dPay); // 1 whole pay token
                await auction.connect(alice).buy(paymentAmount, 0);
                const aliceZeno = await zeno.balanceOf(alice.address);

                // Issuer tops up ZENO with the corresponding amount of underlying.
                await underlying.connect(issuer).transfer(zeno.target, aliceZeno);

                // Fast-forward past maturity.
                await time.increaseTo(BigInt(maturity) + 1n);

                const balBefore = await underlying.balanceOf(alice.address);
                await zeno.connect(alice).redeem(aliceZeno);
                const balAfter = await underlying.balanceOf(alice.address);

                expect(balAfter - balBefore).to.equal(aliceZeno);
                expect(await zeno.balanceOf(alice.address)).to.equal(0);
            });
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Rounding invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — rounding invariants", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let zeno, auction, startTime, endTime;

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 18);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("1000000", 6)],
        ]);
        ({ zeno, auction, startTime, endTime } = await deployStack({
            underlying, payment, issuer, owner,
            // Asymmetric decimals + non-round price chosen to maximize rounding remainders.
            startingPrice: 1_000_007n, // 1.000007 pay-small per whole zeno
            reservePrice:  1_000_007n,
            totalAllocated: 10n ** 30n, // way more than the buyer can ever demand
            fundingMode: FundingMode.Float,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
    });

    it("zenoOut * price <= paymentAmount * 10^D_zeno (never overpays user)", async () => {
        await setNextBlock(startTime + 1);
        // Pick paymentAmount that produces a non-exact division (creates a remainder).
        const paymentAmount = 12_345_679n;
        const dZeno = Number(await zeno.decimals());

        await auction.connect(alice).buy(paymentAmount, 0);
        const got = await zeno.balanceOf(alice.address);

        // Predicted value matches contract.
        const expected = zenoOutFor(paymentAmount, 1_000_007n, dZeno);
        expect(got).to.equal(expected);

        // Protocol invariant.
        expect(got * 1_000_007n).to.be.lte(paymentAmount * 10n ** BigInt(dZeno));
    });

    it("getPrice() rounds the linearly-decayed offset DOWN (price rounds up vs exact)", async () => {
        // Use a decaying auction here.
        const startingPrice = 10_000_000n; // $10
        const reservePrice  =     1n;       //  tiny floor
        const duration = 1000;
        const decayStack = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice, reservePrice,
            totalAllocated: 10n ** 18n,
            fundingMode: FundingMode.Float,
            durationSec: duration,
        });
        const a = decayStack.auction;

        // Pick a tick that yields a non-exact division (elapsed=333 with duration=1000).
        const t = decayStack.startTime + 333;
        await setNextBlock(t);
        await ethers.provider.send("evm_mine", []);
        const onChain = await a.getPrice();

        // Local expectation matches contract truncation:
        const expected = priceAt(decayStack.startTime, decayStack.endTime, startingPrice, reservePrice, t);
        expect(onChain).to.equal(expected);

        // Compare to exact (real-number) interpolation; contract's value must be >= exact.
        // exactOffset = (startingPrice - reservePrice) * elapsed / duration  (no trunc)
        // exactPrice  = startingPrice - exactOffset
        // contractPrice >= exactPrice because contract truncates the offset DOWN.
        // We assert this by checking offset is floor-truncated:
        const elapsed = BigInt(t - decayStack.startTime);
        const numerator = (startingPrice - reservePrice) * elapsed;
        const denominator = BigInt(duration);
        const truncatedOffset = numerator / denominator;
        const exactOffsetTimesD = numerator; // = truncatedOffset*D + remainder
        expect(truncatedOffset * denominator).to.be.lte(exactOffsetTimesD); // floor ✓
        expect(startingPrice - truncatedOffset).to.equal(onChain);
    });

    it("buy() reverts if paymentAmount * 10^D_zeno < price (zenoOut would round to 0)", async () => {
        await setNextBlock(startTime + 1);
        // paymentAmount = 1; price = 1_000_007; 10^18 / 1_000_007 ~= 9.99e11.
        // 1 * 10^18 / 1_000_007 = 999_993_000_006... wait that's positive. Need price > 10^D_zeno.
        // Easier: use a high-priced auction.
        const highStack = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: 10n ** 25n, // > 10^18
            reservePrice:  10n ** 25n,
            totalAllocated: 10n ** 18n,
            fundingMode: FundingMode.Float,
        });
        await payment.connect(alice).approve(highStack.auction.target, ethers.MaxUint256);

        await setNextBlock(highStack.startTime + 1);
        // paymentAmount = 1 → zenoOut = 1 * 10^18 / 10^25 = 0 → ZENO.mint(0) reverts with ZeroAmount.
        await expect(highStack.auction.connect(alice).buy(1, 0))
            .to.be.revertedWithCustomError(highStack.zeno, "ZeroAmount");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dutch price curve
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — Dutch price curve", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let auction, startTime, endTime;
    const startingPrice = ethers.parseUnits("1.00", 6);
    const reservePrice = ethers.parseUnits("0.60", 6);

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("10000", 6)],
        ]);
        ({ auction, startTime, endTime } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice, reservePrice,
            totalAllocated: ethers.parseUnits("10", 6),
            fundingMode: FundingMode.Float,
            durationSec: 7200, // 2h
        }));
    });

    it("returns startingPrice strictly before startTime", async () => {
        expect(await auction.getPrice()).to.equal(startingPrice);
    });

    it("returns startingPrice exactly at startTime", async () => {
        await setNextBlock(startTime);
        await ethers.provider.send("evm_mine", []);
        expect(await auction.getPrice()).to.equal(startingPrice);
    });

    it("returns reservePrice exactly at endTime and after", async () => {
        await setNextBlock(endTime);
        await ethers.provider.send("evm_mine", []);
        expect(await auction.getPrice()).to.equal(reservePrice);

        await setNextBlock(endTime + 1000);
        await ethers.provider.send("evm_mine", []);
        expect(await auction.getPrice()).to.equal(reservePrice);
    });

    it("interpolates linearly at midpoint", async () => {
        const mid = startTime + (endTime - startTime) / 2;
        await setNextBlock(mid);
        await ethers.provider.send("evm_mine", []);
        // Expected = start - (start-reserve)/2 = (start+reserve)/2 = 0.80
        expect(await auction.getPrice()).to.equal(ethers.parseUnits("0.80", 6));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fixed-price mode (startingPrice == reservePrice)
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — fixed-price mode", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let auction, startTime, endTime;
    const fixedPrice = ethers.parseUnits("0.95", 6);

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("10000", 6)],
        ]);
        ({ auction, startTime, endTime } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: fixedPrice, reservePrice: fixedPrice,
            totalAllocated: ethers.parseUnits("10", 6),
            fundingMode: FundingMode.Float,
            durationSec: 7200,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
    });

    it("price stays constant throughout the auction window", async () => {
        const ticks = [startTime, startTime + 1, startTime + 1000, startTime + 5000, endTime - 1];
        for (const t of ticks) {
            await setNextBlock(t);
            await ethers.provider.send("evm_mine", []);
            expect(await auction.getPrice()).to.equal(fixedPrice);
        }
    });

    it("buy at any tick yields the same exchange rate", async () => {
        const paymentAmount = ethers.parseUnits("1", 6);

        // Buy at t=startTime+10.
        await setNextBlock(startTime + 10);
        await auction.connect(alice).buy(paymentAmount, 0);
        const z1 = await zenoOutFor(paymentAmount, fixedPrice, 6);
        expect(await auction.totalRemaining()).to.equal(
            ethers.parseUnits("10", 6) - z1
        );

        // Buy again much later in the auction — same rate.
        await setNextBlock(endTime - 10);
        const beforeBal = await (await ethers.getContractAt("ZENO", await auction.zeno())).balanceOf(alice.address);
        await auction.connect(alice).buy(paymentAmount, 0);
        const afterBal = await (await ethers.getContractAt("ZENO", await auction.zeno())).balanceOf(alice.address);
        expect(afterBal - beforeBal).to.equal(z1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Buy flow — guards, slippage, sold-out, lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — buy flow", () => {
    let owner, issuer, alice, bob;
    let underlying, payment;
    let zeno, auction, startTime, endTime;
    const startingPrice = ethers.parseUnits("1.00", 6);
    const reservePrice = ethers.parseUnits("0.60", 6);
    const totalAllocated = ethers.parseUnits("10", 6);

    beforeEach(async () => {
        [owner, issuer, alice, bob] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("100000", 6)],
            [bob.address, ethers.parseUnits("100000", 6)],
        ]);
        ({ zeno, auction, startTime, endTime } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice, reservePrice,
            totalAllocated,
            fundingMode: FundingMode.Float,
            durationSec: 7200,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
        await payment.connect(bob).approve(auction.target, ethers.MaxUint256);
    });

    it("reverts before startTime with AuctionNotStarted", async () => {
        await expect(auction.connect(alice).buy(ethers.parseUnits("1", 6), 0))
            .to.be.revertedWithCustomError(auction, "AuctionNotStarted");
    });

    it("reverts after endTime with AuctionExpired", async () => {
        await time.increaseTo(endTime + 1);
        await expect(auction.connect(alice).buy(ethers.parseUnits("1", 6), 0))
            .to.be.revertedWithCustomError(auction, "AuctionExpired");
    });

    it("reverts on paymentAmount == 0 with InvalidAmount", async () => {
        await setNextBlock(startTime + 1);
        await expect(auction.connect(alice).buy(0, 0))
            .to.be.revertedWithCustomError(auction, "InvalidAmount");
    });

    it("reverts with SlippageExceeded when zenoOut < minZenoOut", async () => {
        await setNextBlock(startTime + 1);
        const payAmt = ethers.parseUnits("1", 6);
        // At price ~$1 (startTime+1 is very close to start), 1 pay → ~1 ZENO.
        // Demand 100 ZENO → must fail.
        await expect(auction.connect(alice).buy(payAmt, ethers.parseUnits("100", 6)))
            .to.be.revertedWithCustomError(auction, "SlippageExceeded");
    });

    it("caps an oversized buy to remaining and charges only its rounded-up cost", async () => {
        // At price ~$1, allocation is 10 ZENO. Offer 1000 pay → ~1000 ZENO, capped to 10.
        const buyTime = startTime + 1;
        await setNextBlock(buyTime);

        const remaining = await auction.totalRemaining();
        const priceAtBuy = priceAt(startTime, endTime, startingPrice, reservePrice, buyTime);
        const expectedCharge = paymentForExact(remaining, priceAtBuy, 6);
        const offered = ethers.parseUnits("1000", 6);

        const aliceBefore = await payment.balanceOf(alice.address);
        const issuerBefore = await payment.balanceOf(issuer.address);

        await expect(auction.connect(alice).buy(offered, 0))
            .to.emit(auction, "ZENOPurchased")
            .withArgs(alice.address, remaining, expectedCharge, priceAtBuy)
            .and.to.emit(auction, "AuctionEnded")
            .withArgs(priceAtBuy);

        expect(await zeno.balanceOf(alice.address)).to.equal(remaining);
        expect(aliceBefore - (await payment.balanceOf(alice.address))).to.equal(expectedCharge);
        expect((await payment.balanceOf(issuer.address)) - issuerBefore).to.equal(expectedCharge);
        expect(expectedCharge).to.be.lt(offered);
        expect(await auction.totalRemaining()).to.equal(0);
        expect(await auction.checkAuctionEnded()).to.be.true;

        // Repeating the same call after the capped sell-out must not mint or charge again.
        await setNextBlock(buyTime + 1);
        await expect(auction.connect(alice).buy(offered, 0))
            .to.be.revertedWithCustomError(auction, "InsufficientZenoRemaining");
        await expect(auction.connect(bob).buy(1n, 0))
            .to.be.revertedWithCustomError(auction, "InsufficientZenoRemaining");
        expect(await zeno.totalMinted()).to.equal(totalAllocated);
    });

    it("capped fill still enforces minZenoOut against the capped amount", async () => {
        await setNextBlock(startTime + 1);
        const remaining = await auction.totalRemaining();
        await expect(auction.connect(alice).buy(ethers.parseUnits("1000", 6), remaining + 1n))
            .to.be.revertedWithCustomError(auction, "SlippageExceeded");
    });

    it("stale exact-fill quote still clears after the price decays", async () => {
        // Quote at t, execute much later: the lower price would mint more than remaining.
        const quoteTime = startTime + 1;
        const execTime = startTime + 3600;
        const remaining = await auction.totalRemaining();
        const quotedPayment = paymentForExact(
            remaining, priceAt(startTime, endTime, startingPrice, reservePrice, quoteTime), 6
        );
        const execPrice = priceAt(startTime, endTime, startingPrice, reservePrice, execTime);
        expect(zenoOutFor(quotedPayment, execPrice, 6)).to.be.gt(remaining);

        await setNextBlock(execTime);
        const aliceBefore = await payment.balanceOf(alice.address);
        await expect(auction.connect(alice).buy(quotedPayment, remaining))
            .to.emit(auction, "AuctionEnded");

        expect(await zeno.balanceOf(alice.address)).to.equal(remaining);
        expect(aliceBefore - (await payment.balanceOf(alice.address)))
            .to.equal(paymentForExact(remaining, execPrice, 6));
        expect(await auction.checkAuctionEnded()).to.be.true;
    });

    it("payment flows to issuer (not auction or zeno)", async () => {
        await setNextBlock(startTime + 1);
        const payAmt = ethers.parseUnits("3", 6);
        const issuerBefore = await payment.balanceOf(issuer.address);
        await auction.connect(alice).buy(payAmt, 0);
        const issuerAfter = await payment.balanceOf(issuer.address);

        expect(issuerAfter - issuerBefore).to.equal(payAmt);
        expect(await payment.balanceOf(auction.target)).to.equal(0);
        expect(await payment.balanceOf(zeno.target)).to.equal(0);
    });

    it("emits ZENOPurchased and AuctionEnded on sold-out", async () => {
        // Pin block so we can drain exactly.
        const buyTime = startTime + 1;
        await setNextBlock(buyTime);

        const remaining = await auction.totalRemaining();
        const priceAtBuy = priceAt(startTime, endTime, startingPrice, reservePrice, buyTime);
        const drainPayment = paymentForExact(remaining, priceAtBuy, 6);

        await expect(auction.connect(alice).buy(drainPayment, remaining))
            .to.emit(auction, "ZENOPurchased")
            .and.to.emit(auction, "AuctionEnded");

        expect(await auction.totalRemaining()).to.equal(0);
        expect(await auction.checkAuctionEnded()).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. Final-fill dust (payment unit mints more ZENO than remains)
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — final-fill dust", () => {
    let owner, issuer, alice, bob;
    let underlying, payment;
    let zeno, auction, startTime;
    const PRICE = ethers.parseUnits("1", 6); // 1 pay-small mints 1e12 zeno-small
    const TOTAL = ethers.parseUnits("1", 18) + 1n;

    beforeEach(async () => {
        [owner, issuer, alice, bob] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 18);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("1000", 6)],
            [bob.address, ethers.parseUnits("1000", 6)],
        ]);
        ({ zeno, auction, startTime } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: PRICE, reservePrice: PRICE,
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Float,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
        await payment.connect(bob).approve(auction.target, ethers.MaxUint256);
    });

    it("1-wei residual below the minimum output is still purchasable and ends the auction", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(PRICE, 0);
        expect(await auction.totalRemaining()).to.equal(1n);
        expect(zenoOutFor(1n, PRICE, 18)).to.be.gt(1n);

        await setNextBlock(startTime + 2);
        const bobBefore = await payment.balanceOf(bob.address);
        await expect(auction.connect(bob).buy(1n, 1n))
            .to.emit(auction, "ZENOPurchased")
            .withArgs(bob.address, 1n, 1n, PRICE)
            .and.to.emit(auction, "AuctionEnded");

        expect(bobBefore - (await payment.balanceOf(bob.address))).to.equal(1n);
        expect(await zeno.balanceOf(bob.address)).to.equal(1n);
        expect(await zeno.totalMinted()).to.equal(TOTAL);
        expect(await auction.checkAuctionEnded()).to.be.true;
    });

    it("oversized payment on the residual is charged only the rounded-up cost", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(PRICE, 0);

        await setNextBlock(startTime + 2);
        const bobBefore = await payment.balanceOf(bob.address);
        await auction.connect(bob).buy(ethers.parseUnits("500", 6), 0);

        expect(bobBefore - (await payment.balanceOf(bob.address))).to.equal(1n);
        expect(await auction.totalRemaining()).to.equal(0);

        await setNextBlock(startTime + 3);
        await expect(auction.connect(bob).buy(ethers.parseUnits("500", 6), 0))
            .to.be.revertedWithCustomError(auction, "InsufficientZenoRemaining");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Self-buy (ION scenario — issuer == buyer)
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — self-buy (issuer == buyer)", () => {
    let owner, ion;
    let pmUSD; // both underlying & payment
    let zeno, auction, startTime, endTime, maturity;
    const TOTAL = ethers.parseUnits("100", 18); // 100 whole ZENO (pmUSD is 18-dec)

    beforeEach(async () => {
        [owner, ion] = await ethers.getSigners();
        // ION starts with 2× TOTAL: half prefills ZENO, half cycles through buy.
        pmUSD = await deployToken("pmUSD", "pmUSD", 18, [
            [ion.address, TOTAL * 2n],
        ]);
        // Prefill: ION transfers TOTAL into the (about-to-be-deployed) ZENO.
        // Need to deploy ZENO first to know its address.
        const ZENO = await ethers.getContractFactory("ZENO");
        const now = await time.latest();
        maturity = now + Number(YEAR);
        const z = await ZENO.deploy(pmUSD.target, maturity, "ZENO", "Z", owner.address);

        await pmUSD.connect(ion).transfer(z.target, TOTAL);

        const Auction = await ethers.getContractFactory("Auction");
        startTime = now + 60;
        endTime = startTime + 3600;
        const a = await Auction.deploy(
            z.target,
            pmUSD.target, // payment == underlying
            ion.address,  // issuer == buyer
            startTime, endTime,
            10n ** 18n, // price = 1.0 (in pmUSD smallest per whole ZENO)
            10n ** 18n, // fixed
            TOTAL,
            FundingMode.Prefilled,
            owner.address,
        );
        await z.connect(owner).setAuction(a.target);

        zeno = z;
        auction = a;
    });

    it("ION buys their own bond — net pmUSD change is zero (payment cycles), receives ZENO", async () => {
        await pmUSD.connect(ion).approve(auction.target, ethers.MaxUint256);
        await setNextBlock(startTime + 1);

        const pmBefore = await pmUSD.balanceOf(ion.address);
        const zenoBefore = await zeno.balanceOf(ion.address);

        // Buy entire allocation at price 1.0 → paymentAmount = TOTAL.
        await auction.connect(ion).buy(TOTAL, TOTAL);

        const pmAfter = await pmUSD.balanceOf(ion.address);
        const zenoAfter = await zeno.balanceOf(ion.address);

        // Payment-token unchanged for ION (self-transfer).
        expect(pmAfter).to.equal(pmBefore);
        // Received the full allocation.
        expect(zenoAfter - zenoBefore).to.equal(TOTAL);
        // ZENO contract still holds the prefill.
        expect(await pmUSD.balanceOf(zeno.target)).to.equal(TOTAL);
    });

    it("post-buy: surplus is 0, sweep would fail (collateral exactly matches supply)", async () => {
        await pmUSD.connect(ion).approve(auction.target, ethers.MaxUint256);
        await setNextBlock(startTime + 1);
        await auction.connect(ion).buy(TOTAL, TOTAL);

        // Auction is now ended (sold out), so sweep is allowed, but surplus == 0.
        expect(await auction.checkAuctionEnded()).to.be.true;
        await expect(zeno.connect(owner).sweepSurplus(owner.address, 1))
            .to.be.revertedWithCustomError(zeno, "ExceedsSurplus");
    });

    it("after maturity, ION can redeem their ZENO 1:1 for the prefilled pmUSD", async () => {
        await pmUSD.connect(ion).approve(auction.target, ethers.MaxUint256);
        await setNextBlock(startTime + 1);
        await auction.connect(ion).buy(TOTAL, TOTAL);

        await time.increaseTo(maturity + 1);

        const pmBefore = await pmUSD.balanceOf(ion.address);
        await zeno.connect(ion).redeemAll();
        const pmAfter = await pmUSD.balanceOf(ion.address);

        expect(pmAfter - pmBefore).to.equal(TOTAL);
        expect(await zeno.balanceOf(ion.address)).to.equal(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Redemption mechanics
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — redemption", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let zeno, auction, startTime, endTime, maturity;
    const TOTAL = ethers.parseUnits("10", 6);

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6, [
            [issuer.address, ethers.parseUnits("1000", 6)],
        ]);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("100", 6)],
        ]);
        ({ zeno, auction, startTime, endTime, maturity } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: ethers.parseUnits("1", 6),
            reservePrice: ethers.parseUnits("1", 6),
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Float,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
    });

    it("reverts with BondNotRedeemable before maturity", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        await expect(zeno.connect(alice).redeem(ethers.parseUnits("1", 6)))
            .to.be.revertedWithCustomError(zeno, "BondNotRedeemable");
    });

    it("reverts with ZeroAmount on redeem(0)", async () => {
        await time.increaseTo(BigInt(maturity) + 1n);
        await expect(zeno.connect(alice).redeem(0))
            .to.be.revertedWithCustomError(zeno, "ZeroAmount");
    });

    it("reverts with InsufficientBalance when redeeming more than holdings", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        await time.increaseTo(BigInt(maturity) + 1n);
        const held = await zeno.balanceOf(alice.address);
        // Make sure ZENO has enough collateral for the attempt
        await underlying.connect(issuer).transfer(zeno.target, held + 1n);
        await expect(zeno.connect(alice).redeem(held + 1n))
            .to.be.revertedWithCustomError(zeno, "InsufficientBalance");
    });

    it("reverts post-maturity with insufficient-collateral until issuer tops up", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        const held = await zeno.balanceOf(alice.address);

        await time.increaseTo(BigInt(maturity) + 1n);
        // No top-up yet.
        await expect(zeno.connect(alice).redeem(held)).to.be.revertedWithCustomError(zeno, "InsufficientCollateral");

        // Issuer tops up exactly what's needed.
        await underlying.connect(issuer).transfer(zeno.target, held);
        await zeno.connect(alice).redeem(held); // succeeds
        expect(await zeno.balanceOf(alice.address)).to.equal(0);
    });

    it("redeemAll burns and pays entire balance", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("2", 6), 0);
        const held = await zeno.balanceOf(alice.address);
        await underlying.connect(issuer).transfer(zeno.target, held);
        await time.increaseTo(BigInt(maturity) + 1n);

        const undBefore = await underlying.balanceOf(alice.address);
        await zeno.connect(alice).redeemAll();
        const undAfter = await underlying.balanceOf(alice.address);

        expect(undAfter - undBefore).to.equal(held);
        expect(await zeno.balanceOf(alice.address)).to.equal(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. sweepSurplus — gating, surplus math, ownership
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — sweepSurplus", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let zeno, auction, startTime, endTime, maturity;
    const TOTAL = ethers.parseUnits("10", 6);

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6, [
            [issuer.address, ethers.parseUnits("1000", 6)],
        ]);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("100", 6)],
        ]);
        ({ zeno, auction, startTime, endTime, maturity } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: ethers.parseUnits("1", 6),
            reservePrice: ethers.parseUnits("1", 6),
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Prefilled,
            prefillAmount: TOTAL,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
    });

    it("reverts with AuctionNotSet during the deploy window (auction deployed but setAuction not yet called)", async () => {
        // Reproduce the deploy-window: deploy ZENO + prefill + deploy Auction, but DON'T setAuction.
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();

        const u = await deployToken("Under", "UND", 6);
        const p = await deployToken("Pay", "PAY", 6);
        const total = ethers.parseUnits("5", 6);

        const z = await ZENO.deploy(u.target, now + Number(YEAR), "Z", "Z", owner.address);
        await u.mint(z.target, total); // prefill

        // Auction's constructor checks prefill at this moment — passes.
        const a = await Auction.deploy(
            z.target, p.target, issuer.address,
            now + 60, now + 3600,
            ethers.parseUnits("1", 6), ethers.parseUnits("1", 6),
            total, FundingMode.Prefilled, owner.address,
        );

        // setAuction NOT called — z.auction() is address(0).
        // Without the gate, owner could drain the prefill here. With the new gate, it reverts.
        await expect(z.connect(owner).sweepSurplus(owner.address, total))
            .to.be.revertedWithCustomError(z, "AuctionNotSet");

        // Once setAuction is called and auction is still open, the existing "still active" gate fires.
        await z.connect(owner).setAuction(a.target);
        await expect(z.connect(owner).sweepSurplus(owner.address, 1))
            .to.be.revertedWithCustomError(z, "AuctionStillActive");
    });

    it("reverts with AuctionStillActive while auction is open", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);

        await expect(zeno.connect(owner).sweepSurplus(owner.address, 1))
            .to.be.revertedWithCustomError(zeno, "AuctionStillActive");
    });

    it("non-owner cannot sweep even after auction ends", async () => {
        await time.increaseTo(endTime + 1);
        await expect(zeno.connect(alice).sweepSurplus(alice.address, 1))
            .to.be.revertedWithCustomError(zeno, "OwnableUnauthorizedAccount");
    });

    it("post-auction, sweep is capped at balance - totalSupply", async () => {
        // Alice buys 1 ZENO; rest of prefill is unsold.
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        const aliceZeno = await zeno.balanceOf(alice.address);

        await time.increaseTo(endTime + 1);

        const balance = await underlying.balanceOf(zeno.target);
        const supply = await zeno.totalSupply();
        const expectedSurplus = balance - supply;

        // Sweeping more than surplus reverts.
        await expect(zeno.connect(owner).sweepSurplus(owner.address, expectedSurplus + 1n))
            .to.be.revertedWithCustomError(zeno, "ExceedsSurplus");

        // Exact surplus succeeds.
        const ownerBefore = await underlying.balanceOf(owner.address);
        await zeno.connect(owner).sweepSurplus(owner.address, expectedSurplus);
        const ownerAfter = await underlying.balanceOf(owner.address);

        expect(ownerAfter - ownerBefore).to.equal(expectedSurplus);

        // ZENO is now exactly collateralized for the outstanding supply.
        expect(await underlying.balanceOf(zeno.target)).to.equal(aliceZeno);
    });

    it("emits SurplusSwept on success", async () => {
        await time.increaseTo(endTime + 1);
        await expect(zeno.connect(owner).sweepSurplus(owner.address, 1))
            .to.emit(zeno, "SurplusSwept")
            .withArgs(owner.address, 1);
    });

    it("reverts on zero `to` address", async () => {
        await time.increaseTo(endTime + 1);
        await expect(zeno.connect(owner).sweepSurplus(ethers.ZeroAddress, 1))
            .to.be.revertedWithCustomError(zeno, "InvalidAddress");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Counters — totalMinted monotonic, totalRemaining survives burns
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — counters", () => {
    let owner, issuer, alice;
    let underlying, payment;
    let zeno, auction, startTime, endTime, maturity;
    const TOTAL = ethers.parseUnits("10", 6);

    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6, [
            [issuer.address, ethers.parseUnits("1000", 6)],
        ]);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("100", 6)],
        ]);
        ({ zeno, auction, startTime, endTime, maturity } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: ethers.parseUnits("1", 6),
            reservePrice: ethers.parseUnits("1", 6),
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Float,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
    });

    it("totalMinted starts at zero and increments with each buy", async () => {
        expect(await zeno.totalMinted()).to.equal(0);

        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        const minted1 = await zeno.totalMinted();
        expect(minted1).to.be.gt(0);

        await setNextBlock(startTime + 2);
        await auction.connect(alice).buy(ethers.parseUnits("2", 6), 0);
        const minted2 = await zeno.totalMinted();
        expect(minted2).to.be.gt(minted1);
    });

    it("totalRemaining = totalAllocated - totalMinted (derives off totalMinted, not totalSupply)", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("1", 6), 0);
        const minted = await zeno.totalMinted();
        expect(await auction.totalRemaining()).to.equal(TOTAL - minted);

        // Fast-forward, top up, redeem some — totalSupply drops but totalRemaining must not change.
        const held = await zeno.balanceOf(alice.address);
        await underlying.connect(issuer).transfer(zeno.target, held);
        await time.increaseTo(BigInt(maturity) + 1n);
        await zeno.connect(alice).redeem(held / 2n);

        expect(await zeno.totalSupply()).to.equal(held - held / 2n);
        expect(await zeno.totalMinted()).to.equal(minted); // unchanged
        expect(await auction.totalRemaining()).to.equal(TOTAL - minted); // also unchanged
    });

    it("getDetails exposes totalMinted and derived totalRedeemed", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(ethers.parseUnits("3", 6), 0);
        const held = await zeno.balanceOf(alice.address);
        await underlying.connect(issuer).transfer(zeno.target, held);
        await time.increaseTo(BigInt(maturity) + 1n);
        await zeno.connect(alice).redeem(held / 3n);

        const d = await zeno.getDetails();
        expect(d.totalMinted).to.equal(await zeno.totalMinted());
        expect(d.totalRedeemed).to.equal(d.totalMinted - await zeno.totalSupply());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. ZENOFactory — YYYYMMDD name derivation
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — factory naming (YYYYMMDD)", () => {
    let owner, otherOwner;
    let underlying;

    /// Mirror of the contract's Hinnant-based date conversion, using JS UTC primitives.
    function toYYYYMMDD(unixSeconds) {
        const d = new Date(Number(unixSeconds) * 1000);
        return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    }

    beforeEach(async () => {
        [owner, otherOwner] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6);
    });

    it("names the bond 'ZENO Bond YYYYMMDD' and symbol 'ZENO-YYYYMMDD'", async () => {
        const ZENOFactory = await ethers.getContractFactory("ZENOFactory");
        const f = await ZENOFactory.deploy(owner.address);

        // Pick a maturity at a known-distinct date.
        const maturity = (await time.latest()) + 365 * 24 * 3600;
        await f.connect(owner).createZENOContract(underlying.target, maturity, otherOwner.address);

        const zenoAddr = await f.zenos(0);
        const zeno = await ethers.getContractAt("ZENO", zenoAddr);

        const expected = toYYYYMMDD(maturity);
        expect(await zeno.name()).to.equal(`ZENO Bond ${expected}`);
        expect(await zeno.symbol()).to.equal(`ZENO-${expected}`);
    });

    it("createZENOContract returns the deployed ZENO address (and matches storage + event)", async () => {
        const ZENOFactory = await ethers.getContractFactory("ZENOFactory");
        const f = await ZENOFactory.deploy(owner.address);
        const maturity = (await time.latest()) + 90 * 24 * 3600;

        // staticCall gives us the return value before sending the real tx.
        const predicted = await f.connect(owner).createZENOContract.staticCall(
            underlying.target, maturity, otherOwner.address,
        );
        const tx = await f.connect(owner).createZENOContract(
            underlying.target, maturity, otherOwner.address,
        );

        const stored = await f.zenos(0);
        expect(predicted).to.equal(stored);
        await expect(tx).to.emit(f, "ZENOCreated").withArgs(predicted, maturity);
    });

    it("both factories expose an `is*` registry (O(1) authenticity check)", async () => {
        const ZENOFactory   = await ethers.getContractFactory("ZENOFactory");
        const AuctionFactory = await ethers.getContractFactory("AuctionFactory");
        const zf = await ZENOFactory.deploy(owner.address);
        const af = await AuctionFactory.deploy(owner.address);

        const now = await time.latest();
        const maturity = now + 365 * 24 * 3600;
        await zf.connect(owner).createZENOContract(underlying.target, maturity, otherOwner.address);
        const zeno = await zf.zenos(0);
        expect(await zf.isZENO(zeno)).to.be.true;
        expect(await zf.isZENO(ethers.ZeroAddress)).to.be.false;

        const payment = await deployToken("Pay", "PAY", 6);
        await af.connect(owner).createAuction(
            zeno, payment.target, otherOwner.address,
            now + 60, now + 3600,
            ethers.parseUnits("1", 6), ethers.parseUnits("1", 6),
            ethers.parseUnits("10", 6),
            FundingMode.Float, otherOwner.address,
        );
        const auction = await af.auctions(0);
        expect(await af.isAuction(auction)).to.be.true;
        expect(await af.isAuction(ethers.ZeroAddress)).to.be.false;
        // A ZENO is not an Auction and vice versa.
        expect(await af.isAuction(zeno)).to.be.false;
        expect(await zf.isZENO(auction)).to.be.false;
    });

    it("createAuction returns the deployed Auction address (and matches storage + event)", async () => {
        const ZENOFactory   = await ethers.getContractFactory("ZENOFactory");
        const AuctionFactory = await ethers.getContractFactory("AuctionFactory");
        const zf = await ZENOFactory.deploy(owner.address);
        const af = await AuctionFactory.deploy(owner.address);

        const now = await time.latest();
        const maturity = now + 365 * 24 * 3600;
        await zf.connect(owner).createZENOContract(underlying.target, maturity, otherOwner.address);
        const zeno = await zf.zenos(0);

        const payment = await deployToken("Pay", "PAY", 6);
        const start = now + 60;
        const end = start + 3600;

        const args = [
            zeno, payment.target, otherOwner.address,
            start, end,
            ethers.parseUnits("1", 6), ethers.parseUnits("1", 6),
            ethers.parseUnits("10", 6),
            FundingMode.Float, otherOwner.address,
        ];
        const predicted = await af.connect(owner).createAuction.staticCall(...args);
        const tx = await af.connect(owner).createAuction(...args);

        const stored = await af.auctions(0);
        expect(predicted).to.equal(stored);
        await expect(tx).to.emit(af, "AuctionCreated").withArgs(predicted);
    });

    it("two bonds with the same maturity date receive the same name (date is the identifier)", async () => {
        const ZENOFactory = await ethers.getContractFactory("ZENOFactory");
        const f = await ZENOFactory.deploy(owner.address);
        const maturity = (await time.latest()) + 30 * 24 * 3600;

        await f.connect(owner).createZENOContract(underlying.target, maturity, otherOwner.address);
        await f.connect(owner).createZENOContract(underlying.target, maturity, otherOwner.address);

        const z0 = await ethers.getContractAt("ZENO", await f.zenos(0));
        const z1 = await ethers.getContractAt("ZENO", await f.zenos(1));
        expect(await z0.name()).to.equal(await z1.name());
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Multi-buyer accounting under partial fills
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — multi-buyer partial fills", () => {
    let owner, issuer, alice, bob, carol;
    let underlying, payment;
    let zeno, auction, startTime, endTime;
    const PRICE = ethers.parseUnits("1", 6); // 1 pay per whole ZENO
    const TOTAL = ethers.parseUnits("10", 6); // 10 whole ZENO

    beforeEach(async () => {
        [owner, issuer, alice, bob, carol] = await ethers.getSigners();
        underlying = await deployToken("Under", "UND", 6);
        payment = await deployToken("Pay", "PAY", 6, [
            [alice.address, ethers.parseUnits("100", 6)],
            [bob.address, ethers.parseUnits("100", 6)],
            [carol.address, ethers.parseUnits("100", 6)],
        ]);
        ({ zeno, auction, startTime, endTime } = await deployStack({
            underlying, payment, issuer, owner,
            startingPrice: PRICE, reservePrice: PRICE, // fixed-price makes arithmetic clean
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Float,
            durationSec: 3600,
        }));
        await payment.connect(alice).approve(auction.target, ethers.MaxUint256);
        await payment.connect(bob).approve(auction.target, ethers.MaxUint256);
        await payment.connect(carol).approve(auction.target, ethers.MaxUint256);
    });

    it("three sequential buyers: totals progression, sold-out fires only on Carol", async () => {
        const three = ethers.parseUnits("3", 6);
        const four  = ethers.parseUnits("4", 6);

        // ── Alice buys 3 ZENO ───────────────────────────────────────────
        await setNextBlock(startTime + 1);
        await expect(auction.connect(alice).buy(three, three))
            .to.emit(auction, "ZENOPurchased")
            .and.to.not.emit(auction, "AuctionEnded");

        expect(await zeno.balanceOf(alice.address)).to.equal(three);
        expect(await auction.totalRemaining()).to.equal(TOTAL - three);

        // ── Bob buys 4 ZENO ─────────────────────────────────────────────
        await setNextBlock(startTime + 2);
        await expect(auction.connect(bob).buy(four, four))
            .to.emit(auction, "ZENOPurchased")
            .and.to.not.emit(auction, "AuctionEnded");

        expect(await zeno.balanceOf(bob.address)).to.equal(four);
        expect(await auction.totalRemaining()).to.equal(TOTAL - three - four);

        // ── Carol drains the remaining 3 ZENO ───────────────────────────
        await setNextBlock(startTime + 3);
        const remaining = await auction.totalRemaining();
        await expect(auction.connect(carol).buy(remaining, remaining))
            .to.emit(auction, "ZENOPurchased")
            .and.to.emit(auction, "AuctionEnded");

        expect(await zeno.balanceOf(carol.address)).to.equal(remaining);
        expect(await auction.totalRemaining()).to.equal(0);

        // ── Aggregate invariants ────────────────────────────────────────
        expect(await zeno.totalMinted()).to.equal(TOTAL);
        expect(await zeno.totalSupply()).to.equal(TOTAL);
        expect(
            (await zeno.balanceOf(alice.address)) +
            (await zeno.balanceOf(bob.address)) +
            (await zeno.balanceOf(carol.address))
        ).to.equal(TOTAL);
        expect(await auction.checkAuctionEnded()).to.be.true;
    });

    it("once sold out, subsequent buys revert with InsufficientZenoRemaining", async () => {
        await setNextBlock(startTime + 1);
        await auction.connect(alice).buy(TOTAL, TOTAL);
        expect(await auction.totalRemaining()).to.equal(0);

        await setNextBlock(startTime + 2);
        await expect(auction.connect(bob).buy(ethers.parseUnits("1", 6), 0))
            .to.be.revertedWithCustomError(auction, "InsufficientZenoRemaining");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. End-to-end product scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("Zeno — product scenarios", () => {
    let owner, issuer, alice;
    beforeEach(async () => {
        [owner, issuer, alice] = await ethers.getSigners();
    });

    it("Discounted pmUSD bond: USDC payment, pmUSD underlying, Float, fixed 0.95", async () => {
        // pmUSD 18-dec underlying, USDC 6-dec payment.
        const pmUSD = await deployToken("pmUSD", "pmUSD", 18, [
            [issuer.address, ethers.parseUnits("10000", 18)],
        ]);
        const usdc = await deployToken("USDC", "USDC", 6, [
            [alice.address, ethers.parseUnits("10000", 6)],
        ]);
        const PRICE = ethers.parseUnits("0.95", 6); // 0.95 USDC per whole pmUSD-backed ZENO
        const TOTAL = ethers.parseUnits("100", 18); // 100 whole ZENO

        const { zeno, auction, startTime, maturity } = await deployStack({
            underlying: pmUSD, payment: usdc, issuer, owner,
            startingPrice: PRICE, reservePrice: PRICE,
            totalAllocated: TOTAL,
            fundingMode: FundingMode.Float,
        });
        await usdc.connect(alice).approve(auction.target, ethers.MaxUint256);

        // Alice pays 9.5 USDC → ought to receive ~10 whole ZENO.
        await setNextBlock(startTime + 1);
        const paymentAmount = ethers.parseUnits("9.5", 6);
        await auction.connect(alice).buy(paymentAmount, 0);
        const aliceZeno = await zeno.balanceOf(alice.address);
        // zenoOut = 9.5e6 * 1e18 / 0.95e6 = 1e19 = 10 whole ZENO.
        expect(aliceZeno).to.equal(ethers.parseUnits("10", 18));

        // Issuer received the USDC.
        expect(await usdc.balanceOf(issuer.address)).to.equal(paymentAmount);

        // At maturity, issuer tops up pmUSD and Alice redeems for full par (10 pmUSD).
        await underlying_topUp(pmUSD, issuer, zeno, aliceZeno);
        await time.increaseTo(BigInt(maturity) + 1n);

        const pmBefore = await pmUSD.balanceOf(alice.address);
        await zeno.connect(alice).redeemAll();
        const pmAfter = await pmUSD.balanceOf(alice.address);

        expect(pmAfter - pmBefore).to.equal(aliceZeno);
    });

    it("iREET-style: long-term Dutch auction, Float, decimal mismatch (18 underlying, 6 payment)", async () => {
        const iREET = await deployToken("iREET", "iREET", 18, [
            [issuer.address, ethers.parseUnits("10000", 18)],
        ]);
        const usdc = await deployToken("USDC", "USDC", 6, [
            [alice.address, ethers.parseUnits("100000", 6)],
        ]);
        // Start at 1.0, decay to 0.85 over the auction.
        const { zeno, auction, startTime, endTime, maturity } = await deployStack({
            underlying: iREET, payment: usdc, issuer, owner,
            startingPrice: ethers.parseUnits("1.00", 6),
            reservePrice: ethers.parseUnits("0.85", 6),
            totalAllocated: ethers.parseUnits("100", 18),
            fundingMode: FundingMode.Float,
            durationSec: 86400,
        });
        await usdc.connect(alice).approve(auction.target, ethers.MaxUint256);

        // Alice buys at the midpoint where price should be 0.925.
        const buyTime = startTime + 43200;
        await setNextBlock(buyTime);

        const priceMid = priceAt(startTime, endTime, ethers.parseUnits("1.00", 6), ethers.parseUnits("0.85", 6), buyTime);
        expect(priceMid).to.equal(ethers.parseUnits("0.925", 6));

        // Pay 9.25 USDC → expect 10 whole iREET-backed ZENO.
        const payAmt = ethers.parseUnits("9.25", 6);
        await auction.connect(alice).buy(payAmt, 0);
        expect(await zeno.balanceOf(alice.address)).to.equal(ethers.parseUnits("10", 18));

        // Issuer tops up iREET pre-maturity, Alice redeems.
        await underlying_topUp(iREET, issuer, zeno, await zeno.balanceOf(alice.address));
        await time.increaseTo(BigInt(maturity) + 1n);
        const aliceBefore = await iREET.balanceOf(alice.address);
        await zeno.connect(alice).redeemAll();
        expect((await iREET.balanceOf(alice.address)) - aliceBefore).to.equal(ethers.parseUnits("10", 18));
    });

    it("Prefilled fixed 1:1 self-buy (ION → Curve LP seeding)", async () => {
        // Already covered in detail in section 7 — sanity end-to-end here.
        const pmUSD = await deployToken("pmUSD", "pmUSD", 18, [
            [issuer.address, ethers.parseUnits("200", 18)],
        ]);
        const TOTAL = ethers.parseUnits("100", 18);
        const ZENO = await ethers.getContractFactory("ZENO");
        const Auction = await ethers.getContractFactory("Auction");
        const now = await time.latest();
        const maturity = now + Number(YEAR);
        const startTime = now + 60;
        const endTime = startTime + 3600;

        const z = await ZENO.deploy(pmUSD.target, maturity, "ZENO", "Z", owner.address);
        await pmUSD.connect(issuer).transfer(z.target, TOTAL);
        const a = await Auction.deploy(
            z.target, pmUSD.target, issuer.address,
            startTime, endTime,
            10n ** 18n, 10n ** 18n, TOTAL,
            FundingMode.Prefilled, owner.address,
        );
        await z.connect(owner).setAuction(a.target);

        await pmUSD.connect(issuer).approve(a.target, ethers.MaxUint256);
        await setNextBlock(startTime + 1);
        await a.connect(issuer).buy(TOTAL, TOTAL);

        // Issuer holds the full ZENO supply now; prefilled pmUSD still in ZENO contract.
        expect(await z.balanceOf(issuer.address)).to.equal(TOTAL);
        expect(await pmUSD.balanceOf(z.target)).to.equal(TOTAL);
        // Issuer still holds the recycled payment (received it back as issuer).
        expect(await pmUSD.balanceOf(issuer.address)).to.equal(ethers.parseUnits("100", 18));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Local helper used in product scenarios
// ─────────────────────────────────────────────────────────────────────────────

async function underlying_topUp(token, fromSigner, zeno, amount) {
    await token.connect(fromSigner).transfer(zeno.target, amount);
}
