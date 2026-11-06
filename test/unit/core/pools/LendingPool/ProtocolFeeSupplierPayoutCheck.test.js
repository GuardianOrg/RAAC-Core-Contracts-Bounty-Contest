import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Directly verifies, against the REAL deployed contracts (not a JS formula replay),
// whether a supplier who fronts $100,000 for a full year, at 100% utilization,
// against a rate tuned so the borrower's REAL (compounded) total interest is
// exactly $20,000, actually receives $18,000 (their 90% share) -- or something
// less, as claimed.
//
// maxRate is set to ln(1.2) in RAY so that at 100% utilization (which pins the
// borrow rate at maxRate on this curve), D*(e^(Rb) - 1) = 100,000*0.2 = 20,000.

const RAY = ethers.parseUnits("1", 27);
const TARGET_MAX_RATE = 182321556793955090622483950n; // ln(1.2) in RAY (27 decimals)

const OwnerParameter = {
  MaxRate: 12,
};

function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

describe("L-05: does the supplier actually receive their 90% share?", function () {
  it("checks the REAL RToken balance and withdrawable crvUSD after 1 year, not just the formula", async function () {
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

    // Tune maxRate so 100% utilization -> Rb = ln(1.2), giving a real compounded
    // total interest of exactly $20,000 on a $100,000 debt over 1 year.
    await lendingPool.setParameter(OwnerParameter.MaxRate, TARGET_MAX_RATE);

    // --- One supplier deposits $100,000 ---
    const depositAmount = ethers.parseEther("100000");
    await crvusd.mint(user2.address, depositAmount);
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    // --- One borrower borrows all $100,000 (100% utilization -> rate pinned at maxRate) ---
    const collateralAmount = ethers.parseEther("1000000");
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    const borrowAmount = ethers.parseEther("100000");
    await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

    const rateData0 = await lendingPool.rateData();
    console.log(`      confirmed borrow rate at 100% utilization: ${(Number(rateData0.currentUsageRate) / 1e25).toFixed(4)}% (target: ~18.2316%)`);
    expect(rateData0.currentUsageRate).to.be.closeTo(TARGET_MAX_RATE, TARGET_MAX_RATE / 100000n);

    // --- Let exactly one year pass ---
    await time.increase(365 * 24 * 60 * 60);

    // --- Read the LIVE (not-yet-written) RToken balance: this is what the RToken
    // contract itself says the supplier's claim is worth right now, computed the
    // same way the protocol computes it everywhere (deposits, transfers, withdrawals) ---
    const liveRTokenBalance = await rToken.balanceOf(user2.address);
    const liveSupplierInterest = liveRTokenBalance - depositAmount;

    // --- Now have the borrower repay in full, so DebtToken.totalSupply() reflects
    // the REAL (compounded) total the borrower actually owed and pays back ---
    await crvusd.mint(user1.address, ethers.parseEther("100000")); // enough to cover interest too
    await crvusd.connect(user1).approve(lendingPool.target, ethers.MaxUint256);
    const debtBeforeRepay = await lendingPool.getPositionScaledDebt(erc20TokenAdapter.target, user1.address, encodeERC20Token(1));
    const realTotalInterest = debtBeforeRepay - borrowAmount;
    await lendingPool.connect(user1).repay(erc20TokenAdapter.target, encodeERC20Token(1), ethers.MaxUint256);

    // --- Now have the supplier actually withdraw everything, in real crvUSD ---
    const crvusdBefore = await crvusd.balanceOf(user2.address);
    await lendingPool.connect(user2).withdraw(ethers.MaxUint256);
    const crvusdAfter = await crvusd.balanceOf(user2.address);
    const actualPayout = crvusdAfter - crvusdBefore;
    const actualInterestReceived = actualPayout - depositAmount;

    const idealNinetyPercentShare = (realTotalInterest * 9n) / 10n;

    console.log("");
    console.log(`      REAL total interest the borrower actually owed/repaid: ${ethers.formatEther(realTotalInterest)} crvUSD (target: ~20,000)`);
    console.log(`      90% of that REAL total (the "should get 18,000" claim): ${ethers.formatEther(idealNinetyPercentShare)} crvUSD`);
    console.log("");
    console.log(`      supplier's live RToken-implied interest (pre-withdraw): ${ethers.formatEther(liveSupplierInterest)} crvUSD`);
    console.log(`      supplier's ACTUAL withdrawn crvUSD beyond principal:    ${ethers.formatEther(actualInterestReceived)} crvUSD`);
    console.log(`      shortfall vs the "18,000" expectation:                 ${ethers.formatEther(idealNinetyPercentShare - actualInterestReceived)} crvUSD`);
    console.log("");

    // The live view and the actual withdrawn amount must agree (sanity check).
    expect(actualInterestReceived).to.be.closeTo(liveSupplierInterest, ethers.parseEther("1"));

    // The real question: did they get 90% of the real total, or less?
    expect(actualInterestReceived, "supplier received less than the naive 90% expectation").to.be.lt(idealNinetyPercentShare);
  });
});
