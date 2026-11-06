// The tests will check that curve vault deposit, withdraw and rebalancement works as expected
// Test that when deposit, the buffer is met and the rebalancement happpens
// Test that ensure liquidity works: withdraws the required amount
// Test that withdraw works when we change the vault: lending pool received all the amount, including the yield
import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";


const FIRST_NFT_ID = 1;
const SECOND_NFT_ID = 2;

function encodeERC721Token(tokenID) {
  return new ethers.AbiCoder().encode(["uint256"], [tokenID])
}
function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
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
  MaxRate: 12
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
  }
}


describe("Lending Pool with Curve VaultV3", function() {
    let owner, user1, user2, user3;
    let crvusd, raacNFT, raacHousePrices, complianceRegistry, lendingPool, raacNFTAdapter, erc20Token, erc20TokenAdapter, erc20PriceOracle, curveCrvUSDVaultMock, rToken, debtToken, crvUSDToUSDOracle
    let assets = {}
    const ASSET_PRICE = ethers.parseEther("100");

    beforeEach(async function() {
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
        await crvusd.mint(user1.address, amountToPay);

        await crvusd.connect(user1).approve(raacNFT.target, amountToPay);

        // Min the NFT
        await raacNFT.connect(user1).mint(FIRST_NFT_ID, amountToPay);

        // Mint some erc20Token for testing : ASSET_PRICE 
        await erc20Token.mint(user1.address, ASSET_PRICE);

        // Open the user1 vault for tests
        // set the fee to 0 for most of tests
        await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0);
        await lendingPool.connect(user1).openVaultPosition();

        // set the assets map
        assets["ERC20"] = {baseAsset: erc20Token, adapter: erc20TokenAdapter, data: encodeERC20Token(ASSET_PRICE)}
        assets["ERC721"] = {baseAsset: raacNFT, adapter: raacNFTAdapter, data: encodeERC721Token(1)}

        // SEtup vault
        const CurveCrvUSDVaultMock = await ethers.getContractFactory("CurveCrvUSDVaultMock");
        curveCrvUSDVaultMock = await CurveCrvUSDVaultMock.deploy(crvusd.target, "Curve Savings", "scrvusd");

        await lendingPool.setVault(curveCrvUSDVaultMock.target);

        await lendingPool.setParameter(OwnerParameter.LiquidityBufferRatio, 2000);
    })
    it("should have set the vault correctly", async function() {
        const vault = await lendingPool.vault();
        expect(vault).to.equal(curveCrvUSDVaultMock.target);
    })
    it("should revert if the vault is not set and there is not enough liquidity to withdraw", async function() {
      // remove the vault
      await lendingPool.setVault(ethers.ZeroAddress);
      // put in 100, put 100 in collateral, take 50 out, then try taking the 100 out. will revert as only 50 left.
      const depositAmount = ethers.parseEther("100");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      // deposit the NFT
      await raacNFT.connect(user1).approve(assets["ERC721"].adapter.target, FIRST_NFT_ID);
      await lendingPool.connect(user1).depositAsset(assets["ERC721"].adapter, assets["ERC721"].data);

      // take a loan of 50
      await lendingPool.connect(user1).borrow(assets["ERC721"].adapter.target, assets["ERC721"].data, ethers.parseEther("50"));

      // try to withdraw 100
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      await expect(lendingPool.connect(user1).withdraw(ethers.parseEther("100"))).to.be.revertedWith("Insufficient liquidity in the pool");
    })
    it("should deposit the liquidity and rebalance it", async function() {
        const liquidityBufferRatio = (await toParameter(lendingPool)).liquidityBufferRatio
        console.log("liquidityBufferRatio", liquidityBufferRatio);

        // if the buffer ration is 20% and I deposit 1 million, then 200K should remain in RToken and 80% goes in the vault
        const depositAmount = ethers.parseEther("1000000");
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);

        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("200000"));
        expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("800000"));
        expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("800000"));
    })
    it("should withdraw the liquidity and rebalance it", async function() {
        // We deposit 1 million. The liquidity is balanced to 200K/800K. We withdraw 300K, so 100K missing, which is withdrawn from the vault
        const depositAmount = ethers.parseEther("1000000");
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);

        const liquidityBufferRatio = (await toParameter(lendingPool)).liquidityBufferRatio
        console.log("liquidityBufferRatio", liquidityBufferRatio);

        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        console.log("--------------------------------")

        const withdrawAmount = ethers.parseEther("300000");
        await lendingPool.connect(user1).withdraw(withdrawAmount);
    
        // We remain with a liquidity of 700K, with 0K in lending pool and 700K in vault. The lending pool will take 140K (20%) and vault has 560K
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("140000"));
        expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("560000"));
        expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("560000"));
    })
    it("should consider the yield when withdrawing in case requested withdraw is greater than the liquidity available in pool", async function() {
      // we are going to deposit 1M
      // Based on the 20% buffer, the split is 200/800K

      // we increase the price by 1% -> 1.01, so each share is 1.101
      // when we withdraw 300K, 100K will come from the vault. Since the share is 1.01, we will burn now 100K / 1.01 = 99,009.9009901
      // so the remaining 990.0990099 shares will be the yield = 990.0990099 * 1.01 = 1000

      // from percentage view:
      // 1.01 - 1.00 = 0.01
      // 0.01 * 1000000 = 10000

      // this math is the same as we have done in the vault proxy: two ways, share view or percentage view, but same math

      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      console.log("--------------------------------")

      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // deposit X amount total debt to incrase the share price to 1.01

      console.log(await curveCrvUSDVaultMock.totalIdleAssets());
      console.log(await curveCrvUSDVaultMock.totalDebtAssets());

      await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("800000") + ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // deposit yield in the vault
      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);


      console.log(await curveCrvUSDVaultMock.pricePerShare());

      console.log(await crvusd.balanceOf(rToken.target));

      const withdrawAmount = ethers.parseEther("300000");
      await lendingPool.connect(user1).withdraw(withdrawAmount);

      // Ensure liquidity
      // Since 300K > 200K -> need to take 100K assets out of the vault
      // Since we are taking out, we will consider the yield as well: 1.01 * 800K = 8K
      // But we will burn 100K shares

      // Rebalance liquidity
      // RToken balance is 0
      // Vault balance is 800K - (100K + 8K) / 1.01 = 693,069.30693069 shares
      // Buffer is 20%
      // Required: 140K in RToken
      // Withdraw from vault: 140K
      // Total to withdraw: 140K + 0 = 140K because we already took out the yield so lastPriceShare = currentPriceShare = yield 0

      // After withdraw:
      // RToken: 140K
      // Vault = 693,069.30693069 - 140K / 1.01 shares = 554,455.44554455 shares (because since we are taking out 140K worth of asset at 1:1.01 -> we burn less shares so that the remaining is future yield)

      console.log("unclaimed rewards", ethers.formatEther((await lendingPool.vaultRewards())[1]));
      const rewards = (await lendingPool.vaultRewards())[1]
      expect(rewards).to.be.closeTo(ethers.parseEther("8000"), 1); // 8000 is the yield

      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("140000")); // 1000 is the yield in the lending pool
      expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.closeTo(ethers.parseEther("560000"), 1);
      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.closeTo(ethers.parseEther("554455.4455445544554455"), 1000); // these are the shares -> 

      // make sure that the correct shares are burned: when deposited, lending vault had 800K shares. After withdraw process, including yield, should have 700K shares now

    })

    it("should test rebalance after withdraw given exact liquidity available in pool", async function() {
      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      console.log("--------------------------------")

      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("800000") + ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // deposit yield in the vault
      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      const withdrawAmount = ethers.parseEther("200000");
      await crvusd.mint(user1.address, withdrawAmount);
      await crvusd.connect(user1).approve(lendingPool.target, withdrawAmount);
      await lendingPool.connect(user1).withdraw(withdrawAmount);

      /**
       * RToken: 200K
       * vault: 800K
       * Taking out: 200K
       * availableLiquidity: 200K
       * No withdraw from vault, use the available liquidity
       * 
       * Rebalancing:
       * Rtoken: 0K
       * Vault: 800K shares
       * 
       * Buffer: 20%
       * Required: 160K in RToken
       * 
       * Withdraw from vault: 160K
       * 
       * Total to withdraw: 160K + 0.01 * 800K = 168K -> shares burnt: 168K / 1.01 = 166,336.633663366336633663
       * 
       * After withdraw:
       * Rtoken: 160K
       * Vault: 800K - 166,336.633663366336633663 = 633,663.366336633663366337 shares
       * 
       * Overall in the vault (crvUSD): 800K + 8K - 0K - 160K - 8K = 640K
       */

      const vaultSharesBalance = await curveCrvUSDVaultMock.balanceOf(lendingPool.target);
      expect(vaultSharesBalance).to.closeTo(ethers.parseEther("633663.366336633663366337"), 1000);

      const RTokenBalance = await crvusd.balanceOf(rToken.target);
      expect(RTokenBalance).to.equal(ethers.parseEther("160000"));

      const unclaimedRewards = (await lendingPool.vaultRewards())[1];
      expect(unclaimedRewards).to.closeTo(ethers.parseEther("8000"), 1);

      const vaultBalance = await crvusd.balanceOf(curveCrvUSDVaultMock.target);
      expect(vaultBalance).to.closeTo(ethers.parseEther("640000"), 1);// 1 wei due to rounding in favour of the protocol
    })
    it("should withdraw all from vault when vault is changed or removed (with no yield)", async function() {
      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      // there should be 800K shares in the vault and maximum withdrawable should be 800K crvUSD
      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("800000"));
      expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("800000"));

      // Now we will change the vault
      const MockVault = await ethers.getContractFactory("MockVault");
      const newVault = await MockVault.deploy(crvusd.target, lendingPool.target, owner.address);
      await lendingPool.setVault(newVault.target);

      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
      expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("0"));
      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("200000") + ethers.parseEther("800000"));
    })
    it("should withdraw all from vault when vault is changed or removed (with yield)", async function() {
      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      // there should be 800K shares in the vault and maximum withdrawable should be 800K crvUSD
      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("800000"));
      expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("800000"));

      const totalIdle = ethers.parseEther("800000") + ethers.parseEther("8000"); // 800K + 8K yeild (1.01 rate)
      await curveCrvUSDVaultMock.setTotalIdle(totalIdle);
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      expect(await curveCrvUSDVaultMock.pricePerShare()).to.equal(ethers.parseEther("1.01"));
      expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("808000"));

      // If we do not donate some crvusd, it will revert. This could be the Curve Finance putting in the yield after farming
      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("100000")); // 100K - 8K rmeains in the vault
      console.log(await crvusd.balanceOf(curveCrvUSDVaultMock.target));
      const MockVault = await ethers.getContractFactory("MockVault");
      const newVault = await MockVault.deploy(crvusd.target, lendingPool.target, owner.address);
      await lendingPool.setVault(newVault.target);

      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
      expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("0"));
      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("200000") + ethers.parseEther("800000")); // Rtoken + vault + no yield
      expect((await lendingPool.vaultRewards())[1]).to.equal(ethers.parseEther("8000")); // 8K yield
      expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("8000")); // 8K rmeains in the pool for collection
      expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("100000") - ethers.parseEther("8000")); // 100K - 8K rmeains in the vault
    })

    // it("should allow withdraw with case FULL AMOUNT + NO YIELD", async function() {
    //   const user1PreviousBalance = await crvusd.balanceOf(user1.address);
    //   const depositAmount = ethers.parseEther("1000000");
    //   await crvusd.mint(user1.address, depositAmount);
    //   await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
    //   await lendingPool.connect(user1).deposit(depositAmount);

    //   await time.increase(86400);
    //   await ethers.provider.send("evm_mine", []);

    //   console.log("--------------------------------")

    //   // this will caues the price to go to 1.1, but we will not deposit any yield: use max withdraw is still 800K not 808K
    //   // FIXME: this test is wrong: there is yield if there token deposited. you cannot just increae debt and 8000 not there. of course it will fail.
    //   await curveCrvUSDVaultMock.setTotalDebt(ethers.parseEther("8000"));
    //   await time.increase(86400);
    //   await ethers.provider.send("evm_mine", []);

    //   console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []));

    //   // At this point, the RToken = 200K
    //   // Vault = 800K
    //   // Accured yield = 8K - but not deposited yet
    //   // Burned = 800K / 1.01 = 792,079.20792079 shares, remaining = 800K - 792,079.20792079 = 7,920.792079207920792079 shares
    //   const withdrawAmount = ethers.parseEther("1000000");
    //   await lendingPool.connect(user1).withdraw(withdrawAmount);

    //   expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("0"));
    //   expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.be.closeTo(ethers.parseEther("7920.792079207920792079"), 1000); // this represents the yield that was not collected because of max withdraw
    //   expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
    //   expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000000") + user1PreviousBalance);
    //   expect((await lendingPool.vaultRewards())[1]).to.equal(ethers.parseEther("0"));
    // })

    it("should allow withdraw with case FULL AMOUNT + SOME YIELD", async function() {
      const user1PreviousBalance = await crvusd.balanceOf(user1.address);
      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      console.log("--------------------------------")

      // this will caues the price to go to 1.1, but we will not deposit any yield: use max withdraw is still 800K not 808K
      await curveCrvUSDVaultMock.setTotalDebt(ethers.parseEther("0"));
      await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("4000") + ethers.parseEther("800000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // deposit yield in the vault
      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("4000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []));

      // At this point, the RToken = 200K
      // Vault = 800K
      // Accured yield = 8K - but only 4K deposited
      // Burned = 804K / 1.01 = 796,039.60396039 shares, remaining = 800K - 796,039.60396039 = 3,960.396039603960396039 shares
      const withdrawAmount = ethers.parseEther("1000000");
      await lendingPool.connect(user1).withdraw(withdrawAmount);

      console.log("Yield", (await lendingPool.vaultRewards())[1]);

      expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("0"));
      expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.be.closeTo(ethers.parseEther("0"), 1000); // this represents the yield that was not collected because of max withdraw
      expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000000") + user1PreviousBalance);
      expect((await lendingPool.vaultRewards())[1]).to.be.closeTo(ethers.parseEther("4000"), 1);
      expect(await crvusd.balanceOf(lendingPool.target)).to.closeTo(ethers.parseEther("4000"), 1);
    })
    // should be able to claim the yield
    it("should be able to claim the yield", async function() {
      const FeeCollector = await ethers.getContractFactory("FeeCollector");
      const feeCollector = await FeeCollector.deploy(owner.address);

      await feeCollector.addClaimableToken(crvusd.target);
      await feeCollector.addWhitelistedTarget(lendingPool.target);
      await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")), 10000, 0, 0, 0, 0, 0); // all to treasury

      await lendingPool.setFeeCollector(feeCollector.target);

      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      console.log("--------------------------------")
      await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("800000") + ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      const withdrawAmount = ethers.parseEther("1000000");
      await lendingPool.connect(user1).withdraw(withdrawAmount);

      // we have harvested 8k yield
      expect((await lendingPool.vaultRewards())[1]).to.be.closeTo(ethers.parseEther("8000"), 1);
      expect(await crvusd.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("0"));
      expect(await crvusd.balanceOf(lendingPool.target)).to.closeTo(ethers.parseEther("8000"), 1);

      await feeCollector.setTargetFeeType(lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));
      await feeCollector.claimCollectorRewards(crvusd.target, lendingPool.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")));

      expect(await crvusd.balanceOf(feeCollector.target)).to.closeTo(ethers.parseEther("8000"), 1);
      expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
      expect((await lendingPool.vaultRewards())[1]).to.equal(ethers.parseEther("0"));
      expect((await feeCollector.getCollectedFees(crvusd.target, ethers.keccak256(ethers.toUtf8Bytes("VAULT_REWARDS")))).treasuryAmount).to.closeTo(ethers.parseEther("8000"), 1);
    })

    // deposit, deposit, withdraw, deposit, withdraw all: should have correct yield
    it("should have correct yield after deposit, deposit, withdraw, deposit, withdraw all", async function() {
        console.log("==============Depositing 1M===============")
        const depositAmount = ethers.parseEther("1000000");
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);

        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("200000"));
        expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("800000"));


        // Increase the share price to 1.01
        console.log("==============Increasing share price to 1.01===============")
        await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.01"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // Deposit yield in the vault
        await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // console.log(await lendingPool.vaultRewards());

        expect(await curveCrvUSDVaultMock.pricePerShare()).to.equal(ethers.parseEther("1.01"));

        // Before, we had 800K shares.
        // We take out 8K crvUSD, we burn 7920.79207920792079208 shares
        // We have 800K - 7,920.792079207920792079 = 792,079.20792079 shares remaining
        // The share price is 1.01

        // We deposited 1M crvUSD, we have 800K / 1.01 = 792,079.20792079 shares more
        // total shares = 792,079.20792079 + 792,079.20792079 = 1,584,158.41584158
        // Now, we ar at 1.02
        // to withdraw 500K, first we need to see how much to take out from teh vault and rebalance.
        // since 400K in Rtoken, take out 100K from vault (shares burnt 100K / 1.02), which will also take out the yield (delta 0.01 * 1,584,158.41584158 = 15,841.5841584158) not 16K
        // after that, 0 RToken and 1.5M crvusd in vault. Rebalance to 300K Rtoken and 1.2M crvUsd -> no yield since already deducted
        // total shares burned in this stage : 300K/1.02 -> overall 100K/1.02 + 300K/1.02 + 15,841.5841584158 / 1.02 = 400K/1.02 + 15,841.5841584158 / 1.02 = 392,079.20792079

        // remaining shares at this point: 1,584,158.41584158 - 392,079.20792079 = 1,176,470.588235294117647057

        console.log("==============Depositing 1M===============")
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);

        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // This will take the yield out (around 8K)
        expect(await crvusd.balanceOf(lendingPool.target)).to.be.closeTo(ethers.parseEther("8000"), 1);
        expect((await lendingPool.vaultRewards())[1]).to.be.closeTo(ethers.parseEther("8000"), 1);
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("400000"));
        expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.closeTo(ethers.parseEther("1600000"), 1);
        // TOOD: check the vaultRewards status

        console.log("==============Increase share price to 1.02===============")
        await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.02"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("16000"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        expect(await curveCrvUSDVaultMock.pricePerShare()).to.equal(ethers.parseEther("1.02"));
        // console.log(await lendingPool.vaultRewards());
        // console.log(await curveCrvUSDVaultMock.pricePerShare());


        console.log("==============Withdrawing 500K===============")
        const withdrawAmount = ethers.parseEther("500000");
        // since the pool has 400K already, we will take out 100K from the vault.
        await lendingPool.connect(user1).withdraw(withdrawAmount);
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584154"));
        expect((await lendingPool.vaultRewards())[1]).to.equal(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584154"));
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("300000"));
        // expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("1200000"));
        expect((await lendingPool.vaultRewards())[0]).to.closeTo(ethers.parseEther("1200000"), 2);
        expect((await lendingPool.vaultRewards())[6]).to.equal(ethers.parseEther("1176470.588235294117647060"));
        // make sure that the totalshreas * pricePerShare = totalIdleAssets


        console.log("==============Increasing share price to 1.03===============")
        await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.03"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("12000"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // Right now the situation is:
        // Total shares: 1,176,470.588235294117647057
        // Total deposited = 1.2M crvusd
        // Total in RToken = 300K
        // Current price = 1.03

        // So now, when depositing 1M, we will take yield on the current shares
        // 1,176,470.588235294117647057 * 0.01 = 11,764.70588235294117647057 crvUSD
        // Remaining shares = 1,176,470.588235294117647057 - 11,764.70588235294117647057 /1.03 = 1,165,048.543689324268839257
        // now since 300+1.2M+1M=2.5M, we will have 500K in Rtoken and 2M in vault. So 800K more deposited in the vault
        // Total new shares = 800K / 1.03 = 776,699.02912621 shares
        // Total voerall shares = 1,165,048.543689324268839257 + 776,699.02912621 = 1,941,747.572815534395049278

        const pricePerShare = await curveCrvUSDVaultMock.pricePerShare();
        console.log("pricePerShare", pricePerShare);
        const lastSharePrice =( await lendingPool.vaultRewards())[3]
        console.log("lastSharePrice", lastSharePrice);


        console.log("==============Depositing 1M===============")
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);
        console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []))
        console.log(await curveCrvUSDVaultMock.totalIdleAssets())

        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // Now we will take the remaining yield that is inside, on the 1.2M
        expect(await crvusd.balanceOf(lendingPool.target)).to.closeTo(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584154") + ethers.parseEther("11764.705882352941176470"), 2);
        expect((await lendingPool.vaultRewards())[1]).to.closeTo(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584154") + ethers.parseEther("11764.705882352941176470"), 2);
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("500000"));
        // expect(await crvusd.balanceOf(curveCrvUSDVaultMock.target)).to.equal(ethers.parseEther("2000000"));
        console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []))
        console.log(await curveCrvUSDVaultMock.totalIdleAssets())

        console.log(await lendingPool.vaultRewards())
        // TOOD: check the vaultRewards status

        // Simulate that curve vault has the money inside

        await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.04"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        // deposit 20K
        await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("20000"));
        await time.increase(86400);
        await ethers.provider.send("evm_mine", []);

        console.log("==============Change Vault (withdraw all)===============")
        const MockVault = await ethers.getContractFactory("MockVault");
        const newVault = await MockVault.deploy(crvusd.target, lendingPool.target, owner.address);
        console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []))
        console.log(await curveCrvUSDVaultMock.totalIdleAssets())
        await lendingPool.setVault(newVault.target);

        // we are taking the entire yield out at a rate of 1.04
        // Previousl we have total of: 1,941,747.572815534395049278 shres
        // Vault: 2M crvusd
        // RToken: 500K
        // Total assets: 2.5M
        // We withdraw: 2M
        // Calculate the yield: 1,941,747.572815534395049278 * 0.01 = 19,417.47572815534395049278 crvUSD
        // Total burn = 19,417.47572815534395049278 + 2M /...


        expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("0"));
        expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("0"));
        expect(await crvusd.balanceOf(rToken.target)).to.closeTo(ethers.parseEther("500000") + ethers.parseEther("2000000"), 5);
        expect(await crvusd.balanceOf(lendingPool.target)).to.be.closeTo(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584158") + ethers.parseEther("11764.705882352941176470") + ethers.parseEther("19417.475728155343950492"), "10000000");
        expect((await lendingPool.vaultRewards())[1]).to.be.closeTo(ethers.parseEther("8000") + ethers.parseEther("15841.584158415841584158") + ethers.parseEther("11764.705882352941176470") + ethers.parseEther("19417.475728155343950492"), "10000000");
    })
    it("should work with partial withdraw", async function() {
      const depositAmount = ethers.parseEther("1000000");
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);

      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // increase the share price to 1.01
      await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.01"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // deposit yield in the vault
      await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);

      // we try to deposit. The yield is 8K, but we can only take out 4K. We will deposit twice and make sure that yield is taken out properly
      // First time it should take ouy 4K yield
      // Then, since we deposited 1M more, it will take out 4K more yield (we do not count the new deposit since new deposit did not produce any yield)
      await curveCrvUSDVaultMock.setWithdrawLimit(ethers.parseEther("4000"));
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);
      
      let state = await lendingPool.vaultRewards();
      let unclaimedRewards = state[1];
      expect(await crvusd.balanceOf(lendingPool.target)).to.be.closeTo(ethers.parseEther("4000"), 1);
      expect(unclaimedRewards).to.closeTo(ethers.parseEther("4000"), 1);


      // deposit 1M more
      await crvusd.mint(user1.address, depositAmount);
      await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user1).deposit(depositAmount);
      await time.increase(86400);
      await ethers.provider.send("evm_mine", []);
      
      state = await lendingPool.vaultRewards();
      unclaimedRewards = state[1];

      expect(await crvusd.balanceOf(lendingPool.target)).to.closeTo(ethers.parseEther("4000"), 2);
      expect(unclaimedRewards).to.closeTo(ethers.parseEther("4000"), 2);
      // principal accounting = 3 x 800K deposited + the 4K absorbed yield
      expect(state[0]).to.closeTo(ethers.parseEther("2404000"), ethers.parseEther("1"));


      // now the entire yield has been taken out from the deposit 1.

      // now we move with withdraw. 
      // Rtoken = 600L
      // Value = 24M
      // Rewards = 16K remaining (since we deposited 10M twice)
      // We will increase the share to 1.02 so that we have 16K
      // We wanna withdraw an amount of 700K (600K Rtoken and 100K vault), which will trigger the logic for yield
      // we will take out only 8K yield (half), while the other half remains in the vault
      // so the limit to put on withdraw will be 100K + 8K = 108K

      // await curveCrvUSDVaultMock.adjustPricePerShare(ethers.parseEther("1.02"));
      // await time.increase(86400);
      // await ethers.provider.send("evm_mine", []);
      // await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("16000"));
      // await time.increase(86400);
      // await ethers.provider.send("evm_mine", []);
      

      // await curveCrvUSDVaultMock.setWithdrawLimit(ethers.parseEther("108000"));
      // await lendingPool.connect(user1).withdraw(ethers.parseEther("700000"));
      // await time.increase(86400);
      // await ethers.provider.send("evm_mine", []);

      // // what will happen is the following:
      // // 1. withdraw will appen -> take 8K out
      // // 2. Rebalance will happen -> since limit > 8K, 8K is taken out
      // // total: entire 8K is taken out at the end.
      // state = await lendingPool.vaultRewards();
      // unclaimedRewards = state[1];
      // expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("8000") + ethers.parseEther("16000")); // 8K from previous test and now from new test
      // expect(unclaimedRewards).to.equal(ethers.parseEther("24000"));



      // we try withdraw 500K (so 300K from vault) with a limit of 304K, so 4K yield is still inside
      // await curveCrvUSDVaultMock.setWithdrawLimit(ethers.parseEther("304000"));
      // console.log(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, []))
      // await lendingPool.connect(user1).withdraw(ethers.parseEther("500000"));
      // await time.increase(86400);
      // await ethers.provider.send("evm_mine", []);

      // we should have 4K yield inside
      // expect(await crvusd.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("4000"));

      // now we check the pool state, especially last share price given that we know that the current share price is 1.01
      console.log(await lendingPool.vaultRewards())
    })

    describe("rebalance after yield harvest lowers the withdrawable limit", function() {
      beforeEach(async function() {
        // 1M deposited at a 20% buffer: 200K stays in RToken, 800K goes to the vault
        const depositAmount = ethers.parseEther("1000000");
        await crvusd.mint(user1.address, depositAmount);
        await crvusd.connect(user1).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user1).deposit(depositAmount);
        expect(await crvusd.balanceOf(rToken.target)).to.equal(ethers.parseEther("200000"));
        expect(await curveCrvUSDVaultMock.balanceOf(lendingPool.target)).to.equal(ethers.parseEther("800000"));

        // 8K of yield accrues (808K total assets) but only 500K is idle, so maxWithdraw is
        // liquidity-bound. Harvesting the ~8K of yield drains idle to ~492K and lowers maxWithdraw.
        await crvusd.mint(curveCrvUSDVaultMock.target, ethers.parseEther("8000"));
        await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("500000"));
        await curveCrvUSDVaultMock.setTotalDebt(ethers.parseEther("308000"));
        expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("500000"));

        await time.increase(86400);
      })

      it("caps the rebalance withdrawal to the post-harvest limit instead of reverting", async function() {
        // 100% buffer: the whole vault position is a shortage, so the pre-harvest limit (500K) is requested
        await lendingPool.setParameter(OwnerParameter.LiquidityBufferRatio, 10000);

        const rTokenBefore = await crvusd.balanceOf(rToken.target);
        const depositAmount = ethers.parseEther("1000");
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);

        await expect(lendingPool.connect(user2).deposit(depositAmount)).to.not.be.reverted;

        const unclaimedRewards = (await lendingPool.vaultRewards())[1];
        expect(unclaimedRewards).to.be.closeTo(ethers.parseEther("8000"), ethers.parseEther("1"));

        // Everything still withdrawable after the harvest moved into the buffer
        expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.be.lessThan(ethers.parseEther("1"));
        const pulled = (await crvusd.balanceOf(rToken.target)) - rTokenBefore - depositAmount;
        expect(pulled).to.be.closeTo(ethers.parseEther("500000") - unclaimedRewards, ethers.parseEther("1"));
      })

      it("caps the rebalance when the shortage falls between the post- and pre-harvest limits", async function() {
        // Withdrawing 200K empties the buffer via ensureLiquidity (no vault touch needed)
        // and leaves a 20% * 800K = 160K shortage; drop idle so the post-harvest limit sits below it
        await curveCrvUSDVaultMock.setTotalIdle(ethers.parseEther("165000"));
        await curveCrvUSDVaultMock.setTotalDebt(ethers.parseEther("643000"));
        expect(await curveCrvUSDVaultMock.maxWithdraw(lendingPool.target, 0, [])).to.equal(ethers.parseEther("165000"));

        await expect(lendingPool.connect(user1).withdraw(ethers.parseEther("200000"))).to.not.be.reverted;

        const unclaimedRewards = (await lendingPool.vaultRewards())[1];
        expect(unclaimedRewards).to.be.closeTo(ethers.parseEther("8000"), ethers.parseEther("1"));
        expect(await crvusd.balanceOf(rToken.target)).to.be.closeTo(ethers.parseEther("165000") - unclaimedRewards, ethers.parseEther("1"));
      })

      it("still reverts an exact payout that exceeds the post-harvest limit", async function() {
        // 695K needs 495K from the vault: within the pre-harvest 500K, above the post-harvest ~492K
        await expect(lendingPool.connect(user1).withdraw(ethers.parseEther("695000"))).to.be.revertedWith(
          "Not enough liquidity to fulfill the withdrawal"
        );
      })

      it("pays out an exact amount within the post-harvest limit", async function() {
        const balanceBefore = await crvusd.balanceOf(user1.address);
        await lendingPool.connect(user1).withdraw(ethers.parseEther("690000"));
        expect((await crvusd.balanceOf(user1.address)) - balanceBefore).to.equal(ethers.parseEther("690000"));
      })
    })
})
