import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Standalone reproduction for finding L-05:
// "Protocol fees undercounted because supplier interest is linear while debt compounds"
//
// Goal: verify that reserve.scaledPendingProtocolFee, as accrued by
// ReserveLibrary.updateReserveInterests, now matches the fee derived from the
// actual (compounded) growth of the usage index, instead of undercounting it
// via the old linear-liquidity-index-derived formula.

const RAY = ethers.parseUnits("1", 27);

const OwnerParameter = {
  MaxRate: 12,
};

function rayMul(a, b) {
  return (a * b + RAY / 2n) / RAY;
}

function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

describe("L-05: protocol fee derived from compounded debt growth (fix verification)", function () {
  let owner, user1, user2;
  let crvusd, rToken, debtToken, lendingPool;
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;

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

    // Open user1's vault (required before depositAsset)
    await lendingPool.setParameter(10 /* VaultOpeningFee */, 0);
    await lendingPool.connect(user1).openVaultPosition();
  });

  it("accrues the protocol fee equal to the fee derived from the actual compounded usage-index growth", async function () {
    // --- Seed liquidity ---
    const depositAmount = ethers.parseEther("100000");
    await crvusd.mint(user2.address, depositAmount);
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    // --- Collateralize and borrow enough to push utilization above the 80% optimal
    // kink, so the borrow rate is meaningfully large and compounding drift is visible ---
    const collateralAmount = ethers.parseEther("1000000"); // $1,000,000 @ $1/token
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    const borrowAmount = ethers.parseEther("85000"); // 85k / 100k liquidity => 85% utilization
    await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

    // --- Snapshot state right after the borrow. From here on nothing else touches
    // the pool until the single trigger call below, so currentUsageRate and
    // protocolFeeRate are constant across the whole elapsed window. ---
    const rateData0 = await lendingPool.rateData();
    const reserve0 = await lendingPool.reserve();

    const usageRate = rateData0.currentUsageRate;
    const protocolFeeRate = rateData0.protocolFeeRate;
    expect(usageRate).to.be.gt(0n);
    expect(protocolFeeRate).to.be.gt(0n);

    const oldUsageIndex = reserve0.usageIndex;
    const scaledFeeBefore = reserve0.scaledPendingProtocolFee;
    const rawDebt = await debtToken.getRawTotalBorrows();

    console.log(`      utilization-implied borrow rate: ${(Number(usageRate) / 1e25).toFixed(4)}%`);

    // --- Let a full year pass with no intervening pool interaction ---
    await time.increase(365 * 24 * 60 * 60);

    // --- Trigger exactly one reserve-interest update (re-set MaxRate to its
    // current value: no economic effect, just forces updateReserveState) ---
    await lendingPool.setParameter(OwnerParameter.MaxRate, rateData0.maxRate);

    const reserve1 = await lendingPool.reserve();
    const newUsageIndex = reserve1.usageIndex;
    const scaledFeeAfter = reserve1.scaledPendingProtocolFee;

    expect(newUsageIndex).to.be.gt(oldUsageIndex); // sanity: usage index did compound

    // Actual fee accrued this period. The fee is banked SCALED by the liquidity
    // index, so re-value the scaled delta at the index it was banked at
    // (reserve1.liquidityIndex) to recover the amount in underlying units.
    const actualFeeAccrued = rayMul(scaledFeeAfter - scaledFeeBefore, reserve1.liquidityIndex);

    // Independently reproduce the fixed contract formula in JS, in the exact same
    // operation order (two separate rayMul calls, then subtract, then rayMul by
    // protocolFeeRate) so rounding lines up bit-for-bit with Solidity:
    //   uint256 borrowerInterest = rawDebt.rayMul(newUsageIndex) - rawDebt.rayMul(oldUsageIndex);
    //   scaledPendingProtocolFee += borrowerInterest.rayMul(protocolFeeRate).rayDiv(liquidityIndex);
    const borrowerInterest = rayMul(rawDebt, newUsageIndex) - rayMul(rawDebt, oldUsageIndex);
    const expectedFee = rayMul(borrowerInterest, protocolFeeRate);

    console.log(`      fee accrued this period (scaled, re-valued):       ${ethers.formatEther(actualFeeAccrued)}`);
    console.log(`      fee implied by compounded debt growth (expected): ${ethers.formatEther(expectedFee)}`);

    // The fix must make the accrued fee exactly match the compounded-debt-derived
    // amount (both are computed identically now, so this should be bit-exact).
    // Not bit-exact any more: banking does rayDiv(index) and reading does rayMul(index),
    // so a round-trip rounding of a few wei is expected. Anything larger is a real drift.
    expect(actualFeeAccrued).to.be.closeTo(expectedFee, 1000n);
    expect(actualFeeAccrued).to.be.gt(0n);
  });

  it("never claims more than the actual compounded debt growth (no supplier-side deficit)", async function () {
    // Same scenario as above, but this time checks system-wide conservation:
    // (fee accrued this period) + (supplier/RToken claim growth this period)
    // must never exceed the real growth in DebtToken.totalSupply() (i.e. what
    // borrowers now actually owe, which is the only new value entering the pool).
    // liquidityIndex/supplier accrual is untouched by the fix (still linear via
    // calculateLiquidityRate's Rs = U * Rb * (1 - RF)), so this checks that
    // switching the fee side to compounded accrual didn't upset that balance.
    const depositAmount = ethers.parseEther("100000");
    await crvusd.mint(user2.address, depositAmount);
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    const collateralAmount = ethers.parseEther("1000000");
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    const borrowAmount = ethers.parseEther("85000");
    await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

    const reserve0 = await lendingPool.reserve();
    const rateData0 = await lendingPool.rateData();
    const feeValueBefore = await lendingPool.getPendingProtocolFee();
    const rTokenSupplyBefore = await rToken.totalSupply();
    const debtSupplyBefore = await debtToken.totalSupply();

    await time.increase(365 * 24 * 60 * 60);
    await lendingPool.setParameter(OwnerParameter.MaxRate, rateData0.maxRate);

    const reserve1 = await lendingPool.reserve();
    const feeValueAfter = await lendingPool.getPendingProtocolFee();
    const rTokenSupplyAfter = await rToken.totalSupply();
    const debtSupplyAfter = await debtToken.totalSupply();

    // growth in the collector's actual claim, including yield on what was already banked
    const feeGrowth = feeValueAfter - feeValueBefore;
    const supplierClaimGrowth = rTokenSupplyAfter - rTokenSupplyBefore;
    const actualDebtGrowth = debtSupplyAfter - debtSupplyBefore;
    const totalClaimed = feeGrowth + supplierClaimGrowth;
    const unclaimedSlack = actualDebtGrowth - totalClaimed;

    console.log(`      protocol fee growth:        ${ethers.formatEther(feeGrowth)}`);
    console.log(`      supplier (RToken) growth:    ${ethers.formatEther(supplierClaimGrowth)}`);
    console.log(`      total claimed:               ${ethers.formatEther(totalClaimed)}`);
    console.log(`      actual compounded debt growth: ${ethers.formatEther(actualDebtGrowth)}`);
    console.log(`      unclaimed slack (should be >= 0, small): ${ethers.formatEther(unclaimedSlack)}`);

    // No deficit: fee + supplier accrual together never exceed what borrowers
    // actually now owe. A small positive slack is expected (same higher-order
    // residual Aave itself leaves unclaimed, since supplier accrual is linear).
    expect(totalClaimed).to.be.lte(actualDebtGrowth);
    expect(unclaimedSlack).to.be.gte(0n);
  });
});
