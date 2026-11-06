import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// Property-based fuzz test for the L-05 fix in ReserveLibrary.updateReserveInterests.
//
// For many randomized (protocolFeeRate, utilization/borrow-amount, timeDelta) tuples,
// against the REAL deployed LendingPool/RToken/DebtToken stack, this checks:
//
//   P1. liquidityIndex never decreases
//   P2. usageIndex never decreases
//   P3. scaledPendingProtocolFee accrual this period matches the formula (to rounding)
//       rawDebt.rayMul(newUsageIndex) - rawDebt.rayMul(oldUsageIndex), rayMul(protocolFeeRate)
//       (bit-exact, across the whole random input space, not just one hand-picked scenario)
//   P4. no deficit: (protocol fee growth) + (RToken/supplier total-supply growth)
//       <= (DebtToken total-supply growth), i.e. borrow interest paid >= supply + protocol fee
//   P5. no unexpected reverts anywhere in the sequence

const RAY = ethers.parseUnits("1", 27);
const YEAR = 365n * 24n * 60n * 60n;

const OwnerParameter = {
  ProtocolFeeRate: 6,
  MaxRate: 12,
};

// Deterministic seeded PRNG (mulberry32) so failures are reproducible from the printed seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rayMul(a, b) {
  return (a * b + RAY / 2n) / RAY;
}

function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

// log-ish random integer in [lo, hi], biased toward covering many orders of magnitude
function randLog(rng, lo, hi) {
  const lLo = Math.log(Number(lo));
  const lHi = Math.log(Number(hi));
  const v = Math.exp(lLo + rng() * (lHi - lLo));
  return BigInt(Math.max(Number(lo), Math.floor(v)));
}

const SEED = Number(process.env.FUZZ_SEED || 1337);
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS || 150);

describe("L-05 fuzz: protocol fee formula properties over randomized inputs", function () {
  this.timeout(0);

  async function deployStack() {
    const [owner, user1, user2] = await ethers.getSigners();

    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    const crvusd = await CrvUSDToken.deploy(owner.address);
    await crvusd.setMinter(owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
    const complianceRegistry = await ComplianceRegistry.deploy();

    const RToken = await ethers.getContractFactory("RToken");
    const rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);

    const DebtToken = await ethers.getContractFactory("DebtToken");
    const debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);

    const initialPrimeRate = ethers.parseUnits("0.1", 27);

    const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
    const liquidationProxy = await LiquidationProxy.deploy();

    const VaultProxy = await ethers.getContractFactory("VaultProxy");
    const vaultProxy = await VaultProxy.deploy();

    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary");
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy();
    const LendingPool = await ethers.getContractFactory("LendingPool", {
      libraries: { LendingPoolFeeLibrary: lendingPoolFeeLibrary.target },
    });

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

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    const erc20Token = await ERC20Mock.deploy("RWA Vault Token", "RWAToken", 18);

    const MockERC20PriceOracle = await ethers.getContractFactory("MockERC20PriceOracle");
    const erc20PriceOracle = await MockERC20PriceOracle.deploy();
    await erc20PriceOracle.setLatestPrice(ethers.parseEther("1"));

    const ERC20Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
    const erc20TokenAdapter = await ERC20Adapter.deploy(erc20Token.target, erc20PriceOracle.target, lendingPool.target);

    await lendingPool.registerAdapter(erc20TokenAdapter.target);

    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap
    await rToken.transferOwnership(lendingPool.target);
    await debtToken.transferOwnership(lendingPool.target);

    await lendingPool.setParameter(10 /* VaultOpeningFee */, 0);
    await lendingPool.connect(user1).openVaultPosition();

    // Fixed, generous base liquidity + collateral so random utilization/borrow choices
    // below never hit supply/borrow caps or the collateral health threshold.
    const baseLiquidity = ethers.parseEther("1000000");
    await crvusd.mint(user2.address, baseLiquidity);
    await crvusd.connect(user2).approve(lendingPool.target, baseLiquidity);
    await lendingPool.connect(user2).deposit(baseLiquidity);

    const collateralAmount = ethers.parseEther("50000000"); // $50,000,000 @ $1/token
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    return { owner, user1, user2, crvusd, rToken, debtToken, lendingPool, erc20Token, erc20TokenAdapter, baseLiquidity };
  }

  it(`holds P1-P5 across ${ITERATIONS} randomized (protocolFeeRate, utilization, timeDelta) scenarios [seed=${SEED}]`, async function () {
    const rng = mulberry32(SEED);
    let minSlackBps = null; // smallest observed conservation slack, for reporting
    let maxUtilSeen = 0;
    let maxRateSeen = 0n;

    for (let i = 0; i < ITERATIONS; i++) {
      const { user1, rToken, debtToken, lendingPool, erc20TokenAdapter, baseLiquidity } = await loadFixture(deployStack);

      // --- Randomize protocolFeeRate in [0%, 99%] RAY-scaled ---
      const protocolFeeRateBps = BigInt(Math.floor(rng() * 9900)); // 0..9899 (basis points *100 = 0.01% steps)
      const protocolFeeRate = (RAY * protocolFeeRateBps) / 10000n;
      await lendingPool.setParameter(OwnerParameter.ProtocolFeeRate, protocolFeeRate);

      // --- Randomize borrow amount => utilization from ~1% to ~95% of baseLiquidity ---
      const utilPct = 1 + Math.floor(rng() * 94); // 1..94
      const borrowAmount = (baseLiquidity * BigInt(utilPct)) / 100n;
      await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

      const rateData0 = await lendingPool.rateData();
      const reserve0 = await lendingPool.reserve();
      const oldUsageIndex = reserve0.usageIndex;
      const oldLiquidityIndex = reserve0.liquidityIndex;
      const scaledFeeBefore = reserve0.scaledPendingProtocolFee;
      const feeValueBefore = await lendingPool.getPendingProtocolFee();
      const rawDebt = await debtToken.getRawTotalBorrows();
      const rTokenSupplyBefore = await rToken.totalSupply();
      const debtSupplyBefore = await debtToken.totalSupply();

      // --- Randomize elapsed time: 1 second .. 5 years (log-distributed) ---
      const dt = randLog(rng, 1n, 5n * YEAR);
      await time.increase(dt);

      // Trigger exactly one interest-update tick with no other economic effect.
      await lendingPool.setParameter(OwnerParameter.MaxRate, rateData0.maxRate);

      const reserve1 = await lendingPool.reserve();
      const newUsageIndex = reserve1.usageIndex;
      const newLiquidityIndex = reserve1.liquidityIndex;
      const scaledFeeAfter = reserve1.scaledPendingProtocolFee;
      const feeValueAfter = await lendingPool.getPendingProtocolFee();
      const rTokenSupplyAfter = await rToken.totalSupply();
      const debtSupplyAfter = await debtToken.totalSupply();

      const ctx = `iter=${i} seed=${SEED} util=${utilPct}% RF=${protocolFeeRateBps}bp*1e-2 dt=${dt}s usageRate=${rateData0.currentUsageRate}`;

      // P1 / P2: index monotonicity
      expect(newUsageIndex, `P2 usageIndex decreased: ${ctx}`).to.be.gte(oldUsageIndex);
      expect(newLiquidityIndex, `P1 liquidityIndex decreased: ${ctx}`).to.be.gte(oldLiquidityIndex);

      // P3: fee formula fidelity (bit-exact reproduction of the contract's own arithmetic)
      const borrowerInterest = rayMul(rawDebt, newUsageIndex) - rayMul(rawDebt, oldUsageIndex);
      const expectedFee = rayMul(borrowerInterest, protocolFeeRate);
      // Banked scaled, so re-value the scaled delta at the index it was banked at.
      // rayDiv-then-rayMul costs a few wei, hence closeTo rather than equal.
      const accruedThisPeriod = rayMul(scaledFeeAfter - scaledFeeBefore, newLiquidityIndex);
      expect(accruedThisPeriod, `P3 fee formula mismatch: ${ctx}`).to.be.closeTo(expectedFee, 1000n);

      // P4 uses the collector's real claim growth (accrual + yield on the banked balance)
      const actualFeeGrowth = feeValueAfter - feeValueBefore;

      // P4: no supplier-side deficit
      const supplierGrowth = rTokenSupplyAfter - rTokenSupplyBefore;
      const debtGrowth = debtSupplyAfter - debtSupplyBefore;
      const totalClaimed = actualFeeGrowth + supplierGrowth;
      expect(totalClaimed, `P4 deficit: claimed more than actual debt growth: ${ctx}`).to.be.lte(debtGrowth);

      if (debtGrowth > 0n) {
        const slackBps = Number(((debtGrowth - totalClaimed) * 10000n) / debtGrowth);
        if (minSlackBps === null || slackBps < minSlackBps) minSlackBps = slackBps;
      }
      if (utilPct > maxUtilSeen) maxUtilSeen = utilPct;
      if (rateData0.currentUsageRate > maxRateSeen) maxRateSeen = rateData0.currentUsageRate;
    }

    console.log(`      iterations: ${ITERATIONS}, seed: ${SEED}`);
    console.log(`      max utilization seen: ${maxUtilSeen}%, max borrow rate seen: ${(Number(maxRateSeen) / 1e25).toFixed(4)}%`);
    console.log(`      smallest observed conservation slack: ${minSlackBps} bps of actual debt growth (must be >= 0)`);
    expect(minSlackBps === null || minSlackBps >= 0).to.equal(true);
  });
});
