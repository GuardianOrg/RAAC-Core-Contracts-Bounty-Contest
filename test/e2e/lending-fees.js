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

describe("Lending & Fee collection", function () {
  let owner, liquidityProvider, lender1, lender2, lender3, borrower1, borrower2, user1, user2, user3;

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

  // Treasury
  let treasury;

  // Liquidity Pool
  let liquidityPool;

  const INITIAL_MINT_AMOUNT = ethers.parseEther('1000');
  const FIRST_HOUSE_PRICE = ethers.parseEther('100');
  let CurveCrvUSDVaultMock;

  before(async function () {
    [owner, liquidityProvider,lender1, lender2, lender3, borrower1, borrower2, user1, user2, user3] = await ethers.getSigners();
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
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addWhitelistedTarget(lendingPool.target);

     await feeCollector.addClaimableToken(supplyAsset.target)
     await feeCollector.addClaimableToken(rToken.target)

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
    treasury = await Treasury.deploy(owner.address);

    await feeCollector.setTargetAddress(ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), treasury.target);

    await feeCollector.setTargetFeeType(lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE")));
    await feeCollector.setTargetFeeType(lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE")));
    await feeCollector.setTargetFeeType(lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));

    await feeCollector.addWhitelistedTarget(treasury.target);

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

   
    // const currentSwap = await liquidationStrategyProxy.liquidationSwap();
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

    CurveCrvUSDVaultMock = await ethers.getContractFactory("CurveCrvUSDVaultMock");

  });

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

  describe('LendingPoolFeeLibrary Tests', function () {
    describe('Protocol Fee Collection', function () {
        it('should laim protocol fees', async function () {
            const DEPOSIT_AMOUNT = ethers.parseEther('1000');
            const BORROW_AMOUNT = ethers.parseEther('20');
            
             await supplyAsset.connect(lender1).approve(lendingPool.target, DEPOSIT_AMOUNT);
             await lendingPool.connect(lender1).deposit(DEPOSIT_AMOUNT);
         
            await supplyAsset.connect(borrower1).approve(raacNFT.target, FIRST_NFT_PRICE);
            await raacNFT.connect(borrower1).mint(FIRST_NFT_ID, FIRST_NFT_PRICE);
 
            const parameters = await lendingPool.parameters();
            const vaultOpeningFee = parameters.vaultOpeningFee;
            await supplyAsset.mint(borrower1.address, vaultOpeningFee);
            await supplyAsset.connect(borrower1).approve(lendingPool.target, vaultOpeningFee);
            await lendingPool.connect(borrower1).openVaultPosition();

             await raacNFT.connect(borrower1).approve(erc721Adapter.target, FIRST_NFT_ID);
            await lendingPool.connect(borrower1).depositAsset(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID));

            let reserve = await lendingPool.reserve();
            expect(reserve.scaledPendingProtocolFee).to.equal(0n);
            
            await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), BORROW_AMOUNT);
            
            // Pass time
            await time.increase(30 * 24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), BORROW_AMOUNT);

            reserve = await lendingPool.reserve();
            const pendingFees = await lendingPool.getPendingProtocolFee();
            expect(pendingFees).to.be.closeTo(ethers.parseEther('0.008219178'), ethers.parseEther('0.001'));

            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            await lendingPool.connect(owner).claimProtocolFees();
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            expect(feeCollectorBalanceAfter).to.be.closeTo(feeCollectorBalanceBefore + ethers.parseEther('0.008219178'), ethers.parseEther('0.001'));
            
            reserve = await lendingPool.reserve();
            expect(reserve.scaledPendingProtocolFee).to.be.eq(0n);
        });
        
        it('should handle no fees', async function () {
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            await lendingPool.connect(owner).claimProtocolFees();
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            expect(feeCollectorBalanceAfter).to.equal(feeCollectorBalanceBefore);
        });
    });
    
    describe('Insurance Fee Collection', function () {
        it('should collect insurance fees', async function () {
            const DEPOSIT_AMOUNT = ethers.parseEther('100');
            const BORROW_AMOUNT = ethers.parseEther('20');
            const TEN_NFT_ID = 10; 
            
            await supplyAsset.mint(lender1.address, DEPOSIT_AMOUNT);
            await supplyAsset.connect(lender1).approve(lendingPool.target, DEPOSIT_AMOUNT);
            await lendingPool.connect(lender1).deposit(DEPOSIT_AMOUNT);

            await raacHousePrices.setHousePrice(TEN_NFT_ID, FIRST_NFT_PRICE);
            
            await supplyAsset.mint(borrower2.address, FIRST_NFT_PRICE);
            await supplyAsset.connect(borrower2).approve(raacNFT.target, FIRST_NFT_PRICE);
            await raacNFT.connect(borrower2).mint(TEN_NFT_ID, FIRST_NFT_PRICE);
            
            const parameters = await lendingPool.parameters();
            const vaultOpeningFee = parameters.vaultOpeningFee;
            await supplyAsset.mint(borrower2.address, vaultOpeningFee);
            await supplyAsset.connect(borrower2).approve(lendingPool.target, vaultOpeningFee);
            await lendingPool.connect(borrower2).openVaultPosition();
            
            await raacNFT.connect(borrower2).approve(erc721Adapter.target, TEN_NFT_ID);
            await lendingPool.connect(borrower2).depositAsset(erc721Adapter.target, encodeERC721Token(TEN_NFT_ID));
            
            const insuranceFee = await lendingPool.calculateInsuranceFee(erc721Adapter.target, borrower2.address, encodeERC721Token(TEN_NFT_ID), BORROW_AMOUNT);
            expect(insuranceFee).to.be.eq(600000000000000000n);
            
            await supplyAsset.connect(borrower2).approve(lendingPool.target, insuranceFee);
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);

            await lendingPool.connect(borrower2).borrowWithInsurance(erc721Adapter.target, encodeERC721Token(TEN_NFT_ID), BORROW_AMOUNT);
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            expect(feeCollectorBalanceAfter).to.equal(feeCollectorBalanceBefore + insuranceFee);
            
            const position = await lendingPool.getPosition(erc721Adapter.target, borrower2.address, encodeERC721Token(TEN_NFT_ID));
            expect(position.isInsured).to.be.true;
        });
    });
    
    describe('Vault Opening Fee Collection', function () {
        it('should collect vault opening fees', async function () {
            const TWELVE_NFT_ID = 12; 
            
            await raacHousePrices.setHousePrice(TWELVE_NFT_ID, FIRST_NFT_PRICE);
            
            await supplyAsset.mint(user2.address, FIRST_NFT_PRICE);
            await supplyAsset.connect(user2).approve(raacNFT.target, FIRST_NFT_PRICE);
            await raacNFT.connect(user2).mint(TWELVE_NFT_ID, FIRST_NFT_PRICE);
            
            const parameters = await lendingPool.parameters();
            const vaultOpeningFee = parameters.vaultOpeningFee;
            
            await supplyAsset.mint(user2.address, vaultOpeningFee);
            await supplyAsset.connect(user2).approve(lendingPool.target, vaultOpeningFee);
            
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            
            await lendingPool.connect(user2).openVaultPosition();
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            expect(feeCollectorBalanceAfter).to.equal(feeCollectorBalanceBefore + vaultOpeningFee);
        });
    });
    
    describe.skip('Vault Rewards Collection', function () {
        let curveCrvUSDVaultMock;
        
        before(async function () {
            // LendingPoolVault.test uses VAULT_REWARDS
            
            curveCrvUSDVaultMock = await CurveCrvUSDVaultMock.deploy(supplyAsset.target, "Curve Savings", "scrvusd");
            
            await lendingPool.setVault(curveCrvUSDVaultMock.target);
        });

        it('should claim vault rewards without rewards', async function () {
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            
            await feeCollector.claimCollectorRewards(supplyAsset.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
            
            const vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.equal(0);
            expect(vaultRewards.lastClaimTime).to.equal(0);
            expect(vaultRewards.lastWithdrawalTime).to.equal(0);
            expect(vaultRewards.lastDepositTime).to.equal(0);
            expect(vaultRewards.totalDeposits).to.equal(0);
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            expect(feeCollectorBalanceAfter).to.equal(feeCollectorBalanceBefore);
        });

        it('should claim vault rewards', async function () {
            const DEPOSIT_AMOUNT = ethers.parseEther('100'); 
            
            await supplyAsset.mint(lender1.address, DEPOSIT_AMOUNT);
            await supplyAsset.connect(lender1).approve(lendingPool.target, DEPOSIT_AMOUNT);
            await lendingPool.connect(lender1).deposit(DEPOSIT_AMOUNT);
            
            await time.increase(24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.01")); 
            
            await supplyAsset.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000")); // 1%
            
            await time.increase(24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            const THOUSAND_DEPOSIT = ethers.parseEther('1000');
            await supplyAsset.mint(lender2.address, THOUSAND_DEPOSIT);
            await supplyAsset.connect(lender2).approve(lendingPool.target, THOUSAND_DEPOSIT);
            await lendingPool.connect(lender2).deposit(THOUSAND_DEPOSIT);
            
            let vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.be.closeTo(ethers.parseEther("9.119917808219178082"), ethers.parseEther("1"));
            expect(vaultRewards.totalDeposits).to.be.gt(0);
            
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            const lendingPoolBalanceBefore = await supplyAsset.balanceOf(lendingPool.target);
            
            await feeCollector.claimCollectorRewards(supplyAsset.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            const lendingPoolBalanceAfter = await supplyAsset.balanceOf(lendingPool.target);
            
            // expect(feeCollectorBalanceAfter).to.be.closeTo(feeCollectorBalanceBefore + ethers.parseEther("9.119917808219178082"), ethers.parseEther("1"));
            // expect(lendingPoolBalanceAfter).to.be.lt(lendingPoolBalanceBefore); 
            
            vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.equal(0);
            expect(vaultRewards.lastClaimTime).to.be.gt(0);
            
            const collectedFees = await feeCollector.getCollectedFees(supplyAsset.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
            // expect(collectedFees.treasuryAmount).to.be.closeTo(ethers.parseEther("9.119917808219178082"), ethers.parseEther("1"));
        });

        it('should handle multiple', async function () {
            const DEPOSIT_AMOUNT = ethers.parseEther('500000');
            
            await supplyAsset.mint(lender1.address, DEPOSIT_AMOUNT);
            await supplyAsset.connect(lender1).approve(lendingPool.target, DEPOSIT_AMOUNT);
            await lendingPool.connect(lender1).deposit(DEPOSIT_AMOUNT);
            
            await time.increase(24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.01"));
            await supplyAsset.mint(curveCrvUSDVaultMock.target, ethers.parseEther("4000"));
            
            await supplyAsset.mint(lender2.address, ethers.parseEther('1000'));
            await supplyAsset.connect(lender2).approve(lendingPool.target, ethers.parseEther('1000'));
            await lendingPool.connect(lender2).deposit(ethers.parseEther('1000'));
            
            await feeCollector.claimCollectorRewards(supplyAsset.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
            
            let vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.equal(0);
            
            await time.increase(24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.02"));
            await supplyAsset.mint(curveCrvUSDVaultMock.target, ethers.parseEther("4000"));
            
            await supplyAsset.mint(lender3.address, ethers.parseEther('1000'));
            await supplyAsset.connect(lender3).approve(lendingPool.target, ethers.parseEther('1000'));
            await lendingPool.connect(lender3).deposit(ethers.parseEther('1000'));
            
            vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.be.gt(0);
            
            const feeCollectorBalanceBefore = await supplyAsset.balanceOf(feeCollector.target);
            await feeCollector.claimCollectorRewards(supplyAsset.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
            
            const feeCollectorBalanceAfter = await supplyAsset.balanceOf(feeCollector.target);
            // expect(feeCollectorBalanceAfter).to.be.gt(feeCollectorBalanceBefore);
            
            vaultRewards = await lendingPool.vaultRewards();
            expect(vaultRewards.unclaimedRewards).to.equal(0);
        });
    });
  });
  describe('Collect from FeeCollector to Treasury', function () {
    it('should collect fees from FeeCollector to Treasury', async function () {
        const balanceBeforeCollect = {
            treasury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            lendingPool: {
                supplyAsset: await supplyAsset.balanceOf(rToken.target),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
        }

        expect(balanceBeforeCollect.treasury.supplyAsset).to.be.eq(0n);
        expect(balanceBeforeCollect.treasury.rToken).to.be.eq(0n);

        // expect(balanceBeforeCollect.feeCollector.supplyAsset).to.be.closeTo(4294995382340973823407n, 1000000n);
        // expect(balanceBeforeCollect.feeCollector.rToken).to.be.eq(0n);
        // expect(balanceBeforeCollect.lendingPool.supplyAsset).to.be.closeTo(100828000000000000000000n, 1000000n);
        // expect(balanceBeforeCollect.borrower1.debt).to.be.closeTo(40021923814195074047n, 10000000000n);
        // expect(balanceBeforeCollect.lender1.rToken).to.be.closeTo(501200103563023487686850n, 1000000n);

        await lendingPool.connect(owner).claimProtocolFees();

        // With prior tests, the fee collector should have some balance that we now want to send to the treasury
        const balanceBefore = {
            treasury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
            lendingPool: {
                supplyAsset: await supplyAsset.balanceOf(rToken.target),
                rToken: await rToken.balanceOf(lendingPool.target),
            },
        }

        // expect(balanceBefore.lendingPool.supplyAsset).to.be.closeTo(100827996707263550575035n, 10000000n);
        expect(balanceBefore.treasury.supplyAsset).to.be.equal(0);
        expect(balanceBefore.feeCollector.rToken).to.be.equal(0);

        await treasury.addSupportedToken(supplyAsset.target);
        await treasury.addSupportedToken(rToken.target);

        await feeCollector.distributeFees(ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE")), ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), supplyAsset.target);
        await feeCollector.distributeFees(ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE")), ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), supplyAsset.target);
      
        const balanceAfterLendingFeeDistribute = {
            tresury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
        }

        // expect(balanceAfterLendingFeeDistribute.tresury.supplyAsset).to.be.closeTo(300000000000000000000n, 10000000n);
       
        // await feeCollector.distributeFees(ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")), ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), supplyAsset.target);
        await feeCollector.distributeFees(ethers.keccak256(ethers.toUtf8Bytes("PROTOCOL_FEE")), ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), supplyAsset.target);
        const balanceAfterDistribute = {
            tresury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
        }

        // expect(balanceAfterProtocolFeeDistribute.feeCollector.supplyAsset).to.equal(0);
    });
  });
  describe('Clean-up', function () {
    it('should clean-up', async function () {
        // Close all positions
        const debtAmount = await debtToken.balanceOf(borrower1.address);
        console.log('debtAmount', ethers.formatEther(debtAmount));
        expect(debtAmount).to.be.closeTo(40021923814195074047n, 1000000000000000000n);
        // Repay all debt
        await supplyAsset.connect(borrower1).approve(lendingPool.target, debtAmount);
        await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), debtAmount);

        const debtAmount2 = await debtToken.balanceOf(borrower2.address);
        // console.log('debtAmount2', ethers.formatEther(debtAmount2));
        // expect(debtAmount2).to.be.closeTo(40021923814195074047n, 1000000000000000000n);
        await supplyAsset.connect(borrower2).approve(lendingPool.target, debtAmount2);
        const TEN_NFT_ID = 10;
        await lendingPool.connect(borrower2).repay(erc721Adapter.target, encodeERC721Token(TEN_NFT_ID), debtAmount2);

        const debtAmountAfterRepay = await debtToken.balanceOf(borrower1.address);
        expect(debtAmountAfterRepay).to.be.equal(0n);

        const balanceBeforeCollect = {
            treasury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            lendingPool: {
                supplyAsset: ethers.formatEther(await supplyAsset.balanceOf(rToken.target)),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
        }
        await lendingPool.connect(owner).claimProtocolFees();
        const balanceAfterCollect = {
            treasury: {
                supplyAsset: await supplyAsset.balanceOf(treasury.target),
                rToken: await rToken.balanceOf(treasury.target),
            },
            feeCollector: {
                supplyAsset: await supplyAsset.balanceOf(feeCollector.target),
                rToken: await rToken.balanceOf(feeCollector.target),
            },
            lendingPool: {
                supplyAsset: ethers.formatEther(await supplyAsset.balanceOf(rToken.target)),
            },
            borrower1: {
                debt: await debtToken.balanceOf(borrower1.address),
            },
            lender1: {
                rToken: await rToken.balanceOf(lender1.address),
            },
        }

        // expect(await debtToken.balanceOf(borrower1.address)).to.be.equal(0);
        // Lender withdraw all
        const withdrawalAmount = await rToken.balanceOf(lender1.address);

        // expect(withdrawalAmount).to.be.closeTo(50120010356302348768685n, 1000000000000000000n);
        await supplyAsset.connect(lender1).approve(lendingPool.target, withdrawalAmount);
        await lendingPool.connect(lender1).withdraw(withdrawalAmount);
        // Check
        expect(await rToken.balanceOf(lender1.address)).to.be.closeTo(0, ethers.parseEther('0.1'));
        // expect(await supplyAsset.balanceOf(lender1.address)).to.be.closeTo(ethers.parseEther('501200.10356302348768685'), ethers.parseEther('0.1'));
        expect(await debtToken.balanceOf(borrower1.address)).to.equal(0);


        // Treasury
        // expect(await supplyAsset.balanceOf(treasury.target)).to.be.closeTo(ethers.parseEther('4294.998675077423248372'), ethers.parseEther('0.1'));
        expect(await rToken.balanceOf(treasury.target)).to.equal(0);
        // Fee Collector
        expect(await supplyAsset.balanceOf(feeCollector.target)).to.equal(0);
        expect(await rToken.balanceOf(feeCollector.target)).to.equal(0);

        // Lending Pool (has left from vault test, to see later, this tests mostly need to ensure money from collector in treasury is distributed correctly)
        // expect(await supplyAsset.balanceOf(rToken.target)).to.be.closeTo(ethers.parseEther('595.983672158141477439'), ethers.parseEther('0.1'));
        expect(await supplyAsset.balanceOf(lendingPool.target)).to.equal(0);
        
    });
  });


});