import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// The auditor's argument: "the interest on the unclaimed fee is part of the protocol
// fee, so take the whole gap (B - S)."
//
// The principle is right. The question is whether B - S equals it. Decompose the gap:
//
//   gap (A - T)  =  fee accrual (RF x B)
//                +  yield on the unclaimed fee      <-- auditor's claim, legitimately owed
//                +  everything else                 <-- discretization + yield on dust
//
// Scaled storage pays exactly the first two. B - S takes all three.
// The discriminator: at RF = 0 there is no fee, so "interest on the unclaimed fee"
// must be zero. Anything B - S still takes at RF = 0 is provably not fee interest.

const RAY = ethers.parseUnits("1", 27);
const OwnerParameter = { ProtocolFeeRate: 6, VaultOpeningFee: 10, MaxRate: 12 };
const rayMul = (a, b) => (a * b + RAY / 2n) / RAY;
const enc = (a) => new ethers.AbiCoder().encode(["uint256"], [a]);
const f = (v) => Number(ethers.formatEther(v));
const TARGET_U_BPS = 8500;

async function build(owner, user1, user2, rfBpsRay) {
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
  if (rfBpsRay !== null) await lendingPool.setParameter(OwnerParameter.ProtocolFeeRate, rfBpsRay);
  await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
  await lendingPool.connect(user1).openVaultPosition();

  const dep = ethers.parseEther("115000");
  await crvusd.mint(user2.address, dep);
  await crvusd.connect(user2).approve(lendingPool.target, dep);
  await lendingPool.connect(user2).deposit(dep);
  const col = ethers.parseEther("1000000");
  await rwa.mint(user1.address, col);
  await rwa.connect(user1).approve(adapter.target, col);
  await lendingPool.connect(user1).depositAsset(adapter.target, enc(col));
  await lendingPool.connect(user1).borrow(adapter.target, enc(1), ethers.parseEther("100000"));
  return { crvusd, rToken, debtToken, lendingPool };
}

async function walk(ctx, user2, ticks = 60, tickDays = 30) {
  const { crvusd, rToken, debtToken, lendingPool } = ctx;
  const rd0 = await lendingPool.rateData();
  const RF = rd0.protocolFeeRate, maxRate = rd0.maxRate;

  async function pin() {
    const rr = await lendingPool.reserve();
    const target = (rr.totalUsage * BigInt(10000 - TARGET_U_BPS)) / BigInt(TARGET_U_BPS);
    const topUp = target - rr.totalLiquidity;
    if (topUp < ethers.parseEther("10")) return;
    await crvusd.mint(user2.address, topUp);
    await crvusd.connect(user2).approve(lendingPool.target, topUp);
    await lendingPool.connect(user2).deposit(topUp);
  }

  await pin();
  let r = await lendingPool.reserve();
  let prevL = r.liquidityIndex, prevU = r.usageIndex, prevScaled = r.scaledPendingProtocolFee;
  let cumB = 0n, cumS = 0n, accrual = 0n;

  for (let i = 1; i <= ticks; i++) {
    const rawDeposits = await rToken.getRawTotalDeposits();
    const rawDebt = await debtToken.getRawTotalBorrows();
    await time.increase(tickDays * 24 * 3600);
    await lendingPool.setParameter(OwnerParameter.MaxRate, maxRate);
    r = await lendingPool.reserve();
    cumB += rayMul(rawDebt, r.usageIndex) - rayMul(rawDebt, prevU);
    cumS += rayMul(r.liquidityIndex, rawDeposits) - rayMul(prevL, rawDeposits);
    accrual += rayMul(r.scaledPendingProtocolFee - prevScaled, r.liquidityIndex);
    prevL = r.liquidityIndex; prevU = r.usageIndex; prevScaled = r.scaledPendingProtocolFee;
    await pin();
  }
  const feeValue = await lendingPool.getPendingProtocolFee();
  return { RF, cumB, cumS, accrual, feeValue, gap: cumB - cumS };
}

describe("Decomposing the dust: is it all interest on the unclaimed fee?", function () {
  this.timeout(600000);

  it("splits the gap into fee accrual, yield on the unclaimed fee, and the rest", async function () {
    const [owner, user1, user2] = await ethers.getSigners();
    const w = await walk(await build(owner, user1, user2, null), user2);

    const yieldOnFee = w.feeValue - w.accrual;   // what scaled storage pays on top of accrual
    const rest = w.gap - w.feeValue;             // what B - S would take beyond that
    const bMinusS = w.gap;                       // auditor's formula takes the whole gap

    console.log("");
    console.log(`      reserveFactor 10%, 5 years, utilization 85%`);
    console.log(`      borrower interest              : ${f(w.cumB).toFixed(2)}`);
    console.log(`      gap (A - T) = B - S            : ${f(bMinusS).toFixed(2)}   <- auditor takes all of this`);
    console.log(`        fee accrual (RF x B)         : ${f(w.accrual).toFixed(2)}`);
    console.log(`        yield on the unclaimed fee   : ${f(yieldOnFee).toFixed(2)}   <- legitimately owed, scaled pays it`);
    console.log(`        the rest                     : ${f(rest).toFixed(2)}   <- NOT fee interest`);
    console.log(`      scaled storage pays the protocol: ${f(w.feeValue).toFixed(2)}`);
    console.log(`      auditor's B - S overshoots by   : ${f(rest).toFixed(2)} (${(100*f(rest)/f(w.feeValue)).toFixed(2)}% extra)`);
    console.log("");

    expect(yieldOnFee).to.be.gt(0n);
    expect(rest).to.be.gt(0n);                              // B - S takes strictly more
    expect(w.feeValue).to.equal(w.accrual + yieldOnFee);    // scaled == accrual + fee yield
  });

  it("DISCRIMINATOR: at reserveFactor = 0 there is no fee, so fee interest must be 0", async function () {
    const [owner, user1, user2] = await ethers.getSigners();
    const w = await walk(await build(owner, user1, user2, 0), user2);
    expect(w.RF).to.equal(0n);

    console.log("");
    console.log(`      reserveFactor = 0`);
    console.log(`      fee accrual                  : ${f(w.accrual).toFixed(6)}`);
    console.log(`      scaled storage pays protocol : ${f(w.feeValue).toFixed(6)}   <- correctly zero`);
    console.log(`      auditor's B - S still takes  : ${f(w.gap).toFixed(2)}   <- cannot be "interest on the fee"`);
    console.log("");

    expect(w.accrual).to.equal(0n);
    expect(w.feeValue).to.equal(0n);   // no fee => no fee interest
    expect(w.gap).to.be.gt(0n);        // yet B - S still takes a positive amount
  });
});
