import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

import { time } from "@nomicfoundation/hardhat-network-helpers";

import deployCRV from "../utils/deployCRV.js";
import deployLendingPool from "../utils/deployLendingPool.js";
import deployERC721Adapter from "../utils/deployERC721Adapter.js";
import deployRAACNFT from "../utils/deployRAACNFT.js";
import encodeERC721Token from "../utils/encodeERC721Token.js";
import encodeERC20Token from "../utils/encodeERC20Token.js";
import deployFeeCollector from "../utils/deployFeeCollector.js";
import deployStabilityPool from "../utils/deployStabilityPool.js";
import deployRWAVault from "../utils/deployRWAVault.js";
import deployLiquidityPool from "../utils/deployLiquidityPool.js";
import deployLiquidationSwap from "../utils/deployLiquidationSwap.js";

const RAY = ethers.parseUnits("1", 27);
const FIRST_NFT_ID = 1;
const SECOND_NFT_ID = 2;

const FIRST_NFT_PRICE = ethers.parseEther("100");
const SECOND_NFT_PRICE = ethers.parseEther("100");
const INITIAL_LIQUIDITY_POOL_AMOUNT = ethers.parseEther("1000");

describe("Lending & Liquidation", function () {
  let owner, liquidityProvider, lender1, lender2, borrower1, borrower2, user1, user2, user3;

  let raacNFT;

  // Registries
  let complianceRegistry;

  // Lending Pool
  let lendingPool;
  let supplyAsset, rToken, debtToken;

  let liquidationProxy, vaultProxy, liquidationStrategyProxy;

  // Oracles
  let raacHousePrices;
  let initialPrimeRate;

  // Adapters
  let erc721Adapter;

  // Stability Pool
  let stabilityPool;
  let deToken;
  let liquidationSwap;

  // Collectors
  let feeCollector;


  // RWA Vault
  let rwaIndexToken;
  let raacNFTVaultAdapter;
  let rwaVault;
  let erc20TokenVaultAdapter;

  // Liquidity Pool
  let liquidityPool;

  const INITIAL_MINT_AMOUNT = ethers.parseEther('1000');
  const FIRST_HOUSE_PRICE = ethers.parseEther('100');

  before(async function () {
    [owner, liquidityProvider,lender1, lender2, borrower1, borrower2, user1, user2, user3] = await ethers.getSigners();
    ({
        supplyAsset,rToken,debtToken, // crvUSD / rCRV / debtCRV
        lendingPool,liquidationProxy,vaultProxy,complianceRegistry,
        initialPrimeRate, // 0.1
    } = await deployLendingPool(owner));

    // Deploy RAAC NFT
    ({ raacNFT, raacHousePrices } = await deployRAACNFT(supplyAsset, complianceRegistry, owner));

    // Deploy Fee Collector
    feeCollector = await deployFeeCollector(owner);

    // Set fee collector
     await lendingPool.setFeeCollector(await feeCollector.getAddress());
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addClaimableToken(supplyAsset.target)

    await raacHousePrices.setOracle(owner.address);

    erc721Adapter = await deployERC721Adapter(raacNFT,raacHousePrices,lendingPool);
    await lendingPool.registerAdapter(erc721Adapter.target);

    await raacHousePrices.setHousePrice(FIRST_NFT_ID, FIRST_HOUSE_PRICE);

    // Deploy RWA Vault
    ({
        rwaIndexToken,
        rwaVault,
        raacNFTVaultAdapter,
        erc20TokenVaultAdapter,
    } = await deployRWAVault(supplyAsset, complianceRegistry, raacNFT, raacHousePrices, stabilityPool));


    // Should be removed
    const RAACToken = await ethers.getContractFactory("RAACToken");
    const raacToken = await RAACToken.deploy(owner.address);

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(owner.address);

    const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
    const crvusdToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 1);

    // Deploy Stability Pool
    ({
        stabilityPool,
        deToken,
        liquidationStrategyProxy,
        liquidationSwap,
    } = await deployStabilityPool(owner, supplyAsset, rToken, complianceRegistry, lendingPool, rwaIndexToken, treasury, rwaVault, crvusdToUSDOracle, raacToken));

    ({
        liquidityPool
    } = await deployLiquidityPool(supplyAsset, rwaIndexToken, owner, liquidationSwap, stabilityPool, feeCollector));

   
    const currentSwap = await liquidationStrategyProxy.liquidationSwap();
    // depositing crvUSD in vault gives index token back
    await supplyAsset.mint(liquidityProvider.address, INITIAL_LIQUIDITY_POOL_AMOUNT * 2n);
    await supplyAsset.connect(liquidityProvider).approve(erc20TokenVaultAdapter.target, INITIAL_LIQUIDITY_POOL_AMOUNT);
    await rwaVault.connect(liquidityProvider).depositAsset(erc20TokenVaultAdapter.target, encodeERC20Token(INITIAL_LIQUIDITY_POOL_AMOUNT), liquidityProvider.address, 0);

    await rwaIndexToken.connect(liquidityProvider).approve(liquidityPool.target, INITIAL_LIQUIDITY_POOL_AMOUNT);
    await supplyAsset.connect(liquidityProvider).approve(liquidityPool.target, INITIAL_LIQUIDITY_POOL_AMOUNT);
    await liquidityPool.connect(liquidityProvider).add_liquidity([INITIAL_LIQUIDITY_POOL_AMOUNT, INITIAL_LIQUIDITY_POOL_AMOUNT], 0, liquidityProvider.address);

    // Mint initial tokens to users
    for (const user of [lender1, borrower1, borrower2]) {
        await supplyAsset.mint(user.address, INITIAL_MINT_AMOUNT);
    }

  });

  describe('LendingPool', function () {
    const DEPOSIT_AMOUNT = ethers.parseEther('500');
    const BORROW_AMOUNT = ethers.parseEther('10');

    it('should handle interest rate scenarios', async function () {
        // Initial state
        await supplyAsset.connect(lender1).approve(lendingPool.target, DEPOSIT_AMOUNT);
        await lendingPool.connect(lender1).deposit(DEPOSIT_AMOUNT);
        expect(await supplyAsset.balanceOf(lender1.address)).to.be.eq(DEPOSIT_AMOUNT);
        
        // Create NFT collateral and borrow
        await supplyAsset.connect(borrower1).approve(raacNFT.target, ethers.parseEther('1'));
        // Allow to spend crvUSD
        await supplyAsset.connect(borrower1).approve(raacNFT.target, FIRST_NFT_PRICE);
        await raacNFT.connect(borrower1).mint(FIRST_NFT_ID, FIRST_NFT_PRICE);
        expect(await raacNFT.ownerOf(FIRST_NFT_ID)).to.be.eq(borrower1.address);

        const parameters = await lendingPool.parameters();
        const vaultOpeningFee = parameters.vaultOpeningFee;
        await supplyAsset.mint(borrower1.address, vaultOpeningFee);
        await supplyAsset.connect(borrower1).approve(lendingPool.target, vaultOpeningFee);
        
        
        // Open vault position
        await lendingPool.connect(borrower1).openVaultPosition();

        // Deposit NFT
        await raacNFT.connect(borrower1).approve(erc721Adapter.target, FIRST_NFT_ID);
        await lendingPool.connect(borrower1).depositAsset(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID));
        expect(await raacNFT.ownerOf(FIRST_NFT_ID)).to.be.eq(erc721Adapter.target);
        expect(await supplyAsset.balanceOf(borrower1.address)).to.be.eq(INITIAL_MINT_AMOUNT - FIRST_NFT_PRICE);

        // Borrow
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), BORROW_AMOUNT);
        // Check balances
        expect(await supplyAsset.balanceOf(borrower1.address)).to.be.eq(INITIAL_MINT_AMOUNT - FIRST_NFT_PRICE + BORROW_AMOUNT);
        expect(await rToken.balanceOf(borrower1.address)).to.be.eq(0n);
        expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(BORROW_AMOUNT);

        // Record + check initial rates
        const initialRate = await lendingPool.rateData();
        // expect(initialRate.currentLiquidityRate).to.be.eq(537500000000000000000000n);
        expect(initialRate.currentUsageRate).to.be.gte(26875000000000000000000000n);
        expect(initialRate.primeRate).to.be.eq(100000000000000000000000000n);
        expect(initialRate.baseRate).to.be.eq(25000000000000000000000000n);
        expect(initialRate.optimalRate).to.be.eq(50000000000000000000000000n);
        expect(initialRate.maxRate).to.be.eq(836300000000000000000000000n);
        expect(initialRate.optimalUtilizationRate).to.be.eq(800000000000000000000000000n);
        expect(initialRate.protocolFeeRate).to.be.eq(100000000000000000000000000n);
       
        // Create high utilization
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), BORROW_AMOUNT * 4n);
        expect(await supplyAsset.balanceOf(borrower1.address)).to.be.eq(INITIAL_MINT_AMOUNT - FIRST_NFT_PRICE + BORROW_AMOUNT * 4n + BORROW_AMOUNT);
        expect(await rToken.balanceOf(borrower1.address)).to.be.eq(0n);
        expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(BORROW_AMOUNT * 4n + BORROW_AMOUNT);

        // Verify rate increases
        const finalRate = await lendingPool.rateData();
        // flat-rate model below optimal utilization: usage = optimalRate (5%),
        // liquidity = U (10%) * usage * (1 - 10% protocol fee) = 0.45%
        expect(finalRate.currentLiquidityRate).to.be.gte(4500000000000000000000000n);
        expect(finalRate.currentLiquidityRate).to.be.lte(4501000000000000000000000n);
        expect(finalRate.currentUsageRate).to.be.eq(50000000000000000000000000n);

        expect(finalRate.primeRate).to.be.eq(initialRate.primeRate);
        expect(finalRate.baseRate).to.be.eq(initialRate.baseRate);
        expect(finalRate.optimalRate).to.be.eq(initialRate.optimalRate);
        expect(finalRate.maxRate).to.be.eq(initialRate.maxRate);
        expect(finalRate.optimalUtilizationRate).to.be.eq(initialRate.optimalUtilizationRate);
        expect(finalRate.protocolFeeRate).to.be.eq(initialRate.protocolFeeRate);
       
        // Liquidity rate
        expect(finalRate.currentLiquidityRate).to.be.gt(initialRate.currentLiquidityRate);
        // usage rate is flat at optimalRate below optimal utilization, so it does not move
        expect(finalRate.currentUsageRate).to.be.gte(initialRate.currentUsageRate);
    });

    it('should handle liquidation with grace period scenarios', async function () {
        // Setup new position
        const newTokenId = FIRST_NFT_ID + 1;
        await raacHousePrices.setHousePrice(newTokenId, FIRST_NFT_PRICE);

        await supplyAsset.connect(borrower2).approve(raacNFT.target, FIRST_NFT_PRICE);
        await raacNFT.connect(borrower2).mint(newTokenId, FIRST_NFT_PRICE);
        expect(await raacNFT.ownerOf(newTokenId)).to.be.eq(borrower2.address);
        
        await raacNFT.connect(borrower2).approve(erc721Adapter.target, newTokenId);

        const parameters = await lendingPool.parameters();
        const vaultOpeningFee = parameters.vaultOpeningFee;
        await supplyAsset.mint(borrower2.address, vaultOpeningFee);
        await supplyAsset.connect(borrower2).approve(lendingPool.target, vaultOpeningFee);

        const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
        await lendingPool.connect(borrower2).openVaultPosition();
        await lendingPool.connect(borrower2).depositAsset(erc721Adapter.target, encodeERC721Token(newTokenId));

        expect(await supplyAsset.balanceOf(borrower2.address)).to.be.eq(INITIAL_MINT_AMOUNT - FIRST_NFT_PRICE);
        // the vault opening fee is forwarded to the fee collector now
        expect(await supplyAsset.balanceOf(feeCollector.target)).to.be.eq(feeCollectorBalanceBefore + vaultOpeningFee);
        expect(await debtToken.balanceOf(borrower2.address)).to.be.eq(0n);

        // console.log(await contracts.lendingPool.positions(user3.address, newTokenId));
        const insuranceFee = await lendingPool.calculateInsuranceFee(erc721Adapter.target, borrower2.address, encodeERC721Token(newTokenId), BORROW_AMOUNT);
        expect(insuranceFee).to.be.eq(300000000000000000n);
        await supplyAsset.connect(borrower2).approve(lendingPool.target, insuranceFee);
        await lendingPool.connect(borrower2).borrowWithInsurance(erc721Adapter.target, encodeERC721Token(newTokenId), BORROW_AMOUNT);
       
        expect(await supplyAsset.balanceOf(borrower2.address)).to.be.eq(INITIAL_MINT_AMOUNT - FIRST_NFT_PRICE - insuranceFee + BORROW_AMOUNT);
        expect(await supplyAsset.balanceOf(feeCollector.target)).to.be.eq(feeCollectorBalanceBefore + vaultOpeningFee + insuranceFee);
        expect(await debtToken.balanceOf(borrower2.address)).to.be.eq(BORROW_AMOUNT);

        // Trigger liquidation
        await raacHousePrices.setHousePrice(newTokenId, FIRST_NFT_PRICE * 10n / 100n);
        await lendingPool.connect(lender1).initiateLiquidation(erc721Adapter.target, borrower2.address, encodeERC721Token(newTokenId));
        
        // Attempt repayment within grace period
        const debt = await debtToken.balanceOf(borrower2.address);
        await supplyAsset.connect(borrower2).approve(lendingPool.target, debt * 2n);
        // amounts above the debt are no longer capped; MaxUint256 means "repay in full"
        await lendingPool.connect(borrower2).repay(erc721Adapter.target, encodeERC721Token(newTokenId), ethers.MaxUint256);
        await lendingPool.connect(borrower2).closeLiquidation(erc721Adapter.target, encodeERC721Token(newTokenId));
        
        const positionData = await lendingPool.getPosition(erc721Adapter.target, borrower2.address, encodeERC721Token(newTokenId));
        expect(positionData.isUnderLiquidation).to.be.false;
    });
  });

  describe('StabilityPool', function () {
    const STABILITY_DEPOSIT = ethers.parseEther('200');
    const BORROW_AMOUNT = ethers.parseEther('50');

    beforeEach(async function () {
        await supplyAsset.connect(lender1).approve(lendingPool.target, STABILITY_DEPOSIT);
        await lendingPool.connect(lender1).deposit(STABILITY_DEPOSIT);
        await rToken.connect(lender1).approve(stabilityPool.target, STABILITY_DEPOSIT);

    });

    it('should handle liquidation absorption', async function () {
        // Ensure user2 balance from prior tests
        const user2InitialDebtBalance = await debtToken.rawBalanceOf(borrower1.address);
        const INITIAL_DEBT_BALANCE = ethers.parseEther('50');
        expect(user2InitialDebtBalance).to.be.eq(INITIAL_DEBT_BALANCE);

        const timeStampAtLender1Deposit = await time.latest();
        expect(await deToken.rawBalanceOf(lender1.address)).to.be.eq(0n);
        expect(await deToken.balanceOf(lender1.address)).to.be.eq(0n);
        
        // Setup stability pool deposit
        await stabilityPool.connect(lender1).deposit(STABILITY_DEPOSIT);
        const lender1StabilityPoolBalanceRaw = await deToken.rawBalanceOf(lender1.address);
        expect(lender1StabilityPoolBalanceRaw).to.be.eq(STABILITY_DEPOSIT);
        const lender1StabilityPoolBalance = await deToken.balanceOf(lender1.address);
        expect(lender1StabilityPoolBalance).to.be.eq(STABILITY_DEPOSIT);
        const lender1StabilityPoolIndex = await deToken.getUserIndex(lender1.address);
        expect(lender1StabilityPoolIndex).to.be.closeTo(1000000031709791983764586504n, 1n * 10n ** 20n);
        const lender1StabilityPoolScaledBalance = await deToken.getUserDeposit(lender1.address);
        expect(lender1StabilityPoolScaledBalance).to.be.eq(STABILITY_DEPOSIT);
        expect(await rToken.rawBalanceOf(lender1.address)).to.be.eq(500000000000000000000n);
        expect(await rToken.balanceOf(lender1.address)).to.be.eq(500000000000000000000n);
        // await supplyAsset.connect(borrower2).approve(stabilityPool.target, STABILITY_DEPOSIT);
        // await supplyAsset.connect(borrower2).transfer(stabilityPool.target, STABILITY_DEPOSIT);

        // Prior still ongoing position
        const priorTokenId = FIRST_NFT_ID;
        // Create position to be liquidated
        const newTokenId = FIRST_NFT_ID + 2;
        const HOUSE_PRICE = ethers.parseEther('100');

        await raacHousePrices.setHousePrice(newTokenId, HOUSE_PRICE);
        await supplyAsset.connect(borrower1).approve(raacNFT.target, HOUSE_PRICE);
        await raacNFT.connect(borrower1).mint(newTokenId, HOUSE_PRICE);
        await raacNFT.connect(borrower1).approve(erc721Adapter.target, newTokenId);

        // 50 prior + interest from prior
        await lendingPool.connect(borrower1).depositAsset(erc721Adapter.target, encodeERC721Token(newTokenId));
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.eq(INITIAL_DEBT_BALANCE);
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(INITIAL_DEBT_BALANCE, 1n * 10n ** 16n);
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(newTokenId), BORROW_AMOUNT);
        
        const newPosition = await lendingPool.getPosition(erc721Adapter.target, borrower1.address, encodeERC721Token(newTokenId));
        expect(newPosition.rawDebtBalance).to.be.eq(BORROW_AMOUNT);
        expect(newPosition.isUnderLiquidation).to.be.false;
        expect(newPosition.liquidationStartTime).to.be.eq(0n);
        expect(newPosition.positionIndex).to.be.gte(RAY);
        expect(newPosition.positionIndex).to.be.lte(1000000063419585978551030828n);

        expect(newPosition.isInsured).to.be.false;
        expect(newPosition.rawInsuredBalance).to.be.eq(0n);

        const newPositionView = await lendingPool.getPositionView(erc721Adapter.target, borrower1.address, encodeERC721Token(newTokenId));
        expect(newPositionView.rawDebtBalance).to.be.eq(BORROW_AMOUNT);
        expect(newPositionView.scaledDebtBalance).to.be.closeTo(BORROW_AMOUNT, 1n * 10n ** 16n);
        expect(newPositionView.healthFactor).to.be.eq(ethers.parseEther('1.6'));
        expect(newPositionView.isUnderLiquidation).to.be.false;
        expect(newPositionView.liquidationStartTime).to.be.eq(0n);
        expect(newPositionView.positionIndex).to.be.gte(RAY);
        expect(newPositionView.positionIndex).to.be.lte(1000000031709792486520045644n);
        expect(newPositionView.isInsured).to.be.false;


        const priorPosition = await lendingPool.getPosition(erc721Adapter.target, borrower1.address, encodeERC721Token(priorTokenId));
        const priorPositionView = await lendingPool.getPositionView(erc721Adapter.target, borrower1.address, encodeERC721Token(priorTokenId));

        expect(priorPosition.rawDebtBalance).to.be.eq(INITIAL_DEBT_BALANCE);
        expect(priorPosition.isUnderLiquidation).to.be.false;
        expect(priorPosition.liquidationStartTime).to.be.eq(0n);
        expect(priorPosition.positionIndex).to.be.gte(RAY);
        expect(priorPosition.positionIndex).to.be.lte(1000000031709792486520045644n);
        expect(priorPosition.isInsured).to.be.false;
        expect(priorPosition.rawInsuredBalance).to.be.eq(0n);

        expect(priorPositionView.rawDebtBalance).to.be.eq(INITIAL_DEBT_BALANCE);
        expect(priorPositionView.scaledDebtBalance).to.be.closeTo(INITIAL_DEBT_BALANCE, 1n * 10n ** 16n);
        // Check me (was 1.4)
        expect(priorPositionView.healthFactor).to.be.closeTo(ethers.parseEther('1'), ethers.parseEther('0.6'));
        expect(priorPositionView.isUnderLiquidation).to.be.false;
        expect(priorPositionView.liquidationStartTime).to.be.eq(0n);
        // expect(priorPositionView.positionIndex).to.be.eq(RAY);
        expect(priorPositionView.isInsured).to.be.false;

        // Debt accross two positions
        // 90 + 50 + interest from prior 90
        // Will not be exact due to having taken a borrow which minted accrued debt too
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(INITIAL_DEBT_BALANCE + BORROW_AMOUNT, 1n * 10n ** 16n);
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(INITIAL_DEBT_BALANCE + BORROW_AMOUNT, 1n * 10n ** 16n);

        // Trigger and complete liquidation
        await raacHousePrices.setHousePrice(newTokenId, HOUSE_PRICE * 10n / 100n);
        await lendingPool.connect(lender1).initiateLiquidation(erc721Adapter.target, borrower1.address, encodeERC721Token(newTokenId));
        await time.increase(73 * 60 * 60);
        
         // Will call the lendingPool.finalizeLiquidation(user2.address)
         // We need stability pool to have crvUSD to cover the debt
         const initialBalance = await supplyAsset.balanceOf(stabilityPool.target);
         await lendingPool.connect(owner).updateState();
         const currentRawDebtAmountBeforeLiquidation = await debtToken.rawBalanceOf(borrower1.address);
         expect(currentRawDebtAmountBeforeLiquidation).to.be.eq(INITIAL_DEBT_BALANCE + BORROW_AMOUNT);
         await stabilityPool.connect(owner).liquidateBorrower(erc721Adapter.target, raacNFTVaultAdapter.target, borrower1.address, encodeERC721Token(newTokenId), 0);
         
         // Verify stability pool state
         const finalDeposit = await stabilityPool.getUserDeposit(lender1.address);
         expect(finalDeposit).to.be.eq(STABILITY_DEPOSIT);

        // pay back prior debt
        // Ensure liquidated position is closed
        const liquidatedPositionDebt = await lendingPool.getPositionDebt(erc721Adapter.target, borrower1.address, encodeERC721Token(newTokenId));
        expect(liquidatedPositionDebt).to.be.eq(0n);

        // Left over from first element still open
        const finalDebt = await debtToken.balanceOf(borrower1.address);
        const finalRawDebt = await debtToken.rawBalanceOf(borrower1.address);
        expect(finalRawDebt).to.be.eq(INITIAL_DEBT_BALANCE);
        // Because still one open
        expect(finalDebt).to.be.closeTo(INITIAL_DEBT_BALANCE, 1n * 10n ** 17n);
        const finalBalance = await supplyAsset.balanceOf(stabilityPool.target);
        // const estimatedArbitrage = ethers.parseEther("9.884000416869832420")
        console.log("finalBalance", ethers.formatEther(finalBalance));

        // expect(finalBalance).to.be.lte(initialBalance - BORROW_AMOUNT + estimatedArbitrage);

       // Pay back prior debt
       const priorDebt = await debtToken.balanceOf(borrower1.address);
       await supplyAsset.connect(borrower1).approve(lendingPool.target, priorDebt * 2n);
       // const repayAmount = priorDebt * 2n;
       // console.log(repayAmount);

       const beforeRawDebtAmount = await debtToken.rawBalanceOf(borrower1.address);
       const beforeDebtAmount = await debtToken.balanceOf(borrower1.address);
       // console.log({beforeRawDebtAmount, beforeDebtAmount});
       // Let an hour pass
       await time.increase(3600);
       await ethers.provider.send("evm_mine", []);
       await lendingPool.connect(borrower1).updateState();

       const currentRawDebtAmount = await debtToken.rawBalanceOf(borrower1.address);
       const currentDebtAmount = await debtToken.balanceOf(borrower1.address);

       // Expect raw to stat same and debt to increase
       expect(currentRawDebtAmount).to.be.eq(beforeRawDebtAmount);
       expect(currentDebtAmount).to.be.gt(beforeDebtAmount);
       await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(priorTokenId), currentDebtAmount);
       expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(0, 1n * 10n ** 17n);
    //    const positionFinal = await lendingPool.positions(borrower1.address, priorTokenId);
       const positionFinal = await lendingPool.getPosition(erc721Adapter.target, borrower1.address, encodeERC721Token(priorTokenId));
       expect(positionFinal.rawDebtBalance).to.be.eq(0n);
       const positionFinalView = await lendingPool.getPositionView(erc721Adapter.target, borrower1.address, encodeERC721Token(priorTokenId));
       expect(positionFinalView.scaledDebtBalance).to.be.eq(0n);
    });
  });
   describe('Full process', function () {
    const DEPOSIT_AMOUNT = ethers.parseEther('125');
    const BORROW_AMOUNT = ethers.parseEther('40');
    const INITIAL_DEPOSIT = ethers.parseEther('500');

    it('should perform a full lifecycle with multiple NFT positions', async function () {
        // Setup initial states
        await supplyAsset.mint(user3.address, ethers.parseEther('3000'));
        await supplyAsset.mint(user1.address, ethers.parseEther('2000'));
        await supplyAsset.mint(user2.address, ethers.parseEther('2000'));
        
        // User3 to provide liquidity and lock
        await supplyAsset.connect(user3).approve(lendingPool.target, DEPOSIT_AMOUNT);
        await lendingPool.connect(user3).deposit(DEPOSIT_AMOUNT);
        const user3RTokenBalance = await rToken.balanceOf(user3.address);
        expect(user3RTokenBalance).to.be.eq(DEPOSIT_AMOUNT);

        // await raacToken.connect(user3).approve(veRAACToken.target, DEPOSIT_AMOUNT);
        // await veRAACToken.connect(user3).lock(DEPOSIT_AMOUNT, ONE_YEAR);
        
        // User2 will borrow against multiple NFTs
        const tokenId1 = '1021111';
        const tokenId2 = '1021112';
        const tokenId3 = '1021113';
        const tokenId4 = '1021114';

        const HOUSE_PRICE = ethers.parseEther('100');
        // Set different prices for each NFT
        await raacHousePrices.setHousePrice(tokenId1, HOUSE_PRICE);  // 100 ETH
        await raacHousePrices.setHousePrice(tokenId2, HOUSE_PRICE * 2n); // 200 ETH
        await raacHousePrices.setHousePrice(tokenId3, HOUSE_PRICE * 3n); // 300 ETH
        await raacHousePrices.setHousePrice(tokenId4, HOUSE_PRICE); // 100 ETH

        const parameters = await lendingPool.parameters();
        const vaultOpeningFee = parameters.vaultOpeningFee;
        await supplyAsset.mint(user2.address, vaultOpeningFee);
        await supplyAsset.connect(user2).approve(lendingPool.target, vaultOpeningFee);

        await lendingPool.connect(user2).openVaultPosition();
        // Mint and deposit NFTs
        for (const tokenId of [tokenId1, tokenId2, tokenId3]) {
            await supplyAsset.connect(user2).approve(raacNFT.target, HOUSE_PRICE * 3n);
            await raacNFT.connect(user2).mint(tokenId, HOUSE_PRICE * 3n);
            await raacNFT.connect(user2).approve(erc721Adapter.target, tokenId);
            await lendingPool.connect(user2).depositAsset(erc721Adapter.target, encodeERC721Token(tokenId));
        }

        // Borrow different amounts against each NFT
        await lendingPool.connect(user2).borrow(erc721Adapter.target, encodeERC721Token(tokenId1), BORROW_AMOUNT);
        await lendingPool.connect(user2).borrow(erc721Adapter.target, encodeERC721Token(tokenId2), BORROW_AMOUNT * 15n / 10n); // 150% of first borrow
        await lendingPool.connect(user2).borrow(erc721Adapter.target, encodeERC721Token(tokenId3), BORROW_AMOUNT * 2n); // Double the first borrow

        // Check individual health factors
        const healthFactor1 = await lendingPool.calculateHealthFactor(erc721Adapter.target, user2.address, encodeERC721Token(tokenId1));
        const healthFactor2 = await lendingPool.calculateHealthFactor(erc721Adapter.target, user2.address, encodeERC721Token(tokenId2));
        const healthFactor3 = await lendingPool.calculateHealthFactor(erc721Adapter.target, user2.address, encodeERC721Token(tokenId3));

        // Health factors should be different due to different collateral values and borrowed amounts
        expect(healthFactor1).to.not.eq(healthFactor2);
        expect(healthFactor2).to.not.eq(healthFactor3);
        expect(healthFactor1).to.not.eq(healthFactor3);

        // Verify that health factors are properly calculated based on individual positions
        expect(healthFactor2).to.be.gt(healthFactor1); // Second position should be healthier due to more collateral
        expect(healthFactor3).to.be.gt(healthFactor1); // Third position should be healthiest due to most collateral
        
        // User1 to provide stability pool funding (rtoken received from lending pool)
        await supplyAsset.connect(user1).approve(lendingPool.target, DEPOSIT_AMOUNT);
        await lendingPool.connect(user1).deposit(DEPOSIT_AMOUNT);
        // check rtoken balance of user1
        const user1RTokenBalance = await rToken.balanceOf(user1.address);
        expect(user1RTokenBalance).to.be.eq(DEPOSIT_AMOUNT);

        await rToken.connect(user1).approve(stabilityPool.target, DEPOSIT_AMOUNT);
        await stabilityPool.connect(user1).deposit(DEPOSIT_AMOUNT);

        const user1DeTokenIndex = await deToken.getUserIndex(user1.address);
        const user1RTokenIndex = await rToken.getUserIndex(user1.address);
        expect(user1DeTokenIndex).to.be.eq(user1RTokenIndex);

        // No interest yet
        const user1DeTokenRawBalance = await deToken.rawBalanceOf(user1.address);
        expect(user1DeTokenRawBalance).to.be.eq(DEPOSIT_AMOUNT);

        const user1DeTokenBalance = await deToken.balanceOf(user1.address);
        expect(user1DeTokenBalance).to.be.eq(DEPOSIT_AMOUNT);

        // Move time
        await time.increase(30 * 24 * 60 * 60);
        
        // Trigger liquidation scenario for first NFT only (pool will need balance)
        await supplyAsset.connect(user3).approve(stabilityPool.target, BORROW_AMOUNT * 2n);
        await supplyAsset.connect(user3).transfer(stabilityPool.target, BORROW_AMOUNT * 2n);

        // Drop price of first NFT significantly, but keep others stable
        await raacHousePrices.setHousePrice(tokenId1, HOUSE_PRICE * 50n / 100n);
        await lendingPool.connect(user3).initiateLiquidation(erc721Adapter.target, user2.address, encodeERC721Token(tokenId1));

        // Verify other positions remain healthy
        const healthFactor2After = await lendingPool.calculateHealthFactor(erc721Adapter.target, user2.address, encodeERC721Token(tokenId2));
        const healthFactor3After = await lendingPool.calculateHealthFactor(erc721Adapter.target, user2.address, encodeERC721Token(tokenId3));
        expect(healthFactor2After).to.be.gt(ethers.parseEther('1')); // Should still be healthy
        expect(healthFactor3After).to.be.gt(ethers.parseEther('1')); // Should still be healthy

        // Complete liquidation of first position
        await time.increase(73 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await stabilityPool.connect(owner).liquidateBorrower(erc721Adapter.target, raacNFTVaultAdapter.target, user2.address, encodeERC721Token(tokenId1), 0);


        // Interest has been earned
        const user1DeTokenIndexPostLiquidation = await deToken.getUserIndex(user1.address);
        expect(user1DeTokenIndexPostLiquidation).to.be.eq(user1DeTokenIndex);
        const user1RTokenIndexPostLiquidation = await rToken.getUserIndex(user1.address);
        expect(user1RTokenIndexPostLiquidation).to.be.eq(user1RTokenIndex);
        // Because still nothing changed for the user
        expect(user1DeTokenIndexPostLiquidation).to.be.eq(user1RTokenIndexPostLiquidation);

        const user1DeTokenRawBalancePostLiquidation = await deToken.rawBalanceOf(user1.address);
        // User deposited without interest, so raw is pure deposit
        expect(user1DeTokenRawBalancePostLiquidation).to.be.eq(DEPOSIT_AMOUNT);
        const user1DeTokenBalancePostLiquidation = await deToken.balanceOf(user1.address);
        // Because the lending pool itself has changed (interest), so this one should follow the same trends of interest bearing
        const interestEarned = Number(DEPOSIT_AMOUNT) * 0.00285;
        expect(user1DeTokenBalancePostLiquidation).to.be.gt(DEPOSIT_AMOUNT);
        expect(user1DeTokenBalancePostLiquidation).to.be.closeTo(DEPOSIT_AMOUNT + BigInt(interestEarned), 26n * 10n ** 16n);

        // Verify first position is liquidated but others remain intact
        // const position1 = await contracts.lendingPool.positions(user2.address, tokenId1);
        // const position2 = await contracts.lendingPool.positions(user2.address, tokenId2);
        // const position3 = await contracts.lendingPool.positions(user2.address, tokenId3);
        const position1View = await lendingPool.getPositionView(erc721Adapter.target, user2.address, encodeERC721Token(tokenId1));
        const position2View = await lendingPool.getPositionView(erc721Adapter.target, user2.address, encodeERC721Token(tokenId2));
        const position3View = await lendingPool.getPositionView(erc721Adapter.target, user2.address, encodeERC721Token(tokenId3));

        expect(position1View.scaledDebtBalance).to.be.eq(0); // Liquidated position
        expect(position2View.scaledDebtBalance).to.be.gt(0); // Still has debt
        expect(position3View.scaledDebtBalance).to.be.gt(0); // Still has debt

        // Repay remaining positions in full (amounts above the position debt revert now)
        const debt2 = await debtToken.balanceOf(user2.address);
        await supplyAsset.connect(user2).approve(lendingPool.target, debt2 * 2n);
        await lendingPool.connect(user2).repay(erc721Adapter.target, encodeERC721Token(tokenId2), ethers.MaxUint256);
        await lendingPool.connect(user2).repay(erc721Adapter.target, encodeERC721Token(tokenId3), ethers.MaxUint256);

        // Verify all debts are cleared
        const finalDebt = await debtToken.balanceOf(user2.address);
        expect(finalDebt).to.be.closeTo(0, 1 * 10 ** 14);

        // Borrower1 is empty
        expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(0);
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.eq(0);

        // Close remaining positions
        const stabilityDeposit = await stabilityPool.getUserDeposit(user1.address);
        expect(stabilityDeposit).to.be.eq(125000000000000000000n);
        const user1DeTokenBalancePostRepay = await deToken.balanceOf(user1.address);
        expect(user1DeTokenBalancePostRepay).to.be.closeTo(125100767769199372025n, 5n * 10n ** 16n); // ~0.1 accrued under the flat-rate model
        const user1DeTokenRawBalancePostRepay = await deToken.rawBalanceOf(user1.address);
        expect(user1DeTokenRawBalancePostRepay).to.be.eq(125000000000000000000n);

        // Request withdraw
        await stabilityPool.connect(user1).requestWithdraw(user1DeTokenBalancePostRepay);
        // 30 minutes+
        await time.increase(30 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        await stabilityPool.connect(user1).withdraw(user1DeTokenBalancePostRepay);

        const user1DeTokenBalancePostWithdraw = await deToken.balanceOf(user1.address);
        expect(user1DeTokenBalancePostWithdraw).to.be.eq(0);
        const user1DeTokenRawBalancePostWithdraw = await deToken.rawBalanceOf(user1.address);
        expect(user1DeTokenRawBalancePostWithdraw).to.be.eq(0);
        
        // Verify all positions closed
        expect(await stabilityPool.getUserDeposit(user1.address)).to.equal(0);

        await time.increase(30 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        // Mine
        await ethers.provider.send("evm_mine", []);

        // Deposit NFT4 — refresh the house price first: it was set 30+ days ago and
        // the oracle now rejects stale prices
        await raacHousePrices.setHousePrice(tokenId4, HOUSE_PRICE);
        await supplyAsset.connect(borrower1).approve(raacNFT.target, HOUSE_PRICE);
        await raacNFT.connect(borrower1).mint(tokenId4, HOUSE_PRICE);
        await raacNFT.connect(borrower1).approve(erc721Adapter.target, tokenId4);
        await lendingPool.connect(borrower1).depositAsset(erc721Adapter.target, encodeERC721Token(tokenId4));


        // Play with various ops 
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('10'));
        // Mine
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);
        expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(10000000000000000000n);
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.eq(10000000000000000000n);

        // Tine pass
        await time.increase(30 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();

        expect(await debtToken.balanceOf(borrower1.address)).to.be.gt(10000000000000000000n);
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.eq(10000000000000000000n);

        // Increase borrow amount
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('10'));
        await ethers.provider.send("evm_mine", []);
        console.log("Borrower1 raw balance of debt", ethers.formatEther(await debtToken.rawBalanceOf(borrower1.address)));
        // ~0.04 of interest accrues on the first 10 between the two borrows under the flat 5% rate
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('20'), ethers.parseEther('0.05'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('20'), ethers.parseEther('0.05'));

        // Time
        await time.increase(1 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Lender1 deposit a bit more
        await supplyAsset.connect(lender1).approve(lendingPool.target, ethers.parseEther('10'));
        await lendingPool.connect(lender1).deposit(ethers.parseEther('10'));
        expect(await rToken.balanceOf(lender1.address)).to.be.closeTo(ethers.parseEther('510') , ethers.parseEther('0.5'));

        // Time 
        await time.increase(12 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Repay a bit
        await supplyAsset.connect(borrower1).approve(lendingPool.target, ethers.parseEther('10'));
        // Pay what will not even cover interest.
        await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('0.001'));
        // Pay a bit more, but not enought to close debt
        await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('9.999'));
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('10'), ethers.parseEther('0.06'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('10'), ethers.parseEther('0.06'));

        // Time
        await time.increase(18 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Lender2 deposit too
        // 0.2 crvUSD is below the new default 10-token minimum; lower it to 1 wei
        await lendingPool.connect(owner).setParameter(13, 1); // OwnerParameter.MinDepositAmount
        // Mint 0.2 crvUSD
        await supplyAsset.mint(lender2.address, ethers.parseEther('0.2'));
        await supplyAsset.connect(lender2).approve(lendingPool.target, ethers.parseEther('0.2'));
        await lendingPool.connect(lender2).deposit(ethers.parseEther('0.2'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(0);
        const lender2RTokenBalance1 = await rToken.balanceOf(lender2.address);
        expect(lender2RTokenBalance1).to.be.eq(ethers.parseEther('0.2'));

        // Time
        await time.increase(12 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Borrow back
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('10'));
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('20'), ethers.parseEther('0.06'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('20'), ethers.parseEther('0.06'));

        // Time
        await time.increase(2 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Borrow more
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('10'));
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('30'), ethers.parseEther('0.1'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('30'), ethers.parseEther('0.1'));

        // Time
        await time.increase(4 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Repay half
        await supplyAsset.connect(borrower1).approve(lendingPool.target, ethers.parseEther('15'));
        await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.parseEther('15'));
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('15'), ethers.parseEther('0.1'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(ethers.parseEther('15'), ethers.parseEther('0.1'));

        // Time
        await time.increase(3 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Repay all (the accrued debt slightly exceeds 15; MaxUint256 = full repayment)
        await supplyAsset.connect(borrower1).approve(lendingPool.target, ethers.parseEther('15.2'));
        await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(tokenId4), ethers.MaxUint256);
        expect(await debtToken.rawBalanceOf(borrower1.address)).to.be.closeTo(0, ethers.parseEther('0.029'));
        expect(await debtToken.balanceOf(borrower1.address)).to.be.closeTo(0, ethers.parseEther('0.029'));

        // Check rToken of lender2
        const lender2RTokenBalance2 = await rToken.balanceOf(lender2.address);
        expect(lender2RTokenBalance2).to.be.closeTo(ethers.parseEther('0.2'), ethers.parseEther('0.000008'));

        // Check rToken of lender1
        const lender1RTokenBalance = await rToken.balanceOf(lender1.address);
        expect(lender1RTokenBalance).to.be.closeTo(ethers.parseEther('510'), ethers.parseEther('0.5'));

        // Time
        await time.increase(1 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Lender2 lend more
        await supplyAsset.mint(lender2.address, ethers.parseEther('0.2'));
        await supplyAsset.connect(lender2).approve(lendingPool.target, ethers.parseEther('0.2'));
        await lendingPool.connect(lender2).deposit(ethers.parseEther('0.2'));
        expect(await rToken.balanceOf(lender2.address)).to.be.closeTo(ethers.parseEther('0.4'), ethers.parseEther('0.000008'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(0);
        
        // And more
        await supplyAsset.mint(lender2.address, ethers.parseEther('0.2'));
        await supplyAsset.connect(lender2).approve(lendingPool.target, ethers.parseEther('0.2'));
        await lendingPool.connect(lender2).deposit(ethers.parseEther('0.2'));
        expect(await rToken.balanceOf(lender2.address)).to.be.closeTo(ethers.parseEther('0.6'), ethers.parseEther('0.000008'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(0);
        
        // Time
        await time.increase(1 * 24 * 60 * 60);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);

        // Set withdrawTimelockDuration to 1
        await lendingPool.connect(owner).setParameter(10, 1);
        // Lender2 withdraw
        // await lendingPool.connect(lender2).requestWithdraw(ethers.parseEther('0.2'));
        await time.increase(1);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);
        await lendingPool.connect(lender2).withdraw(ethers.parseEther('0.2'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(ethers.parseEther('0.2'));
        expect(await rToken.balanceOf(lender2.address)).to.be.closeTo(ethers.parseEther('0.4'), ethers.parseEther('0.000008'));

        // And readd same
        await supplyAsset.connect(lender2).approve(lendingPool.target, ethers.parseEther('0.2'));
        await lendingPool.connect(lender2).deposit(ethers.parseEther('0.2'));
        expect(await rToken.balanceOf(lender2.address)).to.be.closeTo(ethers.parseEther('0.6'), ethers.parseEther('0.000008'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(0);
        
        // Withdraw all
        // await lendingPool.connect(lender2).requestWithdraw(ethers.parseEther('0.6'));
        await time.increase(1);
        await lendingPool.connect(owner).updateState();
        await ethers.provider.send("evm_mine", []);
        await lendingPool.connect(lender2).withdraw(ethers.parseEther('0.6'));
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(ethers.parseEther('0.6'));
        expect(await rToken.balanceOf(lender2.address)).to.be.closeTo(0, ethers.parseEther('0.000008'));

    });
  });
  describe('Emergency Controls and Governance', function () {
    it('should handle lending pool pause', async function () {
        await lendingPool.connect(owner).setParameter(3, 1); // Pause withdrawals
        await expect(
            lendingPool.connect(borrower1).withdraw(ethers.parseEther('10'))
        ).to.be.revertedWithCustomError(lendingPool, "WithdrawalsArePaused");
    });
    
    it('should handle emergency pauses (Pausable)', async function () {
        await expect(
            lendingPool.connect(lender1).pause()
        ).to.be.revertedWithCustomError(lendingPool, "AccessControlUnauthorizedAccount");
        await expect(
            lendingPool.connect(lender1).unpause()
        ).to.be.revertedWithCustomError(lendingPool, "AccessControlUnauthorizedAccount");

        await expect(
            lendingPool.connect(owner).pause()
        ).to.be.emit(lendingPool, "Paused");

        const isPaused = await lendingPool.paused();
        expect(isPaused).to.be.true;

        await expect(
            lendingPool.connect(lender1).deposit(ethers.parseEther('10'))
        ).to.be.revertedWithCustomError(lendingPool, "EnforcedPause");

        await expect(
            lendingPool.connect(borrower1).withdraw(ethers.parseEther('10'))
        ).to.be.revertedWithCustomError(lendingPool, "EnforcedPause");

        await expect(
            lendingPool.connect(owner).unpause()
        ).to.be.emit(lendingPool, "Unpaused");
    });

    it('should handle parameter updates', async function () {
        // Update lending pool parameters
        await expect(
            lendingPool.connect(lender1).setParameter(0, 7500)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");

        const PARAMETER_ENUM = {
            LiquidationThreshold: 0,
            LiquidationGracePeriod: 1,
            LiquidityBufferRatio: 2,
            WithdrawalStatus: 3,
            CanPaybackDebt: 4,
            InsuranceFee: 5,
            ProtocolFeeRate: 6,
            LendingPoolDepositFee: 7,
            LendingPoolSupplyCap: 8,
            LendingPoolBorrowCap: 9,
            VaultOpeningFee: 10,
            BorrowThreshold: 11,

        }

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LiquidationThreshold, 7500);
        let parameters = await lendingPool.parameters();
        expect(parameters.liquidationThreshold).to.equal(7500);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LiquidationGracePeriod, 7 * 24 * 60 * 60);
        parameters = await lendingPool.parameters();
        expect(parameters.liquidationGracePeriod).to.equal(7 * 24 * 60 * 60);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LiquidityBufferRatio, 10000);
        parameters = await lendingPool.parameters();
        expect(parameters.liquidityBufferRatio).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.WithdrawalStatus, 1);
        parameters = await lendingPool.parameters();
        expect(parameters.withdrawalsPaused).to.equal(true);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.CanPaybackDebt, 1);
        parameters = await lendingPool.parameters();
        expect(parameters.canPaybackDebt).to.equal(true);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.InsuranceFee, 10000);
        parameters = await lendingPool.parameters();
        expect(parameters.insuranceFee).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.ProtocolFeeRate, 10000);
        let rateData = await lendingPool.rateData();
        expect(rateData.protocolFeeRate).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LendingPoolDepositFee, 10000);
        parameters = await lendingPool.parameters();
        expect(parameters.depositFee).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LendingPoolBorrowCap, 10000);
        parameters = await lendingPool.parameters();
        expect(parameters.borrowCap).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.LendingPoolSupplyCap, 1000000);
        parameters = await lendingPool.parameters();
        expect(parameters.supplyCap).to.equal(1000000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.VaultOpeningFee, 10000);
        parameters = await lendingPool.parameters();
        expect(parameters.vaultOpeningFee).to.equal(10000);

        await lendingPool.connect(owner).setParameter(PARAMETER_ENUM.BorrowThreshold, 6000);
        parameters = await lendingPool.parameters();
        expect(parameters.borrowThreshold).to.equal(6000);
    });
   });
});