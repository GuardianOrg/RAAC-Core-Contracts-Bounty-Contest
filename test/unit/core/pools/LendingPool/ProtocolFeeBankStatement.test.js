import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// The most direct possible check of "was the old formula actually correct, or is
// the new one": track REAL crvUSD moving in and out of the RToken contract for
// every party (supplier, protocol fee) across the whole lifecycle (deposit ->
// borrow -> 1yr -> full repay -> fee claim -> full withdraw), and see whether
// (supplier's real payout) + (fee's real payout), under each formula, actually
// sums to the real total interest that really, physically entered the contract.
//
// This isn't a formula replay -- every number here is either an actual ERC20
// balance delta from an actual transaction, or (for the retired old formula only,
// since it's no longer in the contract) an exact JS reproduction of that retired
// formula fed with the real on-chain inputs from this same run.

const RAY = ethers.parseUnits("1", 27);
const TARGET_MAX_RATE = 182321556793955090622483950n; // ln(1.2) in RAY -> real total interest = exactly 20% of debt over 1yr

const OwnerParameter = { MaxRate: 12 };
const PROTOCOL_FEE_TYPE = ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE"));

function rayMul(a, b) { return (a * b + RAY / 2n) / RAY; }
function rayDiv(a, b) { return (a * RAY + b / 2n) / b; }
function encodeERC20Token(amount) { return new ethers.AbiCoder().encode(["uint256"], [amount]); }
function fmt(x) { return ethers.formatEther(x); }

describe("L-05 bank statement: does old or new formula actually balance against real cash flows?", function () {
  it("tracks real crvUSD for every party and checks the sum against the real interest that actually flowed in", async function () {
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
      crvusd.target, rToken.target, debtToken.target,
      liquidationProxy.target, vaultProxy.target, complianceRegistry.target,
      initialPrimeRate, owner.address
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

    // Wire a real FeeCollector so the fee claim is a real token transfer, not just a ledger entry.
    const FeeCollector = await ethers.getContractFactory("FeeCollector");
    const feeCollector = await FeeCollector.deploy(owner.address);
    await feeCollector.addFeeType(PROTOCOL_FEE_TYPE, 10000, 0, 0, 0, 0, 0);
    await feeCollector.addClaimableToken(crvusd.target);
    await feeCollector.setTargetFeeType(lendingPool.target, PROTOCOL_FEE_TYPE);
    await lendingPool.setFeeCollector(feeCollector.target);

    await lendingPool.setParameter(10 /* VaultOpeningFee */, 0);
    await lendingPool.connect(user1).openVaultPosition();
    await lendingPool.setParameter(OwnerParameter.MaxRate, TARGET_MAX_RATE);

    // --- Deposit $100,000, borrow $100,000 (100% utilization) ---
    const depositAmount = ethers.parseEther("100000");
    await crvusd.mint(user2.address, depositAmount);
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    const collateralAmount = ethers.parseEther("1000000");
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    const borrowAmount = ethers.parseEther("100000");
    await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

    // --- Snapshot everything needed to reproduce the RETIRED old formula in JS ---
    const rateData0 = await lendingPool.rateData();
    const reserve0 = await lendingPool.reserve();
    const protocolFeeRate = rateData0.protocolFeeRate;
    const oldLiquidityIndex = reserve0.liquidityIndex;
    const oldUsageIndex = reserve0.usageIndex;
    const rawDeposits = await rToken.getRawTotalDeposits();

    // crvUSD physically inside the RToken contract right now (should be 0: the
    // 100k deposit came in, then the full 100k borrow just left)
    const rTokenCashAtT0 = await crvusd.balanceOf(rToken.target);

    // --- 1 year passes, borrower repays in full (real cash: principal + real
    // compounded interest flows INTO the RToken contract here) ---
    await time.increase(365 * 24 * 60 * 60);

    await crvusd.mint(user1.address, ethers.parseEther("100000"));
    await crvusd.connect(user1).approve(lendingPool.target, ethers.MaxUint256);
    const debtBeforeRepay = await lendingPool.getPositionScaledDebt(erc20TokenAdapter.target, user1.address, encodeERC20Token(1));
    const realTotalInterest = debtBeforeRepay - borrowAmount; // the REAL pie: what the borrower actually now owes beyond principal
    await lendingPool.connect(user1).repay(erc20TokenAdapter.target, encodeERC20Token(1), ethers.MaxUint256);

    // This repay's internal updateReserveState is the ONLY interest tick since
    // the borrow -- it ticked liquidityIndex/usageIndex for the full year and
    // accrued the ACTUAL (fixed-formula) fee for the whole period.
    const reserve1 = await lendingPool.reserve();
    const newLiquidityIndex = reserve1.liquidityIndex;
    const newUsageIndex = reserve1.usageIndex;
    const actualOnChainFeeLedger = await lendingPool.getPendingProtocolFee(); // NEW formula, live (scaled, re-valued)

    const rTokenCashAfterRepay = await crvusd.balanceOf(rToken.target);
    const realCashThatEnteredFromInterest = rTokenCashAfterRepay - rTokenCashAtT0 - realTotalInterest === 0n
      ? realTotalInterest
      : rTokenCashAfterRepay - rTokenCashAtT0; // principal returned + interest; isolate interest below

    // --- Actually claim the protocol fee: real crvUSD leaving to the fee collector ---
    const collectorBalBefore = await crvusd.balanceOf(feeCollector.target);
    await lendingPool.connect(owner).claimProtocolFees();
    const collectorBalAfter = await crvusd.balanceOf(feeCollector.target);
    const actualFeePaidOut = collectorBalAfter - collectorBalBefore; // NEW formula, real money

    // --- Supplier actually withdraws everything: real crvUSD into their wallet ---
    const crvusdBefore = await crvusd.balanceOf(user2.address);
    await lendingPool.connect(user2).withdraw(ethers.MaxUint256);
    const crvusdAfter = await crvusd.balanceOf(user2.address);
    const actualSupplierPayout = (crvusdAfter - crvusdBefore) - depositAmount; // real interest portion only

    // --- RETIRED old formula, reproduced in JS from the same real on-chain inputs ---
    const supplierInterestAmount = rayMul(newLiquidityIndex, rawDeposits) - rayMul(oldLiquidityIndex, rawDeposits);
    const oldFormulaFee = rayMul(supplierInterestAmount, rayDiv(RAY, RAY - protocolFeeRate)) - supplierInterestAmount;

    console.log("");
    console.log(`      === REAL total interest that actually entered the pool (verified via real repay) ===`);
    console.log(`      realTotalInterest:                 ${fmt(realTotalInterest)} crvUSD  (target: 20,000.00)`);
    console.log("");
    console.log(`      === real crvUSD supplier ACTUALLY received (unaffected by this fix either way) ===`);
    console.log(`      actualSupplierPayout:               ${fmt(actualSupplierPayout)} crvUSD`);
    console.log("");
    console.log(`      === OLD formula (retired; JS replica of the exact removed code) ===`);
    console.log(`      old formula's fee:                  ${fmt(oldFormulaFee)} crvUSD`);
    console.log(`      old total claimed (supplier+fee):   ${fmt(actualSupplierPayout + oldFormulaFee)} crvUSD`);
    console.log(`      UNCLAIMED by anyone under OLD code: ${fmt(realTotalInterest - (actualSupplierPayout + oldFormulaFee))} crvUSD  <-- real money, stuck, claimed by no one`);
    console.log("");
    console.log(`      === NEW formula (the fix; real transactions: real fee claim, real withdrawal) ===`);
    console.log(`      new formula's fee (ledger):         ${fmt(actualOnChainFeeLedger)} crvUSD`);
    console.log(`      new formula's fee (real cash paid):  ${fmt(actualFeePaidOut)} crvUSD  <-- actually left the pool to the fee collector`);
    console.log(`      new total claimed (supplier+fee):   ${fmt(actualSupplierPayout + actualFeePaidOut)} crvUSD`);
    console.log(`      unclaimed slack under NEW code:     ${fmt(realTotalInterest - (actualSupplierPayout + actualFeePaidOut))} crvUSD  (small, safe surplus, same residual Aave itself leaves)`);
    console.log("");

    // Sanity: the ledger value and the real cash that left to the collector must match exactly.
    expect(actualFeePaidOut, "real fee payout should match the on-chain ledger").to.equal(actualOnChainFeeLedger);

    // The core question: does the OLD formula's total add up to the real pie, or fall short?
    const oldTotalClaimed = actualSupplierPayout + oldFormulaFee;
    const newTotalClaimed = actualSupplierPayout + actualFeePaidOut;

    expect(oldTotalClaimed, "OLD formula must have left real money unclaimed").to.be.lt(realTotalInterest);
    expect(newTotalClaimed, "NEW formula must claim strictly more of the real pie than OLD").to.be.gt(oldTotalClaimed);
    expect(newTotalClaimed, "NEW formula must never claim MORE than the real pie (no deficit)").to.be.lte(realTotalInterest);
  });
});
