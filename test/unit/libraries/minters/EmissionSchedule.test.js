import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
const { ethers } = hre;

describe("EmissionSchedule", function () {
    let emissionScheduleMock;

    // BASE_WEEKLY_EMISSION matches the Solidity constant (already in wei with 18 decimals)
    const BASE_WEEKLY_EMISSION = 23852798580398015692800n;
    const SECONDS_IN_WEEK = 604800; //(7 * 24 * 60 * 60);
    const BASE_PER_SECOND = BASE_WEEKLY_EMISSION / BigInt(SECONDS_IN_WEEK); // 39439151091927936n

    beforeEach(async function () {
        const EmissionScheduleMock = await ethers.getContractFactory("EmissionScheduleMock");
        emissionScheduleMock = await EmissionScheduleMock.deploy();
        await emissionScheduleMock.waitForDeployment();
    });

    describe("getMintingWeekForTimestamp", function () {
        it("should return the correct week number for a given timestamp", async function () {
            let activationTimestamp = await time.latest();
            const expectedBoundsResults = [
                [[activationTimestamp, 0], 0],
                [[activationTimestamp, activationTimestamp], 1],
                [[activationTimestamp+1, activationTimestamp], 1],
                [[activationTimestamp+SECONDS_IN_WEEK-1, activationTimestamp], 1],
                [[activationTimestamp+SECONDS_IN_WEEK, activationTimestamp], 2],
                [[activationTimestamp+SECONDS_IN_WEEK*2-1, activationTimestamp], 2],
                [[activationTimestamp+SECONDS_IN_WEEK*2, activationTimestamp], 3],
                [[activationTimestamp+SECONDS_IN_WEEK*3-1, activationTimestamp], 3],
                [[activationTimestamp+SECONDS_IN_WEEK*3, activationTimestamp], 4],
                [[activationTimestamp+SECONDS_IN_WEEK*3.5, activationTimestamp], 4],
                [[activationTimestamp+SECONDS_IN_WEEK*10, activationTimestamp], 11],
                [[activationTimestamp+SECONDS_IN_WEEK*100, activationTimestamp], 101],
                [[activationTimestamp+SECONDS_IN_WEEK*780, activationTimestamp], 781],
                [[activationTimestamp+SECONDS_IN_WEEK*781, activationTimestamp], 782],
                [[activationTimestamp+SECONDS_IN_WEEK*782, activationTimestamp], 783],
            ]

            for(const [[lookupTs, activateTs], expectedResult] of expectedBoundsResults) {
                expect(await emissionScheduleMock.getMintingWeekForTimestamp(activateTs, lookupTs)).to.equal(expectedResult);
            }
        });
    });
    

    describe("getEmissionPerSecondForWeek", function () {
        it("should return the correct emission per second for each week", async function () {
            expect(await emissionScheduleMock.getEmissionPerSecondForWeek(0)).to.equal(0);
            for(let i = 1; i <= 104; i++) {
                expect(await emissionScheduleMock.getEmissionPerSecondForWeek(i)).to.equal(BASE_PER_SECOND);
            }
            function getExpectedEmissionForWeek(weekNumber) {
                if(weekNumber == 0) return 0n;
                if(weekNumber < 105) return BASE_PER_SECOND;
                if(weekNumber >= 781) return 0n;
                // Emission per second values computed using Solidity's integer division
                // Each entry: [first_week_of_next_period, emission_per_second_for_this_period]
                const emissions = [
                    [118, 37467193537331539n],   // Weeks 105-117
                    [131, 35593833860464962n],   // Weeks 118-130
                    [144, 33814142167441714n],   // Weeks 131-143
                    [157, 32123435059069628n],   // Weeks 144-156
                    [170, 30517263306116147n],   // Weeks 157-169
                    [183, 28991400140810339n],   // Weeks 170-182
                    [196, 27541830133769822n],   // Weeks 183-195
                    [209, 26164738627081331n],   // Weeks 196-208
                    [222, 24856501695727264n],   // Weeks 209-221
                    [235, 23613676610940901n],   // Weeks 222-234
                    [248, 22432992780393856n],   // Weeks 235-247
                    [261, 21311343141374163n],   // Weeks 248-260
                    [274, 20245775984305455n],   // Weeks 261-273
                    [287, 19233487185090182n],   // Weeks 274-286
                    [300, 18271812825835673n],   // Weeks 287-299
                    [313, 17358222184543889n],   // Weeks 300-312
                    [326, 16490311075316695n],   // Weeks 313-325
                    [339, 15665795521550860n],   // Weeks 326-338
                    [352, 14882505745473317n],   // Weeks 339-351
                    [365, 14138380458199651n],   // Weeks 352-364
                    [378, 13431461435289669n],   // Weeks 365-377
                    [391, 12759888363525185n],   // Weeks 378-390
                    [404, 12121893945348926n],   // Weeks 391-403
                    [417, 11515799248081480n],   // Weeks 404-416
                    [430, 10940009285677406n],   // Weeks 417-429
                    [443, 10393008821393535n],   // Weeks 430-442
                    [456, 9873358380323858n],    // Weeks 443-455
                    [469, 9379690461307666n],    // Weeks 456-468
                    [482, 8910705938242282n],    // Weeks 469-481
                    [495, 8465170641330168n],    // Weeks 482-494
                    [508, 8041912109263660n],    // Weeks 495-507
                    [521, 7639816503800477n],    // Weeks 508-520
                    [534, 7257825678610453n],    // Weeks 521-533
                    [547, 6894934394679930n],    // Weeks 534-546
                    [560, 6550187674945934n],    // Weeks 547-559
                    [573, 6222678291198637n],    // Weeks 560-572
                    [586, 5911544376638705n],    // Weeks 573-585
                    [599, 5615967157806770n],    // Weeks 586-598
                    [612, 5335168799916431n],    // Weeks 599-611
                    [625, 5068410359920610n],    // Weeks 612-624
                    [638, 4814989841924579n],    // Weeks 625-637
                    [651, 4574240349828350n],    // Weeks 638-650
                    [664, 4345528332336933n],    // Weeks 651-663
                    [677, 4128251915720086n],    // Weeks 664-676
                    [690, 3921839319934082n],    // Weeks 677-689
                    [703, 3725747353937378n],    // Weeks 690-702
                    [716, 3539459986240509n],    // Weeks 703-715
                    [729, 3362486986928483n],    // Weeks 716-728
                    [742, 3194362637582059n],    // Weeks 729-741
                    [755, 3034644505702956n],    // Weeks 742-754
                    [768, 2882912280417808n],    // Weeks 755-767
                    [781, 2738766666396918n]     // Weeks 768-780
                ];

                // Binary search for the week number - where first number is greater than weekNumber
                let low = 0;
                let high = emissions.length - 1;
                while(low <= high) {
                    const mid = Math.floor((low + high) / 2);
                    if(emissions[mid][0] > weekNumber) {
                        high = mid - 1;
                    } else {
                        low = mid + 1;
                    }
                }

                return emissions[low][1];
            }

            let sum = 0n;

            for(let i = 0; i < 800; i++) {
                const weekNumber = i;
                const emissionPerSecond = await emissionScheduleMock.getEmissionPerSecondForWeek(weekNumber);
                const expectedEmission = getExpectedEmissionForWeek(weekNumber);
                sum += emissionPerSecond * BigInt(SECONDS_IN_WEEK);
                expect(emissionPerSecond).to.equal(expectedEmission, `Week ${weekNumber} failed`);
            }
            // Total emissions after 780 weeks is ~7,963,200 tokens based on the emission schedule
            expect(sum).to.closeTo(ethers.parseEther("7963200"), ethers.parseEther("1"));
            expect(sum).to.be.below(ethers.parseEther("7963200"));
        });
        it('should be gas efficient', async function () {
            const expectedGas = [
                [0, 21550n],
                [1, 21650n],
                [100, 21850n],
                [103, 21850n],
                [104, 21850n],
                [105, 22050n],
                [130, 22150n],
                [140, 22250n],
                [150, 22250n],
                [350, 22450n],
                [400, 22500n],
                [500, 22550n],
                [600, 22600n],
                [780, 22600n],
                [781, 22100n],
                [782, 22100n],
                [850, 22100n],
            ]
            for(const [week, gas] of expectedGas) {
                const gasEstimate = await emissionScheduleMock.getEmissionPerSecondForWeek.estimateGas(week);
                expect(gasEstimate).to.be.below(gas, `Gas estimate for week ${week} is too high`);
            }
        });
        

    });

    describe('computeWeeklyEmissions', function () {
        it('should return the correct seconds spent in each week', async function () {
            let activationTimestamp = await time.latest();
            const expectations = [
                // [ START_TIME      ,   END_TIME        ,[WEEK_NUMBER, SECONDS_IN_WEEK, SUM_EMISSION_IN_WEEK] ]
                [activationTimestamp, activationTimestamp, [[1, 0, 0]]],
                [activationTimestamp, activationTimestamp+SECONDS_IN_WEEK, [
                    [1, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)]
                ]],
                [activationTimestamp, activationTimestamp+SECONDS_IN_WEEK*2, [
                    [1, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)],
                    [2, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)]
                ]],
                [activationTimestamp, activationTimestamp+SECONDS_IN_WEEK*3, [
                    [1, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)],
                    [2, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)],
                    [3, SECONDS_IN_WEEK, BASE_PER_SECOND * BigInt(SECONDS_IN_WEEK)]
                ]],
                [activationTimestamp+(SECONDS_IN_WEEK*104)-10, activationTimestamp+(SECONDS_IN_WEEK*104)+10, [
                    [104, 10n, 394391510919279360n],   // 10 * BASE_PER_SECOND (39439151091927936)
                    [105, 10n, 374671935373315390n],   // 10 * period1_per_second (37467193537331539)
                ]],
                [activationTimestamp+(SECONDS_IN_WEEK*104)-10, activationTimestamp+(SECONDS_IN_WEEK*106)+10, [
                    [104n, 10n, 394391510919279360n],           // 10 * BASE_PER_SECOND
                    [105n, 604800n, 22660158651378114787200n],  // 604800 * 37467193537331539
                    [106n, 604800n, 22660158651378114787200n],  // 604800 * 37467193537331539
                    [107n, 10n, 374671935373315390n],           // 10 * period1_per_second
                ]],
                [activationTimestamp+(SECONDS_IN_WEEK*500)-10, activationTimestamp+(SECONDS_IN_WEEK*500)+10, [
                    [500, 10n, 80419121092636600n],    // 10 * week500_per_second (8041912109263660)
                    [501, 10n, 80419121092636600n],    // 10 * week501_per_second (same period)
                ]],
                [activationTimestamp+(SECONDS_IN_WEEK*780)-7700, activationTimestamp+(SECONDS_IN_WEEK*780)+7700, [
                    [780n, 7700n, 21088503331256268600n],  // 7700 * week780_per_second (2738766666396918)
                    [781n, 7700n, 0n],                     // No emissions after week 780
                ]],
            ]
            for(const [startTime, endTime, expectedResult] of expectations) {
                const results = await emissionScheduleMock.computeWeeklyEmissions(activationTimestamp, startTime, endTime);
                expect(results).to.deep.equal(expectedResult, `Failed for test case: ${startTime} - ${endTime}`);
            }
        });
        it('should ensure full emission is correct', async function () {
            let activationTimestamp = await time.latest();
            const results = await emissionScheduleMock.computeWeeklyEmissions(activationTimestamp, activationTimestamp, activationTimestamp+SECONDS_IN_WEEK*800)
            let sum = 0n;
            for(const result of results) {
                sum += result[2];
            }
            // Total emissions after 780 weeks is ~7,963,200 tokens
            expect(sum).to.closeTo(ethers.parseEther("7963200"), ethers.parseEther("1"));
        });
        it('should be gas efficient', async function () {
            let activationTimestamp = await time.latest();
            const startTime = activationTimestamp;
            const endTime = activationTimestamp+SECONDS_IN_WEEK*3;
            expect(await emissionScheduleMock.computeWeeklyEmissions.estimateGas(activationTimestamp, startTime, endTime)).to.be.below(30000n);
            expect(await emissionScheduleMock.computeWeeklyEmissions.estimateGas(activationTimestamp, startTime+SECONDS_IN_WEEK*10, startTime+SECONDS_IN_WEEK*11)).to.be.below(30000n);
            expect(await emissionScheduleMock.computeWeeklyEmissions.estimateGas(activationTimestamp, startTime+SECONDS_IN_WEEK*100, startTime+SECONDS_IN_WEEK*101)).to.be.below(30000n);
            expect(await emissionScheduleMock.computeWeeklyEmissions.estimateGas(activationTimestamp, startTime+SECONDS_IN_WEEK*780, startTime+SECONDS_IN_WEEK*781)).to.be.below(30000n);
            expect(await emissionScheduleMock.computeWeeklyEmissions.estimateGas(activationTimestamp, startTime+SECONDS_IN_WEEK*900, startTime+SECONDS_IN_WEEK*901)).to.be.below(30000n);
        });
    });

    describe('calculateScheduledMintableAmount', function () {
        it('should return the correct amount', async function () {
            let activationTimestamp = await time.latest();
            const startTime = activationTimestamp;
            const endTime = activationTimestamp+SECONDS_IN_WEEK * 3;
            const results = await emissionScheduleMock.calculateScheduledMintableAmount(activationTimestamp, startTime, endTime);
            // 3 weeks * 604800 seconds/week * BASE_PER_SECOND (39439151091927936)
            expect(results).to.equal(71558395741194047078400n);
            const total = await emissionScheduleMock.computeWeeklyEmissions(activationTimestamp, activationTimestamp, activationTimestamp+SECONDS_IN_WEEK*785);
            const totalSum = total.reduce((sum, result) => sum + result[2], 0n);
            // Total emissions after 780 weeks is ~7,963,200 tokens
            expect(totalSum).to.closeTo(ethers.parseEther("7963200"), ethers.parseEther("1"));
            expect(totalSum).to.be.below(ethers.parseEther("7963200"));
        });
        it('should be gas efficient', async function () {
            let activationTimestamp = await time.latest();
            const startTime = activationTimestamp;
            const endTime = activationTimestamp+SECONDS_IN_WEEK*3;
            const gasEstimate = await emissionScheduleMock.calculateScheduledMintableAmount.estimateGas(activationTimestamp, startTime, endTime);
            expect(gasEstimate).to.be.below(30000n);
        });
    });

    describe('Emission Schedule Output', function () {
        it('should output the full emission schedule in table format', async function () {
            let activationTimestamp = await time.latest();

            // console.log("\n=== EMISSION SCHEDULE FROM CURRENT ALGORITHM ===\n");
            // console.log("Week\tRAC Emissions\tCumulative\tMonth");
            // console.log("----\t-------------\t----------\t-----");

            let cumulative = 0n;
            const ONE_ETHER = ethers.parseEther("1");

            for (let week = 1; week <= 780; week++) {
                const weekStart = activationTimestamp + (week - 1) * SECONDS_IN_WEEK;
                const weekEnd = activationTimestamp + week * SECONDS_IN_WEEK;

                const weeklyEmission = await emissionScheduleMock.calculateScheduledMintableAmount(
                    activationTimestamp,
                    weekStart,
                    weekEnd
                );

                cumulative += weeklyEmission;
                const month = Math.ceil(week / 4);

                // Convert to whole tokens (divide by 1e18)
                const emissionFormatted = ethers.formatEther(weeklyEmission);
                const cumulativeFormatted = Number(ethers.formatEther(cumulative)).toFixed(18);

                // console.log(`${week}\t${emissionFormatted.toLocaleString()}\t\t\t${cumulativeFormatted.toLocaleString()}\t\t${month}`);
            }

            // console.log("\n=== SUMMARY ===");
            // console.log(`Total emissions after 780 weeks: ${Number(cumulative / ONE_ETHER).toLocaleString()} RAAC`);
            // console.log(`Week 1 emission: ${Number(BASE_WEEKLY_EMISSION / ONE_ETHER).toLocaleString()} RAAC`);
            // console.log(`Week 105 emission (first reduction): ${Number(BASE_WEEKLY_EMISSION * 95n / 100n / ONE_ETHER).toLocaleString()} RAAC`);
        });
    });
}); 