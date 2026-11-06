import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("TimeUtils", () => {
    let mockTimeUtils;

    before(async () => {
        const MockTimeUtils = await ethers.getContractFactory("MockTimeUtils");
        mockTimeUtils = await MockTimeUtils.deploy();
        await mockTimeUtils.waitForDeployment();
    });

    describe("getNextThursdayMidnight", () => {
        it("should return the next Thursday midnight", async () => {

            // Saturday 14 June 2025 00:00:00
            const result = await mockTimeUtils.getNextThursdayMidnight(1749859200);
            // Thursday 19 June 2025 00:00:00
            expect(result).to.equal(1750291200); 
        });
        it('should return the current time if it is already Thursday midnight', async () => {
            // Thursday 19 June 2025 00:00:00
            const result = await mockTimeUtils.getNextThursdayMidnight(1750291200);
            // Thursday 19 June 2025 00:00:00
            expect(result).to.equal(1750291200);
        });
        it('should then return the next Thursday midnight if the current time is slightly after Thursday midnight', async () => {
            // Thursday 19 June 2025 00:00:01
            const result = await mockTimeUtils.getNextThursdayMidnight(1750291201);
            // Thursday 26 June 2025 00:00:00
            expect(result).to.equal(1750896000);
        });
    });

    describe("roundUpToNextWeek", () => {
        it("should return the next week boundary", async () => {
            // 1750291200 is exactly on a week boundary (returned as-is now),
            // so use a timestamp strictly inside the week
            const result = await mockTimeUtils.roundUpToNextWeek(1750291201);
            expect(result).to.equal(1750896000);
        });
        it("should return the current time if it is already a week boundary", async () => {
            const result = await mockTimeUtils.roundUpToNextWeek(1750896000);
            expect(result).to.equal(1750896000);
        });
    });

    describe("getNextWeekOrCap", () => {
        it("should return the next week boundary", async () => {
            const result = await mockTimeUtils.getNextWeekOrCap(1750291200, 1750896000);
            expect(result).to.equal(1750896000);
        });

        it("should return the current time if it is already a week boundary", async () => {
            const result = await mockTimeUtils.getNextWeekOrCap(1750896000, 1750896000);
            expect(result).to.equal(1750896000);
        });

        it("should return the current time if it is before the next week boundary", async () => {
            const result = await mockTimeUtils.getNextWeekOrCap(1750291200, 1750896000);
            expect(result).to.equal(1750896000);
        });

        it("should return the current time if it is after the next week boundary", async () => {
            const result = await mockTimeUtils.getNextWeekOrCap(1750896001, 1750896000);
            expect(result).to.equal(1750896000);
        });
    });
}); 