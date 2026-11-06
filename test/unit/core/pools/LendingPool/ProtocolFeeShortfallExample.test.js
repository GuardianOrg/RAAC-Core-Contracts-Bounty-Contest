import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Minimal, hand-checkable example of the L-05 shortfall: one supplier, one
// borrower, one $100,000 borrow, one year. Compares:
//   - the OLD formula (linear-liquidity-index-derived, reproduced in JS -- it's
//     no longer in the contract, this fix is already applied)
//   - the NEW formula (compounded-usage-index-derived, what the contract now
//     actually does -- read straight from on-chain state)
// against each other, to show the size of the shortfall the old formula had.

const RAY = ethers.parseUnits("1", 27);

const OwnerParameter = {
  MaxRate: 12,
};

function rayMul(a, b) {
  return (a * b + RAY / 2n) / RAY;
}
function rayDiv(a, b) {
  return (a * RAY + b / 2n) / b;
}

function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

describe("L-05 shortfall example: 1 supplier, 1 borrow of $100,000, 1 year", function () {
  it("compares the old (linear-derived) fee formula against the new (compounded-derived) one", async function () {
    const [owner, user1, user2] = await ethers.getSigners();

    // --- Deploy the stack ---
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

    // --- One supplier deposits $100,000 ---
    const depositAmount = ethers.parseEther("100000");
    await crvusd.mint(user2.address, depositAmount);
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    // --- One borrower borrows all $100,000 (100% utilization) against ample collateral ---
    const collateralAmount = ethers.parseEther("1000000"); // $1,000,000 @ $1/token
    await erc20Token.mint(user1.address, collateralAmount);
    await erc20Token.connect(user1).approve(erc20TokenAdapter.target, collateralAmount);
    await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(collateralAmount));

    const borrowAmount = ethers.parseEther("100000");
    await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

    // --- Snapshot state right after the borrow (default protocolFeeRate = 10%) ---
    const rateData0 = await lendingPool.rateData();
    const reserve0 = await lendingPool.reserve();
    const protocolFeeRate = rateData0.protocolFeeRate;
    const oldLiquidityIndex = reserve0.liquidityIndex;
    const oldUsageIndex = reserve0.usageIndex;
    const rawDeposits = await rToken.getRawTotalDeposits();
    const rawDebt = await debtToken.getRawTotalBorrows();

    // --- Let exactly one year pass, then trigger a single interest-update tick ---
    await time.increase(365 * 24 * 60 * 60);
    await lendingPool.setParameter(OwnerParameter.MaxRate, rateData0.maxRate);

    const reserve1 = await lendingPool.reserve();
    const newLiquidityIndex = reserve1.liquidityIndex;
    const newUsageIndex = reserve1.usageIndex;
    const actualOnChainFee = await lendingPool.getPendingProtocolFee(); // the fix, live from the contract (scaled, re-valued)

    // --- OLD formula (7b914729), reproduced in JS: fee derived from the LINEAR
    // supplier-side liquidity-index delta ---
    const supplierInterestAmount = rayMul(newLiquidityIndex, rawDeposits) - rayMul(oldLiquidityIndex, rawDeposits);
    const oldFormulaFee = rayMul(supplierInterestAmount, rayDiv(RAY, RAY - protocolFeeRate)) - supplierInterestAmount;

    // --- NEW formula (the fix): fee derived from the COMPOUNDED usage-index delta ---
    const borrowerInterest = rayMul(rawDebt, newUsageIndex) - rayMul(rawDebt, oldUsageIndex);
    const newFormulaFee = rayMul(borrowerInterest, protocolFeeRate);

    const shortfall = newFormulaFee - oldFormulaFee;
    const shortfallPct = (Number(shortfall) / Number(newFormulaFee)) * 100;

    console.log("");
    console.log(`      borrow rate (APY):                  ${(Number(rateData0.currentUsageRate) / 1e25).toFixed(4)}%`);
    console.log(`      protocol fee rate:                  ${(Number(protocolFeeRate) / 1e25).toFixed(2)}%`);
    console.log(`      supplier interest accrued (linear):  ${ethers.formatEther(supplierInterestAmount)} crvUSD`);
    console.log(`      real debt interest accrued (compound): ${ethers.formatEther(borrowerInterest)} crvUSD`);
    console.log("");
    console.log(`      OLD formula fee (linear-derived):    ${ethers.formatEther(oldFormulaFee)} crvUSD`);
    console.log(`      NEW formula fee (compound-derived):  ${ethers.formatEther(newFormulaFee)} crvUSD`);
    console.log(`      shortfall:                            ${ethers.formatEther(shortfall)} crvUSD  (${shortfallPct.toFixed(2)}% less than it should be)`);
    console.log("");

    // The contract, with the fix applied, must match the NEW formula exactly.
    expect(actualOnChainFee, "on-chain fee should match the fixed (compounded) formula").to.equal(newFormulaFee);

    // The old formula would have undercounted the fee.
    expect(oldFormulaFee).to.be.lt(newFormulaFee);
    expect(shortfall).to.be.gt(0n);
  });
});
