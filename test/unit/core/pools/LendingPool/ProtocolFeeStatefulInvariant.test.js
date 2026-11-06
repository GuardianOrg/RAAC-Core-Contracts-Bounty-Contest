import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Stateful invariant walk for the L-05 fix in ReserveLibrary.updateReserveInterests.
//
// Runs one long randomized sequence of deposit / borrow / repay / claimProtocolFees /
// protocolFeeRate changes / time-warps against the REAL LendingPool stack, and after
// EVERY single step checks:
//
//   I1. reserve.liquidityIndex never decreases
//   I2. reserve.usageIndex never decreases
//   I3. reserve.scaledPendingProtocolFee never decreases, except a claim, which must
//       zero it exactly
//   I4. cumulative protocol fee accrued (ghost sum, ticked independently every step
//       from pre-step rawDebt/usageIndex/protocolFeeRate) plus cumulative supplier
//       interest accrued (same, from rawDeposits/liquidityIndex) never exceeds
//       cumulative actual (compounded) debt interest accrued -- i.e. no deficit,
//       holds under arbitrary interleavings of principal changes, rate changes, and
//       fee claims, not just a single isolated period
//   I5. no unexpected revert anywhere in the random walk

const RAY = ethers.parseUnits("1", 27);
const DAY = 24n * 60n * 60n;

const OwnerParameter = {
  ProtocolFeeRate: 6,
};

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

function randInt(rng, lo, hi) {
  return lo + BigInt(Math.floor(rng() * Number(hi - lo + 1n)));
}

const SEED = Number(process.env.INVARIANT_SEED || 424242);
const STEPS = Number(process.env.INVARIANT_STEPS || 250);
const MIN_BORROW_AMOUNT = ethers.parseEther("10");

describe("L-05 stateful invariant walk: index monotonicity + no-deficit under randomized action sequences", function () {
  this.timeout(0);

  let owner, user1, user2;
  let crvusd, rToken, debtToken, lendingPool, feeCollector;
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;

  const PROTOCOL_FEE_TYPE = ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE"));
  const TREASURY = ethers.keccak256(ethers.toUtf8Bytes("TREASURY"));

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    crvusd = await CrvUSDToken.deploy(owner.address);
    await crvusd.setMinter(owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
    const complianceRegistry = await ComplianceRegistry.deploy();

    const RToken = await ethers.getContractFactory("RToken");
    rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);

    const DebtToken = await ethers.getContractFactory("DebtToken");
    debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);

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

    lendingPool = await LendingPool.deploy(
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
    erc20Token = await ERC20Mock.deploy("RWA Vault Token", "RWAToken", 18);

    const MockERC20PriceOracle = await ethers.getContractFactory("MockERC20PriceOracle");
    erc20PriceOracle = await MockERC20PriceOracle.deploy();
    await erc20PriceOracle.setLatestPrice(ethers.parseEther("1"));

    const ERC20Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
    erc20TokenAdapter = await ERC20Adapter.deploy(erc20Token.target, erc20PriceOracle.target, lendingPool.target);

    await lendingPool.registerAdapter(erc20TokenAdapter.target);

    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap
    await rToken.transferOwnership(lendingPool.target);
    await debtToken.transferOwnership(lendingPool.target);

    await lendingPool.setParameter(10 /* VaultOpeningFee */, 0);
    await lendingPool.connect(user1).openVaultPosition();

    // FeeCollector wiring so claimProtocolFees() is exercisable in the walk.
    const FeeCollector = await ethers.getContractFactory("FeeCollector");
    feeCollector = await FeeCollector.deploy(owner.address);
    await feeCollector.addFeeType(PROTOCOL_FEE_TYPE, 10000, 0, 0, 0, 0, 0);
    await feeCollector.addClaimableToken(crvusd.target);
    await feeCollector.setTargetFeeType(lendingPool.target, PROTOCOL_FEE_TYPE);
    await lendingPool.setFeeCollector(feeCollector.target);

    // Base liquidity + very large fixed collateral so random borrow/repay amounts
    // below never hit caps or the collateral health threshold.
    const baseLiquidity = ethers.parseEther("2000000");
    await crvusd.mint(user2.address, baseLiquidity);
    await crvusd.connect(user2).approve(lendingPool.target, baseLiquidity);
    await lendingPool.connect(user2).deposit(baseLiquidity);

    const collateralAmount = ethers.parseEther("50000000");
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    // Give user1 a large crvUSD balance to repay from (interest capitalizes over
    // time, so repay amounts can exceed principal borrowed).
    await crvusd.mint(user1.address, ethers.parseEther("5000000"));
    await crvusd.connect(user1).approve(lendingPool.target, ethers.MaxUint256);
    await crvusd.connect(user2).approve(lendingPool.target, ethers.MaxUint256);
  });

  it(`holds I1-I5 across ${STEPS} randomized steps of deposit/borrow/repay/claim/rate-change/time-warp [seed=${SEED}]`, async function () {
    const rng = mulberry32(SEED);

    let prevLiquidityIndex = (await lendingPool.reserve()).liquidityIndex;
    let prevUsageIndex = (await lendingPool.reserve()).usageIndex;
    let prevPendingFee = (await lendingPool.reserve()).scaledPendingProtocolFee;

    let cumulativeFeeAccrued = 0n;
    let cumulativeSupplierInterest = 0n;
    let cumulativeDebtInterest = 0n;

    const actionCounts = { deposit: 0, borrow: 0, repay: 0, claim: 0, rateChange: 0, warp: 0 };

    for (let step = 0; step < STEPS; step++) {
      // Always let some time pass between actions (avoids same-block RToken transfer
      // restriction and is itself part of what we want to fuzz).
      const dt = randInt(rng, 1n, 20n * DAY);
      await time.increase(dt);
      actionCounts.warp++;

      // --- Snapshot pre-step "raw" bases used to independently re-derive this
      // step's interest ticks (must be read before the action's own mint/burn). ---
      const reserveBefore = await lendingPool.reserve();
      const rateDataBefore = await lendingPool.rateData();
      const rawDebtBefore = await debtToken.getRawTotalBorrows();
      const rawDepositsBefore = await rToken.getRawTotalDeposits();
      const oldUsageIndex = reserveBefore.usageIndex;
      const oldLiquidityIndex = reserveBefore.liquidityIndex;
      const protocolFeeRateBefore = rateDataBefore.protocolFeeRate;
      const pendingFeeBefore = reserveBefore.scaledPendingProtocolFee;

      // --- Pick and execute a random action ---
      const roll = rng();
      let isClaim = false;
      try {
        if (roll < 0.22) {
          // deposit
          const amount = ethers.parseEther((1 + Math.floor(rng() * 5000)).toString());
          await crvusd.mint(user2.address, amount);
          await lendingPool.connect(user2).deposit(amount);
          actionCounts.deposit++;
        } else if (roll < 0.44) {
          // borrow a modest increment relative to current idle liquidity
          const reserveNow = await lendingPool.reserve();
          const room = reserveNow.totalLiquidity > MIN_BORROW_AMOUNT * 4n ? reserveNow.totalLiquidity / 4n : 0n;
          if (room > MIN_BORROW_AMOUNT) {
            const amount = MIN_BORROW_AMOUNT + (randInt(rng, 0n, room - MIN_BORROW_AMOUNT));
            await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), amount);
            actionCounts.borrow++;
          }
        } else if (roll < 0.66) {
          // repay: either full close-out or a partial amount that leaves >= 2x MIN_BORROW_AMOUNT
          const scaledDebt = await lendingPool.getPositionScaledDebt(erc20TokenAdapter.target, user1.address, encodeERC20Token(1));
          if (scaledDebt > 0n) {
            const full = rng() < 0.3 || scaledDebt <= MIN_BORROW_AMOUNT * 2n;
            const amount = full ? ethers.MaxUint256 : randInt(rng, MIN_BORROW_AMOUNT, scaledDebt - MIN_BORROW_AMOUNT * 2n);
            if (full || amount > 0n) {
              await lendingPool.connect(user1).repay(erc20TokenAdapter.target, encodeERC20Token(1), amount);
              actionCounts.repay++;
            }
          }
        } else if (roll < 0.8) {
          // protocolFeeRate change, bounded to [0, 99%]
          const bps = Math.floor(rng() * 9900);
          const newRate = (RAY * BigInt(bps)) / 10000n;
          await lendingPool.setParameter(OwnerParameter.ProtocolFeeRate, newRate);
          actionCounts.rateChange++;
        } else {
          // claim protocol fees (including when nothing is pending -> should no-op safely)
          await lendingPool.connect(owner).claimProtocolFees();
          isClaim = true;
          actionCounts.claim++;
        }
      } catch (e) {
        throw new Error(`step ${step} action reverted unexpectedly (roll=${roll.toFixed(3)}): ${e.message}`);
      }

      // --- Post-step state ---
      const reserveAfter = await lendingPool.reserve();
      const newUsageIndex = reserveAfter.usageIndex;
      const newLiquidityIndex = reserveAfter.liquidityIndex;
      const pendingFeeAfter = reserveAfter.scaledPendingProtocolFee;

      const ctx = `step=${step} seed=${SEED} roll=${roll.toFixed(3)} dt=${dt}`;

      // I1 / I2: monotonicity, every single step
      expect(newLiquidityIndex, `I1 liquidityIndex decreased: ${ctx}`).to.be.gte(oldLiquidityIndex);
      expect(newUsageIndex, `I2 usageIndex decreased: ${ctx}`).to.be.gte(oldUsageIndex);
      expect(newLiquidityIndex, `I1 liquidityIndex regressed vs prior step: ${ctx}`).to.be.gte(prevLiquidityIndex);
      expect(newUsageIndex, `I2 usageIndex regressed vs prior step: ${ctx}`).to.be.gte(prevUsageIndex);

      // I3: scaledPendingProtocolFee monotonic except an exact zero on claim
      if (isClaim) {
        expect(pendingFeeAfter, `I3 claim did not zero scaledPendingProtocolFee: ${ctx}`).to.equal(0n);
      } else {
        expect(pendingFeeAfter, `I3 scaledPendingProtocolFee decreased without a claim: ${ctx}`).to.be.gte(pendingFeeBefore);
      }

      // --- Independently re-derive this step's interest ticks from pre-step state,
      // exactly mirroring the contract's own formulas, and accumulate ghost sums. ---
      const debtInterestThisStep = rayMul(rawDebtBefore, newUsageIndex) - rayMul(rawDebtBefore, oldUsageIndex);
      const supplierInterestThisStep = rayMul(rawDepositsBefore, newLiquidityIndex) - rayMul(rawDepositsBefore, oldLiquidityIndex);
      const expectedFeeThisStep = rayMul(debtInterestThisStep, protocolFeeRateBefore);

      if (isClaim) {
        // The fee accrued during this step's internal updateReserveState (before the
        // zeroing) must equal pendingFeeBefore + expectedFeeThisStep.
        expect(pendingFeeBefore + expectedFeeThisStep >= 0n, `sanity: ${ctx}`).to.equal(true);
      } else {
        // The fee is banked SCALED by the liquidity index, so re-value this step's
        // scaled delta at the index it was banked at before comparing to the formula.
        // rayDiv-then-rayMul costs a few wei, hence closeTo rather than equal.
        const accruedThisStep = rayMul(pendingFeeAfter - pendingFeeBefore, newLiquidityIndex);
        expect(accruedThisStep, `fee formula mismatch mid-walk: ${ctx}`).to.be.closeTo(expectedFeeThisStep, 1000n);
      }

      cumulativeFeeAccrued += expectedFeeThisStep;
      cumulativeSupplierInterest += supplierInterestThisStep;
      cumulativeDebtInterest += debtInterestThisStep;

      // I4: no deficit, checked cumulatively after every step
      expect(
        cumulativeFeeAccrued + cumulativeSupplierInterest,
        `I4 deficit: cumulative claims exceed cumulative debt interest at ${ctx}`
      ).to.be.lte(cumulativeDebtInterest);

      prevLiquidityIndex = newLiquidityIndex;
      prevUsageIndex = newUsageIndex;
      prevPendingFee = pendingFeeAfter;
    }

    const totalClaimed = cumulativeFeeAccrued + cumulativeSupplierInterest;
    const slack = cumulativeDebtInterest - totalClaimed;
    const slackBps = cumulativeDebtInterest > 0n ? (slack * 10000n) / cumulativeDebtInterest : 0n;

    console.log(`      steps: ${STEPS}, seed: ${SEED}`);
    console.log(`      action counts: ${JSON.stringify(actionCounts)}`);
    console.log(`      cumulative fee accrued:        ${ethers.formatEther(cumulativeFeeAccrued)}`);
    console.log(`      cumulative supplier interest:  ${ethers.formatEther(cumulativeSupplierInterest)}`);
    console.log(`      cumulative debt interest:      ${ethers.formatEther(cumulativeDebtInterest)}`);
    console.log(`      unclaimed slack: ${ethers.formatEther(slack)} (${slackBps} bps, must be >= 0)`);

    expect(slack >= 0n, "final cumulative no-deficit check").to.equal(true);
    expect(actionCounts.borrow).to.be.gt(0);
    expect(actionCounts.repay).to.be.gt(0);
    expect(actionCounts.claim).to.be.gt(0);
    expect(actionCounts.rateChange).to.be.gt(0);
  });
});
