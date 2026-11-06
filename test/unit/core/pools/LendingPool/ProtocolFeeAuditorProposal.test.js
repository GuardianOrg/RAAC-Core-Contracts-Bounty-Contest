import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Evaluates three candidate protocol-fee formulas against live contract indices.
// Nothing in the contract is modified; all three are computed from the same
// per-interval index deltas the pool actually produced.
//
//   A. lender-derived (what develop does today)  : S * RF/(1-RF)
//   B. debt-derived   (the L-05 fix)             : RF * B
//   C. auditor's proposal                        : B - S
//
// where B = rawDebt * dUsageIndex (compounded), S = rawDeposits * dLiquidityIndex (linear).

const RAY = ethers.parseUnits("1", 27);
const OwnerParameter = { ProtocolFeeRate: 6, VaultOpeningFee: 10, MaxRate: 12 };
const rayMul = (a, b) => (a * b + RAY / 2n) / RAY;
const rayDiv = (a, b) => (a * RAY + b / 2n) / b;
const enc = (a) => new ethers.AbiCoder().encode(["uint256"], [a]);
const f = (v) => Number(ethers.formatEther(v));

async function deployStack(owner, user1, user2) {
  const crvusd = await (await ethers.getContractFactory("crvUSDToken")).deploy(owner.address);
  await crvusd.setMinter(owner.address);
  const cr = await (await ethers.getContractFactory("ComplianceRegistry")).deploy();
  const rToken = await (await ethers.getContractFactory("RToken")).deploy(
    "RToken", "RToken", owner.address, crvusd.target, cr.target);
  const debtToken = await (await ethers.getContractFactory("DebtToken")).deploy(
    "DebtToken", "DT", owner.address, crvusd.target);
  const lp = await (await ethers.getContractFactory("LiquidationProxy")).deploy();
  const vp = await (await ethers.getContractFactory("VaultProxy")).deploy();
  const feeLib = await (await ethers.getContractFactory("LendingPoolFeeLibrary")).deploy();
  const lendingPool = await (await ethers.getContractFactory("LendingPool", {
    libraries: { LendingPoolFeeLibrary: feeLib.target },
  })).deploy(crvusd.target, rToken.target, debtToken.target, lp.target, vp.target, cr.target,
    ethers.parseUnits("0.1", 27), owner.address);

  const rwa = await (await ethers.getContractFactory("ERC20Mock")).deploy("RWA", "RWA", 18);
  const oracle = await (await ethers.getContractFactory("MockERC20PriceOracle")).deploy();
  await oracle.setLatestPrice(ethers.parseEther("1"));
  const adapter = await (await ethers.getContractFactory("ERC20AssetAdapter")).deploy(
    rwa.target, oracle.target, lendingPool.target);
  await lendingPool.registerAdapter(adapter.target);
  await rToken.setLendingPool(lendingPool.target);
  await debtToken.setLendingPool(lendingPool.target);
  await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
  await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap
  await rToken.transferOwnership(lendingPool.target);
  await debtToken.transferOwnership(lendingPool.target);
  await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
  await lendingPool.connect(user1).openVaultPosition();

  const dep = ethers.parseEther("120000");
  await crvusd.mint(user2.address, dep);
  await crvusd.connect(user2).approve(lendingPool.target, dep);
  await lendingPool.connect(user2).deposit(dep);

  const col = ethers.parseEther("1000000");
  await rwa.mint(user1.address, col);
  await rwa.connect(user1).approve(adapter.target, col);
  await lendingPool.connect(user1).depositAsset(adapter.target, enc(col));
  await lendingPool.connect(user1).borrow(adapter.target, enc(1), ethers.parseEther("100000"));

  return { crvusd, rToken, debtToken, lendingPool, adapter };
}

describe("Auditor proposal: pendingProtocolFee += borrowerInterest - supplierInterest", function () {
  this.timeout(300000);

  async function walk(ctx, ticks, tickSeconds) {
    const { rToken, debtToken, lendingPool } = ctx;
    const maxRate = (await lendingPool.rateData()).maxRate;
    const RF = (await lendingPool.rateData()).protocolFeeRate;
    let r = await lendingPool.reserve();
    let prevL = r.liquidityIndex, prevU = r.usageIndex;
    const acc = { A: 0n, B: 0n, C: 0n, minGap: null, negatives: 0, totalB: 0n, totalS: 0n };

    for (let i = 0; i < ticks; i++) {
      const rawDeposits = await rToken.getRawTotalDeposits();
      const rawDebt = await debtToken.getRawTotalBorrows();
      await time.increase(tickSeconds);
      await lendingPool.setParameter(OwnerParameter.MaxRate, maxRate);
      r = await lendingPool.reserve();

      const Bi = rayMul(rawDebt, r.usageIndex) - rayMul(rawDebt, prevU);
      const Si = rayMul(r.liquidityIndex, rawDeposits) - rayMul(prevL, rawDeposits);
      prevL = r.liquidityIndex; prevU = r.usageIndex;

      acc.A += RF === 0n ? 0n : rayMul(Si, rayDiv(RAY, RAY - RF)) - Si;
      acc.B += rayMul(Bi, RF);
      acc.C += Bi - Si;                     // auditor's formula (may go negative)
      acc.totalB += Bi; acc.totalS += Si;
      const gap = Bi - Si;
      if (gap < 0n) acc.negatives++;
      if (acc.minGap === null || gap < acc.minGap) acc.minGap = gap;
    }
    return acc;
  }

  it("with reserveFactor = 10%, the proposal sweeps the entire residual, not 10%", async function () {
    const [owner, user1, user2] = await ethers.getSigners();
    const ctx = await deployStack(owner, user1, user2);
    const a = await walk(ctx, 40, 30 * 24 * 3600);

    const effA = (100 * f(a.A)) / f(a.totalB);
    const effB = (100 * f(a.B)) / f(a.totalB);
    const effC = (100 * f(a.C)) / f(a.totalB);

    console.log("");
    console.log(`      borrower interest total : ${f(a.totalB).toFixed(2)}`);
    console.log(`      supplier interest total : ${f(a.totalS).toFixed(2)}`);
    console.log(`      A lender-derived (today): ${f(a.A).toFixed(2)}  -> ${effA.toFixed(3)}% of borrower interest`);
    console.log(`      B debt-derived  (L-05)  : ${f(a.B).toFixed(2)}  -> ${effB.toFixed(3)}%`);
    console.log(`      C auditor B - S         : ${f(a.C).toFixed(2)}  -> ${effC.toFixed(3)}%`);
    console.log(`      residual left by B      : ${(f(a.totalB) - f(a.totalS) - f(a.B)).toFixed(2)}`);
    console.log(`      residual left by C      : ${(f(a.totalB) - f(a.totalS) - f(a.C)).toFixed(2)}`);
    console.log("");

    expect(effB).to.be.closeTo(10, 0.001);       // the fix collects exactly the configured RF
    expect(effC).to.be.greaterThan(effB);        // the proposal collects strictly more
    // and it leaves nothing behind
    expect(f(a.totalB) - f(a.totalS) - f(a.C)).to.be.closeTo(0, 1e-6);
  });

  it("DECISIVE: with reserveFactor = 0 the proposal still charges a protocol fee", async function () {
    const [owner, user1, user2] = await ethers.getSigners();
    const ctx = await deployStack(owner, user1, user2);
    await ctx.lendingPool.setParameter(OwnerParameter.ProtocolFeeRate, 0);
    expect((await ctx.lendingPool.rateData()).protocolFeeRate).to.equal(0n);

    const a = await walk(ctx, 40, 30 * 24 * 3600);
    console.log("");
    console.log(`      reserveFactor = 0`);
    console.log(`      A lender-derived : ${f(a.A).toFixed(6)}`);
    console.log(`      B debt-derived   : ${f(a.B).toFixed(6)}`);
    console.log(`      C auditor B - S  : ${f(a.C).toFixed(6)}   <-- should be 0 if RF means anything`);
    console.log("");

    expect(f(a.A)).to.equal(0);
    expect(f(a.B)).to.equal(0);
    expect(f(a.C)).to.be.greaterThan(0); // documents the flaw
  });

  it("checks whether borrowerInterest - supplierInterest can go negative (underflow risk)", async function () {
    const [owner, user1, user2] = await ethers.getSigners();
    const ctx = await deployStack(owner, user1, user2);
    const { crvusd, lendingPool, rToken, debtToken, adapter } = ctx;
    const maxRate = (await lendingPool.rateData()).maxRate;
    const RFv = (await lendingPool.rateData()).protocolFeeRate;

    let r = await lendingPool.reserve();
    let prevL = r.liquidityIndex, prevU = r.usageIndex;
    let negatives = 0, minGap = null, checked = 0;

    // Mix of operations that move utilization in both directions.
    const ops = [];
    for (let i = 0; i < 24; i++) ops.push(i % 4);

    for (const op of ops) {
      await time.increase(15 * 24 * 3600);

      const rawDeposits = await rToken.getRawTotalDeposits();
      const rawDebt = await debtToken.getRawTotalBorrows();

      if (op === 0) {
        await lendingPool.setParameter(OwnerParameter.MaxRate, maxRate);
      } else if (op === 1) {
        const amt = ethers.parseEther("20000");
        await crvusd.mint(user2.address, amt);
        await crvusd.connect(user2).approve(lendingPool.target, amt);
        await lendingPool.connect(user2).deposit(amt);
      } else if (op === 2) {
        await lendingPool.connect(user1).borrow(adapter.target, enc(1), ethers.parseEther("10000"));
      } else {
        const amt = ethers.parseEther("15000");
        await crvusd.mint(user1.address, amt);
        await crvusd.connect(user1).approve(lendingPool.target, amt);
        await lendingPool.connect(user1).repay(adapter.target, enc(1), amt);
      }

      r = await lendingPool.reserve();
      const Bi = rayMul(rawDebt, r.usageIndex) - rayMul(rawDebt, prevU);
      const Si = rayMul(r.liquidityIndex, rawDeposits) - rayMul(prevL, rawDeposits);
      prevL = r.liquidityIndex; prevU = r.usageIndex;

      const gap = Bi - Si;
      checked++;
      if (gap < 0n) negatives++;
      if (minGap === null || gap < minGap) minGap = gap;
    }

    console.log("");
    console.log(`      intervals checked      : ${checked}`);
    console.log(`      negative (B - S) count : ${negatives}`);
    console.log(`      smallest (B - S)       : ${ethers.formatEther(minGap)}`);
    console.log(`      (a negative value would revert on the unsigned '+=' in the proposal)`);
    console.log("");
    expect(checked).to.be.greaterThan(0);
  });
});
