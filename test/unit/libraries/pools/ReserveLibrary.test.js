import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

// Formulas from tokenomics doc
function expectedBorrowRate(target_rate, utilization_rate, target_utilization_rate, utilization_penalty_rate = 8) {
  return target_rate + Math.max(0, (utilization_rate - target_utilization_rate)  * utilization_penalty_rate)
}

function expectedLiquidityRate(borrow_rate, utilization_rate, protocol_fee)  {
  return borrow_rate * utilization_rate * (1- protocol_fee);
}

describe("ReserveLibrary", function () {
  let reserveLibrary;
  let owner, user1;

  beforeEach(async function () {
    [owner, user1] = await ethers.getSigners();

    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    const crvusd = await CrvUSDToken.deploy(owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
    const complianceRegistry = await ComplianceRegistry.deploy()

    const RToken = await ethers.getContractFactory("RToken");
    const rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);

    const initialPrimeRate = ethers.parseUnits("0.1", 27);
    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary")
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy()
    const LendingPool = await ethers.getContractFactory("LendingPool", {
      libraries: {
        LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
      }
    });

    const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
    const liquidationProxy = await LiquidationProxy.deploy();

    const VaultProxy = await ethers.getContractFactory("VaultProxy");
    const vaultProxy = await VaultProxy.deploy();

    const DebtToken = await ethers.getContractFactory("DebtToken");
    const debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, complianceRegistry.target);

    const lendingPool = await LendingPool.deploy(
      crvusd.target,
      rToken.target,
      debtToken.target,
      liquidationProxy.target,
      vaultProxy.target,
      complianceRegistry.target,
      initialPrimeRate,
      owner.address
    );

    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap

    // Deploy the ReserveLibraryMock contract
    const ReserveLibraryMockFactory = await ethers.getContractFactory("ReserveLibraryMock");
    reserveLibrary = await ReserveLibraryMockFactory.deploy(debtToken.target, rToken.target);
  });

  describe("Deposit and Withdrawal Functionality", function () {
    
    it("should correctly update totalLiquidity after a deposit", async function () {
      const depositAmount = ethers.parseEther("1");
      
      const initialData = await reserveLibrary.getReserveData();
      expect(initialData.totalLiquidity).to.equal(0);

      await reserveLibrary.deposit(depositAmount);

      const finalData = await reserveLibrary.getReserveData();
      expect(finalData.totalLiquidity).to.equal(depositAmount);
    });

    it("should correctly update totalLiquidity after a withdrawal", async function () {
      const depositAmount = ethers.parseEther("2");
      const withdrawAmount = ethers.parseEther("1");

      // Perform deposit
      await reserveLibrary.deposit(depositAmount);

      // Perform withdrawal
      await reserveLibrary.withdraw(withdrawAmount);

      // totalLiquidity should now equal depositAmount - withdrawAmount
      const reserveDataAfterWithdrawal = await reserveLibrary.getReserveData();
      expect(reserveDataAfterWithdrawal.totalLiquidity).to.equal(depositAmount - withdrawAmount);
    });

    it("should handle zero deposit amount correctly", async function () {
      const zeroAmount = ethers.parseEther("0");
      await expect(reserveLibrary.deposit(zeroAmount))
        .to.be.revertedWithCustomError(reserveLibrary, "InvalidAmount");
    });

    it("should handle zero withdrawal amount correctly", async function () {
      const zeroAmount = ethers.parseEther("0");
      await expect(reserveLibrary.withdraw(zeroAmount))
        .to.be.revertedWithCustomError(reserveLibrary, "InvalidAmount");
    });

    it("should not allow withdrawing more than totalLiquidity", async function () {
      const depositAmount = ethers.parseEther("1");
      const withdrawAmount = ethers.parseEther("2");

      await reserveLibrary.deposit(depositAmount);

      await expect(reserveLibrary.withdraw(withdrawAmount))
        .to.be.revertedWithCustomError(reserveLibrary, "InsufficientLiquidity");
    });

    it("should handle large deposit amounts without overflow", async function () {
      const largeAmount = ethers.parseUnits("1", 30); // 1e30

      // Perform deposit
      await reserveLibrary.deposit(largeAmount);

      // totalLiquidity should equal the large amount
      const reserveDataAfterDeposit = await reserveLibrary.getReserveData();
      expect(reserveDataAfterDeposit.totalLiquidity).to.equal(largeAmount);
    });
  });

  describe("Prime Rate Update Tests", function () {
    
    describe("Rate Change Limits (2% of current rate)", function () {
      it("should allow prime rate change within 2% limit for 10% prime rate", async function () {
        const initialPrimeRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(initialPrimeRate);
        
        let rateData = await reserveLibrary.getRateData();
        expect(rateData.primeRate).to.equal(initialPrimeRate);
        
        const maxIncrease = ethers.parseUnits("0.12", 27); // 12%
        const maxDecrease = ethers.parseUnits("0.08", 27); // 8%
        
        await reserveLibrary.setPrimeRate(maxIncrease);
        rateData = await reserveLibrary.getRateData();
        expect(rateData.primeRate).to.equal(maxIncrease);
        
        await reserveLibrary.setPrimeRate(initialPrimeRate);
        
        await reserveLibrary.setPrimeRate(maxDecrease);
        rateData = await reserveLibrary.getRateData();
        expect(rateData.primeRate).to.equal(maxDecrease);
      });

      it("should reject prime rate changes exceeding 2% limit", async function () {
        const initialPrimeRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(initialPrimeRate);
        
        const excessiveIncrease = ethers.parseUnits("0.13", 27); // 13%
        await expect(reserveLibrary.setPrimeRate(excessiveIncrease))
          .to.be.revertedWithCustomError(reserveLibrary, "PrimeRateChangeExceedsLimit");
        
        const excessiveDecrease = ethers.parseUnits("0.07", 27); // 7%
        await expect(reserveLibrary.setPrimeRate(excessiveDecrease))
          .to.be.revertedWithCustomError(reserveLibrary, "PrimeRateChangeExceedsLimit");
      });
      it("should reject prime rate changes exceeding 100%", async function () {
        const initialPrimeRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(initialPrimeRate);
        
        const excessiveIncrease = ethers.parseUnits("1.000001", 27); // 110%
        await expect(reserveLibrary.setPrimeRate(excessiveIncrease))
          .to.be.revertedWithCustomError(reserveLibrary, "PrimeRateChangeExceedsLimit");
      });
    });

    describe("Derived Rate Calculations", function () {
      it("should correctly calculate derived rates from prime rate", async function () {
        const primeRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(primeRate);
        
        const rateData = await reserveLibrary.getRateData();
        
        const expectedBaseRate = ethers.parseUnits("0.025", 27); // 2.5%
        expect(rateData.baseRate).to.equal(expectedBaseRate);
        
        const expectedOptimalRate = ethers.parseUnits("0.05", 27); // 5%
        expect(rateData.optimalRate).to.equal(expectedOptimalRate);
        
        const expectedMaxRate = ethers.parseUnits("1", 27); // 100%
        expect(rateData.maxRate).to.equal(expectedMaxRate);
      });
    });

    describe("Interest Index Updates", function () {
      it("should update interest indices before changing prime rate", async function () {
        const initialPrimeRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(initialPrimeRate);
        
        const initialReserveData = await reserveLibrary.getReserveData();
        
        await ethers.provider.send("evm_increaseTime", [3600]);
        await ethers.provider.send("evm_mine");
        
        const newPrimeRate = ethers.parseUnits("0.105", 27); // 10.5%
        await reserveLibrary.setPrimeRate(newPrimeRate);
        
        const finalReserveData = await reserveLibrary.getReserveData();
        
        // Indices should be updated (though they might not change much without actual deposits/borrows)
        expect(finalReserveData.lastUpdateTimestamp).to.be.gt(initialReserveData.lastUpdateTimestamp);
      });
    });

    describe("Edge Cases and Error Conditions", function () {
      it("should reject zero prime rate", async function () {
        await expect(reserveLibrary.setPrimeRate(0))
          .to.be.revertedWithCustomError(reserveLibrary, "PrimeRateMustBePositive");
      });

      it("should handle multiple consecutive rate changes within limits", async function () {
        let currentRate = ethers.parseUnits("0.10", 27); // 10%
        await reserveLibrary.setPrimeRate(currentRate);
        
        // Make multiple 2% increases (well within 5% limit)
        for (let i = 0; i < 3; i++) {
          const newRate = (currentRate * 102n) / 100n; // 2% increase
          await reserveLibrary.setPrimeRate(newRate);
          currentRate = newRate;
        }
        
        const finalRateData = await reserveLibrary.getRateData();
        const expectedFinalRate = ethers.parseUnits("0.10", 27) * 102n * 102n * 102n / (100n * 100n * 100n);
        expect(finalRateData.primeRate).to.be.closeTo(expectedFinalRate, ethers.parseUnits("0.0001", 27));
      });
    });
  });

  describe("Security and Vulnerability Tests", function () {
    it("should handle division by zero gracefully", async function () {
      // Ensure totalLiquidity and totalUsage are zero
      const reserveData = await reserveLibrary.getReserveData();
      expect(reserveData.totalLiquidity).to.equal(0);
      expect(reserveData.totalUsage).to.equal(0);

      // Calculate utilization rate
      const utilizationRate = await reserveLibrary.calculateUtilizationRate();

      // Utilization rate should be zero and not throw an error
      expect(utilizationRate).to.equal(0);
    });

    it("should prevent overflow when calculating interest", async function () {
      const depositAmount = ethers.MaxUint256;

      // Attempt to deposit the maximum uint256 value
      await expect(reserveLibrary.deposit(depositAmount)).to.be.reverted;
    });

    it("should not allow zero or negative prime rates", async function () {
      const zeroRate = 0;
      await expect(reserveLibrary.setPrimeRate(zeroRate))
        .to.be.revertedWithCustomError(reserveLibrary, "PrimeRateMustBePositive");
    });
  });
});

describe("Borrow and Interest Rate Calculations", function () {
  let reserveLibrary;
  let owner, user1;
  const _primeRate = 0.075;
  const _baseRate = _primeRate / 4;
  const _optimalRate = _primeRate / 2;
  const _maxRate = 0.8375;
  const _optimalUtilizationRate = 0.9;

  const primeRate = ethers.parseUnits(_primeRate.toString(), 27);
  const baseRate = primeRate / 4n;
  const optimalRate = primeRate / 2n;
  const maxRate = ethers.parseUnits(_maxRate.toString(), 27); // 85% ->since we want utilization penalty of 8 (slope 8) -> (maxRate - optimalRate) / (1 - optimalUtilizationRate) = 8 -> maxRate = 8 * (1 - optimalUtilizationRate) + optimalRate = 8 * (1 - 0.9) + 0.0375 = 0.8375
  const optimalUtilizationRate = ethers.parseUnits(_optimalUtilizationRate.toString(), 27);
  // We are going to compare the borrow rate calculation with the tokenomics of the protocl (view the tokenomics doc)
  //R_b traget = 3.75: primeRate = 7.5%, optimalRate = 3.75%, maxRate = 80%, optimalUtilizationRate = 90%
  beforeEach(async function () {
    [owner, user1] = await ethers.getSigners();

    const ReserveLibraryMockFactory = await ethers.getContractFactory("ReserveLibraryMockCalculation");
    reserveLibrary = await ReserveLibraryMockFactory.deploy();
    await reserveLibrary.setRateParameters(
      baseRate, // baseRate = 1.875%
      primeRate, // primeRate = 7.5%
      optimalRate, // optimalRate = 3.75%
      maxRate, // maxRate = 80%
      optimalUtilizationRate // optimalUtilizationRate = 90%
    );
    // console.log(await reserveLibrary.getRateData())
    // console.log(await reserveLibrary.getReserveData())
  })
  it("should calculate the borrow rate correctly", async function () {
    // At 0 utilization rate, the borrow rate should be the optimal rate
    
    // is calculateUtilizationRate correct? i thought it would be borrow / liquidity, but is liquidity = borrow + liquidity? Answer = yes
    await reserveLibrary.setTotalLiquidity(ethers.parseEther("100"));
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.9", 27));
    console.log(ethers.formatUnits( await reserveLibrary.calculateUtilizationRate(), 27));

    
    

    // Deposit some amount
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.0", 27));
    const utilizationRate = await reserveLibrary.calculateUtilizationRate();
    expect(utilizationRate).to.equal(0);
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(0);

    // make utilization rate to 10%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.1", 27)); // 100/1000 = 10%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 20%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.2", 27)); // 200/1000 = 20%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 30%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.3", 27)); // 300/1000 = 30%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 40%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.4", 27)); // 400/1000 = 40%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 50%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.5", 27)); // 500/1000 = 50%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 80%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.8", 27)); // 800/1000 = 80%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 90%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.9", 27)); // 900/1000 = 90%
    expect(await reserveLibrary.calculateBorrowRate()).to.equal(ethers.parseUnits("0.0375", 27));

    // make utilization rate to 100%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.91", 27)); // 910/1000 = 91%
    let expectedValue = expectedBorrowRate(_optimalRate, 0.91, _optimalUtilizationRate)
    expect(await reserveLibrary.calculateBorrowRate()).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 10000000000000);

    // make utilization rate to 95%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.95", 27)); // 950/1000 = 95%
    let expectedValue2 = expectedBorrowRate(_optimalRate, 0.95, _optimalUtilizationRate)
    expect(await reserveLibrary.calculateBorrowRate()).to.be.closeTo(ethers.parseUnits(expectedValue2.toString(), 27), 10000000000000);

    // make utilization rate to 100%
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.9999999999999999999999", 27)); // 1000/1000 = 100%
    expect(await reserveLibrary.calculateBorrowRate()).to.be.closeTo(maxRate, "10000000");
  })
  it("should calculate the interest rate correctly", async function() {
    await reserveLibrary.setTotalLiquidity(ethers.parseEther("100"));
    // console.log("borrow rate")
    // for (let i = 0; i < 100; i+=0.5) {
    //   await reserveLibrary.setUtilizationRate(ethers.parseUnits((i/100).toString(), 27));
    //   const utilizationRate = await reserveLibrary.calculateUtilizationRate();
    //   const borrowRate = await reserveLibrary.calculateBorrowRate();
    //   console.log(ethers.formatUnits(utilizationRate, 27), ethers.formatUnits(borrowRate, 27));
    // }
    // console.log("liquidity rate")
    // for (let i = 0; i < 100; i+=0.5) {
    //   await reserveLibrary.setUtilizationRate(ethers.parseUnits((i/100).toString(), 27));
    //   const utilizationRate = await reserveLibrary.calculateUtilizationRate();
    //   const liquidityRate = (await reserveLibrary.calculateLiquidityRate())[0];

    //   // Include the I_rental x U / LTV (fixed values fro the tokenomics doc)
    //   const slope2 = ethers.parseUnits((0.09333 * (i / 100)).toString(), 27);
    //   const liquidityRate2 = liquidityRate + slope2;
    //   console.log(ethers.formatUnits(utilizationRate, 27),  ethers.formatUnits(liquidityRate2, 27));
    // }
    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.1", 27));
    let borrowRate = 0.0375
    let utilizationRate = 0.1
    let protocolFee = 0.1
    let expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000);

    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.2", 27));
    borrowRate = 0.0375
    utilizationRate = 0.2
    protocolFee = 0.1
    expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000);


    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.8", 27));
    borrowRate = 0.0375
    utilizationRate = 0.8
    protocolFee = 0.1
    expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000);

    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.9", 27));
    borrowRate = 0.0375
    utilizationRate = 0.9
    protocolFee = 0.1
    expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000000000);

    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.95", 27));
    borrowRate = expectedBorrowRate(_optimalRate, 0.95, _optimalUtilizationRate)
    utilizationRate = 0.95
    protocolFee = 0.1
    expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000000000000);

    await reserveLibrary.setUtilizationRate(ethers.parseUnits("0.9999999999999999999999", 27));
    borrowRate = expectedBorrowRate(_optimalRate, 0.9999999999999999999999, _optimalUtilizationRate)
    utilizationRate = 0.9999999999999999999999
    protocolFee = 0.1
    expectedValue = expectedLiquidityRate(borrowRate, utilizationRate, protocolFee);
    expect((await reserveLibrary.calculateLiquidityRate())[0]).to.be.closeTo(ethers.parseUnits(expectedValue.toString(), 27), 100000000000000);

  })
})
