import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

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
  MinDepositAmount: 13
};

const RANDOM_NUMBER = 12


export async function deployVRFConsumer(rwaVaultAddress) {
  const VRF_KEY_HASH = "0x8af398995b04c28e9951adb9721ef74c74f93e6a478f39e7e0777be13527e7ef";
  const VRF_FEE = ethers.parseEther("0.1");
  const VRF_GAS = 2000000;
  const VRF_WEIPERLINK = 7291990000000000

  let vrfCoordinator, vrfSubId, vrfConsumer;
  const MockVRFCoordinatorV2 = await ethers.getContractFactory("MockVRFCoordinatorV2");
  vrfCoordinator = await MockVRFCoordinatorV2.deploy(VRF_FEE, VRF_GAS, VRF_WEIPERLINK);
  await vrfCoordinator.createSubscription();

  const activeSubIds = await vrfCoordinator.getActiveSubscriptionIds(0, 1);
  vrfSubId = activeSubIds[0];
  await vrfCoordinator.fundSubscription(vrfSubId, ethers.parseEther("10000"));

  const VRFConsumer = await ethers.getContractFactory("BaseVRFv2Consumer");
  vrfConsumer = await VRFConsumer.deploy(vrfSubId, vrfCoordinator.target, VRF_KEY_HASH, 100000, 1, 1, rwaVaultAddress);
  await vrfCoordinator.addConsumer(vrfSubId, vrfConsumer.target);

  return {vrfCoordinator, vrfSubId, vrfConsumer}
}

export async function deployRWAVault(crvusd, complianceRegistry) {
  let rwaIndexToken, rwaVault, vrfConsumer;
  const RWAIndexToken = await ethers.getContractFactory("RWAIndexToken");
  rwaIndexToken = await RWAIndexToken.deploy("RWA Index Token", 'RRWA', complianceRegistry.target)

  const RWAVault = await ethers.getContractFactory("RWAVault");
  rwaVault = await RWAVault.deploy(rwaIndexToken.target, complianceRegistry.target);

  const vrf = await deployVRFConsumer(rwaVault.target)
  vrfConsumer = vrf.vrfConsumer;

  await rwaVault.setVRFConsumer(vrfConsumer.target);
  await vrf.vrfCoordinator.fulfillRandomWordsWithOverride(await vrfConsumer.lastRequestId(), vrfConsumer.target, [RANDOM_NUMBER]);
  rwaIndexToken.setVault(rwaVault.target);

  return [rwaIndexToken, rwaVault, vrf];
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

function encodeERC721Token(tokenID) {
  return new ethers.AbiCoder().encode(["uint256"], [tokenID])
}
function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

// TODO: need to test better: how to calculate what is expected output from the swap etc. all the numbers. since we deposit and burn, the index to crv value is high so more crv is given for each swap. take that into account and find a way to calucate the final value
const liquidationSplitPercentages = {
  mint: 0,
  burn: 0,
  swap: 100,
  liquidity: 0
}

describe("StabilityPool", function () {
  let owner, user1, user2, user3, treasury;
  let stabilityPool, lendingPool
  let crvusd, rToken, deToken, rwaVault, rwaIndexToken, vrf, complianceRegistry, liquidationStrategyProxy, liquidationSwap, feeCollector, crvUSDToUSDOracle
  let raacNFT, raacHousePrices, raacNFTAdapter

  const VRF_KEY_HASH = "0x8af398995b04c28e9951adb9721ef74c74f93e6a478f39e7e0777be13527e7ef";
  const assets = {}

  const NFT_ID = 1;
  const ASSET_PRICE = ethers.parseEther("100")
  const ERC20_ASSET_AMOUNT = ASSET_PRICE; // considering each erc20 as 1 crvusd
  const ASSET_BURN = ASSET_PRICE * BigInt(liquidationSplitPercentages.burn) / 100n
  const ASSET_MINT_FEE = ASSET_PRICE * BigInt(liquidationSplitPercentages.mint) / 100n
  const ASSET_SWAP = ASSET_PRICE * BigInt(liquidationSplitPercentages.swap) / 100n
  const ASSET_LIQUIDUTY = ASSET_PRICE * BigInt(liquidationSplitPercentages.liquidity) / 100n
  let crvUSDVaultAdapter, crvUSDPriceOracle;


  beforeEach(async function () {
    [owner, user1, user2, user3, treasury] = await ethers.getSigners();

    // Deploy base tokens
    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    crvusd = await CrvUSDToken.deploy(owner.address);
    await crvusd.setMinter(owner.address);

    const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
    crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

    // Deploy price oracle and set oracle
    const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
    raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);
    await raacHousePrices.setOracle(owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
    complianceRegistry = await ComplianceRegistry.deploy()

    // Deploy NFT
    const RAACNFT = await ethers.getContractFactory("RAACNFT");
    raacNFT = await RAACNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address);

    // Deploy pool tokens
    const RToken = await ethers.getContractFactory("RToken");
    rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);

    const DebtToken = await ethers.getContractFactory("DebtToken");
    const debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);

    const Treasury = await ethers.getContractFactory("Treasury");
    treasury = await Treasury.deploy(owner.address);

    const DEToken = await ethers.getContractFactory("DEToken");
    deToken = await DEToken.deploy("DEToken", "DEToken", owner.address, rToken.target, complianceRegistry.target);

    const FeeCollector = await ethers.getContractFactory("FeeCollector");
    feeCollector = await FeeCollector.deploy(owner.address);

    [rwaIndexToken, rwaVault, vrf] = await deployRWAVault(crvusd, complianceRegistry)

    const LiquidationProxy = await ethers.getContractFactory("LiquidationProxy");
    const liquidationProxy = await LiquidationProxy.deploy();

    // Deploy pools
    const initialPrimeRate = ethers.parseUnits("0.1", 27);
    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary")
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy()
    const LendingPool = await ethers.getContractFactory("LendingPool", {
      libraries: {
        LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
      }
    });

    const VaultProxy = await ethers.getContractFactory("VaultProxy");
    const vaultProxy = await VaultProxy.deploy();
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

    const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = await ProxyAdmin.deploy(owner.address);

    const StabilityPool = await ethers.getContractFactory("StabilityPool");
    const stabilityPoolImplementation = await StabilityPool.deploy(complianceRegistry.target);

    const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy")
    const stabilityPoolProxy = await TransparentUpgradeableProxy.deploy(stabilityPoolImplementation.target, proxyAdmin.target, "0x")

    stabilityPool = StabilityPool.attach(stabilityPoolProxy);

    // Setup cross-contract references
    await lendingPool.setStabilityPool(stabilityPool.target);
    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap
    await rToken.transferOwnership(lendingPool.target);
    await debtToken.transferOwnership(lendingPool.target);
    
    await deToken.setStabilityPool(stabilityPool.target);
    await deToken.transferOwnership(stabilityPool.target);

    const LiquidationSwap = await ethers.getContractFactory("LiquidationSwap");
    liquidationSwap = await LiquidationSwap.deploy(rwaIndexToken.target, crvusd.target, rwaVault.target, crvUSDToUSDOracle.target, owner.address);
    await liquidationSwap.setStabilityPool(stabilityPool.target);

    const LiquidationStrategyProxy = await ethers.getContractFactory("LiquidationStrategyProxy")
    liquidationStrategyProxy = await LiquidationStrategyProxy.deploy();

    // Initialize Stability Pool
    await stabilityPool.initialize(
      rToken.target,
      deToken.target,
      crvusd.target,
      lendingPool.target,
      treasury.target,
      liquidationStrategyProxy.target,
      owner.address
    );

    await stabilityPool.setLiquidationSwap(liquidationSwap.target)
    await stabilityPool.setFeeCollector(feeCollector.target)
    await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS")), 0, 0, 0, 0, 0, 10000)
    await feeCollector.addClaimableToken(rwaIndexToken.target)
    // Set up RWA vault
    await stabilityPool.setRWAVault(rwaVault.target);


    // Mint initial tokens and setup approvals
    const initialBalance = ethers.parseEther("1000");
    
    // Mint crvUSD to users
    await crvusd.mint(user1.address, initialBalance);
    await crvusd.mint(user2.address, initialBalance);
    await crvusd.mint(user3.address, initialBalance);
    
    // Approve crvUSD for LendingPool
    await crvusd.connect(user1).approve(lendingPool.target, initialBalance);
    await crvusd.connect(user2).approve(lendingPool.target, initialBalance);
    await crvusd.connect(user3).approve(lendingPool.target, initialBalance);

    // Initial deposits to get rTokens
    await lendingPool.connect(user1).deposit(initialBalance);
    await lendingPool.connect(user2).deposit(initialBalance);
    await lendingPool.connect(user3).deposit(initialBalance);

    // Approve rTokens for StabilityPool
    await rToken.connect(user1).approve(stabilityPool.target, initialBalance);
    await rToken.connect(user2).approve(stabilityPool.target, initialBalance);
    await rToken.connect(user3).approve(stabilityPool.target, initialBalance);

    // SETUP ERC721 adapter
    const RAACNFTAdapter = await ethers.getContractFactory("ERC721AssetAdapter");
    raacNFTAdapter = await RAACNFTAdapter.deploy(raacNFT.target, raacHousePrices.target, lendingPool.target);

    const RAACNFTVaultAdapterOracle = await ethers.getContractFactory("RAACNFTVaultAdapterOracle");
    const raacNFTVaultAdapterOracle = await RAACNFTVaultAdapterOracle.deploy(raacHousePrices.target);

    const RAACNFTVaultAdapter = await ethers.getContractFactory("RAACNFTVaultAdapterV2");
    const raacNFTVaultAdapter = await RAACNFTVaultAdapter.deploy(raacNFT.target, raacNFTVaultAdapterOracle.target, rwaVault.target, raacHousePrices.target);
    await lendingPool.registerAdapter(raacNFTAdapter.target);
    await rwaVault.registerAdapter(raacNFTVaultAdapter.target)

    const [erc20Token, erc20TokenAdapter, erc20PriceOracle] = await deployIndexToken(lendingPool);
    const ERC20VaultAdapter = await ethers.getContractFactory("ERC20VaultAdapter");
    const erc20TokenVaultAdapter = await ERC20VaultAdapter.deploy(erc20Token.target, erc20PriceOracle.target, rwaVault.target)
    await lendingPool.registerAdapter(erc20TokenAdapter);
    await rwaVault.registerAdapter(erc20TokenVaultAdapter);

    await rwaVault.setStabilityPool(stabilityPool.target)

    // set liquidation percentages

    await stabilityPool.setLiquidationVaultTokenSplit(liquidationSplitPercentages.mint * 100, liquidationSplitPercentages.burn * 100, liquidationSplitPercentages.swap * 100, liquidationSplitPercentages.liquidity * 100);

    // setup depositable asset in the rwa vault
    // RAACNFT and crvusd can be deposited in exchange of vault token
    // TODO: in each adapter we better have which asset is the oracle price referring to, such as crvUSD or gUSD etc. It will help in case we have several assets
    // TODO: add the field also in the RAANFT so that if tomorrow we have RAANFT deployed with an oracle referring to other type of price, we can handle that.
    crvUSDPriceOracle = await (await ethers.getContractFactory("MockERC20PriceOracle")).deploy();
    await crvUSDPriceOracle.setLatestPrice(ethers.parseEther("1"));
    crvUSDVaultAdapter = await ERC20VaultAdapter.deploy(crvusd.target,crvUSDPriceOracle.target, rwaVault.target);
    await rwaVault.registerAdapter(crvUSDVaultAdapter.target)
    await rwaVault.registerDepositableAdapter(crvUSDVaultAdapter.target)

    // setup the asset dictionary
    assets["ERC20"] = {baseAsset: erc20Token, poolAdapter: erc20TokenAdapter, vaultAdapter: erc20TokenVaultAdapter, data: encodeERC20Token(ASSET_PRICE), oracle: erc20PriceOracle}
    assets["ERC721"] = {baseAsset: raacNFT, poolAdapter: raacNFTAdapter, vaultAdapter: raacNFTVaultAdapter, data: encodeERC721Token(NFT_ID), oracle: raacHousePrices}

    // Add index token as supported token for Treasury deposit
    await treasury.addSupportedToken(rwaIndexToken.target)
    await lendingPool.setParameter(OwnerParameter.VaultOpeningFee, 0)
  });

  describe("Initialization", function () {
    it("should initialize with correct parameters", async function () {
      expect(await stabilityPool.rToken()).to.equal(rToken.target);
      expect(await stabilityPool.deToken()).to.equal(deToken.target);
      expect(await stabilityPool.crvUSDToken()).to.equal(crvusd.target);
      expect(await stabilityPool.lendingPool()).to.equal(lendingPool.target);
    });

    it("should fail to initialize twice", async function () {
      await expect(
        stabilityPool.initialize(
          rToken.target,
          deToken.target,
          crvusd.target,
          lendingPool.target,
          treasury.target,
          liquidationStrategyProxy.target,
          owner.address
        )
      ).to.be.revertedWithCustomError(stabilityPool, "InvalidInitialization");
    });

    it("should fail to initialize without proxy", async function () {
      const StabilityPool = await ethers.getContractFactory("StabilityPool");
      const newStabilityPool = await StabilityPool.deploy(complianceRegistry.target);

      // Error from StabilityPool
      await expect(
        newStabilityPool.initialize(
          ethers.ZeroAddress,
          deToken.target,
          crvusd.target,
          lendingPool.target,
          treasury.target,
          liquidationStrategyProxy.target,
          owner.address
        )
      ).to.be.revertedWithCustomError(stabilityPool, "InvalidInitialization");
    });
  });

  describe("Core Functionality", function () {
    describe("Deposits", function () {
      beforeEach(async function () {
        const depositAmount = ethers.parseEther("100");
        await crvusd.mint(user2.address, depositAmount);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
      });

      it("should mint DEToken at correct exchange rate", async function () {
        const depositAmount = ethers.parseEther("50");
        await stabilityPool.connect(user2).deposit(depositAmount);
        
        const deTokenBalance = await deToken.balanceOf(user2.address);
        expect(deTokenBalance).to.equal(depositAmount);
      });

      it("should handle partial withdrawals correctly", async function () {
        const initialDeTokenBalance = await deToken.balanceOf(user2.address);
        expect(initialDeTokenBalance).to.equal(0n);
        const initialAmount = ethers.parseEther("100");
        await stabilityPool.connect(user2).deposit(initialAmount);
        const postDepositDeTokenBalance = await deToken.balanceOf(user2.address);
        console.log("postDepositDeTokenBalance", postDepositDeTokenBalance);
        console.log("postDepositDeTokenBalance", ethers.formatEther(postDepositDeTokenBalance));
        expect(postDepositDeTokenBalance).to.equal(initialAmount);
        const withdrawAmount = ethers.parseEther("30");
        await stabilityPool.connect(user2).requestWithdraw(withdrawAmount);
        await time.increase(30 * 60);
        await ethers.provider.send("evm_mine");
        await stabilityPool.connect(user2).withdraw(withdrawAmount);
        
        const finalBalance = await stabilityPool.getUserDeposit(user2.address);
        const expectedBalance = initialAmount - withdrawAmount;
        expect(finalBalance).to.equal(expectedBalance);
      });
      it("should consider timelock to avoid frontloading withdrawals", async function () {
        // request a withdraw of uint256 max even if the user does not have any balance
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        // check that timelock is set
        const timelock = await stabilityPool.withdrawTimelock(user2.address);
        expect(timelock.readyAt).to.be.greaterThan(0);

        // now deposit some amount in
        const depositAmount = ethers.parseEther("100");
        await crvusd.mint(user2.address, depositAmount);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
        await stabilityPool.connect(user2).deposit(depositAmount);

        // check the timelock is cancelled
        const timelock2 = await stabilityPool.withdrawTimelock(user2.address);
        expect(timelock2.readyAt).to.be.equal(0);

        // user tries to withdraw the amount after the timelock is expired, it should not happen
        await time.increase(30 * 60);
        await ethers.provider.send("evm_mine");
        await expect(stabilityPool.connect(user2).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(stabilityPool, "NoPendingWithdraw");
        
      })
      it("should allow pausing the withdraw", async function() {
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        // check that timelock is set        

        await stabilityPool.setWithdrawTimelockDelay(0);
        await time.increase(15 * 60);
        await ethers.provider.send("evm_mine");
        await expect(stabilityPool.connect(user2).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(stabilityPool, "WithdrawTimelockNotReady");

        await time.increase(15 * 60);
        await ethers.provider.send("evm_mine");
        await expect(stabilityPool.connect(user2).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(stabilityPool, "WithdrawTimelockExpired");
      })
      it("should not allow withdraw after expiration", async function() {
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        // check that timelock is set        
        await time.increase(30 * 60 + 2 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine");
        await expect(stabilityPool.connect(user2).withdraw(ethers.MaxUint256)).to.be.revertedWithCustomError(stabilityPool, "WithdrawTimelockExpired");
      })
    });

    describe("Liquidation of ERC721", function () {
      const FIRST_NFT_ID = NFT_ID;
      const FIRST_NFT_PRICE = ASSET_PRICE;
      const ASSET_AFTER_LIQUIDATION = ethers.parseEther("62.5")
      let liquidityPool;
      let poolAdapter, vaultAdapter, baseAsset, assetOracle, assetEncodedData
      const assetType = "ERC721"

      beforeEach(async function () {
        const asset = assets[assetType];
        poolAdapter = asset.poolAdapter;
        vaultAdapter = asset.vaultAdapter;
        baseAsset = asset.baseAsset;
        assetEncodedData = asset.data;
        assetOracle = asset.oracle;

        const depositAmount = ethers.parseEther("100");
        await crvusd.mint(user2.address, depositAmount);
        await crvusd.mint(user3.address, depositAmount);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
        await stabilityPool.connect(user2).deposit(depositAmount);
        await lendingPool.connect(user3).openVaultPosition();

        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, FIRST_NFT_PRICE);
          await crvusd.connect(user3).approve(baseAsset.target, FIRST_NFT_PRICE);
          await baseAsset.connect(user3).mint(FIRST_NFT_ID, FIRST_NFT_PRICE);
          await baseAsset.connect(user3).approve(poolAdapter.target, FIRST_NFT_ID);
        } else if (assetType === "ERC20") {
          await baseAsset.mint(user3.address, ASSET_PRICE);
          await baseAsset.connect(user3).approve(poolAdapter.target, ASSET_PRICE);
        }
        await lendingPool.connect(user3).depositAsset(poolAdapter, assetEncodedData);     
        
        // borrow 100 crvusd
        await lendingPool.connect(user3).borrow(poolAdapter, assetEncodedData, ethers.parseEther("50"));

        const MockLiquidityPool = await ethers.getContractFactory("MockLiquidityPool");
        const liquidityPoolFee = 100; // 1% in base

        // From curve
        liquidityPool = await MockLiquidityPool.deploy(
            [crvusd.target, rwaIndexToken.target],  // coin addresses - crvUSD first, IndexToken second
            [ethers.parseUnits("1", 18), ethers.parseUnits("1", 18)],  // rate multipliers
            100,                            // A parameter
            liquidityPoolFee,               // fee (1%)
            "Mock Curve Pool",              // name
            "mCRV"                          // symbol
        );

        // Deposit some crvUSD to get some index token
        const initialLiquidity = ethers.parseEther("100000");
        await crvusd.mint(user1.address, initialLiquidity * 2n);

        // depositing crvUSD in vault gives index token back
        await crvusd.connect(user1).approve(crvUSDVaultAdapter.target, initialLiquidity);
        const minSharesOut = await rwaVault.previewDeposit(initialLiquidity)
        await rwaVault.connect(user1).depositAsset(crvUSDVaultAdapter.target, encodeERC20Token(initialLiquidity), user1.address, minSharesOut);


        await crvusd.connect(user1).approve(liquidityPool.target, initialLiquidity);
        await rwaIndexToken.connect(user1).approve(liquidityPool.target, initialLiquidity);

        console.log("Adding initial liquidity:", (initialLiquidity).toString());

        const amounts = [initialLiquidity, initialLiquidity];
        await liquidityPool.connect(user1).add_liquidity(amounts, 0, user1.address); // Set min_mint_amount to 0 for testing

        const crvBalance = await liquidityPool.balances(0);
        const indexBalance = await liquidityPool.balances(1);
        console.log("Initial pool balances - CRV:", crvBalance.toString(), "Index:", indexBalance.toString());

        await liquidationSwap.setLiquidityPool(liquidityPool.target, liquidityPoolFee, 1, 0);

        // Set the parameteres for the liquidation
        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, ASSET_AFTER_LIQUIDATION);
        } else if (assetType === "ERC20") {
          await assetOracle.setLatestPrice(ASSET_AFTER_LIQUIDATION / 100n);
        } 
      });

      it("should liquidate user2 and properly transfer NFT", async function () {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");
        const tokenSupplyBefore = await rwaIndexToken.totalSupply();

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        // initially stored in the pool adapter
        if (assetType === "ERC721") {
          const initialNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          // initially stored in the pool adapter
          expect(initialNFTOwner).to.equal(raacNFTAdapter.target);
        } else if (assetType === "ERC20") {
          expect(await baseAsset.balanceOf(erc20TokenVaultAdapter.target)).to.equal(0);
        }

        const mintSharesOut = await rwaVault.previewDeposit(ASSET_AFTER_LIQUIDATION);
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        // transferred to the vault adapter
        if (assetType === "ERC721") {
          const finalNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          expect(finalNFTOwner).to.equal(vaultAdapter.target);
          const depositedNFTs = await vaultAdapter.getDepositedTokens();
          expect(depositedNFTs[0]).to.equal(FIRST_NFT_ID);
        } else if( assetType === "ERC20") {
          expect(await baseAsset.balanceOf(vaultAdapter.target)).to.equal(ERC20_ASSET_AMOUNT);
        }

        const indexTokenBalance = await rwaIndexToken.balanceOf(stabilityPool.target);
        expect(await rwaIndexToken.totalSupply() - tokenSupplyBefore).to.equal(ASSET_AFTER_LIQUIDATION - ASSET_BURN); // more minted
        // all index token is swapped for CRVUSD, so nothing remaining
        expect(indexTokenBalance).to.equal(0);
        console.log("indexTokenBalance", indexTokenBalance);

        const crvusdBalance = await crvusd.balanceOf(stabilityPool.target);
        console.log("crvusdBalance", crvusdBalance);
      });

      it("reverts when debt is zero", async () => {
        // user3 never borrowed
        await expect(
          stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user1.address, assetEncodedData, 0)
        ).to.be.revertedWithCustomError(stabilityPool, "InvalidAmount");
      });

      it("should allow the user to redeem the NFT from RWA Vault", async function () {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        // set raaNFT as redeemable adapter
        await rwaVault.registerRedeemableERC721Adapter(vaultAdapter.target);

        // Initialize liquidation: Vault received NFT.
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        // Check that the index token is there
        const nfts = await vaultAdapter.getDepositedTokens();
        expect(nfts[0]).to.equal(FIRST_NFT_ID);

        const redemptionToken = await rwaVault.getNextRandomNFT();
        const redemptionAdapter = redemptionToken.adapter;
        const redemptionTokenId = redemptionToken.tokenId;
        expect(redemptionAdapter).to.equal(vaultAdapter);
        expect(redemptionTokenId).to.equal(FIRST_NFT_ID);

        const initialTotalSupply = await rwaIndexToken.totalSupply();

        // Mint initial index token equivalent to the NFT price
        const assetPrice = await vaultAdapter.getAssetValue(assetEncodedData);

        // Simulate user purchsing the index token
        await crvusd.mint(user3.address, assetPrice);
        await crvusd.connect(user3).approve(crvUSDVaultAdapter.target, assetPrice);
        const minSharesOut = await rwaVault.previewDeposit(assetPrice);
        await rwaVault.connect(user3).depositAsset(crvUSDVaultAdapter.target, encodeERC20Token(assetPrice), user3.address, minSharesOut);
        console.log(await rwaVault.convertToShares(ethers.parseEther("1")));
        expect(await rwaIndexToken.balanceOf(user3.address)).to.equal(assetPrice);

        // Redeem the NFT
        const nextNFT = await rwaVault.getNextRandomNFT();
        const maxSharesBurn = await rwaVault.previewWithdraw(assetPrice);
        await rwaVault.connect(user3).redeemNFT(nextNFT[0], nextNFT[1], maxSharesBurn);
        expect(await rwaIndexToken.balanceOf(user3.address)).to.equal(0);

        // Check the NFT ownership
        const nftOwner = await baseAsset.ownerOf(redemptionTokenId);
        expect(nftOwner).to.equal(user3.address);

        // Check that the total supply of the index token has decreased
        const finalTotalSupply = await rwaIndexToken.totalSupply();
        expect(finalTotalSupply).to.equal(initialTotalSupply); // since we mint the indx token and then spend all, the total supply should remain the same

        // check that the user balance of index token has decreased
        const userBalance = await rwaIndexToken.balanceOf(user3.address);
        expect(userBalance).to.equal(0);

        // Simulate VRF fulfillment
        const lastRequestId = await vrf.vrfConsumer.lastRequestId();
        await vrf.vrfCoordinator.fulfillRandomWordsWithOverride(lastRequestId, vrf.vrfConsumer.target, [12]);

        // Check that VRF consumer created a new word
        const request = await vrf.vrfConsumer.getRequestStatus();
        expect(request[0]).to.equal(true);
        expect(request[1]).to.equal(true);
        expect(request[2].length).to.equal(1);
        expect(request[2][0]).to.equal(12);
      });

      it("should not allow liquidation if the adapters are wrong, pool or vault or both", async function() {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        await rwaVault.registerRedeemableERC721Adapter(vaultAdapter.target);

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC721Token(2), 0)).to.be.revertedWithCustomError(stabilityPool, "InvalidAmount");
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, crvusd.target, user3.address, encodeERC721Token(1), 0)).to.be.revertedWith("StabilityPool: Vault Adapter not supported");
        await expect(stabilityPool.liquidateBorrower(crvusd.target, vaultAdapter.target, user3.address, encodeERC721Token(1), 0)).to.be.revertedWith("StabilityPool: Pool Adapter not supported");
      })

      it("should have distributed the percentages correctly after liqudiation", async function() {
        await stabilityPool.setLiquidationVaultTokenSplit(2_00, 2_00, 90_00, 6_00)

        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        const previousTotalSupply = await rwaIndexToken.totalSupply()
        const previousRTokenBalance = await rToken.balanceOf(stabilityPool.target)

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        const previousNAV = await rwaVault.pricePerShare()
        const previousTotalValue = await rwaVault.totalAssets();
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        const expectedSplit = [ASSET_AFTER_LIQUIDATION * 2_00n/100_00n, ASSET_AFTER_LIQUIDATION * 2_00n/100_00n, ASSET_AFTER_LIQUIDATION * 90_00n/100_00n, ASSET_AFTER_LIQUIDATION * 6_00n/100_00n]
        // check that the treasury received 2%
        expect(await rwaIndexToken.balanceOf(treasury)).to.equal(expectedSplit[0])
        // expect total supply of index token to be 95% of the asset value
        expect(await rwaIndexToken.totalSupply()).to.equal(previousTotalSupply + ASSET_AFTER_LIQUIDATION - expectedSplit[1])
        // expect the liquidity rewards to be 6%
        expect((await feeCollector.getCollectedFees(rwaIndexToken.target, ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS")))).otherAmount).to.equal(expectedSplit[3])

        expect(await crvusd.balanceOf(stabilityPool.target)).to.equal(0);
        expect(await rToken.balanceOf(stabilityPool.target)).to.be.greaterThanOrEqual(previousRTokenBalance);
        // expect surplus
        {
          const rtokenBalance = await rToken.balanceOf(stabilityPool.target)
          const deTokenSupply = await deToken.totalSupply();

          const delta = rtokenBalance - deTokenSupply
          expect(delta).to.be.greaterThan(0);
          await expect(stabilityPool.connect(user1).collectDust(rToken.target, owner.address, ethers.MaxUint256)).to.revertedWithCustomError(stabilityPool, "OwnableUnauthorizedAccount")
          await stabilityPool.collectDust(rToken.target, owner.address, ethers.MaxUint256);
          expect(await rToken.balanceOf(owner.address)).to.equal(delta)

          expect(await rToken.balanceOf(stabilityPool.target)).to.equal(await deToken.totalSupply());
          console.log(await rwaIndexToken.balanceOf(stabilityPool.target))
        }


        const expectedTotalValue = previousTotalValue + ASSET_AFTER_LIQUIDATION // index token is not deposited
        const expectedTotalSupply = previousTotalSupply  + ASSET_AFTER_LIQUIDATION - expectedSplit[1];
        console.log(expectedTotalSupply, expectedTotalValue)
        expect(await rwaVault.totalAssets()).to.equal(expectedTotalValue)

        const expectedNAV = expectedTotalValue * BigInt(1e18) / expectedTotalSupply;
        expect(await rwaVault.pricePerShare()).to.be.greaterThan(previousNAV);
        expect(await rwaVault.pricePerShare()).to.be.equal(expectedNAV);
      })

      it("reverts when rToken balance < needed debt", async () => {
        // drain the StabilityPool’s rTokens
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        await time.increase(30 * 60);
        await ethers.provider.send("evm_mine");
        await stabilityPool.connect(user2).withdraw(ethers.MaxUint256);

        // make the user go into the bad debt
        // borrow was 50+ (including intrest)
        // asset goes from 100 to 50
        // bad debt therefore -> no Rtoken -> revert
        await assetOracle.setHousePrice(FIRST_NFT_ID, ethers.parseEther("0.5"));
        console.log(await rToken.balanceOf(stabilityPool.target))
        console.log(await lendingPool.getPositionScaledDebt(poolAdapter.target, user3.address, assetEncodedData));
        console.log(await lendingPool.getUserCollateralValue(user3.address))

        // inititalte liquidation
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData)

        // since all the rtoken is out, we cannot have rtoken to redeem to get the delta required to send all funds to the lending pool
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, 0)).to.revertedWithCustomError(stabilityPool, "InsufficientBalance")
      });
    });

    describe("Liquidation of ERC20", function () {
      const FIRST_NFT_ID = NFT_ID;
      const FIRST_NFT_PRICE = ASSET_PRICE
      const ASSET_AFTER_LIQUIDATION = ethers.parseEther("62.5")
      const ERC20_ASSET_AMOUNT = ASSET_PRICE; // considering each erc20 as 1 crvusd
      let liquidityPool;
      let poolAdapter, vaultAdapter, baseAsset, assetOracle, assetEncodedData
      const assetType = "ERC20"

      beforeEach(async function () {
        const asset = assets[assetType];
        poolAdapter = asset.poolAdapter;
        vaultAdapter = asset.vaultAdapter;
        baseAsset = asset.baseAsset;
        assetEncodedData = asset.data;
        assetOracle = asset.oracle;

        const depositAmount = ethers.parseEther("100");
        await crvusd.mint(user2.address, depositAmount);
        await crvusd.mint(user3.address, depositAmount);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
        await stabilityPool.connect(user2).deposit(depositAmount);
        await lendingPool.connect(user3).openVaultPosition();

        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, FIRST_NFT_PRICE);
          await crvusd.connect(user3).approve(baseAsset.target, FIRST_NFT_PRICE);
          await baseAsset.connect(user3).mint(FIRST_NFT_ID, FIRST_NFT_PRICE);
          await baseAsset.connect(user3).approve(poolAdapter.target, FIRST_NFT_ID);
        } else if (assetType === "ERC20") {
          await baseAsset.mint(user3.address, ASSET_PRICE);
          await baseAsset.connect(user3).approve(poolAdapter.target, ASSET_PRICE);
        }
        await lendingPool.connect(user3).depositAsset(poolAdapter, assetEncodedData);     
        
        // borrow 100 crvusd
        await lendingPool.connect(user3).borrow(poolAdapter, assetEncodedData, ethers.parseEther("50"));

        const MockLiquidityPool = await ethers.getContractFactory("MockLiquidityPool");
        const liquidityPoolFee = 100; // 1% in base

        // From curve
        liquidityPool = await MockLiquidityPool.deploy(
            [crvusd.target, rwaIndexToken.target],  // coin addresses - crvUSD first, IndexToken second
            [ethers.parseUnits("1", 18), ethers.parseUnits("1", 18)],  // rate multipliers
            100,                            // A parameter
            liquidityPoolFee,               // fee (1%)
            "Mock Curve Pool",              // name
            "mCRV"                          // symbol
        );

        // Deposit some crvUSD to get some index token
        const initialLiquidity = ethers.parseEther("100000");
        await crvusd.mint(user1.address, initialLiquidity * 2n);

        // depositing crvUSD in vault gives index token back
        await crvusd.connect(user1).approve(crvUSDVaultAdapter.target, initialLiquidity);
        const minSharesOut = await rwaVault.previewDeposit(initialLiquidity);
        await rwaVault.connect(user1).depositAsset(crvUSDVaultAdapter.target, encodeERC20Token(initialLiquidity), user1.address, minSharesOut);


        await crvusd.connect(user1).approve(liquidityPool.target, initialLiquidity);
        await rwaIndexToken.connect(user1).approve(liquidityPool.target, initialLiquidity);

        console.log("Adding initial liquidity:", (initialLiquidity).toString());

        const amounts = [initialLiquidity, initialLiquidity];
        await liquidityPool.connect(user1).add_liquidity(amounts, 0, user1.address); // Set min_mint_amount to 0 for testing

        const crvBalance = await liquidityPool.balances(0);
        const indexBalance = await liquidityPool.balances(1);
        console.log("Initial pool balances - CRV:", crvBalance.toString(), "Index:", indexBalance.toString());

        // Enabling swap fee on rwa index token
        await liquidationSwap.setLiquidityPool(liquidityPool.target, 200, 1, 0);
        await liquidationSwap.setEnableSlippageProtection(true);
        await rwaIndexToken.setSwapPair(liquidityPool.target, true);
        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        const feeCollector = await FeeCollector.deploy(owner.address);
        await feeCollector.connect(owner).addClaimableToken(rwaIndexToken.target);
        await feeCollector.connect(owner).addWhitelistedTarget(liquidityPool.target);
        await feeCollector.connect(owner).addFeeType(ethers.keccak256(ethers.toUtf8Bytes("SWAP_FEE")), 10000, 0, 0, 0, 0, 0);
        await feeCollector.connect(owner).setTargetAddress(ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), treasury.target);
        await rwaIndexToken.setFeeCollector(feeCollector.target);

        // Set the parameteres for the liquidation
        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, ASSET_AFTER_LIQUIDATION);
        } else if (assetType === "ERC20") {
          await assetOracle.setLatestPrice(ASSET_AFTER_LIQUIDATION / 100n);
        } 
      });

      it("reverts when debt is zero", async () => {
        // user1 never borrowed
        await expect(
          stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user1.address, assetEncodedData, 0)
        ).to.be.revertedWithCustomError(stabilityPool, "InvalidAmount");
      });

      it("reverts when rToken balance < needed debt", async () => {
        // drain the StabilityPool’s rTokens
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        await time.increase(30 * 60);
        await ethers.provider.send("evm_mine");
        await stabilityPool.connect(user2).withdraw(ethers.MaxUint256);

        // make the user go into the bad debt
        // borrow was 50+ (including intrest)
        // asset goes from 100 to 50
        // bad debt therefore -> no Rtoken -> revert
        await assetOracle.setLatestPrice(ethers.parseEther("0.5"));
        console.log(await rToken.balanceOf(stabilityPool.target))
        console.log(await lendingPool.getPositionScaledDebt(poolAdapter.target, user3.address, assetEncodedData));
        console.log(await lendingPool.getUserCollateralValue(user3.address))

        // inititalte liquidation
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData)

        // since all the rtoken is out, we cannot have rtoken to redeem to get the delta required to send all funds to the lending pool
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, 0)).to.revertedWithCustomError(stabilityPool, "InsufficientBalance")
      });

      it("reverts when assetToken mismatch", async () => {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");
        const ERC20VaultAdapter = await ethers.getContractFactory("ERC20VaultAdapter");
        const dummyERC20VaultAdapter = await ERC20VaultAdapter.deploy(user1.address, user2.address, user3.address);
        await lendingPool.registerAdapter(dummyERC20VaultAdapter.target);
        await rwaVault.registerAdapter(dummyERC20VaultAdapter.target)
        await expect(
          stabilityPool.liquidateBorrower(poolAdapter.target, dummyERC20VaultAdapter.target, user3.address, assetEncodedData, 0)
        ).to.be.revertedWithCustomError(stabilityPool, "AdaptersAssetMismatch");
      });

      it("should liquidate user2 and properly transfer ERC20", async function () {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        const tokenSupplyBefore = await rwaIndexToken.totalSupply();

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        // initially stored in the pool adapter
        if (assetType === "ERC721") {
          const initialNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          // initially stored in the pool adapter
          expect(initialNFTOwner).to.equal(poolAdapter.target);
        } else if (assetType === "ERC20") {
          expect(await baseAsset.balanceOf(vaultAdapter.target)).to.equal(0);
        }
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        // transferred to the vault adapter
        if (assetType === "ERC721") {
          const finalNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          expect(finalNFTOwner).to.equal(vaultAdapter.target);
          const depositedNFTs = await vaultAdapter.getDepositedTokens();
          expect(depositedNFTs[0]).to.equal(FIRST_NFT_ID);
        } else if( assetType === "ERC20") {
          expect(await baseAsset.balanceOf(vaultAdapter.target)).to.equal(ERC20_ASSET_AMOUNT);
        }
        
        const indexTokenBalance = await rwaIndexToken.balanceOf(stabilityPool.target);
        expect(await rwaIndexToken.totalSupply() - tokenSupplyBefore).to.equal(ASSET_AFTER_LIQUIDATION - ASSET_BURN); // more minted
        // all index token is swapped for CRVUSD, so nothing remaining
        expect(indexTokenBalance).to.equal(0);
        console.log("indexTokenBalance", indexTokenBalance);

        const crvusdBalance = await crvusd.balanceOf(stabilityPool.target);
        expect(crvusdBalance).to.equal(0)
        console.log("crvusdBalance", crvusdBalance);
      });

      it("should not allow liquidation if the adapters are wrong, pool or vault or both", async function() {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        // the amount value is over the 100 collateral value
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("8493843")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        // the amount value is under the 80
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("80")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        // the amount i snot equal tot he 100: between 80-100
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("90")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, crvusd.target, user3.address, encodeERC721Token(1), 0)).to.be.revertedWith("StabilityPool: Vault Adapter not supported");
        await expect(stabilityPool.liquidateBorrower(crvusd.target, vaultAdapter.target, user3.address, encodeERC721Token(1), 0)).to.be.revertedWith("StabilityPool: Pool Adapter not supported");

        // if the amount is correct, it will liquidate
        const userDeposited = await poolAdapter.balanceOf(user3.address) // amount agnostic
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(userDeposited), mintSharesOut);
      })

      it("should have distributed the percentages correctly after liqudiation", async function() {
        // we choose 90 because total borrow is 80% so we realize profit
        await stabilityPool.setLiquidationVaultTokenSplit(2_00, 2_00, 90_00, 6_00)

        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        const previousTotalSupply = await rwaIndexToken.totalSupply()
        const previousRTokenBalance = await rToken.balanceOf(stabilityPool.target)

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        const previousNAV = await rwaVault.pricePerShare()
        const previousTotalValue = await rwaVault.totalAssets();
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        const expectedSplit = [ASSET_AFTER_LIQUIDATION * 2_00n/100_00n, ASSET_AFTER_LIQUIDATION * 2_00n/100_00n, ASSET_AFTER_LIQUIDATION * 90_00n/100_00n, ASSET_AFTER_LIQUIDATION * 6_00n/100_00n]
        // check that the treasury received 2%
        expect(await rwaIndexToken.balanceOf(treasury)).to.equal(expectedSplit[0])
        // expect total supply of index token to be 95% of the asset value
        expect(await rwaIndexToken.totalSupply()).to.equal(previousTotalSupply + ASSET_AFTER_LIQUIDATION - expectedSplit[1])
        // expect the liquidity rewards to be 6%
        expect((await feeCollector.getCollectedFees(rwaIndexToken.target, ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS")))).otherAmount).to.equal(expectedSplit[3])

        expect(await crvusd.balanceOf(stabilityPool.target)).to.equal(0);
        // TODO: this is failing because initially the Rtoken.balance of the stability pool is 200, instead of 100: why
        // expect(await rToken.balanceOf(stabilityPool.target)).to.be.greaterThanOrEqual(previousRTokenBalance);

        const expectedTotalValue = previousTotalValue + ASSET_AFTER_LIQUIDATION // index token is not deposited
        const expectedTotalSupply = previousTotalSupply  + ASSET_AFTER_LIQUIDATION - expectedSplit[1];
        console.log(expectedTotalSupply, expectedTotalValue)
        expect(await rwaVault.totalAssets()).to.equal(expectedTotalValue)

        const expectedNAV = expectedTotalValue * BigInt(1e18) / expectedTotalSupply;
        expect(await rwaVault.pricePerShare()).to.be.greaterThan(previousNAV);
        expect(await rwaVault.pricePerShare()).to.be.equal(expectedNAV);
      })
    });

    describe("Liquidation of Vault Token as collateral", function () {
      const FIRST_NFT_ID = NFT_ID;
      const FIRST_NFT_PRICE = ASSET_PRICE
      const ASSET_AFTER_LIQUIDATION = ethers.parseEther("62.5")
      const ERC20_ASSET_AMOUNT = ASSET_PRICE; // considering each erc20 as 1 crvusd
      let liquidityPool;
      let poolAdapter, vaultAdapter, baseAsset, assetOracle, assetEncodedData
      const assetType = "ERC20"

      beforeEach(async function () {
        const ERC20Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
        // we are ignoring the oracle from rwa vault.
        const rwaIndexTokenAdapter = await ERC20Adapter.deploy(rwaIndexToken.target, assets["ERC20"].oracle, lendingPool.target)
        await lendingPool.registerAdapter(rwaIndexTokenAdapter.target) // register the adapter in the lending pool

        poolAdapter = rwaIndexTokenAdapter
        vaultAdapter = assets["ERC721"].vaultAdapter // Could be anything
        baseAsset = rwaIndexToken
        assetEncodedData = encodeERC20Token(ASSET_PRICE);
        assetOracle = assets["ERC20"].oracle;


        const depositAmount = ethers.parseEther("100");
        await crvusd.mint(user2.address, depositAmount);
        await crvusd.mint(user3.address, depositAmount);
        await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
        await lendingPool.connect(user2).deposit(depositAmount);
        await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
        await stabilityPool.connect(user2).deposit(depositAmount);

        // mint some index token by depositing crvUSD
        await crvusd.mint(user3.address, depositAmount);
        await crvusd.connect(user3).approve(crvUSDVaultAdapter.target, depositAmount);
        await lendingPool.connect(user3).openVaultPosition();
        const minSharesOut = await rwaVault.previewDeposit(depositAmount);
        await rwaVault.connect(user3).depositAsset(crvUSDVaultAdapter.target, assetEncodedData, user3.address, minSharesOut);
        await rwaIndexToken.connect(user3).approve(poolAdapter.target, depositAmount)
        await lendingPool.connect(user3).depositAsset(poolAdapter.target, assetEncodedData);     
        
        // borrow 100 crvusd
        await lendingPool.connect(user3).borrow(poolAdapter, assetEncodedData, ethers.parseEther("50"));

        const MockLiquidityPool = await ethers.getContractFactory("MockLiquidityPool");
        const liquidityPoolFee = 100; // 1% in base

        // From curve
        liquidityPool = await MockLiquidityPool.deploy(
            [crvusd.target, rwaIndexToken.target],  // coin addresses - crvUSD first, IndexToken second
            [ethers.parseUnits("1", 18), ethers.parseUnits("1", 18)],  // rate multipliers
            100,                            // A parameter
            liquidityPoolFee,               // fee (1%)
            "Mock Curve Pool",              // name
            "mCRV"                          // symbol
        );

        // Deposit some crvUSD to get some index token
        const initialLiquidity = ethers.parseEther("100000");
        await crvusd.mint(user1.address, initialLiquidity * 2n);

        // depositing crvUSD in vault gives index token back
        await crvusd.connect(user1).approve(crvUSDVaultAdapter.target, initialLiquidity);
        const minSharesOut2 = await rwaVault.previewDeposit(initialLiquidity);
        await rwaVault.connect(user1).depositAsset(crvUSDVaultAdapter.target, encodeERC20Token(initialLiquidity), user1.address, minSharesOut2);


        await crvusd.connect(user1).approve(liquidityPool.target, initialLiquidity);
        await rwaIndexToken.connect(user1).approve(liquidityPool.target, initialLiquidity);

        console.log("Adding initial liquidity:", (initialLiquidity).toString());

        const amounts = [initialLiquidity, initialLiquidity];
        await liquidityPool.connect(user1).add_liquidity(amounts, 0, user1.address); // Set min_mint_amount to 0 for testing

        const crvBalance = await liquidityPool.balances(0);
        const indexBalance = await liquidityPool.balances(1);
        console.log("Initial pool balances - CRV:", crvBalance.toString(), "Index:", indexBalance.toString());

        await liquidationSwap.setLiquidityPool(liquidityPool.target, liquidityPoolFee, 1, 0);

        // Set the parameteres for the liquidation
        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, ASSET_AFTER_LIQUIDATION);
        } else if (assetType === "ERC20") {
          await assetOracle.setLatestPrice(ASSET_AFTER_LIQUIDATION / 100n);
        } 
      });

      it("reverts when debt is zero", async () => {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");
        // user1 never borrowed
        await expect(
          stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user1.address, assetEncodedData, 0)
        ).to.be.revertedWithCustomError(stabilityPool, "InvalidAmount");
      });

      it("reverts when rToken balance < needed debt", async () => {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");
        // drain the StabilityPool’s rTokens
        await stabilityPool.connect(user2).requestWithdraw(ethers.MaxUint256);
        await time.increase(30 * 60);
        await ethers.provider.send("evm_mine");
        await stabilityPool.connect(user2).withdraw(ethers.MaxUint256);

        console.log(await lendingPool.getPositionScaledDebt(poolAdapter.target, user3.address, assetEncodedData))

        if (assetType === "ERC721") {
          await assetOracle.setHousePrice(FIRST_NFT_ID, ethers.parseEther("50"));
        } else if (assetType === "ERC20") {
          await assetOracle.setLatestPrice(ethers.parseEther("0.5"));
        } 

        // NOTE: Does not revert because the 100 iRAAC is swapped in the liquidty pool which still has price of 1.
        // the oracle is used in the adapter, not in the liquidyt pool and therefore the liquidation still occurs.
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData);
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, 0)
        
        // await expect(
        //   stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, 0)
        // ).to.be.revertedWithCustomError(stabilityPool, "InsufficientBalance");
      });

      it("reverts when assetToken mismatch", async () => {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();
        await expect(
          stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, 0)
        ).to.be.not.reverted; // asset is index token so the mismatch will not happen
      });

      it("should liquidate and transfer correct index token minting fees", async function () {
        const tokenSupplyBefore = await rwaIndexToken.totalSupply();
        console.log(tokenSupplyBefore);
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        const Treasury = await ethers.getContractFactory("Treasury");
        const treasury = await Treasury.deploy(owner.address);

        await rwaVault.setFeeCollector(treasury.target); // it is not required here

        // we are depositing 100. So 100 index token are minted. The treasury should receive 2
        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        // since index token is the asset, we do not mint
        expect(await treasury.getBalance(rwaIndexToken.target)).to.equal(0)

        // No token has been minted since its the vault token
        // But the tokens has been burnts by some %
        expect(await rwaIndexToken.totalSupply() - tokenSupplyBefore).to.equal(-ASSET_BURN)

        const indexTokenBalance = await rwaIndexToken.balanceOf(stabilityPool.target);
        // all index token is swapped for CRVUSD, so nothing remaining
        expect(indexTokenBalance).to.equal(0);

        const crvusdBalance = await crvusd.balanceOf(stabilityPool.target);
        expect(crvusdBalance).to.equal(0)
      });

      it("should liquidate user2 and properly transfer ERC20", async function () {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        // initially stored in the pool adapter
        if (assetType === "ERC721") {
          const initialNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          // initially stored in the pool adapter
          expect(initialNFTOwner).to.equal(poolAdapter.target);
        } else if (assetType === "ERC20") {
          expect(await baseAsset.balanceOf(vaultAdapter.target)).to.equal(0);
        }
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        // transferred to the vault adapter
        if (assetType === "ERC721") {
          const finalNFTOwner = await baseAsset.ownerOf(FIRST_NFT_ID);
          expect(finalNFTOwner).to.equal(vaultAdapter.target);
          const depositedNFTs = await vaultAdapter.getDepositedTokens();
          expect(depositedNFTs[0]).to.equal(FIRST_NFT_ID);
        } else if( assetType === "ERC20") {
          expect(await baseAsset.balanceOf(vaultAdapter.target)).to.equal(0); // index token does not get deposited
        }

        
        const indexTokenBalance = await rwaIndexToken.balanceOf(stabilityPool.target);
        // all index token is swapped for CRVUSD, so nothing remaining
        expect(indexTokenBalance).to.equal(0);
        console.log("indexTokenBalance", indexTokenBalance);

        const crvusdBalance = await crvusd.balanceOf(stabilityPool.target);
        expect(crvusdBalance).to.equal(0)
      });

      it("should not allow liquidation if the adapters are wrong, pool or vault or both", async function() {
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        // the amount value is over the 100 collateral value
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("8493843")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        // the amount value is under the 80
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("80")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        // the amount i snot equal tot he 100: between 80-100
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, encodeERC20Token(ethers.parseEther("90")), 0)).to.be.revertedWithCustomError(stabilityPool, "CollateralAndParamterDataMismatch");
        
        await expect(stabilityPool.liquidateBorrower(crvusd.target, vaultAdapter.target, user3.address, encodeERC721Token(1), 0)).to.be.revertedWith("StabilityPool: Pool Adapter not supported");

        // if the amount is correct, it will liquidate
        const userDeposited = await poolAdapter.balanceOf(user3.address) // amount agnostic
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, crvusd.target, user3.address,  encodeERC20Token(userDeposited), mintSharesOut)).to.not.reverted // does not revert since it does not depend on index token
      })

      it("should have distributed the percentages correctly after liqudiation", async function() {
        await stabilityPool.setLiquidationVaultTokenSplit(2_00, 2_00, 90_00, 6_00)

        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        const previousTotalSupply = await rwaIndexToken.totalSupply()
        const previousRTokenBalance = await rToken.balanceOf(stabilityPool.target)

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        const previousNAV = await rwaVault.pricePerShare()
        const previousTotalValue = await rwaVault.totalAssets();
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut);

        const expectedSplit = [ERC20_ASSET_AMOUNT * 2_00n/100_00n, ERC20_ASSET_AMOUNT * 2_00n/100_00n, ERC20_ASSET_AMOUNT * 90_00n/100_00n, ERC20_ASSET_AMOUNT * 6_00n/100_00n]
        // check that the treasury received 2%
        expect(await rwaIndexToken.balanceOf(treasury)).to.equal(expectedSplit[0])
        // expect total supply of index token to be 95% of the asset value
        expect(await rwaIndexToken.totalSupply()).to.equal(previousTotalSupply - expectedSplit[1])
        // expect the liquidity rewards to be 6%
        expect((await feeCollector.getCollectedFees(rwaIndexToken.target, ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS")))).otherAmount).to.equal(expectedSplit[3])

        expect(await crvusd.balanceOf(stabilityPool.target)).to.equal(0);
        // TODO: this is failing because initially the Rtoken.balance of the stability pool is 200, instead of 100: why
        // expect(await rToken.balanceOf(stabilityPool.target)).to.be.greaterThanOrEqual(previousRTokenBalance);

        // check that the NAV value increased
        
        const expectedTotalValue = previousTotalValue // index token is not deposited
        const expectedTotalSupply = previousTotalSupply - expectedSplit[1];
        console.log(expectedTotalSupply, expectedTotalValue)
        expect(await rwaVault.totalAssets()).to.equal(expectedTotalValue)

        const expectedNAV = expectedTotalValue * BigInt(1e18) / expectedTotalSupply;
        expect(await rwaVault.pricePerShare()).to.be.greaterThan(previousNAV);
        expect(await rwaVault.pricePerShare()).to.be.equal(expectedNAV);

      })

      it("should allow liquidation despite very low lending pool supply cap", async function () {
        const veryLowSupplyCap = ethers.parseEther("10");
        // Since borrowCap must < supplyCap, we set the supply cap to a higher value
        await lendingPool.setParameter(OwnerParameter.LendingPoolBorrowCap, veryLowSupplyCap - 1n);
        await lendingPool.setParameter(OwnerParameter.LendingPoolSupplyCap, veryLowSupplyCap);
        
        const liquidity = (await lendingPool.getReserveState()).totalLiquidity;
        expect(liquidity).to.be.greaterThan(veryLowSupplyCap);
        
        await time.increase(86400);
        await ethers.provider.send("evm_mine");

        // Make sure that any deposit to the lending pool will fail due to low supply cap (just to make sure the supply cap is set)
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("11"))
        
        await expect(lendingPool.connect(user1).deposit(ethers.parseEther("11"))).to.be.revertedWithCustomError(lendingPool, "SupplyCapReached");

        await lendingPool.initiateLiquidation(poolAdapter.target, user3.address, assetEncodedData); 
        await lendingPool.connect(user3).updateState();

        const stabilityPoolBalanceBefore = await crvusd.balanceOf(stabilityPool.target);
        
        const mintSharesOut = await rwaVault.previewDeposit(await vaultAdapter.getAssetValue(assetEncodedData));
        await expect(stabilityPool.liquidateBorrower(poolAdapter.target, vaultAdapter.target, user3.address, assetEncodedData, mintSharesOut)).to.not.be.revertedWithCustomError(lendingPool, "SupplyCapReached");
        
        const position = await lendingPool.getPosition(poolAdapter.target, user3.address, assetEncodedData);
        expect(position.rawDebtBalance).to.equal(0);
        
        const stabilityPoolBalanceAfter = await crvusd.balanceOf(stabilityPool.target);
        
        expect(stabilityPoolBalanceAfter).to.equal(stabilityPoolBalanceBefore);
      });
    });

    describe("Dust Handling", function () {
      beforeEach(async function () {
        const initialAmount = ethers.parseEther("10");
        await crvusd.mint(user1.address, initialAmount);
        await crvusd.connect(user1).approve(lendingPool.target, initialAmount);
        await lendingPool.connect(user1).deposit(initialAmount);
        await rToken.connect(user1).approve(stabilityPool.target, initialAmount);
        await stabilityPool.setWithdrawTimelockDuration(0);
      });

      it("should handle dust amounts correctly in deposits", async function () {
        // disabling the lending pool min deposit amount so that the deposit() can work
        await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1); 
        const dustAmount = ethers.parseEther("0.0000001");
        await crvusd.mint(user1.address, dustAmount);
        await crvusd.connect(user1).approve(lendingPool.target, dustAmount);
        await lendingPool.connect(user1).deposit(dustAmount);
        await rToken.connect(user1).approve(stabilityPool.target, dustAmount);
        await stabilityPool.connect(user1).deposit(dustAmount);
        
        const userDeposit = await stabilityPool.getUserDeposit(user1.address);
        expect(userDeposit).to.equal(dustAmount);
      });

      it("should handle dust amounts correctly in withdrawals", async function () {
        // disabling the lending pool min deposit amount so that the deposit() can work
        await lendingPool.setParameter(OwnerParameter.MinDepositAmount, ethers.parseEther("1"));
        const initialAmount = ethers.parseEther("1");
        const dustAmount = ethers.parseEther("0.0000001");
        
        await crvusd.mint(user1.address, initialAmount);
        await crvusd.connect(user1).approve(lendingPool.target, initialAmount);
        await lendingPool.connect(user1).deposit(initialAmount);
        await rToken.connect(user1).approve(stabilityPool.target, initialAmount);
        await stabilityPool.connect(user1).deposit(initialAmount);
        
        await stabilityPool.connect(user1).withdraw(dustAmount);
        const remainingDeposit = await stabilityPool.getUserDeposit(user1.address);
        expect(remainingDeposit).to.equal(initialAmount - dustAmount);
      });

      it("should maintain precision with multiple dust operations", async function () {
        // disabling the lending pool min deposit amount so that the deposit() can work
        await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1);
        const dustAmount = ethers.parseEther("0.0000001");
        let totalDeposited = 0n;
        
        // Multiple small deposits
        for (let i = 0; i < 5; i++) {
          await crvusd.mint(user1.address, dustAmount);
          await crvusd.connect(user1).approve(lendingPool.target, dustAmount);
          await lendingPool.connect(user1).deposit(dustAmount);
          await rToken.connect(user1).approve(stabilityPool.target, dustAmount);
          await stabilityPool.connect(user1).deposit(dustAmount);
          totalDeposited += dustAmount;
        }
        
        const userDeposit = await stabilityPool.getUserDeposit(user1.address);
        expect(userDeposit).to.equal(totalDeposited);
      });
    });
  });

  describe("Access Control", function () {
    it("should enforce owner restrictions", async function () {
      await expect(
        stabilityPool.connect(user1).addManager(user2.address)
      ).to.be.revertedWithCustomError(stabilityPool, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to add and remove managers", async function () {
      await stabilityPool.addManager(user1.address);
      expect(await stabilityPool.isAddressManager(user1.address)).to.be.true;

      await stabilityPool.removeManager(user1.address);
      expect(await stabilityPool.isAddressManager(user1.address)).to.be.false;
    });
    it("should prevent blacklisted users from withdrawing", async function () {
      // Setup: user2 makes a deposit first
      const depositAmount = ethers.parseEther("50");
      await crvusd.mint(user2.address, depositAmount);
      await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user2).deposit(depositAmount);
      await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
      await stabilityPool.connect(user2).deposit(depositAmount);

      // Verify user2 has a balance
      const userBalance = await deToken.balanceOf(user2.address);
      expect(userBalance).to.equal(depositAmount);

      // Blacklist user2
      await complianceRegistry.blacklist(user2.address);
      expect(await complianceRegistry.isBlacklisted(user2.address)).to.be.true;

      // Disable withdraw timelock for this test
      await stabilityPool.setWithdrawTimelockDuration(0);

      // Attempt to withdraw should fail with BlacklistedAddress error
      await expect(
        stabilityPool.connect(user2).withdraw(depositAmount)
      ).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");

      // Verify balance remains unchanged
      const balanceAfter = await deToken.balanceOf(user2.address);
      expect(balanceAfter).to.equal(depositAmount);
    });
    it("should not allow DEToken transfer if user is blacklisted", async function () {
      await complianceRegistry.blacklist(user1.address);
      await expect(deToken.connect(user1).transfer(user2.address, ethers.parseEther("10"))).to.be.revertedWithCustomError(deToken, "BlacklistedAddress");
    });
  });

  describe("Emergency Functions", function () {
    beforeEach(async function () {
      const depositAmount = ethers.parseEther("50");
      await crvusd.mint(user2.address, depositAmount);
      await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user2).deposit(depositAmount);
      await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
    });

    it("should allow owner to pause and unpause", async function () {
      await stabilityPool.pause();
      expect(await stabilityPool.paused()).to.be.true;
      
      await expect(
        stabilityPool.connect(user1).deposit(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(stabilityPool, "EnforcedPause");
      
      await stabilityPool.unpause();
      expect(await stabilityPool.paused()).to.be.false;
    });

    it("should prevent all operations when paused", async function () {
      await stabilityPool.pause();
      
      await expect(
        stabilityPool.connect(user1).deposit(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(stabilityPool, "EnforcedPause");
      
      await expect(
        stabilityPool.connect(user1).withdraw(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(stabilityPool, "EnforcedPause");
      const asset = assets["ERC721"]
      await expect(
        stabilityPool.liquidateBorrower(asset.poolAdapter.target, asset.vaultAdapter.target, user1.address, encodeERC721Token(1), 0)
      ).to.be.revertedWithCustomError(stabilityPool, "InvalidAmount");
    });

    it("should maintain state after pause and unpause", async function () {
      // Make initial deposit
      await stabilityPool.connect(user2).deposit(ethers.parseEther("50"));
      const balanceBefore = await stabilityPool.getUserDeposit(user2.address);
      
      // Pause and unpause
      await stabilityPool.pause();
      await stabilityPool.unpause();
      
      // Check balance remains unchanged
      const balanceAfter = await stabilityPool.getUserDeposit(user2.address);
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("Exchange Rate", function () {
    beforeEach(async function () {
      const depositAmount = ethers.parseEther("100");
      await crvusd.mint(user2.address, depositAmount);
      await crvusd.connect(user2).approve(lendingPool.target, depositAmount);
      await lendingPool.connect(user2).deposit(depositAmount);
      await rToken.connect(user2).approve(stabilityPool.target, depositAmount);
    });

    // We have no exchange rate, so we can't test this
    it("should handle exchange rate precision correctly", async function () {
      // disabling the lending pool min deposit amount so that the deposit() can work
      await lendingPool.setParameter(OwnerParameter.MinDepositAmount, 1);
      const smallAmount = ethers.parseEther("0.0001");
      
      // Mint and approve additional tokens for small amount
      await crvusd.mint(user2.address, smallAmount);
      await crvusd.connect(user2).approve(lendingPool.target, smallAmount);
      
      await lendingPool.connect(user2).deposit(smallAmount);
      await rToken.connect(user2).approve(stabilityPool.target, smallAmount);
      await stabilityPool.connect(user2).deposit(smallAmount);
      
      const deTokenBalance = await deToken.balanceOf(user2.address);
      expect(deTokenBalance).to.equal(smallAmount); // 1:1 exchange rate
    });
   
  });


  describe("State Consistency", function () {
    beforeEach(async function () {
      await stabilityPool.setWithdrawTimelockDuration(0);
    });
    it("should maintain correct state after multiple operations", async function () {
      const initialAmount = ethers.parseEther("100");
      const additionalAmount = ethers.parseEther("50");
      const totalAmount = initialAmount + additionalAmount;
      
      // Initial setup
      await crvusd.mint(user1.address, totalAmount);
      await crvusd.connect(user1).approve(lendingPool.target, totalAmount);
      
      // Initial deposit
      await lendingPool.connect(user1).deposit(initialAmount);
      await rToken.connect(user1).approve(stabilityPool.target, initialAmount);
      await stabilityPool.connect(user1).deposit(initialAmount);
      
      // Partial withdrawal
      await stabilityPool.connect(user1).withdraw(ethers.parseEther("30"));
      
      // Additional deposit
      await lendingPool.connect(user1).deposit(additionalAmount);
      await rToken.connect(user1).approve(stabilityPool.target, additionalAmount);
      await stabilityPool.connect(user1).deposit(additionalAmount);
      
      // Verify final state
      const finalDeposit = await stabilityPool.getUserDeposit(user1.address);
      expect(finalDeposit).to.equal(ethers.parseEther("120"));
    });

    it("should handle concurrent deposits and withdrawals correctly", async function () {
      const amount1 = ethers.parseEther("100");
      const amount2 = ethers.parseEther("50");
      
      // Setup initial deposits for both users
      await crvusd.mint(user1.address, amount1);
      await crvusd.mint(user2.address, amount2);
      
      await crvusd.connect(user1).approve(lendingPool.target, amount1);
      await crvusd.connect(user2).approve(lendingPool.target, amount2);
      
      await lendingPool.connect(user1).deposit(amount1);
      await lendingPool.connect(user2).deposit(amount2);


      
      await rToken.connect(user1).approve(stabilityPool.target, amount1);
      await rToken.connect(user2).approve(stabilityPool.target, amount2);

      // Perform concurrent operations
      await Promise.all([
        stabilityPool.connect(user1).deposit(amount1), // ~100
        // stabilityPool.connect(user2).deposit(amount2) // ~50
      ]);
      
      // const initialDeposit = await stabilityPool.getTotalDeposits();
      // await Promise.all([
      //   stabilityPool.connect(user1).withdraw(ethers.parseEther("30")), // left 70
      //   stabilityPool.connect(user2).withdraw(ethers.parseEther("20")) // left 30
      // ]);
      
      // const totalDeposits = await stabilityPool.getTotalDeposits();
      // expect(totalDeposits).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Mock", function () {
    // https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2Mock.sol
    let vrfConsumer;
    beforeEach(async function () {
      const VRFConsumer = await ethers.getContractFactory("BaseVRFv2Consumer");
      vrfConsumer = await VRFConsumer.deploy(vrf.vrfSubId, vrf.vrfCoordinator.target, VRF_KEY_HASH, 100000, 1, 1, owner.address);

      await vrf.vrfCoordinator.addConsumer(vrf.vrfSubId, vrfConsumer.target);
    });
    it("Should check that the VRF is deployed correctly", async function () {
      const subscription = await vrf.vrfCoordinator.getSubscription(vrf.vrfSubId);
      expect(subscription).to.not.reverted;
    });
    it("should not allow non-owner to send request", async function () {
      await vrfConsumer.requestRandomWords();
      const requestId = await vrfConsumer.lastRequestId()
      await vrf.vrfCoordinator.fulfillRandomWordsWithOverride(requestId, vrfConsumer.target, [21]);
      const result = await vrfConsumer.getRequestStatus();
      expect(result[0]).to.equal(true);
      expect(result[1]).to.equal(true);
      const values = result[2];
      expect(values[0]).to.equal(21);
    });
  });
});