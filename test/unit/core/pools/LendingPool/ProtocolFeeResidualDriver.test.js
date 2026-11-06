import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";
import deployFeeCollector from "../../../../utils/deployFeeCollector.js";

// Identity found in the data: (cash + debt) - rTokenSupply == residual + unclaimedFee.
//
// Mechanism: utilization is D/(cash+debt), but suppliers only earn on rTokenSupply.
// An unclaimed fee's backing counts in the denominator and not in the supplier base,
// so the supply rate is diluted and the shortfall becomes residual -- which then feeds
// back into the same gap. dR/dt = Rb*D*(1-RF)*(R+F)/A, so R only grows once F > 0.
//
// Prediction: claim every tick (hold F at ~0) and the residual should stop growing.

const RAY = ethers.parseUnits("1", 27);
const OwnerParameter = { VaultOpeningFee: 10, MaxRate: 12 };
const TARGET_U_BPS = 8500;
const rayMul = (a, b) => (a * b + RAY / 2n) / RAY;
const enc = (a) => new ethers.AbiCoder().encode(["uint256"], [a]);
const f = (v) => Number(ethers.formatEther(v));

async function build(owner, user1, user2, withCollector) {
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

  if (withCollector) {
    const fc = await deployFeeCollector(owner);
    const PF = ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE"));
    await fc.addFeeType(PF, 10000, 0, 0, 0, 0, 0);
    await fc.addClaimableToken(crvusd.target);
    await lendingPool.setFeeCollector(await fc.getAddress());
    await fc.setTargetFeeType(lendingPool.target, PF);
  }

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

  return { crvusd, rToken, debtToken, lendingPool, adapter };
}

describe("What actually drives the unclaimable residual", function () {
  this.timeout(600000);

  async function walk(ctx, claimEveryTick) {
    const { crvusd, rToken, debtToken, lendingPool } = ctx;
    const rd0 = await lendingPool.rateData();
    const RF = rd0.protocolFeeRate, maxRate = rd0.maxRate;

    async function pin() {
      const rr = await lendingPool.reserve();
      const target = (rr.totalUsage * BigInt(10000 - TARGET_U_BPS)) / BigInt(TARGET_U_BPS);
      const topUp = target - rr.totalLiquidity;
      if (topUp <= 0n) return;
      await crvusd.mint(user2.address, topUp);
      await crvusd.connect(user2).approve(lendingPool.target, topUp);
      await lendingPool.connect(user2).deposit(topUp);
    }
    const [, , user2] = await ethers.getSigners();

    await pin();
    let r = await lendingPool.reserve();
    let prevL = r.liquidityIndex, prevU = r.usageIndex;
    let cumB = 0n, cumS = 0n, feeB = 0n, claimed = 0n;

    for (let i = 1; i <= 60; i++) {
      const rawDeposits = await rToken.getRawTotalDeposits();
      const rawDebt = await debtToken.getRawTotalBorrows();
      await time.increase(30 * 24 * 3600);
      await lendingPool.setParameter(OwnerParameter.MaxRate, maxRate);

      r = await lendingPool.reserve();
      cumB += rayMul(rawDebt, r.usageIndex) - rayMul(rawDebt, prevU);
      cumS += rayMul(r.liquidityIndex, rawDeposits) - rayMul(prevL, rawDeposits);
      feeB += rayMul(rayMul(rawDebt, r.usageIndex) - rayMul(rawDebt, prevU), RF);
      prevL = r.liquidityIndex; prevU = r.usageIndex;

      if (claimEveryTick) {
        const before = await lendingPool.getPendingProtocolFee();
        if (before > 0n) { await lendingPool.claimProtocolFees(); claimed += before; }
      }
      await pin();
    }
    return { cumB, cumS, feeB, residual: cumB - cumS - feeB, claimed };
  }

  it("residual grows when the fee is left unclaimed, and stops when it is claimed", async function () {
    const [owner, user1, user2] = await ethers.getSigners();

    const never = await walk(await build(owner, user1, user2, false), false);
    const often = await walk(await build(owner, user1, user2, true), true);

    const pctNever = (100 * f(never.residual)) / f(never.cumB);
    const pctOften = (100 * f(often.residual)) / f(often.cumB);

    console.log("");
    console.log("      5 years, utilization pinned at 85%, monthly ticks");
    console.log(`      never claimed  : borrower ${f(never.cumB).toFixed(2)}  residual ${f(never.residual).toFixed(2)}  (${pctNever.toFixed(2)}%)`);
    console.log(`      claimed monthly: borrower ${f(often.cumB).toFixed(2)}  residual ${f(often.residual).toFixed(2)}  (${pctOften.toFixed(2)}%)`);
    console.log(`      reduction      : ${(100 * (1 - f(often.residual) / f(never.residual))).toFixed(1)}%`);
    console.log("");

    expect(f(never.residual)).to.be.greaterThan(0);
    expect(f(often.residual)).to.be.lessThan(f(never.residual));
  });
});
