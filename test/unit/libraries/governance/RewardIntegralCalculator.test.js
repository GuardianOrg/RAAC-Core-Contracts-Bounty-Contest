import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("RewardIntegralCalculator", function () {
    let calculator;
    let owner;

    const DAY = 24 * 60 * 60;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const YEAR = 365 * DAY;
    
    const WAD = ethers.parseEther("1"); // 1e18
    const RAY = ethers.parseUnits("1", 27); // 1e27
    
    const MIN_BOOST = 10000n; // 1x in BPS (100%)
    const MAX_BOOST = 25000n; // 2.5x in BPS (250%)

    before(async function () {
        [owner] = await ethers.getSigners();

        const MockRewardIntegralCalculator = await ethers.getContractFactory("MockRewardIntegralCalculator");
        calculator = await MockRewardIntegralCalculator.deploy();
        await calculator.waitForDeployment();
    });

    describe("calculateWorkingBalance", function () {
        it("should return 0 when balance is 0", async function () {
            const balance = 0n;
            const userWeight = 15000n;
            const maxBoost = MAX_BOOST;

            const workingBalance = await calculator.calculateWorkingBalance(balance, userWeight, maxBoost);
            expect(workingBalance).to.equal(0);
        });

        it("should calculate working balance with minimum boost (10000 = 1x)", async function () {
            const balance = ethers.parseEther("100");
            const userWeight = MIN_BOOST; // 1x boost
            const maxBoost = MAX_BOOST;

            const workingBalance = await calculator.calculateWorkingBalance(balance, userWeight, maxBoost);
            // workingBalance = (balance * userWeight) / maxBoost = (100 * 10000) / 25000 = 40
            expect(workingBalance).to.equal(ethers.parseEther("40"));
        });

        it("should calculate working balance with maximum boost (25000 = 2.5x)", async function () {
            const balance = ethers.parseEther("100");
            const userWeight = MAX_BOOST; // 2.5x boost
            const maxBoost = MAX_BOOST;

            const workingBalance = await calculator.calculateWorkingBalance(balance, userWeight, maxBoost);
            // workingBalance = (balance * userWeight) / maxBoost = (100 * 25000) / 25000 = 100
            expect(workingBalance).to.equal(balance);
        });

        it("should cap working balance at raw balance", async function () {
            const balance = ethers.parseEther("100");
            const userWeight = 30000n; // 3x boost (above max that is 2.5x)
            const maxBoost = MAX_BOOST;

            const workingBalance = await calculator.calculateWorkingBalance(balance, userWeight, maxBoost);
            // Ensure it's still capped at balance
            expect(workingBalance).to.equal(balance);
        });

        it("should calculate intermediate boost correctly", async function () {
            const balance = ethers.parseEther("1000");
            const userWeight = 17500n; // 1.75x boost
            const maxBoost = MAX_BOOST;

            const workingBalance = await calculator.calculateWorkingBalance(balance, userWeight, maxBoost);
            // workingBalance = (1000 * 17500) / 25000 = 700
            expect(workingBalance).to.equal(ethers.parseEther("700"));
        });
    });

    describe("calculatePeriodIndexFromTime", function () {
        it("should return 0 for time before gauge start", async function () {
            const time = 1000n;
            const gaugeStartTime = 2000n;
            const periodDuration = WEEK;

            const periodIndex = await calculator.calculatePeriodIndexFromTime(time, gaugeStartTime, periodDuration);
            expect(periodIndex).to.equal(0);
        });

        it("should return 0 for time at gauge start", async function () {
            const time = 2000n;
            const gaugeStartTime = 2000n;
            const periodDuration = WEEK;

            const periodIndex = await calculator.calculatePeriodIndexFromTime(time, gaugeStartTime, periodDuration);
            expect(periodIndex).to.equal(0);
        });

        it("should calculate correct period index for first period", async function () {
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);
            const time = gaugeStartTime + periodDuration / 2n; // Mid period

            const periodIndex = await calculator.calculatePeriodIndexFromTime(time, gaugeStartTime, periodDuration);
            expect(periodIndex).to.equal(0);
        });

        it("should calculate correct period index for second period", async function () {
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);
            const time = gaugeStartTime + periodDuration + 1n;

            const periodIndex = await calculator.calculatePeriodIndexFromTime(time, gaugeStartTime, periodDuration);
            expect(periodIndex).to.equal(1);
        });

        it("should calculate correct period index for multiple periods", async function () {
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);
            const time = gaugeStartTime + (periodDuration * 10n);

            const periodIndex = await calculator.calculatePeriodIndexFromTime(time, gaugeStartTime, periodDuration);
            expect(periodIndex).to.equal(10);
        });
    });

    describe("calculatePeriodBoundariesFromTime", function () {
        it("should calculate boundaries for first period", async function () {
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);
            const time = gaugeStartTime + 100n;

            const [periodStartTime, periodEndTime] = await calculator.calculatePeriodBoundariesFromTime(
                time,
                gaugeStartTime,
                periodDuration
            );

            expect(periodStartTime).to.equal(gaugeStartTime);
            expect(periodEndTime).to.equal(gaugeStartTime + periodDuration);
        });

        it("should calculate boundaries for second period", async function () {
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);
            const time = gaugeStartTime + periodDuration + 100n;

            const [periodStartTime, periodEndTime] = await calculator.calculatePeriodBoundariesFromTime(
                time,
                gaugeStartTime,
                periodDuration
            );

            expect(periodStartTime).to.equal(gaugeStartTime + periodDuration);
            expect(periodEndTime).to.equal(gaugeStartTime + (periodDuration * 2n));
        });

        it("should handle time before gauge start", async function () {
            const gaugeStartTime = 2000n;
            const periodDuration = BigInt(WEEK);
            const time = 1000n;

            const [periodStartTime, periodEndTime] = await calculator.calculatePeriodBoundariesFromTime(
                time,
                gaugeStartTime,
                periodDuration
            );

            expect(periodStartTime).to.equal(gaugeStartTime);
            expect(periodEndTime).to.equal(gaugeStartTime + periodDuration);
        });
    });

    describe("calculatePeriodBoundariesFromIndex", function () {
        it("should calculate boundaries for period index 0", async function () {
            const periodIndex = 0n;
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);

            const [periodStartTime, periodEndTime] = await calculator.calculatePeriodBoundariesFromIndex(
                periodIndex,
                gaugeStartTime,
                periodDuration
            );

            expect(periodStartTime).to.equal(gaugeStartTime);
            expect(periodEndTime).to.equal(gaugeStartTime + periodDuration);
        });

        it("should calculate boundaries for period index 5", async function () {
            const periodIndex = 5n;
            const gaugeStartTime = 1000n;
            const periodDuration = BigInt(WEEK);

            const [periodStartTime, periodEndTime] = await calculator.calculatePeriodBoundariesFromIndex(
                periodIndex,
                gaugeStartTime,
                periodDuration
            );

            expect(periodStartTime).to.equal(gaugeStartTime + (periodDuration * 5n));
            expect(periodEndTime).to.equal(gaugeStartTime + (periodDuration * 6n));
        });
    });

    describe("calculateRate", function () {
        it("should return 0 when duration is 0", async function () {
            const amount = ethers.parseEther("1000");
            const duration = 0n;

            const rate = await calculator.calculateRate(amount, duration);
            expect(rate).to.equal(0);
        });

        it("should return 0 when amount is 0", async function () {
            const amount = 0n;
            const duration = BigInt(WEEK);

            const rate = await calculator.calculateRate(amount, duration);
            expect(rate).to.equal(0);
        });

        it("should calculate rate correctly for 1 week", async function () {
            const amount = ethers.parseEther("1000");
            const duration = BigInt(WEEK);

            const rate = await calculator.calculateRate(amount, duration);
            
            // Rate should be amount per second in RAY precision
            // rate = rayDiv(wadToRay(amount), duration) = (wadToRay(amount) * RAY) / duration
            // wadToRay(amount) = amount * 1e9, then rayDiv multiplies by 1e27 again
            expect(rate).to.be.gt(0);
            
            // rate * duration / RAY / 1e9 = original amount
            const recovered = (rate * duration) / RAY / 1000000000n;
            expect(recovered).to.be.closeTo(amount, amount / 1000n); // 0.1% tolerance
        });

        it("should calculate rate correctly for 1 month", async function () {
            const amount = ethers.parseEther("10000");
            const duration = BigInt(MONTH);

            const rate = await calculator.calculateRate(amount, duration);
            
            expect(rate).to.be.gt(0);
            
            const recovered = (rate * duration) / RAY / 1000000000n;
            expect(recovered).to.be.closeTo(amount, amount / 1000n);
        });
    });

    describe("calculateGaugeIntegral", function () {
        it("should return current integral when working supply is 0", async function () {
            const currentIntegral = RAY * 100n;
            const rate = RAY * 10n;
            const timeDelta = 3600n;
            const workingSupply = 0n;

            const updatedIntegral = await calculator.calculateGaugeIntegral(
                currentIntegral,
                rate,
                timeDelta,
                workingSupply
            );

            expect(updatedIntegral).to.equal(currentIntegral);
        });

        it("should return current integral when rate is 0", async function () {
            const currentIntegral = RAY * 100n;
            const rate = 0n;
            const timeDelta = 3600n;
            const workingSupply = ethers.parseEther("1000");

            const updatedIntegral = await calculator.calculateGaugeIntegral(
                currentIntegral,
                rate,
                timeDelta,
                workingSupply
            );

            expect(updatedIntegral).to.equal(currentIntegral);
        });

        it("should return current integral when time delta is 0", async function () {
            const currentIntegral = RAY * 100n;
            const rate = RAY * 10n;
            const timeDelta = 0n;
            const workingSupply = ethers.parseEther("1000");

            const updatedIntegral = await calculator.calculateGaugeIntegral(
                currentIntegral,
                rate,
                timeDelta,
                workingSupply
            );

            expect(updatedIntegral).to.equal(currentIntegral);
        });

        it("should calculate integral correctly with valid inputs", async function () {
            const currentIntegral = 0n;
            const amount = ethers.parseEther("1000");
            const duration = BigInt(WEEK);
            const rate = await calculator.calculateRate(amount, duration);
            const timeDelta = BigInt(DAY);
            const workingSupply = ethers.parseEther("100");

            const updatedIntegral = await calculator.calculateGaugeIntegral(
                currentIntegral,
                rate,
                timeDelta,
                workingSupply
            );

            expect(updatedIntegral).to.be.gt(currentIntegral);
        });

        it("should accumulate integral over multiple updates", async function () {
            const amount = ethers.parseEther("1000");
            const duration = BigInt(WEEK);
            const rate = await calculator.calculateRate(amount, duration);
            const timeDelta = BigInt(DAY);
            const workingSupply = ethers.parseEther("100");

            let integral = 0n;
            
            // First update
            integral = await calculator.calculateGaugeIntegral(integral, rate, timeDelta, workingSupply);
            const firstIntegral = integral;
            expect(firstIntegral).to.be.gt(0);

            // Second update
            integral = await calculator.calculateGaugeIntegral(integral, rate, timeDelta, workingSupply);
            expect(integral).to.be.gt(firstIntegral);
            expect(integral).to.equal(firstIntegral * 2n);
        });
    });

    describe("calculateUserIntegral", function () {
        it("should return 0 claimable when user working balance is 0", async function () {
            const userWorkingBalance = 0n;
            const gaugeIntegral = RAY * 100n;
            const userLastGaugeIntegral = 0n;
            const userIntegral = 0n;

            const [newUserIntegral, claimableRewards] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );

            expect(newUserIntegral).to.equal(userIntegral);
            expect(claimableRewards).to.equal(0);
        });

        it("should return 0 claimable when gauge integral hasn't increased", async function () {
            const userWorkingBalance = ethers.parseEther("100");
            const gaugeIntegral = RAY * 100n;
            const userLastGaugeIntegral = RAY * 100n;
            const userIntegral = ethers.parseEther("50");

            const [newUserIntegral, claimableRewards] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );

            expect(newUserIntegral).to.equal(userIntegral);
            expect(claimableRewards).to.equal(0);
        });

        it("should calculate claimable rewards correctly", async function () {
            const userWorkingBalance = ethers.parseEther("100");
            const amount = ethers.parseEther("1000");
            const duration = BigInt(WEEK);
            const rate = await calculator.calculateRate(amount, duration);
            const timeDelta = BigInt(DAY);
            const workingSupply = ethers.parseEther("1000");

            // Calculate gauge integral increase
            const gaugeIntegral = await calculator.calculateGaugeIntegral(0n, rate, timeDelta, workingSupply);
            const userLastGaugeIntegral = 0n;
            const userIntegral = 0n;

            const [newUserIntegral, claimableRewards] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );

            expect(claimableRewards).to.be.gt(0);
            expect(newUserIntegral).to.equal(userIntegral + claimableRewards);
        });

        it("should accumulate user integral correctly", async function () {
            const userWorkingBalance = ethers.parseEther("100");
            const amount = ethers.parseEther("1000");
            const duration = BigInt(WEEK);
            const rate = await calculator.calculateRate(amount, duration);
            const timeDelta = BigInt(DAY);
            const workingSupply = ethers.parseEther("1000");

            // First period
            let gaugeIntegral = await calculator.calculateGaugeIntegral(0n, rate, timeDelta, workingSupply);
            let [userIntegral, claimable1] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                0n,
                0n
            );

            expect(claimable1).to.be.gt(0);
            expect(userIntegral).to.equal(claimable1);

            // Second period
            const lastGaugeIntegral = gaugeIntegral;
            gaugeIntegral = await calculator.calculateGaugeIntegral(gaugeIntegral, rate, timeDelta, workingSupply);
            const [newUserIntegral, claimable2] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                lastGaugeIntegral,
                userIntegral
            );

            expect(claimable2).to.be.closeTo(claimable1, claimable1 / 100n); // Within 1%
            expect(newUserIntegral).to.equal(userIntegral + claimable2);
        });
    });

    describe("recalculateRate", function () {
        it("should return 0 rate when remaining time is 0", async function () {
            const currentRate = RAY * 10n;
            const oldWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = ethers.parseEther("2000");
            const remainingTime = 0n;
            const lastUpdateTime = 1000n;
            const currentTime = 1000n;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(newRate).to.equal(0);
            expect(accruedRewards).to.equal(0);
        });

        it("should return 0 rate when new working supply is 0", async function () {
            const currentRate = RAY * 10n;
            const oldWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = 0n;
            const remainingTime = BigInt(WEEK);
            const lastUpdateTime = 1000n;
            const currentTime = 1000n;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(newRate).to.equal(0);
            expect(accruedRewards).to.equal(0);
        });

        it("should return 0 when current rate is 0", async function () {
            const currentRate = 0n;
            const oldWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = ethers.parseEther("2000");
            const remainingTime = BigInt(WEEK);
            const lastUpdateTime = 1000n;
            const currentTime = 1000n;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(newRate).to.equal(0);
            expect(accruedRewards).to.equal(0);
        });

        it("should calculate accrued rewards when time has passed", async function () {
            const amount = ethers.parseEther("1000");
            const totalDuration = BigInt(WEEK);
            const currentRate = await calculator.calculateRate(amount, totalDuration);
            const oldWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = ethers.parseEther("2000");
            const timePassed = BigInt(DAY);
            const remainingTime = totalDuration - timePassed;
            const lastUpdateTime = 1000n;
            const currentTime = lastUpdateTime + timePassed;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(accruedRewards).to.be.gt(0);
            expect(newRate).to.be.gt(0);
            expect(newRate).to.be.lt(currentRate);
        });

        it("should recalculate rate correctly with no time passed", async function () {
            const amount = ethers.parseEther("1000");
            const totalDuration = BigInt(WEEK);
            const currentRate = await calculator.calculateRate(amount, totalDuration);
            const oldWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = ethers.parseEther("2000");
            const remainingTime = totalDuration;
            const lastUpdateTime = 1000n;
            const currentTime = 1000n;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(accruedRewards).to.equal(0);
            expect(newRate).to.equal(currentRate); 
        });

        it("should handle working supply increase mid-period", async function () {
            const amount = ethers.parseEther("1000");
            const totalDuration = BigInt(WEEK);
            const currentRate = await calculator.calculateRate(amount, totalDuration);
            const oldWorkingSupply = ethers.parseEther("100");
            const newWorkingSupply = ethers.parseEther("200");
            const timePassed = totalDuration / 2n;
            const remainingTime = totalDuration - timePassed;
            const lastUpdateTime = 1000n;
            const currentTime = lastUpdateTime + timePassed;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                currentRate,
                oldWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(accruedRewards).to.be.gt(0);
            expect(newRate).to.be.gt(0);
            expect(newRate).to.be.lte(currentRate);
            
            // Working supply has changed, so the left over amount can be recovered from the new rate
            const recoveredRemaining = (newRate * remainingTime) / RAY / 1000000000n;
            expect(recoveredRemaining).to.be.gt(0);
            expect(recoveredRemaining).to.be.lt(amount);
        });
    });

    describe("Integration scenarios", function () {
        it("should handle full reward distribution cycle", async function () {
            // Setup
            const rewardAmount = ethers.parseEther("1000");
            const periodDuration = BigInt(WEEK);
            const workingSupply = ethers.parseEther("1000");
            const userWorkingBalance = ethers.parseEther("100"); // 10% of supply

            // Calculate rate
            const rate = await calculator.calculateRate(rewardAmount, periodDuration);
            expect(rate).to.be.gt(0);

            let gaugeIntegral = 0n;
            let userIntegral = 0n;
            let userLastGaugeIntegral = 0n;
            let totalClaimed = 0n;

            gaugeIntegral = await calculator.calculateGaugeIntegral(
                gaugeIntegral,
                rate,
                periodDuration / 4n,
                workingSupply
            );

            let [newUserIntegral, claimable] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );
            
            userIntegral = newUserIntegral;
            userLastGaugeIntegral = gaugeIntegral;
            totalClaimed += claimable;

            // QUARTER
            gaugeIntegral = await calculator.calculateGaugeIntegral(
                gaugeIntegral,
                rate,
                periodDuration / 4n,
                workingSupply
            );

            [newUserIntegral, claimable] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );
            
            userIntegral = newUserIntegral;
            userLastGaugeIntegral = gaugeIntegral;
            totalClaimed += claimable;

            // MID
            gaugeIntegral = await calculator.calculateGaugeIntegral(
                gaugeIntegral,
                rate,
                periodDuration / 2n,
                workingSupply
            );

            [newUserIntegral, claimable] = await calculator.calculateUserIntegral(
                userWorkingBalance,
                gaugeIntegral,
                userLastGaugeIntegral,
                userIntegral
            );
            
            totalClaimed += claimable;

            // User get ~ 10% of total rewards
            const expectedRewards = rewardAmount / 10n;
            expect(totalClaimed).to.be.closeTo(expectedRewards, expectedRewards / 100n); // 1% tolerance
        });

        it("should handle mid-period working supply change", async function () {
            const rewardAmount = ethers.parseEther("1000");
            const periodDuration = BigInt(WEEK);
            const initialWorkingSupply = ethers.parseEther("1000");
            const newWorkingSupply = ethers.parseEther("2000");

            let rate = await calculator.calculateRate(rewardAmount, periodDuration);

            // MID period, working supply doubles
            const timePassed = periodDuration / 2n;
            const remainingTime = periodDuration - timePassed;
            const lastUpdateTime = 0n;
            const currentTime = timePassed;

            const [newRate, accruedRewards] = await calculator.recalculateRate(
                rate,
                initialWorkingSupply,
                newWorkingSupply,
                remainingTime,
                lastUpdateTime,
                currentTime
            );

            expect(accruedRewards).to.be.gt(0);
            expect(newRate).to.be.gt(0);
            
            // First half used original rate, second half uses new rate
            const firstHalfDistributed = (rate * timePassed) / RAY / 1000000000n;
            const secondHalfDistributed = (newRate * remainingTime) / RAY / 1000000000n;
            const totalDistributed = firstHalfDistributed + secondHalfDistributed;
            
            expect(totalDistributed).to.be.closeTo(rewardAmount, rewardAmount / 1000n); // 0.1% 
        });
    });
});

