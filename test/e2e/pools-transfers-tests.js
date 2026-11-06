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
const THIRD_NFT_ID = 3;

const INITIAL_LIQUIDITY_POOL_AMOUNT = ethers.parseEther("1000");

describe("Pools transfers", function () {
  let owner, liquidityProvider, lender1, lender2, lender3, borrower1, borrower2, borrower3, user1, user2, user3;

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

  const INITIAL_MINT_AMOUNT = ethers.parseEther('100000');
  const FIRST_NFT_PRICE = ethers.parseEther('100000');
  const SECOND_NFT_PRICE = ethers.parseEther('100000');
  const THIRD_NFT_PRICE = ethers.parseEther('100000');

  before(async function () {
    [owner, liquidityProvider,lender1, lender2, lender3, borrower1, borrower2, borrower3, user1, user2, user3] = await ethers.getSigners();
   
    // Deploy Fee Collector
    feeCollector = await deployFeeCollector(owner);

    ({
        supplyAsset,rToken,debtToken, // crvUSD / rCRV / debtCRV
        lendingPool,liquidationProxy,vaultProxy,complianceRegistry,
        initialPrimeRate, // 0.1
    } = await deployLendingPool(owner, feeCollector));

    // Deploy RAAC NFT
    ({ raacNFT, raacHousePrices } = await deployRAACNFT(supplyAsset, complianceRegistry, owner));

    // Set fee collector
     await lendingPool.setFeeCollector(await feeCollector.getAddress());
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE")), 10000, 0, 0, 0, 0, 0);
     await feeCollector.addClaimableToken(supplyAsset.target)

    await raacHousePrices.setOracle(owner.address);

    erc721Adapter = await deployERC721Adapter(raacNFT,raacHousePrices,lendingPool);
    await lendingPool.registerAdapter(erc721Adapter.target);

    await raacHousePrices.setHousePrice(FIRST_NFT_ID, FIRST_NFT_PRICE);
    await raacHousePrices.setHousePrice(SECOND_NFT_ID, SECOND_NFT_PRICE);
    await raacHousePrices.setHousePrice(THIRD_NFT_ID, THIRD_NFT_PRICE);

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

    // Mint initial tokens to users (enought for the price of the NFTs for borrowers)
    await supplyAsset.mint(borrower1.address, FIRST_NFT_PRICE);
    await supplyAsset.mint(borrower2.address, SECOND_NFT_PRICE);
    await supplyAsset.mint(borrower3.address, THIRD_NFT_PRICE);

    // Mint initial tokens to lenders
    for (const user of [lender1, lender2, lender3]) {
        await supplyAsset.mint(user.address, INITIAL_MINT_AMOUNT);
    }
  });

  describe('Minting NFT for borrowers', function () {
    it('should handle minting NFT for borrowers', async function () {
      await supplyAsset.connect(borrower1).approve(raacNFT.target, FIRST_NFT_PRICE);
      await raacNFT.connect(borrower1).mint(FIRST_NFT_ID, FIRST_NFT_PRICE);
      await raacNFT.connect(borrower1).approve(erc721Adapter.target, FIRST_NFT_ID);

      await supplyAsset.connect(borrower2).approve(raacNFT.target, SECOND_NFT_PRICE);
      await raacNFT.connect(borrower2).mint(SECOND_NFT_ID, SECOND_NFT_PRICE);
      await raacNFT.connect(borrower2).approve(erc721Adapter.target, SECOND_NFT_ID);

      await supplyAsset.connect(borrower3).approve(raacNFT.target, THIRD_NFT_PRICE);
      await raacNFT.connect(borrower3).mint(THIRD_NFT_ID, THIRD_NFT_PRICE);
      await raacNFT.connect(borrower3).approve(erc721Adapter.target, THIRD_NFT_ID);
    });
    
  });

  const FIRST_LENDER_DEPOSIT_AMOUNT = ethers.parseEther('20000');
  const FIRST_BORROWER_AMOUNT = ethers.parseEther('10000');

  describe('Lending Pool Setup', function () {
    it('should handle deposit to lending pool', async function () {
        expect(await supplyAsset.balanceOf(lender1.address)).to.be.eq(INITIAL_MINT_AMOUNT);
        // Lender 1 deposits 20 000 crvUSD
        await supplyAsset.connect(lender1).approve(lendingPool.target, FIRST_LENDER_DEPOSIT_AMOUNT);
        await lendingPool.connect(lender1).deposit(FIRST_LENDER_DEPOSIT_AMOUNT);

        expect(await rToken.balanceOf(lender1.address)).to.be.eq(FIRST_LENDER_DEPOSIT_AMOUNT);
        expect(await supplyAsset.balanceOf(rToken.target)).to.be.eq(FIRST_LENDER_DEPOSIT_AMOUNT);
    });

    it('should handle borrow from lending pool', async function () {
        await raacNFT.connect(borrower1).approve(erc721Adapter.target, FIRST_NFT_ID);
        const parameters = await lendingPool.parameters();
        const vaultOpeningFee = parameters.vaultOpeningFee;
        await supplyAsset.mint(borrower1.address, vaultOpeningFee);
        await supplyAsset.connect(borrower1).approve(lendingPool.target, vaultOpeningFee);
        await lendingPool.connect(borrower1).openVaultPosition();
        await lendingPool.connect(borrower1).depositAsset(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID));

        // 10 000 crvUSD
        await supplyAsset.connect(borrower1).approve(lendingPool.target, FIRST_BORROWER_AMOUNT);
        await lendingPool.connect(borrower1).borrow(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), FIRST_BORROWER_AMOUNT);

        expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(FIRST_BORROWER_AMOUNT);
    });
  });
  const SECOND_LENDER_DEPOSIT_AMOUNT = ethers.parseEther('10000');
  describe('Week later', function () {
    it('should pass a week', async function () {
        await time.increase(7 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
    });
    it('should have increase debt and lend', async function(){
        // Previously, needed to update state, now it is done automatically and therefore such test should pass
        expect(await rToken.balanceOf(lender1.address)).to.gt(FIRST_LENDER_DEPOSIT_AMOUNT)
        expect(await debtToken.balanceOf(borrower1.address)).to.gt(FIRST_BORROWER_AMOUNT)
    })
  });

//   return;

  const LENDER1_TRANSFER_DETOKEN_AMOUNT = ethers.parseEther('10');
  const LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT = ethers.parseEther('100');
  describe('Stability Pool Setup', function () {
    it('should handle deposit to stability pool', async function () {
        expect(await rToken.balanceOf(stabilityPool.target)).to.equal(0);
        // Initial value + interest
        const lender1ObservedInterest = await rToken.balanceOf(lender1.address) - FIRST_LENDER_DEPOSIT_AMOUNT;
        expect(lender1ObservedInterest).to.gt(0);
        await rToken.connect(lender1).approve(stabilityPool.target, LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT);
        await stabilityPool.connect(lender1).deposit(LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT);
        expect(await rToken.balanceOf(stabilityPool.target)).to.eq(LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT);
        expect(await rToken.balanceOf(lender1.address)).to.eq(FIRST_LENDER_DEPOSIT_AMOUNT + lender1ObservedInterest - LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT);
    });
    it('should allow to transfer DEToken to user1', async function () {
        await deToken.connect(lender1).transfer(user1.address, LENDER1_TRANSFER_DETOKEN_AMOUNT);
        expect(await deToken.balanceOf(user1.address)).to.eq(LENDER1_TRANSFER_DETOKEN_AMOUNT);
    });
  });

  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
    });
    it('should have generated interest for RToken, DebtToken and DEToken for lender 1, borrower 1 and user1', async function () {
        const lender1ObservedInterest = await rToken.balanceOf(lender1.address) - FIRST_LENDER_DEPOSIT_AMOUNT;
        expect(lender1ObservedInterest).to.gt(0);
        const borrower1ObservedInterest = await debtToken.balanceOf(borrower1.address) - FIRST_BORROWER_AMOUNT;
        expect(borrower1ObservedInterest).to.gt(0);
        const user1ObservedInterest = await deToken.balanceOf(user1.address) - LENDER1_TRANSFER_DETOKEN_AMOUNT;
        expect(user1ObservedInterest).to.gt(0);

        // Because we also deposited to stability pool, the stability pool itself should be affected by the interest
        const stabilityPoolObservedInterest = await rToken.balanceOf(stabilityPool.target) - LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT;
        expect(stabilityPoolObservedInterest).to.gt(0);
    })
  });
  const USER1_TRANSFER_USER2_AMOUNT = ethers.parseEther('0.1');
  describe('DEToken transfers', function () {
    it('should allow user1 to transfer DEToken to user2 and back to lender1', async function () {
        const user1BalanceBefore = await deToken.balanceOf(user1.address);
        await deToken.connect(user1).transfer(lender1.address, LENDER1_TRANSFER_DETOKEN_AMOUNT);
        expect(await deToken.balanceOf(user1.address)).to.eq(user1BalanceBefore - LENDER1_TRANSFER_DETOKEN_AMOUNT);
        // Because full money has been paid back to him + interests
        expect(await deToken.balanceOf(lender1.address)).to.gt(LENDER1_STABILITY_POOL_DEPOSIT_AMOUNT);
        // User1 still has resulting interest
        expect(await deToken.balanceOf(user1.address)).to.gt(0);

        await deToken.connect(user1).transfer(user2.address, USER1_TRANSFER_USER2_AMOUNT);
        expect(await deToken.balanceOf(user2.address)).to.eq(USER1_TRANSFER_USER2_AMOUNT);

        // no new interest
        expect(await deToken.balanceOf(user1.address)).to.eq(user1BalanceBefore - LENDER1_TRANSFER_DETOKEN_AMOUNT - USER1_TRANSFER_USER2_AMOUNT);
    })
    it('should allow user2 to transfer full visibile balance to user3', async function () {
        const user2BalanceBefore = await deToken.balanceOf(user2.address);
        await deToken.connect(user2).transfer(user3.address, user2BalanceBefore);
        expect(await deToken.balanceOf(user3.address)).to.eq(user2BalanceBefore);
        expect(await deToken.balanceOf(user2.address)).to.eq(0);

        // no new interest
        expect(await deToken.balanceOf(user2.address)).to.eq(0);
        expect(await deToken.balanceOf(user3.address)).to.eq(user2BalanceBefore);

        // Transfer back all to user1
        const user1BalanceBefore = await deToken.balanceOf(user1.address);
        const user3BalanceBefore = await deToken.balanceOf(user3.address);
        await deToken.connect(user3).transfer(user1.address, user3BalanceBefore);
        expect(await deToken.balanceOf(user1.address)).to.eq(user1BalanceBefore + user3BalanceBefore);
        // no new interest nor balance
        expect(await deToken.balanceOf(user2.address)).to.eq(0);
        expect(await deToken.balanceOf(user3.address)).to.eq(0);
    });
  });

  describe('Week later', function () {
    it('should pass a week', async function () {
        await time.increase(7 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
    });
  });

  describe('User 3 transfers to user 2 full balance with interest', function () {
    it('should allow user3 to transfer full visibile balance to user2', async function () {
        const user3BalanceBefore = await deToken.balanceOf(user3.address);
        const user2BalanceBefore = await deToken.balanceOf(user2.address);
        await deToken.connect(user3).transfer(user2.address, user3BalanceBefore);
        const user3BalanceAfter = await deToken.balanceOf(user3.address);
        const user2BalanceAfter = await deToken.balanceOf(user2.address);

        expect(user3BalanceAfter).to.eq(0);
        // No new interest minted, has been minted first to user2 and is part of what is being transferred
        expect(user2BalanceAfter).to.eq(user3BalanceBefore);
    });
  });

  const LENDER1_SECOND_DEPOSIT_AMOUNT = ethers.parseEther('10');
  describe('Lender 1 deposit a bit more', function () {
    it('should handle lending pool deposit and generate interest upon deposit to lender1', async function () {
        const lender1BalanceBefore = await rToken.balanceOf(lender1.address);
        
        await supplyAsset.connect(lender1).approve(lendingPool.target, LENDER1_SECOND_DEPOSIT_AMOUNT);
        await lendingPool.connect(lender1).deposit(LENDER1_SECOND_DEPOSIT_AMOUNT);

        expect(await rToken.balanceOf(lender1.address)).to.be.eq(lender1BalanceBefore + LENDER1_SECOND_DEPOSIT_AMOUNT);
    });
    it('should handle stability pool deposit and generate interest upon deposit to lender1', async function () {
        const stabilityPoolBalanceBefore = await rToken.balanceOf(stabilityPool.target);

        await rToken.connect(lender1).approve(stabilityPool.target, LENDER1_SECOND_DEPOSIT_AMOUNT);
        await stabilityPool.connect(lender1).deposit(LENDER1_SECOND_DEPOSIT_AMOUNT);

        expect(await rToken.balanceOf(stabilityPool.target)).to.be.closeTo(stabilityPoolBalanceBefore + LENDER1_SECOND_DEPOSIT_AMOUNT, 1);
        // This shall have minted interest
        expect(await deToken.rawBalanceOf(lender1.address)).to.be.eq(await deToken.balanceOf(lender1.address));
    });
  });


  const SECOND_LENDER_STABILITY_POOL_DEPOSIT_AMOUNT = ethers.parseEther('100');

  describe('Lender 2 deposits', function () {
    it('should handle lender 2 deposit to lending pool', async function () {
        expect(await supplyAsset.balanceOf(lender2.address)).to.be.eq(INITIAL_MINT_AMOUNT);

        await supplyAsset.connect(lender2).approve(lendingPool.target, SECOND_LENDER_DEPOSIT_AMOUNT);
        await lendingPool.connect(lender2).deposit(SECOND_LENDER_DEPOSIT_AMOUNT);

        expect(await rToken.balanceOf(lender2.address)).to.be.eq(SECOND_LENDER_DEPOSIT_AMOUNT);
        expect(await supplyAsset.balanceOf(rToken.target)).to.be.eq(SECOND_LENDER_DEPOSIT_AMOUNT + FIRST_LENDER_DEPOSIT_AMOUNT + LENDER1_SECOND_DEPOSIT_AMOUNT - FIRST_BORROWER_AMOUNT);
    });
    it('should handle lender 2 deposit to stability pool', async function () {
        await rToken.connect(lender2).approve(stabilityPool.target, SECOND_LENDER_STABILITY_POOL_DEPOSIT_AMOUNT);
        await stabilityPool.connect(lender2).deposit(SECOND_LENDER_STABILITY_POOL_DEPOSIT_AMOUNT);

        expect(await rToken.balanceOf(lender2.address)).to.be.eq(SECOND_LENDER_DEPOSIT_AMOUNT - SECOND_LENDER_STABILITY_POOL_DEPOSIT_AMOUNT);
        expect(await deToken.balanceOf(lender2.address)).to.be.eq(SECOND_LENDER_STABILITY_POOL_DEPOSIT_AMOUNT);
    });
  });

  describe('Month later', function () {
    it('should pass a month', async function () {
        await time.increase(30 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
    });
  });

  const SECOND_BORROWER_AMOUNT = ethers.parseEther('10000');
  describe('Borrowers 2', async function () {
    it('should handle borrower 2 deposit to stability pool', async function () {
        await raacNFT.connect(borrower2).approve(erc721Adapter.target, SECOND_NFT_ID);
        const parameters = await lendingPool.parameters();
        const vaultOpeningFee = parameters.vaultOpeningFee;
        await supplyAsset.mint(borrower2.address, vaultOpeningFee);
        await supplyAsset.connect(borrower2).approve(lendingPool.target, vaultOpeningFee);
        await lendingPool.connect(borrower2).openVaultPosition();
        await lendingPool.connect(borrower2).depositAsset(erc721Adapter.target, encodeERC721Token(SECOND_NFT_ID));

        await supplyAsset.connect(borrower2).approve(lendingPool.target, SECOND_BORROWER_AMOUNT);
        await lendingPool.connect(borrower2).borrow(erc721Adapter.target, encodeERC721Token(SECOND_NFT_ID), SECOND_BORROWER_AMOUNT);

        expect(await debtToken.balanceOf(borrower2.address)).to.be.eq(SECOND_BORROWER_AMOUNT);
    });
  });


  const timed_balances = {
    time:[],
    lender1:[],
    borrower1:[],
    user1:[],
    stabilityPool:[],
    lender2:[],
    borrower2:[],
  }
  describe('Year later', function () {
    it('should pass a year', async function () {
        // get block time
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));

    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");

        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");

        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Year later', function () {
    it('should pass a year', async function () {
        await time.increase(365 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        timed_balances.time.push(await ethers.provider.getBlock('latest').timestamp);
       
        timed_balances.lender1.push(await rToken.balanceOf(lender1.address));
        timed_balances.lender2.push(await rToken.balanceOf(lender2.address));
        timed_balances.user1.push(await rToken.balanceOf(user1.address));
        timed_balances.stabilityPool.push(await rToken.balanceOf(stabilityPool.target));

        timed_balances.borrower1.push(await debtToken.balanceOf(borrower1.address));
        timed_balances.borrower2.push(await debtToken.balanceOf(borrower2.address));
    });
  });
  describe('Pay back 3/4 of debt in multiple times', function () {
    it('should pay back 3/4 of debt in multiple times', async function () {
      const debtAmountBorrower2 = await debtToken.balanceOf(borrower2.address);

      await supplyAsset.mint(borrower2.address, ethers.parseEther('918'));
      const supplyAssetBalanceBorrower2 = await supplyAsset.balanceOf(borrower2.address);

      // pay back 918
      await supplyAsset.connect(borrower2).approve(lendingPool.target, ethers.MaxUint256);
      await lendingPool.connect(borrower2).repay(erc721Adapter.target, encodeERC721Token(SECOND_NFT_ID), ethers.parseEther('918'));


      const supplyAfterRepay = await supplyAsset.balanceOf(borrower2.address);
      const supplyDiff = supplyAssetBalanceBorrower2 - supplyAfterRepay;
      console.log('supplyAfterRepay', supplyAfterRepay);
      console.log('supplyDiff', supplyDiff);
      expect(supplyDiff).to.be.eq(ethers.parseEther('918'));
      const debtAfterRepay = await debtToken.balanceOf(borrower2.address);
      console.log('debtAfterRepay', ethers.formatUnits(debtAfterRepay, 18));
      console.log('debtAmountBorrower2', ethers.formatUnits(debtAmountBorrower2, 18));
      // expect(debtAfterRepay).to.be.closeTo(ethers.parseEther('14000'), ethers.parseEther('1'));


      const amountToRepay = [1100, 900, 200, 1800, 2000, 1400, 15, 25, 1000, 2000];
      // const remainingDebtExpected = [14088, 12988, 12169, 11969, 9100, 7700, 7685, 7660, 6660, 4660];

      const remainingDebtExpectedBefore = [
        14088, 13055, 12169, 12092, 10410, 8478, 7079, 7065, 7080, 6150
      ];
      const remainingDebtExpectedAfter = [
        12988, 12155, 11969, 10292, 8410, 7078, 7064, 7040, 6080, 4150
      ];

      await supplyAsset.mint(borrower2.address, ethers.parseEther('10000'));

      for(let i = 0; i < amountToRepay.length; i++) {
        // Time pass
        await time.increase(amountToRepay[i] * 60 * 60);
        await ethers.provider.send("evm_mine");

        const repayment = BigInt(amountToRepay[i] * 1e18);
        const blockTime = await ethers.provider.getBlock('latest');
        const date = new Date(blockTime.timestamp * 1000);

        const debtBeforeRepay = await debtToken.balanceOf(borrower2.address);
        expect(debtBeforeRepay).to.be.closeTo(ethers.parseEther(remainingDebtExpectedBefore[i].toString()), ethers.parseEther('20'));

        console.log(`${date.toISOString()} - Borrower will repay ${ethers.formatUnits(repayment, 18)} of debt of ${ethers.formatUnits(await debtToken.balanceOf(borrower2.address), 18)}`);

        // Repay
        await supplyAsset.connect(borrower2).approve(lendingPool.target, ethers.MaxUint256);
        await lendingPool.connect(borrower2).repay(erc721Adapter.target, encodeERC721Token(SECOND_NFT_ID), repayment);
      
        const debtAfterRepay = await debtToken.balanceOf(borrower2.address);
        expect(debtAfterRepay).to.be.closeTo(ethers.parseEther(remainingDebtExpectedAfter[i].toString()), ethers.parseEther('20'));
      }
    });
  });

  describe('Pay back all debt', function () {
    it('should pay back all debt', async function () {
      const debtAmountBorrower1 = await debtToken.balanceOf(borrower1.address);
      // Mint the needed amount
      await supplyAsset.mint(borrower1.address, debtAmountBorrower1);

      const beforeRepay = await supplyAsset.balanceOf(borrower1.address);
      await supplyAsset.connect(borrower1).approve(lendingPool.target, ethers.MaxUint256);
      await lendingPool.connect(borrower1).repay(erc721Adapter.target, encodeERC721Token(FIRST_NFT_ID), debtAmountBorrower1);
      // expect(await debtToken.balanceOf(borrower1.address)).to.be.eq(0);
      const supplyDiff = beforeRepay - await supplyAsset.balanceOf(borrower1.address);
      expect(supplyDiff).to.be.eq(debtAmountBorrower1);
      expect(supplyDiff).to.be.closeTo(16746704957271773809934n, 100000000000000000000n);

      // Borrow 2 also pays it all
      const debtAmountBorrower2 = await debtToken.balanceOf(borrower2.address);
      
      // Mint the needed amount
      await supplyAsset.mint(borrower2.address, debtAmountBorrower2);
      const supplyAssetBalanceBorrower2 = await supplyAsset.balanceOf(borrower2.address);
      await supplyAsset.connect(borrower2).approve(lendingPool.target, ethers.MaxUint256);
      await lendingPool.connect(borrower2).repay(erc721Adapter.target, encodeERC721Token(SECOND_NFT_ID), debtAmountBorrower2);

      expect(await debtToken.balanceOf(borrower2.address)).to.be.eq(0);
      const supplyDiff2 = supplyAssetBalanceBorrower2 - await supplyAsset.balanceOf(borrower2.address);
      expect(supplyDiff2).to.be.eq(debtAmountBorrower2);
      expect(supplyDiff2).to.be.closeTo(4150178070582077363024n, 1000000000000000000n);
    });
  });
  let currentLiquidityRate;
  describe('Interest increase as expected', function () {
    it('should get current lender interest rate', async function () {
        const reserveRateData = await lendingPool.getReserveRateData();
        currentLiquidityRate = reserveRateData.currentLiquidityRate;
        console.log('currentLiquidityRate', ethers.formatUnits(currentLiquidityRate, 27));
        
    });
    it('should ensure lender increase linearly as expected', async function () {
        const diffs1 = [];
        const diffs2 = [];
        const diffsStabilityPool = [];
        // Verify that each year, the interest is linearly increasing
        for(let i = 1; i < timed_balances.time.length; i++) {
            // // Lender1
            const diff = timed_balances.lender1[i] - timed_balances.lender1[i-1];
            // console.log('lender1', timed_balances.lender1[i], timed_balances.lender1[i-1], diff);
            diffs1.push(diff);
            if(i > 1) {
                expect(diffs1[i-1]).to.be.closeTo(diffs1[i-2], 1);
            }
        }

        for(let i = 1; i < timed_balances.time.length; i++) {
            const diff = timed_balances.lender2[i] - timed_balances.lender2[i-1];
            // console.log('lender2', timed_balances.lender2[i], timed_balances.lender2[i-1], diff);
            diffs2.push(diff);
            if(i > 1) { 
                expect(diffs2[i-1]).to.be.closeTo(diffs2[i-2], 1);
            }
        }

        for(let i = 1; i < timed_balances.time.length; i++) {
            const diff = timed_balances.stabilityPool[i] - timed_balances.stabilityPool[i-1];
            // console.log('stabilityPool', timed_balances.stabilityPool[i], timed_balances.stabilityPool[i-1], diff);
            diffsStabilityPool.push(diff);
            if(i > 1) {
                expect(diffsStabilityPool[i-1]).to.be.closeTo(diffsStabilityPool[i-2], 2);
            }
        }
    });
    it('should ensure borrower increase exponentially as expected', async function () {
        // Verify that each year, the interest is exponentially increasing
        const diffs1borrower = [];
        for(let i = 1; i < timed_balances.time.length; i++) {
            const diff = timed_balances.borrower1[i] - timed_balances.borrower1[i-1];
            diffs1borrower.push(diff);
            if(i > 1) {
                expect(diffs1borrower[i-1]).to.be.gt(diffs1borrower[i-2]);
            }
        }
        // console.log('--------------------------------');
        const diffs2borrower = [];
        for(let i = 1; i < timed_balances.time.length; i++) {
            const diff = timed_balances.borrower2[i] - timed_balances.borrower2[i-1];
            // console.log('borrower2', timed_balances.borrower2[i], timed_balances.borrower2[i-1], diff);
            diffs2borrower.push(diff);
            if(i > 1) {
                expect(diffs2borrower[i-1]).to.be.gt(diffs2borrower[i-2]);
            }
        }
    });
    it('should ensure debt pays lender', async function () {
        const rawSupplyRToken = await rToken.rawTotalSupply();
        const rawSupplyDebtToken = await debtToken.rawTotalSupply();
        // Verify that each year, the debt pays the lender
        for(let i = 1; i < timed_balances.time.length; i++) {
            const diffDebt1 = timed_balances.borrower1[i] - timed_balances.borrower1[i-1];
            const diffDebt2 = timed_balances.borrower2[i] - timed_balances.borrower2[i-1];

            const diffLender1 = timed_balances.lender1[i] - timed_balances.lender1[i-1];
            const diffLender2 = timed_balances.lender2[i] - timed_balances.lender2[i-1];
            
            const diffStabilityPool = timed_balances.stabilityPool[i] - timed_balances.stabilityPool[i-1];

            const totalLenders = diffLender1 + diffLender2 + diffStabilityPool;
            const totalDebts = diffDebt1 + diffDebt2;
            
            // TODO: calculate the interest rate applies as expected

            // console.log('diffDebts', diffDebt1 + diffDebt2);
            // console.log('diffLenders', diffLender1 + diffLender2 + diffStabilityPool);
            // console.log('diff', diffDebt1 + diffDebt2 > diffLender1 + diffLender2 + diffStabilityPool);
            expect(totalDebts).to.be.gt(totalLenders);
        }
    });
  });
});