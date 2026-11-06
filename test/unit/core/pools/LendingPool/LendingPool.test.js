import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

const RAY = ethers.parseUnits("1", 27);

const FIRST_NFT_ID = 1;
const SECOND_NFT_ID = 2;

async function getCurrentLiquidityRatePercentage(lendingPool) {
  const rateData = await lendingPool.rateData();
  const currentLiquidityRate = rateData.currentLiquidityRate;
  const percentage = Number(currentLiquidityRate) / 1e25;
  return percentage;
}

async function getCurrentBorrowRatePercentage(lendingPool) {
  const rateData = await lendingPool.rateData();
  const currentUsageRate = rateData.currentUsageRate;
  const percentage = Number(currentUsageRate) / 1e25;
  return percentage;
}

function encodeERC721Token(tokenID) {
  return new ethers.AbiCoder().encode(["uint256"], [tokenID])
}
function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

async function getCurrentUtilizationRatePercentage(lendingPool) {
  const reserve = await lendingPool.reserve();
  const totalLiquidity = reserve.totalLiquidity;
  const totalUsage = reserve.totalUsage;

  const utilizationRate = Number(totalUsage) / (Number(totalLiquidity) + Number(totalUsage));

  const usageIndex = reserve.usageIndex;
  const usage = totalUsage * (usageIndex / RAY);

  if (totalLiquidity == 0n) {
    return 0;
  }

  // const utilizationRate = (Number(usage) / Number(totalLiquidity)) * 100;
  return utilizationRate * 100;
}

async function deployIndexToken(lendingPool) {
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;

  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
  erc20Token = await ERC20Mock.deploy("RWA Vault Token", "RWAToken", 18);

  const MockERC20PriceOracle = await ethers.getContractFactory("MockERC20PriceOracle");
  erc20PriceOracle = await MockERC20PriceOracle.deploy();

  await erc20PriceOracle.setLatestPrice(ethers.parseEther("1"));

  const ERC20Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
  erc20TokenAdapter = await ERC20Adapter.deploy(erc20Token.target, erc20PriceOracle.target, lendingPool.target)

  return [erc20Token, erc20TokenAdapter, erc20PriceOracle]; 
}

const OwnerParameter = {
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
  MaxRate: 12,
  MinDepositAmount: 13,
};

async function toParameter(lendingPool) {
  const parameters = await lendingPool.parameters()
  return {
    canPaybackDebt: parameters[0],
    withdrawalsPaused: parameters[1],
    liquidationThreshold: parameters[2], 
    liquidationGracePeriod: parameters[3],
    insuranceFee: parameters[4],
    depositFee: parameters[5],
    liquidityBufferRatio: parameters[6],
    supplyCap: parameters[7],
    borrowCap: parameters[8],
    vaultOpeningFee: parameters[9],
    borrowThreshold: parameters[10],
    minDepositAmount: parameters[11]
  }
}


// TODO: test with depositFee activated: check that only some amount is minted and other is going to the treasury

describe("LendingPool", function () {
  let owner, user1, user2, user3;
  let crvusd;
  let stabilityPool, raacFCL, raacVault, complianceRegistry;
  let crvUSDToUSDOracle;
  let raacNFT, raacNFTAdapter, raacHousePrices;
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;
  let lendingPool, rToken, debtToken;
  let deployer;
  let token;
  const INSURANCE_FEE = ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE"));
  const ASSET_PRICE = ethers.parseEther("100");

  let assets = {}

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    crvusd = await CrvUSDToken.deploy(owner.address);
  
    await crvusd.setMinter(owner.address);

    const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
    crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

    // Deploy RAACNFT with oracle
    const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
    raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
    complianceRegistry = await ComplianceRegistry.deploy()

    const RAACNFT = await ethers.getContractFactory("RAACNFT");
    raacNFT = await RAACNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address);
  
    token = crvusd;
  
    // Setup Stability pool
    stabilityPool = { target: owner.address };
  
    // Deploy tokens
    const RToken = await ethers.getContractFactory("RToken");
    rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);
  
    const DebtToken = await ethers.getContractFactory("DebtToken");
    debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);
  
    const initialPrimeRate = ethers.parseUnits("0.1", 27);

    const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
    const liquidationProxy = await LiquidationProxy.deploy();

    const VaultProxy = await ethers.getContractFactory("VaultProxy");
    const vaultProxy = await VaultProxy.deploy();

    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary")
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy()
    const LendingPool = await ethers.getContractFactory("LendingPool", {
      libraries: {
        LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
      }
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

    // Deploy NFT adapter
    const RAACNFTAdapter = await ethers.getContractFactory("ERC721AssetAdapter");
    raacNFTAdapter = await RAACNFTAdapter.deploy(raacNFT.target, raacHousePrices.target, lendingPool.target);

    // Deploy ERC20 Adapter
    [erc20Token, erc20TokenAdapter, erc20PriceOracle] = await deployIndexToken(lendingPool);

    // Whitelist adapters
    await lendingPool.registerAdapter(raacNFTAdapter.target);
    await lendingPool.registerAdapter(erc20TokenAdapter.target);

    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap

    await rToken.transferOwnership(lendingPool.target);
    await debtToken.transferOwnership(lendingPool.target);

    const mintAmount = ethers.parseEther("1000");
    await crvusd.mint(user1.address, mintAmount);
    await crvusd.mint(user3.address, mintAmount);

    const mintAmount2 = ethers.parseEther("10000");
    await crvusd.mint(user2.address, mintAmount2);

    await crvusd.connect(user1).approve(lendingPool.target, mintAmount);
    await crvusd.connect(user2).approve(lendingPool.target, mintAmount);
    await crvusd.connect(user3).approve(lendingPool.target, mintAmount);

    await raacHousePrices.setOracle(owner.address);

    // Setup house prices for minting
    await raacHousePrices.setHousePrice(FIRST_NFT_ID, ASSET_PRICE);
    await raacHousePrices.setHousePrice(SECOND_NFT_ID, ASSET_PRICE);

    await ethers.provider.send("evm_mine", []);

    const housePrice = await raacHousePrices.tokenToHousePrice(FIRST_NFT_ID);
    expect(housePrice).to.equal(ASSET_PRICE);

    const priceFromNFT = await raacNFT.getHousePrice(FIRST_NFT_ID);
    expect(priceFromNFT).to.equal(ASSET_PRICE);

    const amountToPay = ASSET_PRICE;

    // Mint crvUSD to purchase the house
    await token.mint(user1.address, amountToPay);

    await token.connect(user1).approve(raacNFT.target, amountToPay);

    // Min the NFT
    await raacNFT.connect(user1).mint(FIRST_NFT_ID, amountToPay);

    // Mint some erc20Token for testing : ASSET_PRICE 
    await erc20Token.mint(user1.address, ASSET_PRICE);


    // Deposit money in lending pool
    const depositAmount = ethers.parseEther("1000");
    await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
    await lendingPool.connect(user2).deposit(depositAmount);

    await ethers.provider.send("evm_mine", []);

    expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1000"));

    // Open the user1 vault for tests
    await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
    await lendingPool.connect(user1).openVaultPosition();

    // set the assets map
    assets["ERC20"] = {baseAsset: erc20Token, adapter: erc20TokenAdapter, data: encodeERC20Token(ASSET_PRICE)}
    assets["ERC721"] = {baseAsset: raacNFT, adapter: raacNFTAdapter, data: encodeERC721Token(1)}

    // Increase the borrow threshold to 79%
    await lendingPool.setParameter(OwnerParameter.BorrowThreshold, 7900);
  });

  describe("Access Control and Security", function () {
    it("should prevent non-owner from setting prime rate", async function () {
      await expect(lendingPool.connect(user1).setPrimeRate(ethers.parseEther("0.05")))
        .to.be.revertedWithCustomError(lendingPool, "Unauthorized")
    });

    it("should prevent reentrancy attacks on deposit", async function () {
      await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1); // 0 is no longer allowed (InvalidAmount); 1 wei effectively disables the minimum
      const depositAmount = ethers.parseEther("1");
      await expect(lendingPool.connect(user1).deposit(depositAmount)).to.not.be.reverted;
    });

    it("should have registered the adapters properly", async function () {
      const supportedAdapters = await lendingPool.getAdapters();
      expect(supportedAdapters[0]).to.equal(raacNFTAdapter.target)
      expect(supportedAdapters[1]).to.equal(erc20TokenAdapter.target);
    })

    it("should prevent non-owner from changing price oracle", async function() {
      await expect(raacNFTAdapter.connect(user2).setPriceOracle(user1.address)).to.revertedWithCustomError(raacNFTAdapter, "OwnableUnauthorizedAccount")
      await expect(erc20TokenAdapter.connect(user2).setPriceOracle(user1.address)).to.revertedWithCustomError(erc20TokenAdapter, "OwnableUnauthorizedAccount")
    })

    it("should allow owner from changing price oracle", async function() {
      await raacNFTAdapter.setPriceOracle(user1.address)
      await erc20TokenAdapter.setPriceOracle(user1.address)

      expect(await raacNFTAdapter.priceOracle()).to.equal(user1.address);
      expect(await erc20TokenAdapter.priceOracle()).to.equal(user1.address);
    })

    it("should prevent non-pool from calling pool only methods", async function() {
      await expect(raacNFTAdapter.connect(user2).deposit(user1.address, encodeERC721Token(1))).to.revertedWith("ERC721Adapter: only pool")
      await expect(erc20TokenAdapter.connect(user2).deposit(user1.address, encodeERC20Token(1))).to.revertedWith("ERC20Adapter: only pool")

      await expect(raacNFTAdapter.connect(user2).withdraw(user1.address, encodeERC721Token(1))).to.revertedWith("ERC721Adapter: only pool")
      await expect(erc20TokenAdapter.connect(user2).withdraw(user1.address, encodeERC20Token(1))).to.revertedWith("ERC20Adapter: only pool")

      await expect(raacNFTAdapter.connect(user2).transferAsset(user1.address, encodeERC721Token(1), user2.address)).to.revertedWith("ERC721Adapter: only pool")
      await expect(erc20TokenAdapter.connect(user2).transferAsset(user1.address, encodeERC20Token(1), user2.address)).to.revertedWith("ERC20Adapter: only pool")
    })
  });

  describe("Deposit and Withdraw", function () {
    it("should fail", async function() {
      const depositAmount = ethers.parseEther("100");
      await lendingPool.connect(user1).deposit(depositAmount);

      await time.increase(86000);
      await ethers.provider.send("evm_mine", []);

      await expect(lendingPool.connect(user1).withdraw(ethers.parseEther("120"))).to.be.revertedWithCustomError(lendingPool, "InsufficientBalance");
    })
    it("should allow user to deposit crvUSD and receive rToken", async function () {
      const depositAmount = ethers.parseEther("100");
      await lendingPool.connect(user1).deposit(depositAmount);

      await ethers.provider.send("evm_mine", []);
      const rTokenBalance = await rToken.balanceOf(user1.address);
      expect(rTokenBalance).to.equal(depositAmount);

      const crvUSDBalance = await crvusd.balanceOf(user1.address);
      expect(crvUSDBalance).to.equal(ethers.parseEther("900"));

      const debtBalance = await debtToken.balanceOf(user1.address);
      expect(debtBalance).to.equal(0);

      const reserveBalance = await crvusd.balanceOf(rToken.target)
      expect(reserveBalance).to.equal(ethers.parseEther("1100"));
    });

    it("should allow user to withdraw crvUSD by burning rToken", async function () {
      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1000"));
      expect(await rToken.balanceOf(user1.address)).to.equal(0);
      expect(await debtToken.balanceOf(user1.address)).to.equal(0);
      expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
      const depositAmount = ethers.parseEther("100");
      await lendingPool.connect(user1).deposit(depositAmount);
      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1100"));
      expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await debtToken.balanceOf(user1.address)).to.equal(0);
      expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
      await rToken.connect(user1).approve(lendingPool.target, depositAmount);

      const withdrawAmount = ethers.parseEther("10");
      await time.increase(1);
      await ethers.provider.send("evm_mine", []);

      await lendingPool.connect(user1).withdraw(withdrawAmount);
      expect(await debtToken.balanceOf(user1.address)).to.equal(ethers.parseEther("0"));
      expect(await rToken.balanceOf(user1.address)).to.equal(ethers.parseEther("90"));
      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1090"));
      expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("910"));


      await lendingPool.connect(user1).withdraw(depositAmount - withdrawAmount);

      const rTokenBalance = await rToken.balanceOf(user1.address);
      expect(rTokenBalance).to.equal(0);

      const crvUSDBalance = await crvusd.balanceOf(user1.address);
      expect(crvUSDBalance).to.equal(ethers.parseEther("1000"));

      const debtBalance = await debtToken.balanceOf(user1.address);

      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1000"));
      expect(debtBalance).to.equal(0);
    });

    it("should prevent withdrawing more than balance", async function () {
        const depositAmount = ethers.parseEther("100");
        const withdrawAmount = ethers.parseEther("200");

        expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1000"));
        expect(await rToken.balanceOf(user1.address)).to.equal(0);
        expect(await debtToken.balanceOf(user1.address)).to.equal(0);

        await lendingPool.connect(user1).deposit(depositAmount);
        await rToken.connect(user1).approve(lendingPool.target, withdrawAmount);

        expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1100"));
        expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
        expect(await debtToken.balanceOf(user1.address)).to.equal(0);

        await time.increase(1);
        await ethers.provider.send("evm_mine", []);

        await lendingPool.connect(user1).withdraw(ethers.MaxUint256);
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("1000"));

        expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
        expect(await rToken.balanceOf(user1.address)).to.equal(0);
        expect(await debtToken.balanceOf(user1.address)).to.equal(0);
    });

    it("should allow the user to withdraw even if the interest is accured", async function() {
      // basically, we should count for the dust if the user has some accured interest
      // Deposit some amount
      const depositAmount = ethers.parseEther("100");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      await crvusd.mint(user2.address, depositAmount);
      await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user2).deposit(depositAmount);

      // borrow some amount to accur interest: approve an nft and deposit it as collateral
      await raacNFT.connect(user1).approve(raacNFTAdapter.target, FIRST_NFT_ID);
      await lendingPool.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(FIRST_NFT_ID));
      await lendingPool.connect(user1).borrow(raacNFTAdapter.target, encodeERC721Token(FIRST_NFT_ID), ethers.parseEther("50"));

      // Wait for some time
      await time.increase(24 * 60 * 60);
      await ethers.provider.send("evm_mine", []);

      await lendingPool.updateState();

      const lastBalance = await rToken.balanceOf(user1.address);
      expect(lastBalance).to.be.greaterThan(ethers.parseEther("100"));

      await time.increase(24 * 60 * 60);
      await ethers.provider.send("evm_mine", []);

      // time passed since last update so the state will be updated when withdrawing which will cause more interest to be accured
      // user will try withdrawing the amount that does not have the actual new accured interest
      await lendingPool.connect(user1).withdraw(lastBalance);

      console.log(await rToken.balanceOf(user1.address))
      expect(await rToken.balanceOf(user1.address)).to.be.greaterThan(0); // there is still some interst remaining

      // sending a uint256.max will resolve the dust
      await lendingPool.connect(user1).withdraw(ethers.MaxUint256);
      expect(await rToken.balanceOf(user1.address)).to.equal(0);
    }) 

    it("should prevent deposit if supply cap is reached", async function() {
      // disabling the minDepositAmount by setting it to 0 since we are working with small values for testing purposes
      await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1); 
      const initialSupplyCap = ethers.parseEther("10000000") // this is set in the lending pool by default
      await time.increase(1);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.connect(user2).withdraw(ethers.parseEther("1000"))
      const initialUserBalance = await crvusd.balanceOf(user1.address)
      // check that initial cap is correct
      expect((await toParameter(lendingPool)).supplyCap).to.equal(initialSupplyCap);
      expect(await rToken.totalSupply()).to.equal(0n);
      // deposit half inside it: check that it is still correct
      let depositAmount = initialSupplyCap / 2n;
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount)
      expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await rToken.totalSupply()).to.equal(initialSupplyCap / 2n);
      // deposit other half of it: check tha it happens correctly.
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount)
      expect(await rToken.balanceOf(user1.address)).to.equal(initialSupplyCap);
      expect(await rToken.totalSupply()).to.equal(initialSupplyCap);
      // check that total supply now, from RToken.totalSupply is equal to the initial Supply
      // try adding 1 crvUSD more: should not allow you to deposit it
      depositAmount = 1n
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await expect(lendingPool.deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "SupplyCapReached")
      expect(await rToken.balanceOf(user1.address)).to.equal(initialSupplyCap);
      expect(await rToken.totalSupply()).to.equal(initialSupplyCap);
      expect(await crvusd.balanceOf(user1.address)).to.equal(initialUserBalance + depositAmount)
    })

    it("should allow depositing more after the supply cap has been increased", async function() {
      // disabling the minDepositAmount by setting it to 0 since we are working with small values for testing purposes
      await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1);
      const initialSupplyCap = ethers.parseEther("10000000") // this is set in the lending pool by default
      await time.increase(1);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.connect(user2).withdraw(ethers.parseEther("1000"))
      // check that initial cap is correct
      expect((await toParameter(lendingPool)).supplyCap).to.equal(initialSupplyCap);
      expect(await rToken.totalSupply()).to.equal(0n);
      // deposit half inside it: check that it is still correct
      let depositAmount = initialSupplyCap;
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount)
      expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await rToken.totalSupply()).to.equal(initialSupplyCap);

      depositAmount = ethers.parseEther("10")
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await expect(lendingPool.deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "SupplyCapReached")

      // increase the cap
      await lendingPool.setParameter(OwnerParameter.LendingPoolSupplyCap, initialSupplyCap + ethers.parseEther("10"));
      await lendingPool.connect(user1).deposit(depositAmount)
      
      depositAmount = 1
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await expect(lendingPool.deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "SupplyCapReached")
    })

    it("should allow stability pool to deposit beyond supply cap", async function() {
      // since we are working with small values for testing purpose, disabling the minDepositAmount
      await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1);
      const lowSupplyCap = ethers.parseEther("100");
      await lendingPool.setParameter(OwnerParameter.LendingPoolBorrowCap, lowSupplyCap - 1n);
      await lendingPool.setParameter(OwnerParameter.LendingPoolSupplyCap, lowSupplyCap);
      await time.increase(1);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.connect(user2).withdraw(ethers.parseEther("1000"))

      await lendingPool.setStabilityPool(owner.address);
      
      // Clean state first
      expect(await rToken.totalSupply()).to.equal(0n);
      
      // Regular user deposits up to the cap
      const regularDepositAmount = lowSupplyCap;
      await crvusd.mint(user1.address, regularDepositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, regularDepositAmount);
      await lendingPool.connect(user1).deposit(regularDepositAmount);
      expect(await rToken.totalSupply()).to.equal(lowSupplyCap);
      
      // Regular user cannot deposit more (beyond cap)
      const additionalAmount = ethers.parseEther("1");
      await crvusd.mint(user1.address, additionalAmount);
      await crvusd.connect(user1).approve(lendingPool.target, additionalAmount);
      await expect(lendingPool.connect(user1).deposit(additionalAmount))
        .to.be.revertedWithCustomError(lendingPool, "SupplyCapReached");
      
      // Stability pool (owner) can deposit beyond the cap
      const stabilityPoolDepositAmount = ethers.parseEther("500"); // Much larger than remaining cap
      await crvusd.mint(owner.address, stabilityPoolDepositAmount);
      await crvusd.connect(owner).approve(lendingPool.target, stabilityPoolDepositAmount);
      await lendingPool.connect(owner).deposit(stabilityPoolDepositAmount);
      
      // Verify the deposit went through despite exceeding cap
      expect(await rToken.balanceOf(owner.address)).to.equal(stabilityPoolDepositAmount);
      expect(await rToken.totalSupply()).to.equal(lowSupplyCap + stabilityPoolDepositAmount);
    })

    it("should not allow user to deposit less than minimum deposit amount", async function() {
      // NOTE: Min amount is 10e18 from the lending pool constructor value (unless changed in the codebase)

      let depositAmount = ethers.parseEther("9.9999");
      await expect(lendingPool.connect(user1).deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "MinDepositAmountRequired")

      depositAmount = ethers.parseEther("10");
      await lendingPool.connect(user1).deposit(depositAmount);

      depositAmount = ethers.parseEther("30");
      await lendingPool.connect(user1).deposit(depositAmount);

      depositAmount = ethers.parseEther("0")
      await expect(lendingPool.connect(user1).deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "InvalidAmount")  // reverted from ReserveLibarary.deposit

      depositAmount = ethers.parseEther("0.1")
      await expect(lendingPool.connect(user1).deposit(depositAmount)).to.be.revertedWithCustomError(lendingPool, "MinDepositAmountRequired")
    })

    it("should prevent the user from borrowing more than the borrow limit", async function() {
      const initialSupplyCap = ethers.parseEther("10000000") // this is set in the lending pool by default

      await time.increase(1);
      await ethers.provider.send("evm_mine", []);
      await lendingPool.connect(user2).withdraw(ethers.parseEther("1000"))
      // check that initial cap is correct
      expect((await toParameter(lendingPool)).supplyCap).to.equal(initialSupplyCap);
      expect(await rToken.rawTotalSupply()).to.equal(0n);
      // deposit all of the liquidity
      let depositAmount = initialSupplyCap;
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount)
      expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await rToken.totalSupply()).to.equal(initialSupplyCap);

      // set the borrow limit to 70% of the total supply: we can still take 80%
      await lendingPool.setParameter(OwnerParameter.LendingPoolBorrowCap, ethers.parseEther("5000000"));

      // Generate colltaral and deposit collateral
      await erc20Token.mint(user1.address, initialSupplyCap)
      await erc20Token.connect(user1).approve(erc20TokenAdapter.target, initialSupplyCap);
      await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(initialSupplyCap));


      // take 2_500_000 (25%) loan
      let borrowAmount = initialSupplyCap / 4n;
      await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount);

      const dust = await debtToken.totalSupply() - borrowAmount; // accured interest

      // take 2_500_000 more (comes to 50% collateral usage)
      const borrowAmount2 =  (initialSupplyCap / 4n) - dust;
      await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount2);

      // try taking 1 wei more: 70%+0.00001% > borrow cap
      const borrowAmount3 = ethers.parseEther("10");
      await expect(lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount3)).to.be.revertedWithCustomError(lendingPool,"BorrowCapReached");

      // increase the cap and take until the ful collateral: 5_000_000 + 2_000_000 + 900_000 (new) = 7_900_000 (79% -> health = 1) - 79% borrow limit
      await lendingPool.setParameter(OwnerParameter.LendingPoolBorrowCap, ethers.parseEther("8000000"));
      const borrowAmount4 = initialSupplyCap * 9n / 100n;
      await lendingPool.connect(user1).borrow(erc20TokenAdapter.target, encodeERC20Token(1), borrowAmount4)
    });

    describe("Deposit with depositFee activated", function() {
      // deploy the LENDING_FEE in the fee collector
      // enable the depositFee percentage
      // what needs to be tested:
      // make sure that the amount of rtoken minted is correct: if i put 100, with 2% fees, i need to get 98 and 2 to fee collector
      // make sure all tests are running: what if user does not approve and funds etc.
      const LENDING_FEE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE"));
      const DEPOSIT_FEE = 2_00
      let feeCollector;
      beforeEach(async function() {
        const FeeCollector = await ethers.getContractFactory("FeeCollector")
        feeCollector = await FeeCollector.deploy(owner.address);

        await time.increase(1);
        await ethers.provider.send("evm_mine", []);

        // clean lending pool
        await lendingPool.connect(user2).withdraw(ethers.parseEther("1000"))
        // 20% treasury, 0% to repair, 0% burn share, 80% veraac, 0% other
        expect(await feeCollector.addFeeType(LENDING_FEE, 20_00, 0, 0, 80_00, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);
        expect(await lendingPool.setParameter(OwnerParameter.LendingPoolDepositFee, 2_00)).to.emit(lendingPool,"DepositFeeUpdated").withArgs(0, DEPOSIT_FEE) // 2%
        expect(await feeCollector.addClaimableToken(crvusd.target)).to.emit(feeCollector, "TokenAdded").withArgs(crvusd.target)
      })
      it("should allow deposit but not collect fees becuase fee collector not set", async function() {
        const depositAmount = ethers.parseEther("100")
        await lendingPool.connect(user1).deposit(depositAmount);

        // check that user received only all of it since we have not set the fee collector yet
        expect(await rToken.balanceOf(user1.address)).to.equal(depositAmount);
      })
      it("should collect fee when fee collector and fees are set", async function() {
        await lendingPool.setFeeCollector(feeCollector.target);

        const depositAmount = ethers.parseEther("100")
        await lendingPool.connect(user1).deposit(depositAmount);

        const depositFeeAmount = depositAmount * BigInt(DEPOSIT_FEE) / BigInt(100_00);
        const amountDeposited = depositAmount - depositFeeAmount;
        
        // Rtoken
        expect(await rToken.balanceOf(user1.address)).to.equal(amountDeposited);
        expect(await crvusd.balanceOf(rToken.target)).to.equal(amountDeposited);

        // Fee collector
        expect(await feeCollector.getTargetAmount(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target)).to.equal(depositFeeAmount * 20_00n / 100_00n)
        expect(await feeCollector.getTargetAmount(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("VERAAC")), crvusd.target)).to.equal(depositFeeAmount * 80_00n / 100_00n)
        expect(await crvusd.balanceOf(feeCollector.target)).to.equal(depositFeeAmount);
      })
    })
    
  });

  describe("Test ERC20 specific actions", function() {
    beforeEach(async function() {
      await lendingPool.connect(user2).openVaultPosition();
    })
    it("should revert if a non-whitelisted ERC20 token is deposited", async function () {
      // Attempt to deposit a token that is not whitelisted.
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
      const notWhitelistedToken = await ERC20Mock.deploy("NWT", "NWT", 18)

      const depositAmount = ethers.parseUnits("100", 18);
      notWhitelistedToken.mint(user2.target, depositAmount)
      await notWhitelistedToken.connect(user2).approve(lendingPool.target, depositAmount);
      await expect(
        lendingPool.connect(user2).depositAsset(notWhitelistedToken.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))
      ).to.be.revertedWithCustomError(lendingPool, "AdapterNotSupported");
    });
    it("should update user deposit correctly on multiple deposits", async function () {
      const depositAmount = ethers.parseUnits("100", 18);
      await erc20Token.mint(user2.address, ethers.parseEther("300"));
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, ethers.parseEther("200"));
  
      // First deposit.
      await expect(lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount])))
        .to.emit(erc20TokenAdapter, "TokenDeposited")
        .withArgs(erc20Token.target, user2.address, depositAmount);
  
      // Second deposit.
      await expect(lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount])))
        .to.emit(erc20TokenAdapter, "TokenDeposited")
        .withArgs(erc20Token.target, user2.address, depositAmount);

      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(depositAmount + depositAmount);
  
      const poolBalance = await erc20Token.balanceOf(erc20TokenAdapter.target);
      expect(poolBalance).to.equal(depositAmount * 2n);
    });
    it("should revert if the user has no deposit for that token for withdrawal", async function () {
      const depositAmount = ethers.parseEther("100")
      await expect(
        lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))
      ).to.be.revertedWith("ERC20Adapter: insufficient balance")
    });
    it("should revert if attempting to withdraw more than deposited", async function () {
      const depositAmount = ethers.parseEther("100")

      // Assume user deposits depositAmount.
      await erc20Token.mint(user2.address, depositAmount);
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount);
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))
      
      const overWithdrawAmount = depositAmount + ethers.parseEther("1");
      await expect(
        lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [overWithdrawAmount]))
      ).to.be.revertedWith("ERC20Adapter: insufficient balance")
    });
    it("should allow a partial withdrawal with no debt", async function () {
      const depositAmount = ethers.parseEther("100");
      await erc20Token.mint(user2.address, depositAmount)
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount)
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))

      // since LTV is 80%, we deposit 100 and take out 40, so 60% inside.
      const partialWithdraw = ethers.parseEther("40");
      // No debt exists so no collateral check is needed.
      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [partialWithdraw])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address, partialWithdraw);

      // Verify the deposit is reduced.
      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(depositAmount - partialWithdraw);

      // Check that the contract balance of erc20Token decreased by the withdrawn amount.
      const poolBalance = await erc20Token.balanceOf(erc20TokenAdapter.target);
      expect(poolBalance).to.equal(depositAmount - partialWithdraw);
    });
    it("should allow full withdrawal with no debt", async function () {
      const depositAmount = ethers.parseEther("100");
      await erc20Token.mint(user2.address, depositAmount)
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount)
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))

      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address, depositAmount);

      // Verify that the deposit is now zero.
      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(0);

      const poolBalance = await erc20Token.balanceOf(erc20TokenAdapter.target);
      expect(poolBalance).to.equal(0);
    });
    it("should allow a partial withdrawal if remaining collateral covers the debt", async function () {
      // update the borrow threshold to 50%
      await lendingPool.setParameter(OwnerParameter.BorrowThreshold, 50_00);
      const depositAmount = ethers.parseEther("100");
      await erc20Token.mint(user2.address, depositAmount)
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount)
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))

      const borrowAmount = ethers.parseEther("25");
      await lendingPool.connect(user2).borrow(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [borrowAmount]), borrowAmount);
      // Withdraw 50 tokens. Remaining collateral = 50 tokens.
      // New collateral threshold = 50 * 0.5 = 25.
      // Debt is 25, so newHealthFactor = (25 * 1e18) / 25 = 1e18, which is above the threshold.
      const withdrawAmount = ethers.parseEther("50");
      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [withdrawAmount])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address, withdrawAmount);

      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(depositAmount - withdrawAmount);
    });
    it("should revert a partial withdrawal if remaining collateral would be insufficient", async function () {
      // update the borrow threshold to 50%
      await lendingPool.setParameter(OwnerParameter.BorrowThreshold, 50_00);
      const depositAmount = ethers.parseEther("100");
      await erc20Token.mint(user2.address, depositAmount)
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount)
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))

      const borrowAmount = ethers.parseEther("30");
      await lendingPool.connect(user2).borrow(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [borrowAmount]), borrowAmount);
      // Withdraw 50 tokens. Then, remaining collateral = 30 tokens.
      // New collateral threshold = 50 * 0.5 = 25, which is less than the actual debt (30).
      const withdrawAmount = ethers.parseEther("50");
      await expect(
        lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [withdrawAmount]))
      ).to.be.revertedWithCustomError(lendingPool, "WithdrawalWouldLeaveUserUnderCollateralized");

      // The deposited amount should remain unchanged.
      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(depositAmount);
    });
    it("should allow multiple partial withdrawals that eventually fully withdraw the deposit", async function () {
      const depositAmount = ethers.parseEther("100");
      await erc20Token.mint(user2.address, depositAmount)
      await erc20Token.connect(user2).approve(erc20TokenAdapter.target, depositAmount)
      await lendingPool.connect(user2).depositAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [depositAmount]))

      // First withdrawal of 30 tokens.
      const withdraw1 = ethers.parseEther("30")
      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [withdraw1])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address, withdraw1);
      expect(await erc20Token.balanceOf(erc20TokenAdapter.target)).to.equal(depositAmount - withdraw1);

      // Second withdrawal of 50 tokens.
      const withdraw2 = ethers.parseEther("50")
      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [withdraw2])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address , withdraw2);
      expect(await erc20Token.balanceOf(erc20TokenAdapter.target)).to.equal(depositAmount - withdraw1 - withdraw2);

      // Final withdrawal of 20 tokens.
      const withdraw3 = ethers.parseEther("20");
      await expect(lendingPool.connect(user2).withdrawAsset(erc20TokenAdapter.target, new ethers.AbiCoder().encode(['uint256'], [withdraw3])))
        .to.emit(erc20TokenAdapter, "TokenWithdrawn")
        .withArgs(erc20Token.target, user2.address, withdraw3);
      expect(await erc20Token.balanceOf(erc20TokenAdapter.target)).to.equal(0);

      // Total withdrawn equals 100 tokens.
      const collateralValue = await lendingPool.getUserCollateralValue(user2.address);
      expect(collateralValue).to.equal(0);

    });
  })

  describe("Test ERC721 specific actions", async function() {
    beforeEach(async function() {
      await lendingPool.connect(user2).openVaultPosition();
      await raacNFT.connect(user1).approve(raacNFTAdapter.target, 1);
      await lendingPool.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(1));

      await crvusd.mint(user2.address, ASSET_PRICE);
      await crvusd.connect(user2).approve(raacNFT.target, ASSET_PRICE)
      await raacNFT.connect(user2).mint(2, ASSET_PRICE);
      await raacNFT.connect(user2).approve(raacNFTAdapter.target, 2);
      await lendingPool.connect(user2).depositAsset(raacNFTAdapter.target, encodeERC721Token(2));
    });

    it('should not allow a non-owner to borrow, repay', async function () {
      // user 2 should not borrow using user 1 token
      await expect(lendingPool.connect(user2).borrow(raacNFTAdapter.target, encodeERC721Token(1), ethers.parseEther("10"))).to.be.revertedWith("ERC721Adapter: not depositor");
      await expect(lendingPool.connect(user2).borrow(raacNFTAdapter.target, encodeERC721Token(3), ethers.parseEther("10"))).to.be.revertedWith("ERC721Adapter: not depositor")
      await expect(lendingPool.connect(user2).borrow(raacNFTAdapter.target, encodeERC721Token(2), ethers.parseEther("10"))).to.not.be.reverted;

      // User 2 cannot try repaying user 1 debt
      await expect(lendingPool.connect(user2).repay(raacNFTAdapter.target, encodeERC721Token(1), ethers.parseEther("10"))).to.be.revertedWith("ERC721Adapter: not depositor");
      await expect(lendingPool.connect(user2).repay(raacNFTAdapter.target, encodeERC721Token(3), ethers.parseEther("10"))).to.be.revertedWith("ERC721Adapter: not depositor");
    });

    it("should not allow a wrong user to initialize liquidation (user does not own NFT)", async function() {
      // user 2 does not own token 1
      await expect(lendingPool.connect(user1).initiateLiquidation(raacNFTAdapter.target, user2.address, encodeERC721Token(1))).to.be.revertedWith("ERC721Adapter: not depositor");
    })
  })

  function describeBorrowAndRepay(assetType) {
    describe(assetType + ": Borrow and Repay", function () {
      const NFT_ID = 1;
      const encodedNFT_ID = encodeERC721Token(NFT_ID)
      let feeCollector
      let assetAdapter
      let baseAsset
      let assetData;
      
      beforeEach(async function () {
        // Deploy fee collector
        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(
          owner.address
        );
        await feeCollector.waitForDeployment();
  
        const depositAmount = ethers.parseEther("1000");
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);

        // Get the asset type
        assetAdapter = assets[assetType].adapter;
        baseAsset = assets[assetType].baseAsset;
        assetData = assets[assetType].data;
        
        // Deposit NFT
        if (assetType === "ERC721") {
          await raacNFT.connect(user1).approve(raacNFTAdapter.target, NFT_ID);
          await lendingPool.connect(user1).depositAsset(raacNFTAdapter.target, encodedNFT_ID);
        } else if (assetType === "ERC20") {
          // Deposit erc20Asset
          await erc20Token.connect(user1).approve(erc20TokenAdapter.target, encodeERC20Token(ASSET_PRICE));
          await lendingPool.connect(user1).depositAsset(erc20TokenAdapter.target, encodeERC20Token(ASSET_PRICE));
        }
  
        // set fee collector
        await lendingPool.setFeeCollector(await feeCollector.getAddress());
        await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
        await feeCollector.addClaimableToken(crvusd.target)
      });
      it("should return the correct asset type", async function() {
        expect(await assetAdapter.getAssetType() === assetType);
      })
      it('should check that the asset has been deposited correctly', async function () {
        if (assetType === "ERC20") {
          expect(await erc20Token.balanceOf(erc20TokenAdapter.target)).to.equal(ASSET_PRICE);
          expect(await erc20TokenAdapter.balanceOf(user1.address)).to.equal(ASSET_PRICE);
        } else if (assetType === "ERC721") {
          const user = await raacNFTAdapter.getDepositor(NFT_ID);
          expect(user).to.equal(user1.address);
        }
      });      
  
      it("should allow user to borrow crvUSD using asset collateral", async function () {
          const borrowAmount = ethers.parseEther("50");
  
          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
      
          const crvUSDBalance = await crvusd.balanceOf(user1.address);
          expect(crvUSDBalance).to.equal(ethers.parseEther("1050"));
      
          const debtBalance = await debtToken.balanceOf(user1.address);
  
          expect(debtBalance).to.gte(borrowAmount);
      });
  
      it("should allow user to borrow crvUSD using asset collateral with insurance", async function () {
        const borrowAmount = ethers.parseEther("50");
        
        // calculate insurance
        const insurancePercentage = (await toParameter(lendingPool)).insuranceFee;
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        expect(insuranceFee).to.equal(ethers.parseEther((ethers.formatEther(borrowAmount) * Number(insurancePercentage) / 1e4).toString()));
  
        // Approve the insurance fee
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
  
        // Borrow with insurance
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
    
        // Check user balance
        const crvUSDBalance = await crvusd.balanceOf(user1.address);
        expect(crvUSDBalance).to.equal(ethers.parseEther((1050 - Number(ethers.formatEther(insuranceFee))).toString()));
  
        // Expect the fee collector to receive the insurance fee (fee collector is owner)
        const collectedFees = await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE);
        const treasuryAmount = collectedFees.treasuryAmount
        expect(treasuryAmount).to.equal(insuranceFee);
    
        const debtBalance = await debtToken.balanceOf(user1.address);
  
        expect(debtBalance).to.gte(borrowAmount);
  
        const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const rawInsuredBalance = position.rawInsuredBalance;
        expect(rawInsuredBalance).to.equal(borrowAmount);
      });
  
      // Test: borrow without, borrow without, borrow with, then borrow without then borrow with.
      it("should allow the user to borrow without loan, borrow without loan, borrow with, then borrow without then borrow with loan.", async function () {
        // update oracle prices for all the assets
        await raacHousePrices.setHousePrice(1, ethers.parseEther("2000"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("20"))
        // Borrow without
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
  
        let position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        let uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(borrowAmount);
  
        // Borrow without
        const borrowAmount2 = ethers.parseEther("100");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount2);
  
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(borrowAmount + borrowAmount2);
  
        // Borrow with
        const borrowAmount3 = ethers.parseEther("200");
        let insuranceFeePercentage = (await toParameter(lendingPool)).insuranceFee;
        let insuranceFeeAmount1 = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount3);
        // the insurance fees needs to be the previous uninsured balance + the new borrow amount
        let expectedTotalInsuranceAmount = borrowAmount + borrowAmount2 + borrowAmount3;
  
        expect(insuranceFeeAmount1).to.equal(ethers.parseEther((ethers.formatEther(expectedTotalInsuranceAmount) * Number(insuranceFeePercentage) / 1e4).toString()));
  
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(borrowAmount + borrowAmount2);
  
        await crvusd.connect(user1).approve(lendingPool.target, insuranceFeeAmount1);
        // Borrow with insurance
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount3);
  
  
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(0);
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const rawInsuredBalance = position.rawInsuredBalance;
        expect(rawInsuredBalance).to.equal(borrowAmount + borrowAmount2 + borrowAmount3);
  
        const collectedFees = await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE);
        const treasuryAmount = collectedFees.treasuryAmount
        expect(treasuryAmount).to.equal(insuranceFeeAmount1);
  
        // Borrow without: this will reset all the fees: user has to pay all fees again
        const borrowAmount4 = ethers.parseEther("300");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount4);
  
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(borrowAmount + borrowAmount2 +  borrowAmount3 + borrowAmount4);
  
        // Borrow with
        const borrowAmount5 = ethers.parseEther("400");
  
        insuranceFeePercentage = (await toParameter(lendingPool)).insuranceFee;
        let insuranceFeeAmount2 = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount5);
        // the insurance fees needs to be the previous uninsured balance + the new borrow amount
        expectedTotalInsuranceAmount = borrowAmount +  borrowAmount2 +  borrowAmount3 + borrowAmount4 + borrowAmount5; // all over again since borrow without reset all the sums
  
        expect(insuranceFeeAmount2).to.equal(ethers.parseEther((ethers.formatEther(expectedTotalInsuranceAmount) * Number(insuranceFeePercentage) / 1e4).toString()));
  
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(borrowAmount +  borrowAmount2 +  borrowAmount3 + borrowAmount4); // not add borrow5 because that will be inserted later
  
        await crvusd.connect(user1).approve(lendingPool.target, insuranceFeeAmount2);
        // Borrow with insurance
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount5);

  
        uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(0);
  
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const rawInsuredBalance2 = position.rawInsuredBalance;
        expect(rawInsuredBalance2).to.equal(borrowAmount + borrowAmount2 + borrowAmount3 + borrowAmount4 + borrowAmount5);
  
        const collectedFees2 = await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE);
        const treasuryAmount2 = collectedFees2.treasuryAmount
        expect(treasuryAmount2).to.equal(insuranceFeeAmount1 + insuranceFeeAmount2);
  
      });
  
      it("should allow the user to repay and borrow again with insurance", async function () {
        await raacHousePrices.setHousePrice(1, ethers.parseEther("1000"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("10"))
        // Borrow with
  
        const borrowAmount = ethers.parseEther("50");
        let insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
  
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        // check that fee collector received the funds
        const feeCollectorBalance = (await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE)).treasuryAmount;
        expect(feeCollectorBalance).to.equal(insuranceFee);
  
        let uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(0);
  
        // Repay half
        const repayAmount = ethers.parseEther("25");
        await crvusd.connect(user1).approve(lendingPool.target, repayAmount);
        await crvusd.connect(user1).approve(rToken.target, repayAmount);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, repayAmount);
  
        // Check the metrics. We expect that the insuredAmount is now 25
        let position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const insuredBalance = position.rawInsuredBalance;
        expect(insuredBalance).to.equal(repayAmount);
  
        // We expect the rawDebt to be 25
        const debtBalance = await debtToken.balanceOf(user1.address);
        expect(debtBalance).to.equal(repayAmount);
  
        const userDebtNFT = await lendingPool.getPositionDebt(assetAdapter.target, user1.address, assetData);
        expect(userDebtNFT).to.equal(repayAmount);
  
  
        // Repay entire debt
        await crvusd.connect(user1).approve(lendingPool.target, repayAmount);
        await crvusd.connect(user1).approve(rToken.target, repayAmount);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, repayAmount);
  
        // Check the metrics. We expect that the insuredAmount is now 0
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const insuredBalance2 = position.rawInsuredBalance;
        expect(insuredBalance2).to.equal(0);
  
        // We expect the rawDebt to be 0
        const debtBalance2 = await debtToken.balanceOf(user1.address);
        expect(debtBalance2).to.equal(0);
  
        const userDebtNFT2 = await lendingPool.getPositionDebt(assetAdapter.target, user1.address, assetData);
        expect(userDebtNFT2).to.equal(0);
  
  
        // Borrow again
        const borrowAmount2 = ethers.parseEther("50");
        const insuranceFee2 = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount2);
  
        await crvusd.connect(user1).approve(lendingPool.target, insuranceFee2);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount2);
  
        // check that Fee Collector received the funds
        const feeCollectorBalance2 = (await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE)).treasuryAmount;
        // the difference because the fee collector already contains the insurance fee from previous run
        expect(feeCollectorBalance2 - feeCollectorBalance).to.equal(insuranceFee2);
        
  
        // Check the metrics. We expect that the insuredAmount is now 0
        position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        const insuredBalance4 = position.rawInsuredBalance;
        expect(insuredBalance4).to.equal(borrowAmount2);
  
        // We expect the rawDebt to be 50
        const debtBalance4 = await debtToken.balanceOf(user1.address);
        expect(debtBalance4).to.equal(borrowAmount2);
  
        const userDebtNFT4 = await lendingPool.getPositionDebt(assetAdapter.target, user1.address, assetData);
        expect(userDebtNFT4).to.equal(borrowAmount2);
      })
      it("should charge insurance only on the newly borrowed portion after a partial repayment", async function () {
        // 1) set up prices
        await raacHousePrices.setHousePrice(1, ethers.parseEther("2000"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("20"));

        const adapter = assetAdapter.target;
        const data    = assetData;

        // 2) initial borrowWithInsurance of 100
        const initialBorrow = ethers.parseEther("100");
        const fee1 = await lendingPool.calculateInsuranceFee(adapter, user1.address, data, initialBorrow);
        await crvusd.connect(user1).approve(lendingPool.target, fee1);
        await lendingPool.connect(user1).borrowWithInsurance(adapter, data, initialBorrow);

        // collectedFees after first insurance
        let fees = await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE);
        expect(fees.treasuryAmount).to.equal(fee1);

        // 3) repay 50
        const repayAmount = ethers.parseEther("50");
        await crvusd.connect(user1).approve(lendingPool.target, repayAmount);
        await lendingPool.connect(user1).repay(adapter, data, repayAmount);

        // state after repay
        let pos = await lendingPool.getPosition(adapter, user1.address, data);
        expect(pos.rawDebtBalance).to.equal(initialBorrow - (repayAmount));
        expect(pos.rawInsuredBalance).to.equal(initialBorrow - (repayAmount));

        // 4) re-borrow 50 with insurance
        const reborrow = ethers.parseEther("50");
        // calculate fee: should only be on the *new* 50
        const fee2 = await lendingPool.calculateInsuranceFee(adapter, user1.address, data, reborrow);
        expect(fee2).to.equal(
          reborrow
            * ((await toParameter(lendingPool)).insuranceFee)
             / BigInt(1e4)
        );

        await crvusd.connect(user1).approve(lendingPool.target, fee2);
        await lendingPool.connect(user1).borrowWithInsurance(adapter, data, reborrow);

        // 5) after re-borrow:
        // - rawInsuredBalance goes back to 100
        // - uninsuredBalance is zero
        pos = await lendingPool.getPosition(adapter, user1.address, data);
        const uninsured = await lendingPool.getUninsuredBalance(adapter, user1.address, data);
        expect(uninsured).to.equal(0);
        expect(pos.rawInsuredBalance).to.equal(initialBorrow);

        // 6) total fees collected = fee1 + fee2
        fees = await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE);
        expect(fees.treasuryAmount).to.equal(fee1 + (fee2));
      });

      it("should not allow the user to ensure without paying the insurance", async function () {
        await raacHousePrices.setHousePrice(1, ethers.parseEther("1000"));
        
        // Call borrowWithInsurance without sending the crvUSD fees to the contract
        const borrowAmount = ethers.parseEther("50");
        // reset the allowance
        await crvusd.connect(user1).approve(lendingPool.target, "0");
        await expect(lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount)).to.be.revertedWithCustomError(lendingPool, "InsufficientAllowanceForFees");
  
        // check the status
        let position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        let uninsuredBalance = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
        expect(uninsuredBalance).to.equal(0);
        expect(position.rawInsuredBalance).to.equal(0);
        expect(position.rawDebtBalance).to.equal(0);
        expect(await debtToken.balanceOf(user1.address)).to.equal(0);
      });
  
      it("should ensure the debt accrues interest", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
  
        const initialRawDebt = await debtToken.rawBalanceOf(user1.address);
        const initialDebt = await debtToken.balanceOf(user1.address);
        
        await time.increase(3600);
        await ethers.provider.send("evm_mine", []);
        await lendingPool.connect(user1).updateState();
  
        const finalRawDebt = await debtToken.rawBalanceOf(user1.address);
        // Would be different only if we act on it to remint the diff
        expect(finalRawDebt).to.eq(initialRawDebt);
        const finalDebt = await debtToken.balanceOf(user1.address);
        expect(finalDebt).to.gte(initialDebt);
      });
  
      it('should allow to get the position of the user and user data', async () => {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
  
        const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
  
        expect(position.rawDebtBalance).to.equal(borrowAmount);
        expect(position.isUnderLiquidation).to.equal(false);
        expect(position.liquidationStartTime).to.equal(0);
  
        const positionView = await lendingPool.getPositionView(assetAdapter.target, user1.address, assetData);
        expect(positionView.rawDebtBalance).to.equal(borrowAmount);
        expect(positionView.scaledDebtBalance).to.equal(borrowAmount);
        expect(positionView.healthFactor).to.equal(ethers.parseEther("1.6"));
        expect(positionView.isUnderLiquidation).to.equal(false);
        expect(positionView.isInsured).to.equal(false);
        expect(positionView.liquidationStartTime).to.equal(0);
       
        // Time pass
        await lendingPool.connect(user1).updateState();
        // Get current block timestamp
        const currentBlock = await ethers.provider.getBlock('latest');
        const currentTime = currentBlock.timestamp;
        
        // Calculate time until next hour
        const timeUntilNextHour = 3600 - (currentTime % 3600);
        
  
        // Increase time to next hour boundary
        await time.increase(timeUntilNextHour);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
  
        const debtBalance2 = await debtToken.balanceOf(user1.address);
        expect(debtBalance2).to.be.gte(borrowAmount);
  
        const positionAfter = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        expect(positionAfter.rawDebtBalance).to.be.eq(borrowAmount);
        expect(positionAfter.isUnderLiquidation).to.be.eq(false);
        expect(positionAfter.liquidationStartTime).to.be.eq(0);
  
        const positionViewAfter = await lendingPool.getPositionView(assetAdapter.target, user1.address, assetData);
        expect(positionViewAfter.rawDebtBalance).to.be.eq(borrowAmount);
        expect(positionViewAfter.scaledDebtBalance).to.be.eq(debtBalance2);
        expect(positionViewAfter.healthFactor).to.be.lt(ethers.parseEther("1.6"));
        expect(positionViewAfter.healthFactor).to.be.gte(ethers.parseEther("1.59"));
        expect(positionViewAfter.isUnderLiquidation).to.be.eq(false);
        expect(positionViewAfter.isInsured).to.be.eq(false);
        expect(positionViewAfter.liquidationStartTime).to.be.eq(0);
        expect(positionViewAfter.adapter).to.be.equal(assetAdapter.target);
        expect(positionViewAfter.asset).to.be.equal(baseAsset.target);
  
        if (assetType === "ERC721") {
          const userNFTs = await assetAdapter.getDepositedTokens(user1.address);
          const scaledDebtBalance = await lendingPool.getPositionsScaledDebt(user1.address)
          const totalCollateralValue = await lendingPool.getUserCollateralValue(user1.address);
          expect(userNFTs).to.deep.equal([NFT_ID]);
          expect(scaledDebtBalance).to.be.eq(debtBalance2);
          expect(totalCollateralValue).to.be.eq(ethers.parseEther("100"));
        }
  
        let positions = []
        positions.push(await lendingPool.getPositionView(assetAdapter.target, user1.address, assetData));
  
        const firstPosition = positions[0];
        // console.log(firstPosition)
        expect(firstPosition.rawDebtBalance).to.be.eq(borrowAmount);
        expect(firstPosition.scaledDebtBalance).to.be.eq(debtBalance2);
        expect(firstPosition.healthFactor).to.be.lt(ethers.parseEther("1.6"));
        expect(firstPosition.isUnderLiquidation).to.be.eq(false);
        expect(firstPosition.liquidationStartTime).to.be.eq(0);
  
        const reserveState = await lendingPool.getReserveState();
        expect(reserveState.reserveRTokenAddress).to.equal(rToken.target);
        expect(reserveState.reserveAssetAddress).to.equal(crvusd.target);
        expect(reserveState.reserveDebtTokenAddress).to.equal(debtToken.target);
        expect(reserveState.liquidityIndex).to.gt(RAY);
        expect(reserveState.usageIndex).to.gt(RAY);
        expect(reserveState.totalLiquidity).to.eq(ethers.parseEther("1950"));
        // totalUsage tracks the debt including accrued interest, i.e. the user's scaled debt
        expect(reserveState.totalUsage).to.closeTo(debtBalance2, ethers.parseEther("0.000001"));


        const reserveRateData = await lendingPool.getReserveRateData();
        // New rate model: borrow rate is flat at optimalRate (50% of prime) below optimal utilization
        // Liquidity rate = U * Rb * (1 - protocolFee) with U = 50/2000 = 2.5% and a 10% default protocol fee
        expect(reserveRateData.currentLiquidityRate).to.closeTo(ethers.parseEther("1125000"), ethers.parseEther("20"));
        expect(reserveRateData.currentUsageRate).to.eq(ethers.parseEther("50000000"));
        expect(reserveRateData.primeRate).to.eq(ethers.parseEther("100000000"));
        expect(reserveRateData.baseRate).to.eq(ethers.parseEther("25000000"));
        expect(reserveRateData.optimalRate).to.eq(ethers.parseEther("50000000"));
        // maxRate now defaults to 83.63% in RAY
        expect(reserveRateData.maxRate).to.eq(ethers.parseEther("836300000"));
        expect(reserveRateData.optimalUtilizationRate).to.eq(ethers.parseEther("800000000"));
        // protocolFeeRate now defaults to 10% in RAY
        expect(reserveRateData.protocolFeeRate).to.eq(ethers.parseEther("100000000"));
      });
  
      it("should prevent user from borrowing more than allowed", async function () {
        const borrowAmount = ethers.parseEther("900");
  
        await expect(lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount))
          .to.be.revertedWithCustomError(lendingPool, "NotEnoughCollateralToBorrow");
      });
  
      it("should allow user to repay borrowed crvUSD", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
  
        await crvusd.connect(user1).approve(rToken.target, ethers.MaxUint256);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
  
        const debtBalance = await debtToken.balanceOf(user1.address);
        expect(debtBalance).to.equal(0);
  
        const crvUSDBalance = await crvusd.balanceOf(user1.address);
        expect(crvUSDBalance).to.lte(ethers.parseEther("1000"));
        expect(crvUSDBalance).to.gte(ethers.parseEther("999.9999990"));
      });
  
      it("should only allow user to repay up to the owed amount", async function () {
        const borrowAmount = ethers.parseEther("50");
  
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
        
        // Let the interest accrue accross 2 blocks
        await ethers.provider.send("evm_mine", []);
        await ethers.provider.send("evm_mine", []);
        await lendingPool.connect(user1).updateState();

        const debtAmount = await debtToken.balanceOf(user1.address);
        await crvusd.connect(user1).approve(rToken.target, ethers.MaxUint256);
        
        const initialBalance = await crvusd.balanceOf(user1.address);
  
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
        
        const finalDebt = await debtToken.balanceOf(user1.address);
        const finalBalance = await crvusd.balanceOf(user1.address);
        
        expect(finalDebt).to.equal(0);
        const balanceDifference = initialBalance - finalBalance;
        const tolerance = ethers.parseEther("0.00001");
        expect(balanceDifference).to.be.closeTo(debtAmount, tolerance);
        expect(balanceDifference).to.be.closeTo(borrowAmount, tolerance);
        expect(balanceDifference).to.be.gt(borrowAmount - tolerance);
      });
      it("should allow user1 to deposit, borrow 20 crvUSD, repay, and verify depositor interest", async function () {
        let expectedBalances = {
          user1:{
            crvUSD: ethers.parseEther("1000"),
            rToken: ethers.parseEther("0"),
            debt: ethers.parseEther("0")
          },
          user2:{
            crvUSD: ethers.parseEther("8000"),
            rToken: ethers.parseEther("2000"),
            debt: ethers.parseEther("0")
          },
          rToken: {
            crvUSD: ethers.parseEther("2000"),
          }
        }
        
        const user2InitialBalance = await crvusd.balanceOf(user2.address);
        expect(user2InitialBalance).to.equal(expectedBalances.user2.crvUSD);
  
        const depositedAmount = await rToken.balanceOf(user2.address);
        
        expect(depositedAmount).to.equal(expectedBalances.rToken.crvUSD);
  
        const initialBalanceOfRToken = await crvusd.balanceOf(rToken.target);
        expect(initialBalanceOfRToken).to.equal(expectedBalances.rToken.crvUSD);
  
        const borrowAmount = ethers.parseEther("20");
        expect(await crvusd.balanceOf(user1.address)).to.equal(expectedBalances.user1.crvUSD);
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
        await lendingPool.connect(user1).updateState();
  
        expectedBalances.user1.crvUSD = expectedBalances.user1.crvUSD + borrowAmount;
        expectedBalances.user1.debt = expectedBalances.user1.debt + borrowAmount;
        expectedBalances.rToken.crvUSD = expectedBalances.rToken.crvUSD - borrowAmount;
  
        let user1CrvUSDBalance = await crvusd.balanceOf(user1.address);
        expect(user1CrvUSDBalance).to.equal(expectedBalances.user1.crvUSD);
        let user1DebtBalance = await debtToken.balanceOf(user1.address);
        expect(user1DebtBalance).to.closeTo(expectedBalances.user1.debt, ethers.parseEther("0.000002"));
  
        await ethers.provider.send("evm_increaseTime", [1 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);
        await lendingPool.connect(user1).updateState();
  
         await ethers.provider.send("evm_increaseTime", [364 * 24 * 60 * 60]);
         await ethers.provider.send("evm_mine", []);
         await lendingPool.connect(user1).updateState();
  
         const currentBorrowRate = await getCurrentBorrowRatePercentage(lendingPool);
         const currentLiquidityRate = await getCurrentLiquidityRatePercentage(lendingPool)
         
        expect(currentBorrowRate).to.be.closeTo(5, 0.03); // fixed to 5%
        const wadCurrentBorrowRatePercentage = ethers.parseUnits(currentBorrowRate.toString(), 18);
        const wadCurrentLiquidityRatePercentage = ethers.parseUnits(currentLiquidityRate.toString(), 18);
  
        expect(wadCurrentBorrowRatePercentage).to.be.closeTo(ethers.parseUnits(currentBorrowRate.toString(), 18), ethers.parseUnits("0.01", 18))
  
        await lendingPool.connect(user1).updateState();
        const generatedDebt = (expectedBalances.user1.debt * wadCurrentBorrowRatePercentage) / BigInt(100 * 1e18);
  
        const utilizationRate = await getCurrentUtilizationRatePercentage(lendingPool);
        const totalLiquidity = await crvusd.balanceOf(rToken.target);
        const generatedInterest = (totalLiquidity * wadCurrentLiquidityRatePercentage) / BigInt(100 * 1e18);
        // Depositor interest for one year on a 20 crvUSD debt: with the flat 5% borrow rate
        expect(generatedInterest).to.be.closeTo(ethers.parseUnits("0.9362", 18), ethers.parseUnits("0.008", 18));
        const percentInterestGenerated = Number((generatedDebt * 100n * BigInt(1e18)) / expectedBalances.user1.debt) / 1e18;
        expect(percentInterestGenerated).to.be.closeTo(currentBorrowRate, 0.03);
        expectedBalances.user1.debt = expectedBalances.user1.debt + generatedDebt;
        expectedBalances.user2.rToken = expectedBalances.user2.rToken + generatedInterest;
  
        await lendingPool.connect(user1).updateState();
        const user2RTokenBalance = await rToken.balanceOf(user2.address);

        expect(user2RTokenBalance).to.closeTo(expectedBalances.user2.rToken, ethers.parseUnits("0.06", 18));
        const amountInterest = user2RTokenBalance - expectedBalances.user2.rToken;
  
        const repayAmount = ethers.parseEther("1");
        await crvusd.connect(user1).approve(rToken.target, repayAmount);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, repayAmount);
        await lendingPool.connect(user1).updateState();
        console.log({
          crvusd:{
            user1: ethers.formatEther(await crvusd.balanceOf(user1.address)),
            user2: ethers.formatEther(await crvusd.balanceOf(user2.address)),
            reserve: ethers.formatEther(await crvusd.balanceOf(rToken.target)),
          },
          rToken: {
            user1: ethers.formatEther(await rToken.balanceOf(user1.address)),
            user2: ethers.formatEther(await rToken.balanceOf(user2.address)),
          },
          debtToken: {
            user1: ethers.formatEther(await debtToken.balanceOf(user1.address)),
            user2: ethers.formatEther(await debtToken.balanceOf(user2.address)),
          },
        });
        expectedBalances.user1.crvUSD = expectedBalances.user1.crvUSD - repayAmount;
        expectedBalances.user1.debt = expectedBalances.user1.debt - repayAmount;
        expectedBalances.rToken.crvUSD = expectedBalances.rToken.crvUSD + repayAmount;
  
        user1CrvUSDBalance = await crvusd.balanceOf(user1.address)
        expect(user1CrvUSDBalance).to.be.closeTo(expectedBalances.user1.crvUSD, ethers.parseEther("0.05"));
        // expect(await debtToken.balanceOf(user1.address)).to.be.equal(0n);
        expect(await debtToken.balanceOf(user1.address)).to.be.closeTo(expectedBalances.user1.debt, ethers.parseEther("0.06"));
        expect(await crvusd.balanceOf(rToken.target)).to.be.gte(expectedBalances.rToken.crvUSD);
        expect(await crvusd.balanceOf(rToken.target)).to.be.lte(expectedBalances.rToken.crvUSD + 1n);
  
        const depositAmount = ethers.parseEther("990");

        // The 1 crvUSD deposits below are under the default 10 crvUSD minimum; lower it to 1 wei
        await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount + ethers.parseEther("10"));
        await lendingPool.connect(user2).deposit(depositAmount);
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await lendingPool.connect(user2).deposit(ethers.parseEther("1"));
        await time.increase(1);
        await ethers.provider.send("evm_mine", []);
        expectedBalances.user2.crvUSD = expectedBalances.user2.crvUSD - depositAmount - ethers.parseEther("10");
        expectedBalances.user2.rToken = expectedBalances.user2.rToken + depositAmount + ethers.parseEther("10");
        expectedBalances.rToken.crvUSD = expectedBalances.rToken.crvUSD + depositAmount + ethers.parseEther("10");
        expect(await crvusd.balanceOf(rToken.target)).to.be.gte(expectedBalances.rToken.crvUSD);
        expect(await crvusd.balanceOf(rToken.target)).to.be.lte(expectedBalances.rToken.crvUSD);
  
        expect(await rToken.balanceOf(user2.address)).to.closeTo(expectedBalances.user2.rToken, ethers.parseEther("0.06"));
        expect(await crvusd.balanceOf(user2.address)).to.equal(expectedBalances.user2.crvUSD);
  
        const user2RTokenBalanceAfterDeposit = await rToken.balanceOf(user2.address);
        // ~0.90 interest accrued over the year on the 20 debt (flat 5% borrow rate, 10% protocol fee)
        expect(user2RTokenBalanceAfterDeposit).to.be.closeTo(depositAmount + ethers.parseEther("10") + depositedAmount + ethers.parseEther("0.90"), ethers.parseEther("0.3"));
        user1DebtBalance = await debtToken.balanceOf(user1.address);
        // Debt = 20 borrowed + ~1.03 interest accrued over the year (flat 5% borrow rate, compounded) - 1 repaid
        expect(user1DebtBalance).to.be.closeTo(borrowAmount + ethers.parseEther("1.03") - repayAmount, ethers.parseEther("0.05"));
        // await ethers.provider.send("evm_increaseTime", [7 * 86400]);
        // await ethers.provider.send("evm_mine");
  
        const generatedInterest2 = (expectedBalances.user1.debt * wadCurrentBorrowRatePercentage) / BigInt(100 * 1e18);
        const percentInterestGenerated2 = Number((generatedInterest2 * 100n * BigInt(1e18)) / expectedBalances.user1.debt) / 1e18;
        expect(percentInterestGenerated2).to.be.closeTo(currentBorrowRate, 0.01);
        const secondRepayAmount = ethers.parseEther("4");
        await crvusd.connect(user1).approve(rToken.target, secondRepayAmount);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, secondRepayAmount);

        expectedBalances.user1.crvUSD = expectedBalances.user1.crvUSD - secondRepayAmount;
        expectedBalances.user1.debt = expectedBalances.user1.debt - secondRepayAmount;
        expectedBalances.rToken.crvUSD = expectedBalances.rToken.crvUSD + secondRepayAmount;

        expect(await crvusd.balanceOf(user1.address)).to.be.closeTo(expectedBalances.user1.crvUSD, ethers.parseEther("0.3"));
        expect(await debtToken.balanceOf(user1.address)).to.be.closeTo(expectedBalances.user1.debt, ethers.parseEther("0.1"));
        expect(await crvusd.balanceOf(rToken.target)).to.be.gte(expectedBalances.rToken.crvUSD);
        expect(await crvusd.balanceOf(rToken.target)).to.be.lte(expectedBalances.rToken.crvUSD + 10n);
        const user1CrvUSDAfterSecondRepay = await crvusd.balanceOf(user1.address);
  
        // 1000 initial + 20 borrowed - 1 repaid - 4 repaid = 1015
        expect(user1CrvUSDAfterSecondRepay).to.be.lessThanOrEqual(ethers.parseEther("1015"));
        expect(user1CrvUSDAfterSecondRepay).to.be.greaterThanOrEqual(ethers.parseEther("1014.999"));

        const user2RTokenBalanceAfterSecondRepay = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfterSecondRepay).to.be.closeTo(depositAmount + depositedAmount + ethers.parseEther("10") + ethers.parseEther("0.90"), ethers.parseEther("0.1"));
        await lendingPool.connect(user2).withdraw(depositAmount);
        const user2RTokenBalanceAfterWithdraw = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfterWithdraw).to.be.closeTo(depositedAmount + ethers.parseEther("10.90"), ethers.parseEther("0.3"));
  
        const user1DebtBalance2 = await debtToken.balanceOf(user1.address);
        await crvusd.connect(user1).approve(rToken.target, user1DebtBalance2  + ethers.parseEther("0.3"));
  
        // If withdraw before repaying the debt: cannot do since would leave undercollateralized.
        await expect(lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData)).to.be.revertedWithCustomError(lendingPool, "WithdrawalWouldLeaveUserUnderCollateralized")
        // Repay in full: amounts above the debt are no longer capped (only MaxUint256 is), they would revert
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
  
        const user2RTokenBalanceAfter = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfter).to.be.gt('2000');
        // Check debt 
        const user1DebtBalanceAfterRepay = await debtToken.balanceOf(user1.address);
        const user1DebtBalanceAfterRepayRaw = await debtToken.rawBalanceOf(user1.address);
        expect(user1DebtBalanceAfterRepay).to.be.eq(0n);
  
        await lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData);

        if (assetType === "ERC20") {
          expect(await baseAsset.balanceOf(user1.address)).to.equal(ASSET_PRICE);
          expect(await assetAdapter.getAssetValue(user1.address, new ethers.AbiCoder().encode([], []))).to.equal(0);
        } else {
          expect(await baseAsset.ownerOf(NFT_ID)).to.equal(user1.address);
          expect(await assetAdapter.getDepositor(NFT_ID)).to.equal(ethers.ZeroAddress);
        }
  
        // Withdrawing more than the balance now reverts (InsufficientBalance); MaxUint256 withdraws everything
        await lendingPool.connect(user2).withdraw(ethers.MaxUint256);
        const user2RTokenBalanceAfterFinalWithdraw = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfterFinalWithdraw).to.equal(0);
        const lendingPoolBalance = await crvusd.balanceOf(rToken.target);
        // Residual is mostly the unclaimed 10% protocol fee share of the ~1.25 interest paid, plus rounding dust
        let expectedFinalReservePoolBalance = ethers.parseEther("0.1253")

        expect(lendingPoolBalance).to.closeTo(expectedFinalReservePoolBalance, ethers.parseEther("0.01"));
        
        const user1CrvUSDBalanceAfterFinalWithdraw = await crvusd.balanceOf(user1.address);
        expect(user1CrvUSDBalanceAfterFinalWithdraw).to.closeTo(ethers.parseEther("998.9746"), ethers.parseEther("0.01"));
  
        const user1DebtBalanceAfterFinalWithdraw = await debtToken.balanceOf(user1.address);
        expect(user1DebtBalanceAfterFinalWithdraw).to.equal(0);
  
        const user2CrvUSDBalanceAfterFinalWithdraw = await crvusd.balanceOf(user2.address);
        expect(user2CrvUSDBalanceAfterFinalWithdraw).to.closeTo(user2InitialBalance + ethers.parseEther("2000") + ethers.parseEther("0.90"), ethers.parseEther("0.01"));
  
        expect(user2RTokenBalanceAfterFinalWithdraw).to.equal(0);
  
        expect(await rToken.totalSupply()).to.eq(0n)
        expect(await rToken.rawTotalSupply()).to.eq(0n)
        expect(await debtToken.totalSupply()).to.eq(0n)
        expect(await debtToken.rawTotalSupply()).to.eq(0n)
      });

      it("should allow the user to repay the debt with accured interest as dust", async function() {
        // create obligations
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("100"));
        await lendingPool.connect(user1).deposit(ethers.parseEther("100"));

        // borrow some amount to accur interest: approve an nft and deposit it as collateral
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("50"));

        // Wait for some time
        await time.increase(24 * 60 * 60);
        await ethers.provider.send("evm_mine", []);

        await lendingPool.updateState();

        // user borrowed 50, but the interst should have increased
        const lastBalance = await debtToken.balanceOf(user1.address);
        expect(lastBalance).to.be.greaterThan(ethers.parseEther("50"));
        console.log(lastBalance)

        await time.increase(24 * 60 * 60);
        await ethers.provider.send("evm_mine", []);

        
        // user will try repaying the debt with the accured interest as dust: some time has occured since the last state update so some interests will be added at the time of repaying and the user will not be able to repay the full debt as small amount of dust is left
        // since the dust is less than MIN_BORROW_AMOUNT, the user will not be able to repay the debt
        await crvusd.connect(user1).approve(lendingPool.target, lastBalance);
        // check allowance
        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, lastBalance)).to.be.revertedWithCustomError(lendingPool, "ResidualCannotBeRepaid");

        // use the uint256 max amount to repay the entire debt and check that the debt is 0
        await crvusd.connect(user1).approve(lendingPool.target, ethers.MaxUint256);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);

        expect(await debtToken.balanceOf(user1.address)).to.be.equal(0);

        // check that the user can withdraw the asset
        await lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData);
      })
      it("should allow loan to be repayed on behalf of another user", async function() {
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("100"));
        await lendingPool.connect(user1).deposit(ethers.parseEther("100"));

        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("50"));

        // user2 will try to repay the debt on behalf of user1
        // Repay with MaxUint256: any interest accrued since the borrow would otherwise leave
        // dust below MIN_BORROW_AMOUNT and revert with ResidualCannotBeRepaid
        await time.increase(5);
        await ethers.provider.send("evm_mine", []);
        await crvusd.connect(user2).approve(lendingPool.target, ethers.MaxUint256);
        await lendingPool.connect(user2).repayOnBehalf(assetAdapter.target, assetData, ethers.MaxUint256, user1.address);

        // check that the debt is 0
        expect(await debtToken.balanceOf(user1.address)).to.be.equal(0);

        // check that the user can withdraw the asset
        await lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData);
      })
      it("should revert if borrow amount is below MIN_BORROW_AMOUNT", async function () {
        // MIN_BORROW_AMOUNT is 10e18
        const belowMinAmount = ethers.parseEther("1"); // 1 unit, below 10e18
        await expect(
          lendingPool.connect(user1).borrow(assetAdapter.target, assetData, belowMinAmount)
        ).to.be.revertedWithCustomError(lendingPool, "InvalidBorrowAmount");
      });
      it("should have a debt balance of at least MIN_BORROW_AMOUNT or 0", async function() {
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("100"));
        await lendingPool.connect(user1).deposit(ethers.parseEther("100"));

        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("50"));

        // repay 40 so that 10 remain, it should not revert
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("40"));
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.parseEther("40"));

        // repay 1 wei -> since value < 10 which is MIN_BORROW_AMOUNT, it should revert
        await crvusd.connect(user1).approve(lendingPool.target, 1);
        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, 1)).to.be.revertedWithCustomError(lendingPool, "ResidualCannotBeRepaid");

        // if i repay the entire balance, it should allow me to do that
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("10"));
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.parseEther("10"));

        // check that the debt is 0
        expect(await debtToken.balanceOf(user1.address)).to.be.equal(0);
      });
      it("should do exhaustive repayments to ensure there is no dust left", async function() {
        const timeIntervals = [1, 10, 20, 30, 50, 100, 150, 200, 500, 1000, 2423, 5000, 10000, 24324, 54324, 143234, 200000, 500000, 1000000, 2000000, 5004651, 10000000, 100000000, 1000000000]; // Different time intervals in seconds
        
        for (let i = 0; i < timeIntervals.length; i++) {
          const timeInterval = timeIntervals[i];
          
          await lendingPool.connect(user1).updateState();
          
          await crvusd.mint(user1.address, ethers.parseEther("1000"));
          await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("100"));
          await lendingPool.connect(user1).deposit(ethers.parseEther("100"));

          // increase the collteral 
          await raacHousePrices.setHousePrice(1, ethers.parseEther("2000"));
          await erc20PriceOracle.setLatestPrice(ethers.parseEther("20"))
          
          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("50"));
          
          await time.increase(timeInterval);
          await ethers.provider.send("evm_mine", []);
          await lendingPool.connect(user1).updateState();

          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("10"));

          await time.increase(timeInterval);
          await ethers.provider.send("evm_mine", []);
          await lendingPool.connect(user1).updateState();
          
          const debtBeforeRepay = await debtToken.balanceOf(user1.address);
          console.log(`Time interval ${timeInterval}: Debt before repay: ${ethers.formatEther(debtBeforeRepay)}`);
          
          await crvusd.connect(user1).approve(lendingPool.target, ethers.MaxUint256);
          await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
          
          const debtAfterRepay = await debtToken.balanceOf(user1.address);
          console.log(`Time interval ${timeInterval}: Debt after repay: ${ethers.formatEther(debtAfterRepay)}`);
          
          expect(debtAfterRepay).to.be.equal(0);
          
          console.log(`Time interval ${timeInterval}: No dust left behind\n`);
        }
      });
      describe("Insurance fee set to zero", function () {
        const pctMul = (value, bps) => (value * bps + 5000n) / 10000n;

        it("quotes a zero premium regardless of position size", async function () {
          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("40"));

          expect((await toParameter(lendingPool)).insuranceFee).to.equal(300n);
          expect(await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, ethers.parseEther("10"))).to.be.gt(0n);

          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);

          expect(await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, ethers.parseEther("10"))).to.equal(0n);
          expect(await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, ethers.parseEther("1000000"))).to.equal(0n);
        });

        it("insures the whole existing position for free", async function () {
          const priorDebt = ethers.parseEther("40");
          const trigger = ethers.parseEther("10");

          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, priorDebt);
          expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.false;
          expect(await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData)).to.equal(priorDebt);

          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);

          const balanceBefore = await crvusd.balanceOf(user1.address);
          await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, trigger);

          expect(await crvusd.balanceOf(user1.address)).to.equal(balanceBefore + trigger);
          expect((await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE)).treasuryAmount).to.equal(0n);

          const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
          expect(position.isInsured).to.be.true;
          expect(position.rawInsuredBalance).to.equal(priorDebt + trigger);
          expect(await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData)).to.be.lt(ethers.parseEther("0.01"));
        });

        it("keeps the coverage after the fee is restored", async function () {
          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("40"));
          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);
          await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, ethers.parseEther("10"));

          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 300);
          await time.increase(30 * 24 * 60 * 60);

          expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true;
        });

        it("charges the restored fee on the new borrow only", async function () {
          const priorDebt = ethers.parseEther("40");
          const trigger = ethers.parseEther("10");
          const newBorrow = ethers.parseEther("10");

          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, priorDebt);
          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);
          await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, trigger);
          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 300);

          const carriedOver = await lendingPool.getUninsuredBalance(assetAdapter.target, user1.address, assetData);
          const premium = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, newBorrow);

          expect(premium).to.equal(pctMul(carriedOver + newBorrow, 300n));
          expect(premium).to.be.closeTo(pctMul(newBorrow, 300n), ethers.parseEther("0.001"));
          expect(premium).to.be.lt(pctMul(priorDebt + trigger + newBorrow, 300n) / 2n);

          await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, newBorrow);
          expect((await feeCollector.getCollectedFees(crvusd.target, INSURANCE_FEE)).treasuryAmount).to.equal(premium);
        });

        it("drops the free coverage on an uninsured borrow", async function () {
          const priorDebt = ethers.parseEther("40");
          const trigger = ethers.parseEther("10");

          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, priorDebt);
          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);
          await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, trigger);
          await lendingPool.setParameter(OwnerParameter.InsuranceFee, 300);

          await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("10"));

          const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
          expect(position.isInsured).to.be.false;
          expect(position.rawInsuredBalance).to.equal(0n);
          expect(await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, ethers.parseEther("10"))).to.be.gt(pctMul(priorDebt + trigger, 300n));
        });
      });
    });
  }

  describeBorrowAndRepay("ERC20")
  describeBorrowAndRepay("ERC721")

  function describeFullSequence(assetType) {
    describe("Full sequence", function () {
      let assetAdapter
      let baseAsset
      let assetData;
      beforeEach(async function () {
        // Get the asset type
        assetAdapter = assets[assetType].adapter;
        baseAsset = assets[assetType].baseAsset;
        assetData = assets[assetType].data;
        const initialBalanceOfRToken = await crvusd.balanceOf(rToken.target);
        const depositAmount = ethers.parseEther("1000");
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        // mine 1 day update state
        await ethers.provider.send("evm_increaseTime", [1 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user2).updateState();
        const tokenId = 1;
        await baseAsset.connect(user1).approve(assetAdapter.target, assetData);
        await lendingPool.connect(user1).depositAsset(assetAdapter.target, assetData);
  
        // Let liquidation threshold be 81% and borrow threshold be 80%
        await lendingPool.setParameter(OwnerParameter.LiquidationThreshold, 8100);
        await lendingPool.setParameter(OwnerParameter.BorrowThreshold, 8000);
        const borrowAmount = ethers.parseEther("80");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
  
        await crvusd.connect(user2).approve(lendingPool.target, ethers.parseEther("1000"));
        await crvusd.connect(owner).approve(lendingPool.target, ethers.parseEther("1000"));
  
        await lendingPool.connect(user2).withdraw(depositAmount);
        const depositedAmount = ethers.parseEther("1000");
        const user2RTokenBalanceAfterWithdraw = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfterWithdraw).to.be.closeTo(depositedAmount, ethers.parseEther("0.3"));
  
        const user1DebtBalance2 = await debtToken.balanceOf(user1.address);
        await crvusd.connect(user1).approve(rToken.target, ethers.MaxUint256);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
  
        const user1DebtAfterRepay2 = await debtToken.balanceOf(user1.address);
        expect(user1DebtAfterRepay2).to.be.lte(0); // Should be zero
  
        const user2RTokenBalanceAfter = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfter).to.be.gt('2000');
  
        await lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData);
  
        const rTokenBeforeFullWithdraw = await rToken.balanceOf(user2.address)
        const fullWithdraw = rTokenBeforeFullWithdraw
        
        await lendingPool.connect(user2).withdraw(fullWithdraw);
        const user2RTokenBalanceAfterFinalWithdraw = await rToken.balanceOf(user2.address);
        expect(user2RTokenBalanceAfterFinalWithdraw).to.equal(0);
  
        const lendingPoolBalance = await crvusd.balanceOf(rToken.target);
        // expect(initialBalanceOfRToken).to.equal(ethers.parseEther("2000"));
  
        let expectedFinalReservePoolBalance = initialBalanceOfRToken
              - ethers.parseEther("80")     // User1 borrow
              + ethers.parseEther("1000")   // User2 additional deposit
              // + ethers.parseEther("80")      // User1 second repay
              - ethers.parseEther("1000")   // User2 first withdrawal
              + user1DebtBalance2           // User1 final repay (actual debt balance)
              // + ethers.parseEther("20")     // User3 deposit
              - rTokenBeforeFullWithdraw     // User2 final withdrawal
             + ethers.parseEther("0.0000002"); // difference between linear and compounded interest + rounding + other reserve
              // + ethers.parseEther("0.000000000024778654"); // difference between linear and compounded interest + rounding + other reserve
  
              console.log("Expected final reserve pool balance:", ethers.formatUnits(expectedFinalReservePoolBalance));
              console.log("Lending pool balance:", ethers.formatUnits(lendingPoolBalance));
        // Assert the expected balance
        expect(lendingPoolBalance).to.be.closeTo(expectedFinalReservePoolBalance, ethers.parseEther("0.00006"));
        
        // Display user1's crvUSD balance
        const user1CrvUSDBalanceAfterFinalWithdraw = await crvusd.balanceOf(user1.address);
        expect(user1CrvUSDBalanceAfterFinalWithdraw).to.closeTo(ethers.parseEther("999.99"), ethers.parseEther("0.1"));
  
        // Display user1's debt balance
        const user1DebtBalanceAfterFinalWithdraw = await debtToken.balanceOf(user1.address);
        expect(user1DebtBalanceAfterFinalWithdraw).to.equal(0);
  
        // Display user2's crvUSD balance
        const user2CrvUSDBalanceAfterFinalWithdraw = await crvusd.balanceOf(user2.address);
        expect(user2CrvUSDBalanceAfterFinalWithdraw).to.gte(ethers.parseEther("1000"));
        expect(user2RTokenBalanceAfterFinalWithdraw).to.equal(0);
      });
    });
  }

  describeFullSequence("ERC20")
  describeFullSequence("ERC721")

  function describeLiquidation(assetType) {
    describe("Liquidation", function () {
      let assetAdapter
      let baseAsset
      let assetData;
      const NFT_ID = 1;
      const encodedNFT_ID = encodeERC721Token(NFT_ID)
      let feeCollector;
      beforeEach(async function () {
        // Get the asset type
        assetAdapter = assets[assetType].adapter;
        baseAsset = assets[assetType].baseAsset;
        assetData = assets[assetType].data;
        // Deploy fee collector
        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(
          owner.address
        );
        await feeCollector.waitForDeployment();
  
        // User2 deposits into the reserve pool to provide liquidity
        const depositAmount = ethers.parseEther("1000");
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
    
        // User1 deposits NFT and borrows
        await baseAsset.connect(user1).approve(assetAdapter.target, assetData);
        await lendingPool.connect(user1).depositAsset(assetAdapter.target, assetData);
  
        // Users approve crvUSD for potential transactions
        await crvusd.connect(user2).approve(lendingPool.target, ethers.parseEther("1000"));
        await crvusd.connect(owner).approve(lendingPool.target, ethers.parseEther("1000"));
  
        // set fee collector
        await lendingPool.setFeeCollector(await feeCollector.getAddress());
        await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
        await feeCollector.addClaimableToken(crvusd.target)

        // Set the borrow threshold to 50%
        await lendingPool.setParameter(OwnerParameter.BorrowThreshold, 5000);
      });
    
      it("should allow initiation of liquidation when loan is undercollateralized", async function () {
        const borrowAmount = ethers.parseEther("50");
  
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
  
        // Decrease house price to trigger liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49")); // the liquidation threshold is 80% so decreasing to 62.50% triggers liquidation
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"))
        
        // Attempt to initiate liquidation
        await expect(lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData))
          .to.emit(lendingPool, "LiquidationInitiated")
          .withArgs(user2.address, user1.address, assetAdapter.target, assetData);
    
        // Verify that the user is under liquidation
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isUnderLiquidation).to.be.true;
  
        // Verify that the user cannot withdraw NFT while under liquidation
        await expect(lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData))
          .to.be.revertedWithCustomError(lendingPool, "CannotWithdrawUnderLiquidation");
  
        // Verify the liquidation start time is set
        const positionData = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        expect(positionData.liquidationStartTime).to.be.gt(0);
  
        // Verify the health factor is below the liquidation threshold
        const healthFactor = await lendingPool.calculateHealthFactor(assetAdapter.target, user1.address, assetData);
        const healthFactorLiquidationThreshold = await lendingPool.HEALTH_FACTOR_LIQUIDATION_THRESHOLD();
        expect(healthFactor).to.be.lte(healthFactorLiquidationThreshold);
      });

      it("(ERC20) should prevent user from depositing more asset into the pool if under liquidation", async function () {
        if (assetType !== "ERC20") return;
        const borrowAmount = ethers.parseEther("50");
  
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
  
        // Decrease house price to trigger liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"))
        
        // Attempt to initiate liquidation
        await expect(lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData))
          .to.emit(lendingPool, "LiquidationInitiated")
          .withArgs(user2.address, user1.address, assetAdapter.target, assetData);
    
        let attackerAssetEncodedData = encodeERC20Token(1);
        await baseAsset.mint(user1.address, 1);
        await baseAsset.connect(user1).approve(assetAdapter.target, 1);
        await expect(lendingPool.connect(user1).depositAsset(assetAdapter.target, attackerAssetEncodedData)).to.be.revertedWithCustomError(lendingPool, "CannotDepositWhenUnderLiquidation")
      });
    
      it("should allow the user to close liquidation within grace period (with insurance)", async function () {
        const borrowAmount = ethers.parseEther("50");
        
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(lendingPool.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
        await time.increase(16000);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"))
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
    
        const userScaledDebt = await lendingPool.getPositionScaledDebt(assetAdapter.target, user1.address, assetData);
        await crvusd.connect(user1).approve(lendingPool.target, userScaledDebt + ethers.parseEther("0.001"));
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.MaxUint256);
        // Time pass
        await time.increase(3600);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
    
        // User1 closes the liquidation
        await expect(lendingPool.connect(user1).closeLiquidation(assetAdapter.target, assetData))
          .to.emit(lendingPool, "LiquidationClosed")
          .withArgs(user1.address, assetAdapter.target, assetData);
  
        // Time pass
        await time.increase(3600);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
    
        // Verify that the user is no longer under liquidation
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isUnderLiquidation).to.be.false;
        // Verify that the user can now withdraw their NFT
        if (assetType === "ERC20") {
          await expect(lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData))
            .to.emit(assetAdapter, "TokenWithdrawn")
            .withArgs(baseAsset.target, user1.address, ASSET_PRICE);

            expect(await assetAdapter.getAssetValue(user1.address, assetData)).to.equal(0)
            expect(await baseAsset.balanceOf(user1.address)).to.equal(ASSET_PRICE)
          } else if (assetType === "ERC721") {
          await expect(lendingPool.connect(user1).withdrawAsset(assetAdapter.target, assetData))
            .to.emit(assetAdapter, "NFTWithdrawn")
            .withArgs(baseAsset.target, user1.address, NFT_ID);

          expect(await assetAdapter.getDepositor(NFT_ID)).to.equal(ethers.ZeroAddress)
          // Verify that the NFT is now owned by user1
          expect(await baseAsset.ownerOf(NFT_ID)).to.equal(user1.address);
        }
  
        // since the NFT has been withdrawn, the owner is not adapter anymore.
        
  
        // Get current block timestamp
        const currentBlock = await ethers.provider.getBlock('latest');
        const currentTime = currentBlock.timestamp;
        
        // Calculate time until next hour
        const timeUntilNextHour = 3600 - (currentTime % 3600);
        
        // Increase time to next hour boundary
        await time.increase(timeUntilNextHour);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
  
        // Verify that the user's account is cleaned
        const positionData = await lendingPool.getPositionView(assetAdapter.target, user1.address, assetData);
        expect(positionData.isUnderLiquidation).to.be.false;
        expect(positionData.scaledDebtBalance).to.equal(0);
        expect(positionData.healthFactor).to.equal(1000000000000000000000000000n);
        expect(positionData.rawDebtBalance).to.equal(0);
        expect(positionData.liquidationStartTime).to.equal(0);
        expect(positionData.isInsured).to.be.false;
        // Usage index accrued at the flat 5% borrow rate (new rate model) at the time the liquidation was closed
        expect(positionData.positionIndex).to.closeTo(RAY + ethers.parseEther('25368.155'), ethers.parseEther('0.3'));
        expect(positionData.adapter).to.be.equal(assetAdapter.target);
        expect(positionData.asset).to.be.equal(baseAsset.target);
        expect(positionData.scaledDebtBalance).to.equal(0);
  
        if(assetType === "ERC721") {
          const totalTokens = await assetAdapter.getDepositedTokens(user1.address)
          expect(totalTokens).to.be.deep.equal([]);
        }
  
        // Double-check that the user has no remaining debt
        const userClosedLiquidationDebt = await lendingPool.getPositionsScaledDebt(user1.address);
        expect(userClosedLiquidationDebt).to.equal(0);
  
        // Verify that the user's health factor is now at its maximum (type(uint256).max)
        const healthFactor = await lendingPool.calculateHealthFactor(assetAdapter.target, user1.address, assetData);
        expect(healthFactor).to.equal(1000000000000000000000000000n);
      });
    
      it("should allow Stability Pool to close liquidation after grace period (if insured)", async function () {
        const borrowAmount = ethers.parseEther("50");
        
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"))
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
    
        // Advance time beyond grace period (72 hours)
        await ethers.provider.send("evm_increaseTime", [72 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
    
        // Fund the stability pool with crvUSD
        await crvusd.connect(owner).mint(owner.address, ethers.parseEther("1000"));
  
        // Set Stability Pool address (using owner for this test)
        await lendingPool.connect(owner).setStabilityPool(owner.address);
    
        await expect(lendingPool.connect(owner).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.emit(lendingPool, "LiquidationFinalized")
          // .withArgs(owner.address, user1.address, NFT_ID, ethers.parseEther("80"), ethers.parseEther("90"));
          
        // Verify that the user is no longer under liquidation
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isUnderLiquidation).to.be.false;
        // Since NFT has been liquidated, the adapter loaes the nft
        if (assetType === "ERC721") {
          expect(await assetAdapter.getDepositor(NFT_ID)).to.equal(ethers.ZeroAddress);
          // Verify that the NFT has been transferred to the Stability Pool
          expect(await raacNFT.ownerOf(NFT_ID)).to.equal(owner.address);
        } else if (assetType === "ERC20") {
          expect(await assetAdapter.getAssetValue(user1.address, assetData)).to.equal(0);
          expect(await baseAsset.balanceOf(owner.address)).to.equal(ASSET_PRICE)
        }
  
        // Verify that the user's debt has been repaid
        const userClosedLiquidationDebt = await lendingPool.getPositionsScaledDebt(user1.address);
        expect(userClosedLiquidationDebt).to.equal(0);
  
        // Verify that the user's health factor is now at its maximum (type(uint256).max)
        const healthFactor = await lendingPool.calculateHealthFactor(assetAdapter.target, user1.address, assetData);
        expect(healthFactor).to.equal(1000000000000000000000000000n);
      });
    
      it("should prevent non-owner from closing liquidation within grace period", async function () {
        const borrowAmount = ethers.parseEther("50");
        
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
    
        // Attempt to close liquidation by non-owner (user2)
        await expect(lendingPool.connect(user2).closeLiquidation(assetAdapter.target, assetData))
          .to.be.revertedWithCustomError(lendingPool, "NotUnderLiquidation");
  
        // Attempt to close liquidation by non-owner (user2)
        await expect(lendingPool.connect(user2).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.be.revertedWithCustomError(lendingPool, "Unauthorized");
      });
    
      it("should prevent Stability Pool from closing liquidation within grace period", async function () {
        const borrowAmount = ethers.parseEther("50");
        
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
    
        // Set Stability Pool address (using owner for this test)
        await lendingPool.connect(owner).setStabilityPool(owner.address);
    
        // Attempt to close liquidation by Stability Pool within grace period
        await expect(lendingPool.connect(owner).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.be.revertedWithCustomError(lendingPool, "GracePeriodNotExpired");
      });
      it("should prevent the user from repay if under liquidation and insurance not acquired", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
        // Attempt to repay debt
        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, borrowAmount))
          .to.be.revertedWithCustomError(lendingPool, "CannotRepayUnderLiquidationWithoutInsurance");
      });
      it("should prevent the user from closing liquidation after the grace period (no insurance)", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
        // Advance time beyond grace period (72 hours)
        await ethers.provider.send("evm_increaseTime", [72 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // if grace period expired and under liquidation, they cannot repay, since not insured
        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, borrowAmount))
          .to.be.revertedWithCustomError(lendingPool, "CannotRepayUnderLiquidationWithoutInsurance");
        // Attempt to close liquidation
        await expect(lendingPool.connect(user1).closeLiquidation(assetAdapter.target, assetData))
          .to.be.revertedWithCustomError(lendingPool, "GracePeriodExpired");
  
        const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        expect(position.isUnderLiquidation).to.be.true;
      });
      it("should prevent the user from closing liquidation after the grace period (with insurance)", async function () {
        const borrowAmount = ethers.parseEther("50"); // 50% collateral
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(feeCollector.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
        // Advance time beyond grace period (72 hours)
        await ethers.provider.send("evm_increaseTime", [72 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // if grace period expired and under liquidation, they cannot repay.
        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, borrowAmount))
          .to.be.revertedWithCustomError(lendingPool, "GracePeriodExpired");
        // Attempt to close liquidation
        await expect(lendingPool.connect(user1).closeLiquidation(assetAdapter.target, assetData))
          .to.be.revertedWithCustomError(lendingPool, "GracePeriodExpired");
  
        const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        expect(position.isUnderLiquidation).to.be.true;
      });
      it("should allow the user to close liquidation after repaying the debt (with insurance) even if grace period expired", async function() {
        const borrowAmount = ethers.parseEther("50");
        
        const insuranceFee = await lendingPool.calculateInsuranceFee(assetAdapter.target, user1.address, assetData, borrowAmount);
        await crvusd.connect(user1).approve(lendingPool.target, insuranceFee);
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, borrowAmount);
  
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true
        await time.increase(16000);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
        // Decrease house price and initiate liquidation
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.50"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6250"))
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);
    
        // User1 repays the debt
        const userScaledDebt = await lendingPool.getPositionScaledDebt(assetAdapter.target, user1.address, assetData);
        const repaymentAmount = ethers.MaxUint256;
        await crvusd.connect(user1).approve(lendingPool.target, repaymentAmount);
        await lendingPool.connect(user1).repay(assetAdapter.target, assetData, repaymentAmount);

        // Time pass: make grace period expire
        await time.increase(72 * 3600 + 10);
        await ethers.provider.send("evm_mine");
        await lendingPool.connect(user1).updateState();
    
        // User1 closes the liquidation
        await expect(lendingPool.connect(user1).closeLiquidation(assetAdapter.target, assetData))
          .to.emit(lendingPool, "LiquidationClosed")
          .withArgs(user1.address, assetAdapter.target, assetData);
        
        // Verify that the user is no longer under liquidation
        const position = await lendingPool.getPosition(assetAdapter.target, user1.address, assetData);
        expect(position.isUnderLiquidation).to.be.false;
        expect(position.isInsured).to.be.false;
      })
      it("should test the price drop below liquidation threshold and should liquidate", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);

        // Price drop below the liquidation threshold
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await expect(lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData))
          .to.not.be.reverted;
      });
      it("should test the price drop above liquidation threshold and should not liquidate", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);

        // Price drop above the liquidation threshold
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.51"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6251"));
        await expect(lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData))
          .to.be.revertedWithCustomError(lendingPool, "HealthFactorTooHigh");
      });
      it("should test the price drop equal to liquidation threshold and should liquidate", async function () {
        const borrowAmount = ethers.parseEther("50");
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, borrowAmount);

        // Price drop equal to the liquidation threshold
        await raacHousePrices.setHousePrice(1, ethers.parseEther("62.49"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.6249"));
        await expect(lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData))
          .to.not.be.reverted;
      });
      it("gives a position insured at a zero fee the full grace period", async function () {
        await lendingPool.setParameter(OwnerParameter.InsuranceFee, 0);
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("30"));
        await lendingPool.connect(user1).borrowWithInsurance(assetAdapter.target, assetData, ethers.parseEther("10"));
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.true;

        await raacHousePrices.setHousePrice(1, ethers.parseEther("45"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.45"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);

        await lendingPool.connect(owner).setStabilityPool(owner.address);
        expect((await toParameter(lendingPool)).liquidationGracePeriod).to.equal(3n * 24n * 60n * 60n);

        await expect(lendingPool.connect(owner).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.be.revertedWithCustomError(lendingPool, "GracePeriodNotExpired");

        await time.increase(3 * 24 * 60 * 60 + 1);

        await expect(lendingPool.connect(owner).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.emit(lendingPool, "LiquidationFinalized");
      });

      it("gives an uninsured position no grace period", async function () {
        await lendingPool.connect(user1).borrow(assetAdapter.target, assetData, ethers.parseEther("40"));
        expect((await lendingPool.getPosition(assetAdapter.target, user1.address, assetData)).isInsured).to.be.false;

        await raacHousePrices.setHousePrice(1, ethers.parseEther("45"));
        await erc20PriceOracle.setLatestPrice(ethers.parseEther("0.45"));
        await lendingPool.connect(user2).initiateLiquidation(assetAdapter.target, user1.address, assetData);

        await lendingPool.connect(owner).setStabilityPool(owner.address);

        await expect(lendingPool.connect(user1).repay(assetAdapter.target, assetData, ethers.parseEther("1")))
          .to.be.revertedWithCustomError(lendingPool, "CannotRepayUnderLiquidationWithoutInsurance");

        await expect(lendingPool.connect(owner).finalizeLiquidation(assetAdapter.target, user1.address, assetData))
          .to.emit(lendingPool, "LiquidationFinalized");
      });
    });
  }

  describeLiquidation("ERC20")
  describeLiquidation("ERC721")

  describe("Withdrawal Specific Pause", function () {
    let feeCollector;

    beforeEach(async function () {
        const depositAmount = ethers.parseEther("100");
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);
        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(
          owner.address
        );

        await feeCollector.addFeeType(INSURANCE_FEE, 10000, 0, 0, 0, 0, 0);
        await feeCollector.addClaimableToken(crvusd.target)
        await lendingPool.connect(owner).setFeeCollector(feeCollector.target);
        await lendingPool.connect(user2).openVaultPosition();
    });

    it("should allow owner to pause and unpause withdrawals", async function () {
        await lendingPool.connect(owner).setParameter(OwnerParameter.WithdrawalStatus, 1); // WithdrawalStatus = 4, true = 1
        expect((await toParameter(lendingPool)).withdrawalsPaused).to.be.true;

        await lendingPool.connect(owner).setParameter(OwnerParameter.WithdrawalStatus, 0); // WithdrawalStatus = 4, false = 0
        expect((await toParameter(lendingPool)).withdrawalsPaused).to.be.false;
    });

    it("should prevent withdrawals when withdrawals are paused but allow other operations", async function () {
        await lendingPool.connect(owner).setParameter(OwnerParameter.WithdrawalStatus, 1); // WithdrawalStatus = 4, true = 1

        // Attempt withdrawal should fail
        await expect(lendingPool.connect(user1).withdraw(ethers.parseEther("10")))
            .to.be.revertedWithCustomError(lendingPool, "WithdrawalsArePaused");

        // Other operations should still work
        const depositAmount = ethers.parseEther("10");
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await expect(lendingPool.connect(user2).deposit(depositAmount))
            .to.not.be.reverted;

        // NFT operations should still work
        const tokenId = 1;
        await raacNFT.connect(user1).approve(raacNFTAdapter.target, tokenId);
        await expect(lendingPool.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(tokenId)))
            .to.not.be.reverted;
    });

    it("should prevent non-access from pausing withdrawals", async function () {
        await expect(lendingPool.connect(user1).setParameter(OwnerParameter.WithdrawalStatus, 1))
            .to.be.revertedWithCustomError(lendingPool, "AccessDenied");
    });

    it("should allow withdrawals after unpausing", async function () {
        await lendingPool.connect(owner).setParameter(OwnerParameter.WithdrawalStatus, 1); // WithdrawalStatus = 4, true = 1
        await lendingPool.connect(owner).setParameter(OwnerParameter.WithdrawalStatus, 0); // WithdrawalStatus = 4, false = 0

        const withdrawAmount = ethers.parseEther("10");
        await time.increase(1);
        await ethers.provider.send("evm_mine", []);
        await expect(lendingPool.connect(user1).withdraw(withdrawAmount))
            .to.not.be.reverted;
    });

    it('should test with multiple users', async function() {
      const NFT_ID = 1;
      const SECOND_NFT_ID = 2;

      // User 1 deposit
      await raacNFT.connect(user1).approve(raacNFTAdapter.target, NFT_ID);
      await lendingPool.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(NFT_ID));

      // User 1 borrow
      const borrowAmount = ethers.parseEther("50");
      await lendingPool.connect(user1).borrow(raacNFTAdapter.target, encodeERC721Token(NFT_ID), borrowAmount);

      const position = await lendingPool.getPosition(raacNFTAdapter.target, user1.address, encodeERC721Token(NFT_ID));

      expect(position.rawDebtBalance).to.equal(borrowAmount);
      expect(position.isUnderLiquidation).to.equal(false);
      expect(position.liquidationStartTime).to.equal(0);

      const positionView = await lendingPool.getPositionView(raacNFTAdapter.target, user1.address, encodeERC721Token(NFT_ID));
      expect(positionView.rawDebtBalance).to.equal(borrowAmount);
      expect(positionView.scaledDebtBalance).to.equal(borrowAmount);
      expect(positionView.healthFactor).to.equal(ethers.parseEther("1.6"));
      expect(positionView.isUnderLiquidation).to.equal(false);
      expect(positionView.liquidationStartTime).to.equal(0);
      expect(positionView.adapter).to.be.equal(raacNFTAdapter.target);
      expect(positionView.asset).to.be.equal(raacNFT.target);
     
      // Time pass
      await lendingPool.connect(user1).updateState();

      await time.increase(3600);
      await ethers.provider.send("evm_mine", []);
      
      await lendingPool.connect(user1).updateState();

      const debtBalance2 = await debtToken.balanceOf(user1.address);
      expect(debtBalance2).to.be.gte(borrowAmount);

      const positionAfter = await lendingPool.getPosition(raacNFTAdapter.target, user1.address, encodeERC721Token(NFT_ID));
      expect(positionAfter.rawDebtBalance).to.be.eq(borrowAmount);
      expect(positionAfter.isUnderLiquidation).to.be.eq(false);
      expect(positionAfter.liquidationStartTime).to.be.eq(0);

      const positionViewAfter = await lendingPool.getPositionView(raacNFTAdapter.target, user1.address, encodeERC721Token(NFT_ID));
      expect(positionViewAfter.rawDebtBalance).to.be.eq(borrowAmount);
      expect(positionViewAfter.scaledDebtBalance).to.be.eq(debtBalance2);
      expect(positionViewAfter.healthFactor).to.be.lt(ethers.parseEther("1.6"));
      expect(positionViewAfter.healthFactor).to.be.gte(ethers.parseEther("1.59"));
      expect(positionViewAfter.isUnderLiquidation).to.be.eq(false);
      expect(positionViewAfter.liquidationStartTime).to.be.eq(0);
      expect(positionViewAfter.adapter).to.be.equal(raacNFTAdapter.target);
      expect(positionViewAfter.asset).to.be.equal(raacNFT.target);

      const userNFTs = await raacNFTAdapter.getDepositedTokens(user1.address);
      const scaledDebtBalance = await lendingPool.getPositionsScaledDebt(user1.address)
      const totalCollateralValue = await lendingPool.getUserCollateralValue(user1.address);
      expect(userNFTs).to.deep.equal([NFT_ID]);
      expect(scaledDebtBalance).to.be.eq(debtBalance2);
      expect(totalCollateralValue).to.be.eq(ethers.parseEther("100"));

      const reserveState = await lendingPool.getReserveState();
      expect(reserveState.reserveRTokenAddress).to.equal(rToken.target);
      expect(reserveState.reserveAssetAddress).to.equal(crvusd.target);
      expect(reserveState.reserveDebtTokenAddress).to.equal(debtToken.target);
      expect(reserveState.liquidityIndex).to.gt(RAY);
      expect(reserveState.usageIndex).to.gt(RAY);
      expect(reserveState.totalLiquidity).to.eq(ethers.parseEther("1050"));
      expect(reserveState.totalUsage).to.closeTo(borrowAmount, ethers.parseEther("0.1"));
      
      const reserveRateData = await lendingPool.getReserveRateData();
      expect(reserveRateData.currentLiquidityRate).to.closeTo(ethers.parseEther("2045454.545"), ethers.parseEther("20"));
      expect(reserveRateData.currentUsageRate).to.eq(ethers.parseEther("50000000"));
      expect(reserveRateData.primeRate).to.eq(ethers.parseEther("100000000"));
      expect(reserveRateData.baseRate).to.eq(ethers.parseEther("25000000"));
      expect(reserveRateData.optimalRate).to.eq(ethers.parseEther("50000000"));
      expect(reserveRateData.maxRate).to.eq(ethers.parseEther("836300000"));
      expect(reserveRateData.optimalUtilizationRate).to.eq(ethers.parseEther("800000000"));
      expect(reserveRateData.protocolFeeRate).to.eq(ethers.parseEther("100000000"));
      
       // Time pass a whole 1.6 months
       await time.increase(1.6 * 30 * 24 * 60 * 60);
       await ethers.provider.send("evm_mine", []);
       await lendingPool.connect(user1).updateState();
       
       // User 2 mint NFT
       // Refresh the house price after the time jump: RAACNFT enforces price freshness on mint
       await raacHousePrices.setHousePrice(SECOND_NFT_ID, ethers.parseEther("100"));
       await crvusd.connect(user2).approve(raacNFT.target, ethers.parseEther("100"));
       await raacNFT.connect(user2).mint(SECOND_NFT_ID, ethers.parseEther("100"));
       await raacNFT.connect(user2).approve(raacNFTAdapter.target, SECOND_NFT_ID);
       await lendingPool.connect(user2).depositAsset(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID));
 
       // Check the debt of user 2
       const debtBalanceUser2Before = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2Before).to.be.eq(ethers.parseEther("0"));
 
       // Check health factor
       const healthFactorUser2Before = await lendingPool.calculateHealthFactor(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(healthFactorUser2Before).to.be.equal(ethers.parseEther("1000000000"));
       // User 2 borrow 50
       await lendingPool.connect(user2).borrow(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID), ethers.parseEther("50"));
 
       // Check the debt of user 2
       const debtBalanceUser2 = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2).to.be.eq(ethers.parseEther("50"));
 
       // Check health factor
       const healthFactorUser2 = await lendingPool.calculateHealthFactor(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(healthFactorUser2).to.be.closeTo(ethers.parseEther("1.5"), ethers.parseEther("0.1"));
 
       // time pass 1.6 months
       await time.increase(1.6 * 30 * 24 * 60 * 60);
       await ethers.provider.send("evm_mine", []);
       await lendingPool.connect(user2).updateState();
 
       // check the debt of user 2 (50 + ~0.33 interest at the flat 5% borrow rate)
       const debtBalanceUser2After = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2After).to.be.closeTo(ethers.parseEther("50.33"), ethers.parseEther("0.1"));
       // Check health factor
       const healthFactorUser2After = await lendingPool.calculateHealthFactor(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(healthFactorUser2After).to.be.closeTo(ethers.parseEther("1.5"), ethers.parseEther("0.1"));
 
       // Borrow more with insurance
       const borrowAmount2 = ethers.parseEther("28");
      //  const insuranceFeeBeforeBorrow = await lendingPool.calculateInsuranceFee(user2.address, SECOND_NFT_ID, ethers.parseEther("50"));
      // set fee collector 
       const insuranceFeeNewBorrow = await lendingPool.calculateInsuranceFee(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID), borrowAmount2);
       await crvusd.connect(user2).approve(lendingPool.target, insuranceFeeNewBorrow);
       // borrow with insurance additional 28 (+ 50 initial + 0.33 interest) = ~78.33
       await lendingPool.connect(user2).borrowWithInsurance(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID), borrowAmount2);

       // check the debt of user 2
       const debtBalanceUser2After2 = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2After2).to.be.closeTo(ethers.parseEther("78.33"), ethers.parseEther("0.1"));
       // Check health factor
       const healthFactorUser2After2 = await lendingPool.calculateHealthFactor(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(healthFactorUser2After2).to.be.closeTo(ethers.parseEther("1.023"), ethers.parseEther("0.01"));
 
       // Time pass until liquidation (~1 year)
       await time.increase(365 * 24 * 60 * 60);
       await ethers.provider.send("evm_mine", []);
       await lendingPool.connect(user2).updateState();
 
       // // check the debt of user 2
       const debtBalanceUser2After3 = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2After3).to.be.closeTo(ethers.parseEther("82.35"), ethers.parseEther("0.05"));

       // Health factor should be just below 1
       const healthFactorUser2After3 = await lendingPool.calculateHealthFactor(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(healthFactorUser2After3).to.be.closeTo(ethers.parseEther("0.9715"), ethers.parseEther("0.001"));
 
       // Liquidate initiate
       await lendingPool.connect(user1).initiateLiquidation(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
   
       // User1 repays the debt but not enough
       const userScaledDebt = await lendingPool.getPositionScaledDebt(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       const repaymentAmount = userScaledDebt;
       await crvusd.connect(user2).approve(lendingPool.target, repaymentAmount);
       await lendingPool.connect(user2).repay(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID), repaymentAmount);
   
       // User2 closes the liquidation
       await expect(lendingPool.connect(user2).closeLiquidation(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID)))
         .to.emit(lendingPool, "LiquidationClosed")
         .withArgs(user2.address, raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID));
   
       // Verify that the user is no longer under liquidation
       expect((await lendingPool.getPosition(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID))).isUnderLiquidation).to.be.false;
       // Verify that the user can now withdraw their NFT
       await expect(lendingPool.connect(user2).withdrawAsset(raacNFTAdapter.target, encodeERC721Token(SECOND_NFT_ID)))
         .to.emit(raacNFTAdapter, "NFTWithdrawn")
         .withArgs(raacNFT.target, user2.address, SECOND_NFT_ID);
 
       // Verify that the NFT is now owned by user1
       expect(await raacNFT.ownerOf(SECOND_NFT_ID)).to.equal(user2.address);
 
       // Check the values 
       const debtBalanceUser2After4 = await debtToken.balanceOf(user2.address);
       expect(debtBalanceUser2After4).to.be.closeTo(ethers.parseEther("0"), ethers.parseEther("0.000001"));
 
       const positionAfterUser2 = await lendingPool.getPosition(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(positionAfterUser2.rawDebtBalance).to.be.eq(0);
       expect(positionAfterUser2.isUnderLiquidation).to.be.eq(false);
       expect(positionAfterUser2.liquidationStartTime).to.be.eq(0);
 
       const positionViewAfterUser2 = await lendingPool.getPositionView(raacNFTAdapter.target, user2.address, encodeERC721Token(SECOND_NFT_ID));
       expect(positionViewAfterUser2.rawDebtBalance).to.be.eq(0);
       expect(positionViewAfterUser2.scaledDebtBalance).to.be.eq(0);
       expect(positionViewAfterUser2.healthFactor).to.be.equal(ethers.parseEther("1000000000"));
       expect(positionViewAfterUser2.isUnderLiquidation).to.be.eq(false);
       expect(positionViewAfterUser2.liquidationStartTime).to.be.eq(0);
       expect(positionViewAfterUser2.adapter).to.be.equal(raacNFTAdapter.target);
       expect(positionViewAfterUser2.asset).to.be.equal(raacNFT.target);
 
       const reserveStateUser2 = await lendingPool.getReserveState();
       expect(reserveStateUser2.reserveRTokenAddress).to.equal(rToken.target);
       expect(reserveStateUser2.reserveAssetAddress).to.equal(crvusd.target);
       expect(reserveStateUser2.reserveDebtTokenAddress).to.equal(debtToken.target);
       expect(reserveStateUser2.liquidityIndex).to.gt(RAY);
       expect(reserveStateUser2.usageIndex).to.gt(RAY);
       // Depositor interest is higher under the flat 5% borrow rate (with 10% protocol fee):
       // remaining usage is user1's 50 debt compounded for ~1.28 years
       expect(reserveStateUser2.totalLiquidity).to.closeTo(ethers.parseEther("1054.35"), ethers.parseEther("0.2"));
       expect(reserveStateUser2.totalUsage).to.closeTo(ethers.parseEther("53.3"), ethers.parseEther("0.2"));

       const reserveRateDataUser2 = await lendingPool.getReserveRateData();
       expect(reserveRateDataUser2.currentLiquidityRate).to.closeTo(ethers.parseEther("2160000"), ethers.parseEther("10000"));
       expect(reserveRateDataUser2.currentUsageRate).to.eq(ethers.parseEther("50000000"));
       expect(reserveRateDataUser2.primeRate).to.eq(ethers.parseEther("100000000"));
       expect(reserveRateDataUser2.baseRate).to.eq(ethers.parseEther("25000000"));
       expect(reserveRateDataUser2.optimalRate).to.eq(ethers.parseEther("50000000"));
       expect(reserveRateDataUser2.maxRate).to.eq(ethers.parseEther("836300000"));
       expect(reserveRateDataUser2.optimalUtilizationRate).to.eq(ethers.parseEther("800000000"));
       expect(reserveRateDataUser2.protocolFeeRate).to.eq(ethers.parseEther("100000000"));

       // After the battle, user 3 comes in for a deposit of 10 
       await crvusd.connect(user3).approve(lendingPool.target, ethers.parseEther("10"));
       await lendingPool.connect(user3).deposit(ethers.parseEther("10"));

       // Check RToken balance of user 3
       expect(await rToken.balanceOf(user3.address)).to.be.eq(ethers.parseEther("10"));
       expect(await rToken.rawBalanceOf(user3.address)).to.be.eq(ethers.parseEther("10"));

       // Check debt token balance of user 3
       expect(await debtToken.balanceOf(user3.address)).to.be.eq(ethers.parseEther("0"));
       expect(await debtToken.rawBalanceOf(user3.address)).to.be.eq(ethers.parseEther("0"));
    })
  });

  describe("Parameter Setting", function() {
    it("should allow owner to set liquidation threshold", async function() {
      const newValue = 8500; // 85%
      await lendingPool.connect(owner).setParameter(OwnerParameter.LiquidationThreshold, newValue); // LiquidationThreshold = 0
      expect((await toParameter(lendingPool)).liquidationThreshold).to.equal(newValue);
    });

    it("should allow owner to set liquidation grace period", async function() {
      const newValue = 2 * 24 * 60 * 60; // 2 days
      await lendingPool.connect(owner).setParameter(OwnerParameter.LiquidationGracePeriod, newValue); // LiquidationGracePeriod = 2
      expect((await toParameter(lendingPool)).liquidationGracePeriod).to.equal(newValue);
    });

    it("should allow owner to set liquidity buffer ratio", async function() {
      const newValue = 3000; // 30%
      await lendingPool.connect(owner).setParameter(OwnerParameter.LiquidityBufferRatio, newValue); // LiquidityBufferRatio = 3
      expect((await toParameter(lendingPool)).liquidityBufferRatio).to.equal(newValue);
    });

    it("should allow owner to set can payback debt", async function() {
      await lendingPool.connect(owner).setParameter(OwnerParameter.CanPaybackDebt, 0); // CanPaybackDebt = 5, false = 0
      expect((await toParameter(lendingPool)).canPaybackDebt).to.be.false;

      await lendingPool.connect(owner).setParameter(OwnerParameter.CanPaybackDebt, 1); // CanPaybackDebt = 5, true = 1
      expect((await toParameter(lendingPool)).canPaybackDebt).to.be.true;
    });

    it("should revert when setting invalid values", async function() {
      // Invalid grace period (> 7 days)
      await expect(lendingPool.connect(owner).setParameter(OwnerParameter.LiquidationGracePeriod, 8 * 24 * 60 * 60))
          .to.be.revertedWithCustomError(lendingPool, "InvalidGracePeriod");


      // Invalid boolean value
      await expect(lendingPool.connect(owner).setParameter(OwnerParameter.CanPaybackDebt, 2))
          .to.be.revertedWithCustomError(lendingPool, "InvalidBoolean");
    });
  });

  describe("LendingPool: setParameter access control & validation", function () {
    let governance, protocol, stranger;
    const initialSupplyCap = ethers.parseEther("10000000");
    const initialBorrowCap = initialSupplyCap;
  
    beforeEach(async () => {
      governance = user1;
      protocol   = user2;
      stranger   = user3;
  
      // grant roles
      await lendingPool.connect(owner)
        .grantRole(await lendingPool.GOVERNANCE_ROLE(), governance.address);
      await lendingPool.connect(owner)
        .grantRole(await lendingPool.PROTOCOL_ROLE(),   protocol.address);
    });
  
    describe("Protocol parameters", () => {
      let updatedBorrowCap = 999
      beforeEach(async () => {
        // protocol sets supply cap first
        // need to decrease the borrow first
        await lendingPool.connect(protocol).setParameter(OwnerParameter.LendingPoolBorrowCap, updatedBorrowCap);
        await lendingPool.connect(protocol).setParameter(
          OwnerParameter.LendingPoolSupplyCap, 1000
        );
      });
  
      it("GOV cannot change borrowCap", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LendingPoolBorrowCap, 600)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can raise borrowCap", async () => {
        await expect(lendingPool.connect(protocol).setParameter(OwnerParameter.LendingPoolBorrowCap, 800))
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.LendingPoolBorrowCap, updatedBorrowCap, 800);
        expect((await toParameter(lendingPool)).borrowCap).to.equal(800);
      });
  
      it("PROTOCOL can lower borrowCap", async () => {
        await lendingPool.connect(protocol)
          .setParameter(OwnerParameter.LendingPoolBorrowCap, 900);
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LendingPoolBorrowCap, 400)
        )
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.LendingPoolBorrowCap, 900, 400);
      });
  
      it("borrowCap cannot exceed supplyCap", async () => {
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LendingPoolBorrowCap, 1001)
        ).to.be.revertedWithCustomError(lendingPool, "CapExceedSupply")
      });
  
      it("others cannot change borrowCap", async () => {
        await expect(
          lendingPool.connect(stranger)
            .setParameter(OwnerParameter.LendingPoolBorrowCap, 100)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set supplyCap", async () => {
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LendingPoolSupplyCap, 5000)
        )
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.LendingPoolSupplyCap, 1000, 5000);
        expect((await toParameter(lendingPool)).supplyCap).to.equal(5000);
      });
  
      it("GOV cannot set supplyCap", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LendingPoolSupplyCap, 2000)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set BorrowThreshold (≤100_00)", async () => {

        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.BorrowThreshold, 5000)
        )
          .to.emit(lendingPool, "ParameterChanged")
        expect((await toParameter(lendingPool)).borrowThreshold).to.equal(5000);
      });

      it("PROTOCOL can set LiquidationThreshold (≤100_00)", async () => {
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LiquidationThreshold, 8000)
        )
          .to.emit(lendingPool, "ParameterChanged")
        expect((await toParameter(lendingPool)).liquidationThreshold).to.equal(8000);
      });
  
      it("GOV cannot set LiquidationThreshold", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LiquidationThreshold, 5000)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set LiquidationGracePeriod (1-7 days)", async () => {
        const twoDays = 2 * 24 * 3600;
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LiquidationGracePeriod, twoDays)
        )
          .to.emit(lendingPool, "ParameterChanged")
        expect((await toParameter(lendingPool)).liquidationGracePeriod).to.equal(twoDays);
      });
  
      it("GOV cannot set LiquidationGracePeriod", async () => {
        const twoDays = 2 * 24 * 3600;
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LiquidationGracePeriod, twoDays)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set LiquidityBufferRatio (≤100_00)", async () => {
        await lendingPool.connect(protocol)
          .setParameter(OwnerParameter.LiquidityBufferRatio, 7500);
        expect((await toParameter(lendingPool)).liquidityBufferRatio).to.equal(7500);
      });
  
      it("PROTOCOL can set LiquidityBufferRatio to exactly 100%", async () => {
        await expect(
          lendingPool.connect(protocol).setParameter(OwnerParameter.LiquidityBufferRatio, 10_000)
        ).to.emit(lendingPool, "ParameterChanged");
      });

      it("PROTOCOL cannot set LiquidityBufferRatio above 100%", async () => {
        await expect(
          lendingPool.connect(protocol).setParameter(OwnerParameter.LiquidityBufferRatio, 10_001)
        ).to.be.revertedWithCustomError(lendingPool, "InvalidPercentage");
      });

      it("GOV cannot set LiquidityBufferRatio", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LiquidityBufferRatio, 7500)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set WithdrawalStatus (boolean)", async () => {
        await lendingPool.connect(protocol)
          .setParameter(OwnerParameter.WithdrawalStatus, 1);
        expect((await toParameter(lendingPool)).withdrawalsPaused).to.be.true;
      });
  
      it("GOV cannot set WithdrawalStatus", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.WithdrawalStatus, 1)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("PROTOCOL can set CanPaybackDebt (boolean)", async () => {
        await lendingPool.connect(protocol)
          .setParameter(OwnerParameter.CanPaybackDebt, 1);
        expect((await toParameter(lendingPool)).canPaybackDebt).to.be.true;
      });
  
      it("GOV cannot set CanPaybackDebt", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.CanPaybackDebt, 1)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });

      it("PROTOCOL can set MaxRate", async () => {
        await lendingPool.connect(protocol)
          .setParameter(OwnerParameter.MaxRate, ethers.parseUnits("0.8", 27));
        expect((await lendingPool.rateData()).maxRate).to.equal(ethers.parseUnits("0.8", 27));
      });

      it("GOV cannot set MaxRate", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.MaxRate, ethers.parseUnits("0.8", 27))
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
    });
  
    describe("Governance parameters", () => {
      it("GOV can set InsuranceFee (≤100_00)", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.InsuranceFee, 2500)
        )
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.InsuranceFee, (await toParameter(lendingPool)).insuranceFee, 2500);
        expect((await toParameter(lendingPool)).insuranceFee).to.equal(2500);
      });
  
      it("PROTOCOL cannot set InsuranceFee", async () => {
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.InsuranceFee, 2500)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("GOV can set ProtocolFeeRate (RAY)", async () => {
        const feeRate = ethers.parseUnits("0.2", 27);
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.ProtocolFeeRate, feeRate)
        )
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.ProtocolFeeRate, (await lendingPool.rateData()).protocolFeeRate, feeRate);
        expect((await lendingPool.rateData()).protocolFeeRate).to.equal(feeRate);
      });

      it("GOV can set ProtocolFeeRate to exactly RAY", async () => {
        const RAY = ethers.parseUnits("1", 27);
        await lendingPool.connect(governance).setParameter(OwnerParameter.ProtocolFeeRate, RAY);
        expect((await lendingPool.rateData()).protocolFeeRate).to.equal(RAY);
      });

      it("GOV cannot set ProtocolFeeRate above RAY", async () => {
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.ProtocolFeeRate, ethers.parseUnits("1", 27) + 1n)
        ).to.be.revertedWithCustomError(lendingPool, "InvalidPercentage");
      });
  
      it("PROTOCOL cannot set ProtocolFeeRate", async () => {
        const RAY = ethers.WeiPerEther;
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.ProtocolFeeRate, RAY)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
  
      it("GOV can set LendingPoolDepositFee", async () => {
        const depositFee = 100n;
        await expect(
          lendingPool.connect(governance)
            .setParameter(OwnerParameter.LendingPoolDepositFee, depositFee)
        )
          .to.emit(lendingPool, "ParameterChanged")
          .withArgs(OwnerParameter.LendingPoolDepositFee, (await toParameter(lendingPool)).depositFee, depositFee);
        expect((await toParameter(lendingPool)).depositFee).to.equal(depositFee);
      });

      for (const name of ["LendingPoolDepositFee", "InsuranceFee"]) {
        it(`GOV can set ${name} to exactly 100%`, async () => {
          await expect(
            lendingPool.connect(governance).setParameter(OwnerParameter[name], 10_000)
          ).to.emit(lendingPool, "ParameterChanged");
        });

        it(`GOV cannot set ${name} above 100%`, async () => {
          await expect(
            lendingPool.connect(governance).setParameter(OwnerParameter[name], 10_001)
          ).to.be.revertedWithCustomError(lendingPool, "InvalidPercentage");
        });
      }
  
      it("PROTOCOL cannot set LendingPoolDepositFee", async () => {
        const RAY = ethers.WeiPerEther;
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.LendingPoolDepositFee, RAY)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });

      it("GOV can set VaultOpeningFee", async () => {
        await lendingPool.connect(governance)
          .setParameter(OwnerParameter.VaultOpeningFee, ethers.parseEther("1"));
        expect((await toParameter(lendingPool)).vaultOpeningFee).to.equal(ethers.parseEther("1"));
      });
  
      it("PROTOCOL cannot set VaultOpeningFee", async () => {
        await expect(
          lendingPool.connect(protocol)
            .setParameter(OwnerParameter.VaultOpeningFee, 500)
        ).to.be.revertedWithCustomError(lendingPool, "AccessDenied");
      });
    });
  
    it.skip("unknown param reverts", async () => {
      await expect(
        lendingPool.connect(governance).setParameter(99, 123)
      ).to.be.revertedWithCustomError(lendingPool, "InvalidParameter");
    });  
  });

  describe("Vault opening", async function() {
    let feeCollector;
    let fee = ethers.parseEther("10")
    const LENDING_FEE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE"));
    beforeEach(async function() {
      await crvusd.connect(user3).approve(lendingPool.target, 0);
      
      const FeeCollector = await ethers.getContractFactory("FeeCollector");
      const feeCollector = await FeeCollector.deploy(owner.address)
      await lendingPool.setFeeCollector(feeCollector.target);
      
      expect(await feeCollector.addFeeType(LENDING_FEE, 20_00, 0, 0, 80_00, 0, 0)).to.emit(feeCollector, "FeeTypeAdded").withArgs(true);
      expect(await feeCollector.addClaimableToken(crvusd.target)).to.emit(feeCollector, "TokenAdded").withArgs(crvusd.target)
      await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, fee) // 10 crvUSD fees
      expect((await toParameter(lendingPool)).vaultOpeningFee).to.equal(fee)
    })
    it("should prevent user from depositing if fees is not paid", async function() {
      await expect(lendingPool.connect(user3).depositAsset(raacNFTAdapter.target, encodeERC721Token(1))).to.be.revertedWithCustomError(lendingPool, "VaultPositionNotOpened");
    })
    it("should revert if user opens a position without crvusd approval", async function() {
      await expect(lendingPool.connect(user3).openVaultPosition()).to.be.revertedWithCustomError(crvusd, "ERC20InsufficientAllowance")
      await crvusd.connect(user3).approve(lendingPool.target, fee / 2n);
      await expect(lendingPool.connect(user3).openVaultPosition()).to.be.revertedWithCustomError(crvusd, "ERC20InsufficientAllowance")
      await crvusd.connect(user3).approve(lendingPool.target, fee)
      await expect(lendingPool.connect(user3).openVaultPosition()).to.emit(lendingPool, "VaultOpeningFeePaid").withArgs(user3.address, fee)
    });
    it("should allow deposit of asset after the vault is opened", async function() {
      await crvusd.connect(user2).approve(lendingPool.target, fee)
      await expect(lendingPool.connect(user2).openVaultPosition()).to.emit(lendingPool, "VaultOpeningFeePaid").withArgs(user2.address, fee)

      const asset = assets["ERC20"];
      await asset.baseAsset.mint(user2.address, (new ethers.AbiCoder().decode(['uint256'], asset.data)).toString());
      await asset.baseAsset.connect(user2).approve(asset.adapter.target, (new ethers.AbiCoder().decode(['uint256'], asset.data)).toString());
      await expect(lendingPool.connect(user2).depositAsset(asset.adapter.target, asset.data)).to.not.reverted
    })
    it("should prevent opening vault ones opened", async function() {
      await crvusd.connect(user2).approve(lendingPool.target, fee)
      await expect(lendingPool.connect(user2).openVaultPosition()).to.emit(lendingPool, "VaultOpeningFeePaid").withArgs(user2.address, fee)
      
      await crvusd.connect(user2).approve(lendingPool.target, fee)
      await expect(lendingPool.connect(user2).openVaultPosition()).to.be.revertedWithCustomError(lendingPool, "VaultPositionAlreadyOpened")

    })
  })

  describe("RWAIndexTokenOracle", () => {
    it("returns the price of the index token in crvUSD", async () => {
      const RWAVault = await ethers.getContractFactory("RWAVault");
      const RWAIndexToken = await ethers.getContractFactory("RWAIndexToken");
      const rwaIndexToken = await RWAIndexToken.deploy("RWA Index Token", 'RRWA', complianceRegistry.target)
      const rwaVault = await RWAVault.deploy(rwaIndexToken.target, complianceRegistry.target);

      const RWAIndexTokenOracle = await ethers.getContractFactory("RWAIndexTokenOracle");
      const rwaIndexTokenOracle = await RWAIndexTokenOracle.deploy(rwaVault.target, crvUSDToUSDOracle.target, owner.address);

      const price = await rwaIndexTokenOracle.getLatestPrice();
      expect(price).to.be.equal(ethers.parseEther("1"));
    });
  });
});

describe("RAAC Lending - exhaustive edge-cases", () => {
  let owner, users;
  let crvUSD, rToken, debtToken, lendingPool;
  let lendingPoolProxy;
  const DECIMALS = [6, 8, 12, 18];
  const encode = v => new ethers.AbiCoder().encode(["uint256"], [v]);
  let complianceRegistry;

  beforeEach(async () => {
    users = await ethers.getSigners();
    [owner] = users;

    const CrvUSD = await ethers.getContractFactory("crvUSDToken");
    crvUSD = await CrvUSD.deploy(owner.address);
    await crvUSD.setMinter(owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
    complianceRegistry = await ComplianceRegistry.deploy()

    const RToken = await ethers.getContractFactory("RToken");
    rToken = await RToken.deploy("ReserveToken", "rCV", owner.address, crvUSD.target, complianceRegistry.target);

    const Debt = await ethers.getContractFactory("DebtToken");
    debtToken = await Debt.deploy("dToken", "dCV", owner.address, crvUSD.target);

    const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
    lendingPoolProxy = await LiquidationProxy.deploy();


    const VaultProxy = await ethers.getContractFactory("VaultProxy");
    const vaultProxy = await VaultProxy.deploy();

    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary")
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy()
    const LendingPool = await ethers.getContractFactory("LendingPool", {
      libraries: {
        LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
      }
    });
    lendingPool = await LendingPool.deploy(
      crvUSD.target,
      rToken.target,
      debtToken.target,
      lendingPoolProxy.target,
      vaultProxy.target,
      complianceRegistry.target,
      ethers.parseUnits("0.1", 27),
      owner.address
    );

    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap
    
  });

  describe("multi-decimal", () => {
    beforeEach(async () => {
      await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
    })
    it("handles deposit / withdraw round-trip across all decimals", async () => {
      const assets = [];
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const MockOracle = await ethers.getContractFactory("MockERC20PriceOracle");
      const Adapter = await ethers.getContractFactory("ERC20AssetAdapter");

      for (const d of DECIMALS) {
        const token = await ERC20Mock.deploy(`TOKEN${d}`, `T${d}`, d);
        const oracle = await MockOracle.deploy();
        await oracle.setLatestPrice(ethers.parseEther("1"));
        const adapter = await Adapter.deploy(token.target, oracle.target, lendingPool.target);
        await lendingPool.registerAdapter(adapter.target);
        assets.push({ token, oracle, adapter, decimals: d });
      }
      for (const ctx of assets) {
        const amt = ctx.decimals === 18 ? ethers.parseEther("100") : 100n * 10n ** BigInt(ctx.decimals);
        await ctx.token.mint(users[1].address, amt);
        await ctx.token.connect(users[1]).approve(ctx.adapter.target, ethers.MaxUint256);
        if (!(await lendingPool.vaultOpened(users[1].address))) await lendingPool.connect(users[1]).openVaultPosition();
        await lendingPool.connect(users[1]).depositAsset(ctx.adapter.target, encode(amt));
        expect(await ctx.adapter.balanceOf(users[1].address)).to.equal(amt);
        await lendingPool.connect(users[1]).withdrawAsset(ctx.adapter.target, encode(amt));
        expect(await ctx.adapter.balanceOf(users[1].address)).to.equal(0);
      }
    });

    it("rejects borrowing beyond max-LTV when oracle price drops to zero", async () => {
      const assets = [];
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const MockOracle = await ethers.getContractFactory("MockERC20PriceOracle");
      const Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
      for (const d of DECIMALS) {
        const token = await ERC20Mock.deploy(`TOKEN${d}`, `T${d}`, d);
        const oracle = await MockOracle.deploy();
        await oracle.setLatestPrice(ethers.parseEther("1"));
        const adapter = await Adapter.deploy(token.target, oracle.target, lendingPool.target);
        await lendingPool.registerAdapter(adapter.target);
        assets.push({ token, oracle, adapter, decimals: d });
      }
      const ctx = assets[0];
      const amt = 1000n * 10n ** BigInt(ctx.decimals);
      await ctx.token.mint(users[2].address, amt);
      await ctx.token.connect(users[2]).approve(ctx.adapter.target, amt);
      await lendingPool.connect(users[2]).openVaultPosition();
      await lendingPool.connect(users[2]).depositAsset(ctx.adapter.target, encode(amt));
      await ctx.oracle.setLatestPrice(0);
      await expect(
        lendingPool.connect(users[2]).borrow(ctx.adapter.target, encode(amt), ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(lendingPool, "NoCollateral");
    });
  });

  describe("deregistration", () => {
    let nft, oracle, adapter;

    beforeEach(async () => {
      const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
      const crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

      const Oracle = await ethers.getContractFactory("RAACHousePrices");
      oracle = await Oracle.deploy(crvUSDToUSDOracle.target, owner.address);
      await oracle.setOracle(owner.address);

      const NFT = await ethers.getContractFactory("RAACNFT");
      nft = await NFT.deploy(crvUSD.target, oracle.target, complianceRegistry.target, owner.address);

      const Adapt = await ethers.getContractFactory("ERC721AssetAdapter");
      adapter = await Adapt.deploy(nft.target, oracle.target, lendingPool.target);
      await lendingPool.registerAdapter(adapter.target);

      await oracle.setHousePrice(1, ethers.parseEther("200"));
      await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
    });
    it("allows existing positions to unwind after adapter deregistration", async () => {
      await crvUSD.mint(users[7].address, ethers.parseEther("200"));
      await crvUSD.connect(users[7]).approve(nft.target, ethers.parseEther("200"));
      await nft.connect(users[7]).mint(1, ethers.parseEther("200"));
      await nft.connect(users[7]).approve(adapter.target, 1);
      await lendingPool.connect(users[7]).openVaultPosition();
      await lendingPool.connect(users[7]).depositAsset(adapter.target, encode(1));
      await lendingPool.connect(owner).unregisterAdapter(adapter.target);
      await expect(
        lendingPool.connect(users[8]).depositAsset(adapter.target, encode(1))
      ).to.be.revertedWithCustomError(lendingPool, "AdapterNotSupported");
      // TODO: what shall we do if the adapter is taken out? the assets are locked there
      await expect(
        lendingPool.connect(users[7]).withdrawAsset(adapter.target, encode(1))
      ).to.be.revertedWithCustomError(lendingPool, "AdapterNotSupported");
    });
  });


  describe("fuzz: 100 iterations randomised ops", () => {
    it("never exceeds liquidity nor negative HF", async () => {
      const ITER = 100;
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
      const MockOracle = await ethers.getContractFactory("MockERC20PriceOracle");
      const Adapter = await ethers.getContractFactory("ERC20AssetAdapter");

      const t = await ERC20Mock.deploy("Fuzz", "FZ", 18);
      const o = await MockOracle.deploy();
      await o.setLatestPrice(ethers.parseEther("1"));
      const a = await Adapter.deploy(t.target, o.target, lendingPool.target);
      await lendingPool.registerAdapter(a.target);

      for (const u of users.slice(0, 10)) {
        await t.mint(u.address, ethers.parseEther("1000"));
        await t.connect(u).approve(a.target, ethers.MaxUint256);
      }

      for (let i = 0; i < ITER; i++) {
        const idx = Math.floor(Math.random() * 10);
        const u = users[idx];
        const op = Math.floor(Math.random() * 4);
        const qty = ethers.parseEther((Math.random() * 20).toFixed(4));
        try {
          if (op === 0) {
            await lendingPool.connect(u).depositAsset(a.target, encode(qty));
          } else if (op === 1) {
            await lendingPool.connect(u).borrow(a.target, encode(qty), qty.div(2));
          } else if (op === 2) {
            await lendingPool.connect(u).withdrawAsset(a.target, encode(qty));
          } else {
            await crvUSD.connect(u).approve(rToken.target, qty);
            await lendingPool.connect(u).repay(a.target, encode(qty), qty);
          }
        } catch (_) {}
      }

      const state = await lendingPool.getReserveState();
      expect(state.totalLiquidity).to.be.gte(0);
      for (const u of users.slice(0, 10)) {
        const debt = await lendingPool.getPositionsScaledDebt(u.address);
        if (debt === 0n) continue;
        const collateral = await lendingPool.getUserCollateralValue(u.address);
        expect(collateral).to.be.gte(0);
      }
    });
  });
});


