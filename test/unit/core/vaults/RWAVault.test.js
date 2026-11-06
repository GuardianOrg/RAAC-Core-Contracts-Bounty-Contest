import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { solidityPackedKeccak256 } from "ethers";


const FIRST_NFT_ID = 1
const SECOND_NFT_ID = 2
let RANDOM_NUMBER = 12

async function deployERC20(vault) {
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;

  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
  erc20Token = await ERC20Mock.deploy("RWA Vault Token", "RWAToken", 18);

  const MockERC20PriceOracle = await ethers.getContractFactory("MockERC20PriceOracle");
  erc20PriceOracle = await MockERC20PriceOracle.deploy();

  await erc20PriceOracle.setLatestPrice(ethers.parseEther("1"));

  const ERC20Adapter = await ethers.getContractFactory("ERC20VaultAdapter");
  erc20TokenAdapter = await ERC20Adapter.deploy(erc20Token.target, erc20PriceOracle.target, vault.target)

  return [erc20Token, erc20TokenAdapter, erc20PriceOracle]; 
}

function encodeERC721Token(tokenID) {
  return new ethers.AbiCoder().encode(["uint256"], [tokenID])
}
function encodeERC20Token(amount) {
  return new ethers.AbiCoder().encode(["uint256"], [amount]);
}

function extractAsset(assets, assetType) {
  const asset = assets[assetType];
  let vaultAdapter = asset.adapter
  let baseAsset = asset.baseAsset;
  let assetData = asset.data
  let oracle = asset.oracle;
  return [baseAsset, vaultAdapter, assetData, oracle];
}

// TODO: test with depositing tokens of different decimals
// TODO: test properly in case of total value > total suppl etC: rounding and expectation of the shares price. Make sure it never reaches 0.

describe("RWAVault", function () {
  let owner, user1, user2, user3;
  let crvusd, raacNFT, raacHousePrices, rwaVault, rwaIndexToken, vrfCoordinator, vrfConsumer, feeCollector, complianceRegistry, crvUSDToUSDOracle;
  let deployer;
  let vrfSubId;

  const VRF_KEY_HASH = "0x8af398995b04c28e9951adb9721ef74c74f93e6a478f39e7e0777be13527e7ef";
  const VRF_FEE = ethers.parseEther("0.1");
  const VRF_GAS = 2000000;
  const VRF_WEIPERLINK = 7291990000000000

  const MINT_FEE = ethers.keccak256(ethers.toUtf8Bytes("MINT_FEE"));

  const ASSET_PRICE = ethers.parseEther("100")
  let assets = {}

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    // deployments
    const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
    crvusd = await CrvUSDToken.deploy(owner.address);
  
    await crvusd.setMinter(owner.address);

    const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
    crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);
    
    const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
    raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);

    const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
    complianceRegistry = await ComplianceRegistry.deploy()
  
    const RAACNFT = await ethers.getContractFactory("RAACNFT");
    raacNFT = await RAACNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address);

    const RWAIndexToken = await ethers.getContractFactory("RWAIndexToken");
    rwaIndexToken = await RWAIndexToken.deploy("RWA Index Token", 'RRWA', complianceRegistry.target)

    const RWAVault = await ethers.getContractFactory("RWAVault");
    rwaVault = await RWAVault.deploy(rwaIndexToken.target, complianceRegistry.target);

    const FeeCollector = await ethers.getContractFactory("FeeCollector")
    feeCollector = await FeeCollector.deploy(owner.address);

    await feeCollector.addFeeType(MINT_FEE, 20_00, 0, 80_00, 0, 0, 0);
    await feeCollector.addClaimableToken(rwaIndexToken.target)

    // setup RWAVault in Index token
    rwaIndexToken.setVault(rwaVault.target);

    // mint some money to user1
    const mintAmount = ethers.parseEther("10000");
    await crvusd.mint(user1.address, mintAmount);

    // set house prices
    await raacHousePrices.setOracle(owner.address);
    await raacHousePrices.setHousePrice(FIRST_NFT_ID, ASSET_PRICE);
    await raacHousePrices.setHousePrice(SECOND_NFT_ID, ASSET_PRICE);
    await ethers.provider.send("evm_mine", []);

    // check the price is set correctly
    const housePrice = await raacHousePrices.tokenToHousePrice(FIRST_NFT_ID);
    expect(housePrice).to.equal(ASSET_PRICE);
    const priceFromNFT = await raacNFT.getHousePrice(FIRST_NFT_ID);
    expect(priceFromNFT).to.equal(ASSET_PRICE);

    // mint  property 1 and give it to user 1
    const amountToPay = ASSET_PRICE;
    await crvusd.mint(user1.address, amountToPay);
    await crvusd.connect(user1).approve(raacNFT.target, amountToPay);
    await raacNFT.connect(user1).mint(FIRST_NFT_ID, amountToPay);

    await ethers.provider.send("evm_mine", []);

    // set the VRF
    const MockVRFCoordinatorV2 = await ethers.getContractFactory("MockVRFCoordinatorV2");
    vrfCoordinator = await MockVRFCoordinatorV2.deploy(VRF_FEE, VRF_GAS, VRF_WEIPERLINK);
    await vrfCoordinator.createSubscription();

    const activeSubIds = await vrfCoordinator.getActiveSubscriptionIds(0, 1);
    vrfSubId = activeSubIds[0];
    await vrfCoordinator.fundSubscription(vrfSubId, ethers.parseEther("10000"));

    const VRFConsumer = await ethers.getContractFactory("BaseVRFv2Consumer");
    vrfConsumer = await VRFConsumer.deploy(vrfSubId, vrfCoordinator.target, VRF_KEY_HASH, 100000, 1, 1, rwaVault.target);
    await vrfCoordinator.addConsumer(vrfSubId, vrfConsumer.target);

    // set the VRF in the RWAVault
    await rwaVault.setVRFConsumer(vrfConsumer.target);
    await vrfCoordinator.fulfillRandomWordsWithOverride(await vrfConsumer.lastRequestId(), vrfConsumer.target, [RANDOM_NUMBER]);

    // setup the assets list
    const [erc20Token, erc20TokenAdapter, erc20PriceOracle] = await deployERC20(rwaVault);

    const RAACNFTVaultAdapterOracle = await ethers.getContractFactory("RAACNFTVaultAdapterOracle");
    const raacNFTVaultAdapterOracle = await RAACNFTVaultAdapterOracle.deploy(raacHousePrices.target);

    const RAACNFTVaultAdapter = await ethers.getContractFactory("RAACNFTVaultAdapterV2")
    const raacNFTAdapter = await RAACNFTVaultAdapter.deploy(raacNFT.target, raacNFTVaultAdapterOracle.target, rwaVault.target, raacHousePrices.target) 

    // add the syncer to the house prices
    await raacHousePrices.addSyncer(raacNFTAdapter.target);

    await rwaVault.registerAdapter(erc20TokenAdapter.target)
    await rwaVault.registerAdapter(raacNFTAdapter.target);
    assets["ERC20"] = {baseAsset: erc20Token, adapter: erc20TokenAdapter, data: encodeERC20Token(ASSET_PRICE), oracle: erc20PriceOracle}
    assets["ERC721"] = {baseAsset: raacNFT, adapter: raacNFTAdapter, data: encodeERC721Token(1), oracle: raacHousePrices}
  });

  // it.skip("should deposit a lot and see gas requirements", async function() {
  //   // keep minting any buying new nfts and then depositing them and calling the pricePerShare()
  //   await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
  //   let count = 1;
  //   while(true) {
  //     await raacHousePrices.setHousePrice(count+1, ASSET_PRICE);
  //     await raacNFT.minterMint(user1.address, count+1);
  //     const raacNFTAdapter = assets["ERC721"].adapter;
  //     await raacNFT.connect(user1).approve(raacNFTAdapter.target, count+1);
  //     console.log("Gas cost for calling depositAsset: ", await rwaVault.connect(user1).depositAsset.estimateGas(raacNFTAdapter.target, encodeERC721Token(count+1), user1.address));
  //     await rwaVault.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(count+1), user1.address);

  //     // console.log("Count: ", count);
  //     // console.log("PricePerShare: ", await rwaVault.pricePerShare());
  //     console.log("Gas cost for calling pricePerShare: ", await rwaVault.pricePerShare.estimateGas());
  //     // see how much cost to deposit an asset
  //     console.log(count)
  //     count++;
  //   }
  // })
  describe("Access, Control and Initialization", function() {
    it("Should setup the RWA Vault properly", async () => {
      expect(await rwaVault.underlyingVaultToken()).to.equal(rwaIndexToken.target)
      expect(await rwaVault.vrfConsumer()).to.equal(vrfConsumer.target);
      expect(await rwaVault.adapters(0)).to.equal(assets["ERC20"].adapter)
      expect(await rwaVault.adapters(1)).to.equal(assets["ERC721"].adapter)
      await expect(rwaVault.redeemableERC721Adapters(0)).to.be.reverted
      await expect(rwaVault.depositableAdapters(0)).to.be.reverted
    })
    it("should prevent non-owner access", async function() {
      await expect(rwaVault.connect(user1).setVRFConsumer(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).setStabilityPool(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).setIndexTokenMintingFee(90_00)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).setFeeCollector(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).registerAdapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).unregisterAdapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).registerDepositableAdapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).unregisterDepositableAdapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).registerRedeemableERC721Adapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).unregisterRedeemableERC721Adapter(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")
      await expect(rwaVault.connect(user1).addManager(user1.address)).to.be.revertedWithCustomError(rwaVault, "OwnableUnauthorizedAccount")

      await (rwaVault.registerAdapter(user1.address))
      await expect(rwaVault.connect(user1).poolDepositAsset(user1.address, encodeERC20Token("2"), user1.address, 0)).to.be.revertedWith("RWAVault: only stability pool caller")
      await expect(rwaVault.connect(user1).adminWithdrawAsset(user1.address, encodeERC20Token("2"), user1.address, false, 0)).to.be.revertedWithCustomError(rwaVault, "NotManager")
      await expect(rwaVault.connect(user1).adminDepositAsset(user1.address, encodeERC20Token("2"), false, 0)).to.be.revertedWithCustomError(rwaVault, "NotManager")
    })
    it("should allow owner access", async function() {
      await expect(rwaVault.setStabilityPool(user1.address)).to.not.reverted
      expect(await rwaVault.stabilityPool()).to.equal(user1.address)
      await expect(rwaVault.setIndexTokenMintingFee(90_00)).to.not.reverted
      expect(await rwaVault.indexTokenMintingFee()).to.equal(90_00n)
      await expect(rwaVault.setFeeCollector(user1.address)).to.not.reverted
      expect(await rwaVault.feeCollector()).to.equal(user1.address)
      await expect(rwaVault.addManager(user1.address)).to.not.reverted
      expect(await rwaVault.isManager(user1.address)).to.be.true
      const ERC20Adapter = await ethers.getContractFactory("ERC20VaultAdapter")
      const erc20Adapter = await ERC20Adapter.deploy(crvusd.target, user1.address, user1.address)
      await expect(rwaVault.registerAdapter(erc20Adapter.target)).to.not.reverted
      await expect(rwaVault.unregisterAdapter(erc20Adapter.target)).to.not.reverted
      await expect(rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target)).to.not.reverted
      await expect(rwaVault.unregisterDepositableAdapter(assets["ERC721"].adapter.target)).to.not.reverted
      await expect(rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target)).to.not.reverted
      await expect(rwaVault.unregisterRedeemableERC721Adapter(assets["ERC721"].adapter.target)).to.not.reverted
    })
  })

  describe("Adapters", function() {
    it("should insert and remove a supported adapter", async function() {
      // two adapters are already inserted
      expect(await rwaVault.supportedAdapters(assets["ERC20"].adapter.target)).to.be.true;
      expect(await rwaVault.supportedAdapters(assets["ERC721"].adapter.target)).to.be.true;
      expect(await rwaVault.supportedAdapters(user1.address)).to.be.false;

      await expect(rwaVault.registerAdapter(assets["ERC20"].adapter.target)).to.be.revertedWith("RWAVault: adapter already supported")

      // remove
      await rwaVault.unregisterAdapter(assets["ERC20"].adapter.target)
      expect(await rwaVault.adapters(0)).to.equal(assets["ERC721"].adapter.target)
      expect(await rwaVault.supportedAdapters(assets["ERC20"].adapter.target)).to.be.false;
    })
    it("should insert and remove a depositable adapter", async function() {
       // two adapters are already inserted
       await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
       expect(await rwaVault.supportedDepositableAdapters(assets["ERC721"].adapter.target)).to.be.true;
       expect(await rwaVault.depositableAdapters(0)).to.equal(assets["ERC721"].adapter.target)
       expect(await rwaVault.supportedDepositableAdapters(assets["ERC20"].adapter.target)).to.be.false;

       await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
       expect(await rwaVault.supportedDepositableAdapters(assets["ERC20"].adapter.target)).to.be.true;
       expect(await rwaVault.depositableAdapters(1)).to.equal(assets["ERC20"].adapter.target)

       await expect(rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target)).to.be.revertedWith("RWAVault: depositable already supported")
 
       // remove
       await rwaVault.unregisterDepositableAdapter(assets["ERC20"].adapter.target)
       expect(await rwaVault.depositableAdapters(0)).to.equal(assets["ERC721"].adapter.target)
       expect(await rwaVault.supportedDepositableAdapters(assets["ERC20"].adapter.target)).to.be.false;
    })
    it("should insert and remove a redeemable adapter", async function() {
      // two adapters are already inserted
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);
      expect(await rwaVault.supportedRedeemableERC721Adapters(assets["ERC721"].adapter.target)).to.be.true;
      expect(await rwaVault.redeemableERC721Adapters(0)).to.equal(assets["ERC721"].adapter.target)
      expect(await rwaVault.supportedRedeemableERC721Adapters(assets["ERC20"].adapter.target)).to.be.false;

      await expect(rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target)).to.be.revertedWith("RWAVault: redeemalble already supported")

      // should revert if trying to register non ERC721Enumerable contract
      await expect(rwaVault.registerRedeemableERC721Adapter(assets["ERC20"].adapter.target)).to.be.revertedWith("RWAVault: adapter is not ERC721")

      // remove
      await rwaVault.unregisterRedeemableERC721Adapter(assets["ERC721"].adapter.target)
      expect(await rwaVault.supportedRedeemableERC721Adapters(assets["ERC721"].adapter.target)).to.be.false;
   })
   it("should allow removing adapter if funds are still inside",  async function() {
    // throw some assets in the adapter and try removing it. it should revert 
      const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, "ERC20");
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);
      await baseAsset.mint(user1.address, ASSET_PRICE)
      await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
      await rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
      await rwaVault.unregisterDepositableAdapter(vaultAdapter.target);
      await expect(rwaVault.unregisterAdapter(vaultAdapter.target)).to.not.reverted
   })
   it("should not allow removing adapter if it is registered as redeemable or depositable",  async function() {
    // throw some assets in the adapter and try removing it. it should revert 
      const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, "ERC721");
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);
      await expect(rwaVault.unregisterAdapter(vaultAdapter.target)).to.be.revertedWith("RWAVault: adapter is registered as redeemable or depositable")
      await rwaVault.registerRedeemableERC721Adapter(vaultAdapter.target);
      await expect(rwaVault.unregisterAdapter(vaultAdapter.target)).to.be.revertedWith("RWAVault: adapter is registered as redeemable or depositable")

      await rwaVault.unregisterDepositableAdapter(vaultAdapter.target);
      await expect(rwaVault.unregisterAdapter(vaultAdapter.target)).to.be.revertedWith("RWAVault: adapter is registered as redeemable or depositable")
      await rwaVault.unregisterRedeemableERC721Adapter(vaultAdapter.target);
      await expect(rwaVault.unregisterAdapter(vaultAdapter.target)).to.not.reverted
   })
  })

  describe("Deposit Public Assets: General", function() {
    const assetType = "ERC20"
    let baseAsset, vaultAdapter, encodedAssetData, assetOracle;
    beforeEach(function() {
      [baseAsset, vaultAdapter, encodedAssetData, assetOracle] = extractAsset(assets, assetType);
    })
    it("Should allow a user to deposit asset in the vault", async () => {
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);

      if (assetType === "ERC20") {
        await baseAsset.mint(user1.address, ASSET_PRICE)
        await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
      } else if (assetType === "ERC721") {
        await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
      }

      const totalSupplyBefore = await rwaIndexToken.totalSupply();
      expect(await vaultAdapter.totalValue()).to.equal(0)
      await rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
      // check the balance of the index token, should be 1:1
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(ASSET_PRICE);
      expect(await rwaIndexToken.totalSupply() - totalSupplyBefore).to.equal(ASSET_PRICE);
      // check that the vault has received the crvUSD
      expect(await vaultAdapter.totalValue()).to.equal(ASSET_PRICE) // considering 1:1
    })
    it("should prevent non-supported assets to be deposited in the vault", async function() {
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);
      await rwaVault.setFeeCollector(feeCollector.target)
      const indexTokenMintingFee = await rwaVault.indexTokenMintingFee();

      if (assetType === "ERC20") {
        await baseAsset.mint(user1.address, ASSET_PRICE)
        await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
      } else if (assetType === "ERC721") {
        await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
      }

      const expectedMintAmount = ASSET_PRICE * indexTokenMintingFee / 100_00n;
      const expectedUserBalance = ASSET_PRICE - expectedMintAmount;

      const totalSupplyBefore = await rwaIndexToken.totalSupply();
      expect(await vaultAdapter.totalValue()).to.equal(0)

      await rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
      // check the balance of the index token, should be 1:1
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedUserBalance);
      expect(await rwaIndexToken.totalSupply() - totalSupplyBefore).to.equal(ASSET_PRICE);
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(expectedMintAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(expectedMintAmount * 20_00n / 100_00n)
      // check that the vault has received the crvUSD
      expect(await vaultAdapter.totalValue()).to.equal(ASSET_PRICE) // considering 1:1
      // check that ther eis not index token remainig in the vault after the split
      expect(await rwaIndexToken.balanceOf(rwaVault.target)).to.be.equal(0);

      // check the user balance
      if (assetType === "ERC20") {
        expect(await baseAsset.balanceOf(user1.address)).to.equal(0)
      } else if (assetType === "ERC721") {
        expect(await baseAsset.ownerOf(FIRST_NFT_ID)).to.equal(vaultAdapter.target);
      }
    })
  })

  describe("Deposit Public Asset: ERC721 only", function() {
    const assetType = "ERC721"
    let baseAsset, vaultAdapter, encodedAssetData, assetOracle;
    beforeEach(function() {
      [baseAsset, vaultAdapter, encodedAssetData, assetOracle] = extractAsset(assets, assetType);
    })
    it("should not allow an NFT to be deposited again", async function() {
      
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);

      await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
      await expect(rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)).to.be.revertedWith("ERC721VaultAdapter: already deposited");
    });
    it("should not allow deposit if the house price is pending", async function() {
      await rwaVault.registerDepositableAdapter(vaultAdapter.target);

      const donId = ethers.encodeBytes32String("1");
      // Deploy mock functions router
      const MockRouter = await ethers.getContractFactory("MockFunctionsRouter");
      const mockRouter = await MockRouter.deploy();
      await mockRouter.waitForDeployment();

      // Deploy test RAACHousePriceOracle
      const RAACHousePriceOracle = await ethers.getContractFactory("TestRAACHousePriceOracle");
      const testOracle = await RAACHousePriceOracle.deploy(await mockRouter.getAddress(), donId, "return 100000000000000000000", 1, "0x", 1, 200000, assetOracle.target, raacNFT.target);
      await testOracle.waitForDeployment();

      // Deploy mock 1 DON Oracle
      const MockDONOracle = await ethers.getContractFactory("MockOracle");
      const mockDONOracle = await MockDONOracle.deploy(donId);
      await mockDONOracle.waitForDeployment();

      // Set the oracle address on the house price contract
      await assetOracle.setOracle(await testOracle.getAddress());

      await testOracle.sendRequest(
        ["8453", raacNFT.target, FIRST_NFT_ID.toString()],
        []
      );

      const lastRequestId = await testOracle.s_lastRequestId();
      const pendingRequest = await testOracle.isPendingRequest(FIRST_NFT_ID);
      expect(pendingRequest).to.equal(true);

      await expect(rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)).to.be.revertedWithCustomError(vaultAdapter, "HousePricePending");

      // Simulate the DON calling fulfillRequest for first request
      await mockDONOracle.fulfillRequest(
          await testOracle.getAddress(),
          lastRequestId,
          encodedAssetData,
          "0x"
      );

      const pendingRequest2 = await testOracle.isPendingRequest(FIRST_NFT_ID);
      expect(pendingRequest2).to.equal(false);

      await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
    })
  })

  describe("Admin Deposit and Withdraw", function() {
    describe("Withdraw Any Asset by Manager", function() {
      // the index token value should go up.
      // the withdrawal will happen only by the manager: tested before
      // the withdrawal should give the correct asset to the manager and the adapter should not have the asset
      it("should allow withdrawal of any fund", async function() {
        await rwaVault.addManager(owner.address);
        // deposit all the assets in the assets
        const assetKeys = Object.keys(assets)
        for (let i in assetKeys) {
          const assetType = assetKeys[i];
          const asset = assets[assetType];
          await rwaVault.registerDepositableAdapter(asset.adapter.target)
  
          let userBalanceBefore = 0;
          if (assetType === "ERC20") {
            userBalanceBefore = await rwaIndexToken.balanceOf(user1.address)
          }
          const totalSupplyBefore = await rwaIndexToken.totalSupply()
          if (assetType === "ERC20") {
            await asset.baseAsset.mint(user1.address, ASSET_PRICE)
            await asset.baseAsset.connect(user1).approve(asset.adapter.target, ASSET_PRICE);
          } else if (assetType === "ERC721") {
            await asset.baseAsset.connect(user1).approve(asset.adapter.target, (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString());
          }
          await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
          
          if (assetType === "ERC721") {
            expect(await asset.baseAsset.ownerOf((new ethers.AbiCoder().decode(["uint256"], asset.data)).toString())).to.equal(asset.adapter.target)
          }
  
          if (assetType === "ERC20") {
            const userBalanceAfter = await rwaIndexToken.balanceOf(user1.address)
            expect(userBalanceAfter - userBalanceBefore).to.equal(ASSET_PRICE)
          }
          const totalSupplyAfter = await rwaIndexToken.totalSupply()
          expect(totalSupplyAfter - totalSupplyBefore).to.equal(ASSET_PRICE);
        }
        expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(ASSET_PRICE * BigInt(assetKeys.length));
        // should be able to withdraw all the asset.
  
        let count = 0;
        for (let i in assetKeys) {
          count++;
          const assetType = assetKeys[i];
          const asset = assets[assetType];
          const totalSupplyBefore = await rwaIndexToken.totalSupply()
          const totalValueBefore = await rwaVault.totalAssets();
  
          await rwaVault.connect(owner).adminWithdrawAsset(asset.adapter.target, asset.data, user1.address, false, 0);
  
          // check that user has received the asset
          if (assetType === "ERC20") {
            expect(await asset.baseAsset.balanceOf(user1.address)).to.equal(BigInt(count) * ASSET_PRICE)
          } else if (assetType === "ERC721") {
            expect(await asset.baseAsset.ownerOf((new ethers.AbiCoder().decode(["uint256"], asset.data)).toString())).to.equal(user1.address)
          }
          const totalSupplyAfter = await rwaIndexToken.totalSupply()
          const totalValueAfter = await rwaVault.totalAssets();
          expect(totalSupplyAfter - totalSupplyBefore).to.equal(0);
          expect(totalValueAfter - totalValueBefore).to.equal(-ASSET_PRICE);
  
          const expectedSharePrice = totalValueAfter > 0 ? (totalValueAfter * BigInt(1e18)) / totalSupplyAfter : BigInt(1e18)
          expect(await rwaVault.pricePerShare()) .to.equal(expectedSharePrice);
        }
      })
      it("Should not allow non-manager to withdraw tokens", async function () {
        // Deposit tokens into the vault.
        const asset = assets["ERC20"]
        const depositAmount = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
        await rwaVault.registerDepositableAdapter(asset.adapter.target)
  
        await asset.baseAsset.mint(user1.address, depositAmount)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, depositAmount);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
    
        // User3 is not a manager, so the withdrawal should revert.
        await expect(
          rwaVault.connect(user3).adminWithdrawAsset(asset.adapter.target, asset.data, user3.address, false, 0)
        ).to.be.revertedWithCustomError(rwaVault, "NotManager");
      });
      it("Should revert when withdrawing more tokens than available", async function () {
        // Deposit tokens into the vault.
        const asset = assets["ERC20"]
        const depositAmount = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
        await rwaVault.registerDepositableAdapter(asset.adapter.target)
  
        await asset.baseAsset.mint(user1.address, depositAmount)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, depositAmount);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
    
        // Add manager privileges to user2.
        await rwaVault.addManager(user1.address);
        
        // Attempt to withdraw more tokens than the vault holds.
        const assetData = encodeERC20Token(ethers.parseEther("300"))
        // TODO: this will be fixed with upcoming ERC20VaultAdapter fix -> ERC20VaultAdapteR: insufficient balance error will be thrown.
        await expect(
          rwaVault.connect(user1).adminWithdrawAsset(asset.adapter.target, assetData, user1.address, false, 0)
        ).to.be.revertedWith("ERC20VaultAdapter: insufficient balance")
      });
    })
    describe("Deposit Any Asset by Manager", function() {
      it("should allow deposit of any asset", async function() {
        await rwaVault.addManager(user1.address);
        // deposit all the assets in the assets
        const assetKeys = Object.keys(assets); // consider all types of asset: ERC20, ERC721 ...
        for (let i in assetKeys) {
          const assetType = assetKeys[i];
          const asset = assets[assetType];
          await rwaVault.registerDepositableAdapter(asset.adapter.target)
  
          let userBalanceBefore = 0;
          if (assetType === "ERC20") {
            userBalanceBefore = await rwaIndexToken.balanceOf(user1.address)
          }
          const totalSupplyBefore = await rwaIndexToken.totalSupply()
          if (assetType === "ERC20") {
            await asset.baseAsset.mint(user1.address, ASSET_PRICE)
            await asset.baseAsset.connect(user1).approve(asset.adapter.target, ASSET_PRICE);
          } else if (assetType === "ERC721") {
            await asset.baseAsset.connect(user1).approve(asset.adapter.target, (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString());
          }
          await rwaVault.connect(user1).adminDepositAsset(asset.adapter.target, asset.data, false, 0);
          

          // Check that the asset is deposited in the adapter
          if (assetType === "ERC721") {
            expect(await asset.baseAsset.ownerOf((new ethers.AbiCoder().decode(["uint256"], asset.data)).toString())).to.equal(asset.adapter.target)
          }
  
          // Check that the user balance did not change: no vault token minted
          if (assetType === "ERC20") {
            const userBalanceAfter = await rwaIndexToken.balanceOf(user1.address)
            expect(userBalanceAfter - userBalanceBefore).to.equal(0)
          }
          // Check that the total supply did not change: no vault token minted
          const totalSupplyAfter = await rwaIndexToken.totalSupply()
          expect(totalSupplyAfter - totalSupplyBefore).to.equal(0); // supply does not change since we did not mint any token
        }
        // Check that the user balance is 0: no vault token minted
        expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(0);
      })
    })
  })

  describe("Remdeption of ERC721", function() {
    // only ERC721Enumerable
    // TODO: test if there are many allowed NFTs
    it("Should not allow redemption if no adapter or NFT is inside the adapter", async () => {
      const priceInShares = await rwaVault.previewWithdraw(0);
      await expect(rwaVault.connect(user1).redeemNFT(assets["ERC721"].adapter.target, 1, priceInShares)).to.be.revertedWith("RWAVault: no redeemable adapters");
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);
      await expect(rwaVault.connect(user1).redeemNFT(assets["ERC721"].adapter.target, 1, priceInShares)).to.be.revertedWith("RWAVault: no NFTs available");
    });
    it("Should not allow redemption if the user balance is insufficient", async () => {
      // Deposit NFT so that user1 gets vault tokens equivalent to the NFT price
      const asset = assets["ERC721"]
      const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
      await rwaVault.registerDepositableAdapter(asset.adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

      const nftPrice = await asset.baseAsset.getHousePrice(tokenId);
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      // Remove the vault tokens from user1 so balance is insufficient
      await rwaIndexToken.connect(user1).transfer(owner.address, nftPrice);
  
      const nextNFT = await rwaVault.getNextRandomNFT();
      const priceInShares = await rwaVault.previewWithdraw(nftPrice);
      await expect(rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares)).to.be.revertedWithCustomError(rwaVault, "InsufficientBalance");
    });
    it("Should allow the user to view the next random NFT", async () => {
      // Deposit NFT so that there is one in the vault
      const asset = assets["ERC721"]
      const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
      await rwaVault.registerDepositableAdapter(asset.adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
  
      const nextNFT = await rwaVault.getNextRandomNFT();
      expect(nextNFT.adapter).to.equal(asset.adapter.target);
      expect(nextNFT.tokenId).to.equal(tokenId);
    });
    it("Should remove NFT from adapter storage after redemption", async () => {
      const asset = assets["ERC721"]
      const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
      await rwaVault.registerDepositableAdapter(asset.adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
      expect((await asset.adapter.getDepositedTokens()).length).to.equal(1);
  
      // Redeem the NFT (user1 has sufficient vault tokens from the deposit)
      const totalSupplyBefore = await rwaIndexToken.totalSupply()
      const nextNFT = await rwaVault.getNextRandomNFT();
      const priceInShares = await rwaVault.previewWithdraw(ASSET_PRICE);

      await rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares);

      expect((await asset.adapter.getDepositedTokens()).length).to.equal(0);
      // check that the shares are burns by comparing before and after total supply
      const totalSupplyAfter = await rwaIndexToken.totalSupply()
      expect(totalSupplyAfter - totalSupplyBefore).to.equal(-ASSET_PRICE);
      // check that user received the NFT
      expect(await asset.baseAsset.ownerOf(tokenId)).to.equal(user1.address)
  
      // check that VRF call has been triggered
      const lastRequestId = await vrfConsumer.lastRequestId();
      await vrfCoordinator.fulfillRandomWordsWithOverride(lastRequestId, vrfConsumer.target, [RANDOM_NUMBER]);
  
      // Check that VRF consumer created a new word
      const request = await vrfConsumer.getRequestStatus();
      expect(request[0]).to.equal(true);
      expect(request[1]).to.equal(true);
      expect(request[2].length).to.equal(1);
      expect(request[2][0]).to.equal(RANDOM_NUMBER);
    });
    // TODO: always finds an nft even if the adapter does not have it. To do this, put two raac nft contract. Put the one you expect to not have any nft
    // the result should be that the circular loop should have executed

    it("should prevent sending request before the vrf request delay", async function() {
      const asset = assets["ERC721"]
      const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
      await rwaVault.registerDepositableAdapter(asset.adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
      expect((await asset.adapter.getDepositedTokens()).length).to.equal(1);

      // send a request, but the request feature is disabled
      await expect(rwaVault.connect(user1).requestRandomSeed()).to.be.revertedWith("public requests disabled")
      await rwaVault.setAllowVRFRequest(true);
      expect(await rwaVault.allowVRFRequest()).to.be.true;

      // send a request, but the time has not passed yet
      await expect(rwaVault.requestRandomSeed()).to.be.revertedWith("you cannot send request");

      // pass time by 3 days
      const delay = 3 * 24 * 60 * 60
      await time.increase(delay);
      await ethers.provider.send("evm_mine", []);

      const previousRequest = await vrfConsumer.getRequestStatus();
      expect(previousRequest[2][0]).to.equal(RANDOM_NUMBER);

      await rwaVault.requestRandomSeed();
      const lastRequestId = await vrfConsumer.lastRequestId();
      await vrfCoordinator.fulfillRandomWordsWithOverride(lastRequestId, vrfConsumer.target, [RANDOM_NUMBER +1]);

      const newRequest = await vrfConsumer.getRequestStatus();
      expect(newRequest[2][0]).to.equal(RANDOM_NUMBER+1);
    })
    it("should not allow redemption if the house price is pending", async function() {
      const asset = assets["ERC721"]
      const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
      await rwaVault.registerDepositableAdapter(asset.adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

      const nftPrice = await asset.baseAsset.getHousePrice(tokenId);
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const donId = ethers.encodeBytes32String("1");
      // Deploy mock functions router
      const MockRouter = await ethers.getContractFactory("MockFunctionsRouter");
      const mockRouter = await MockRouter.deploy();
      await mockRouter.waitForDeployment();

      // Deploy test RAACHousePriceOracle
      const RAACHousePriceOracle = await ethers.getContractFactory("TestRAACHousePriceOracle");
      const testOracle = await RAACHousePriceOracle.deploy(
        await mockRouter.getAddress(),
        donId,
        "return 100000000000000000000",
        1,
        "0x",
        1,
        200000,
        asset.oracle.target,
        raacNFT.target
      );
      await testOracle.waitForDeployment();

      // Deploy mock 1 DON Oracle
      const MockDONOracle = await ethers.getContractFactory("MockOracle");
      const mockDONOracle = await MockDONOracle.deploy(donId);
      await mockDONOracle.waitForDeployment();

      // Set the oracle address on the house price contract
      await asset.oracle.setOracle(await testOracle.getAddress());

      await testOracle.sendRequest(
        ["8453", raacNFT.target, FIRST_NFT_ID.toString()],
        []
      );

      const lastRequestId = await testOracle.s_lastRequestId();
      const pendingRequest = await testOracle.isPendingRequest(FIRST_NFT_ID);
      expect(pendingRequest).to.equal(true);

      const nextNFT = await rwaVault.getNextRandomNFT();
      const priceInShares = await rwaVault.previewWithdraw(nftPrice);
      await expect(rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares)).to.be.revertedWithCustomError(asset.adapter, "HousePricePending");

      // Simulate the DON calling fulfillRequest for first request
      await mockDONOracle.fulfillRequest(
          await testOracle.getAddress(),
          lastRequestId,
          asset.data,
          "0x"
      );

      const pendingRequest2 = await testOracle.isPendingRequest(FIRST_NFT_ID);
      expect(pendingRequest2).to.equal(false);

      await rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares);
    })

    describe('ZKME verification', function() {
      let cooperatorAddress;
      let mockZKMEVerify;
      let kycVerifyModule;
      beforeEach(async function() {
          // Enable ZKME by setting the cooperator and verify contract
          cooperatorAddress = user3.address;
          const MockZKMEVerify = await ethers.getContractFactory("MockZKMEVerifyUpgradeable");
          mockZKMEVerify = await MockZKMEVerify.deploy();

          const KYCVerifyModule = await ethers.getContractFactory("ZKMEKYCVerifyModule");
          const kycVerifyModule = await KYCVerifyModule.deploy(mockZKMEVerify.target, cooperatorAddress, owner.address);

          await rwaVault.connect(owner).setKYCVerifyModule(kycVerifyModule.target);
      })
      it("should allow redeeming if user is approved", async function() {

          // write the process to redeem an NFT
          const asset = assets["ERC721"]
          const tokenId = (new ethers.AbiCoder().decode(["uint256"], asset.data)).toString();
          await rwaVault.registerDepositableAdapter(asset.adapter.target)
          await rwaVault.registerRedeemableERC721Adapter(asset.adapter.target);

          await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenId);
          await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
          expect((await asset.adapter.getDepositedTokens()).length).to.equal(1);
      
          // Redeem the NFT (user1 has sufficient vault tokens from the deposit)
          const nextNFT = await rwaVault.getNextRandomNFT();
          const priceInShares = await rwaVault.previewWithdraw(ASSET_PRICE);
          await expect(rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares)).to.be.revertedWithCustomError(rwaVault, "KYCNotVerified");

          await mockZKMEVerify.mockApprove(cooperatorAddress, user1.address, 1);

          await expect(rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares)).to.not.reverted;
      });
    })
  })

  describe("RWA Index Token", () => {
    it("Should not allow non-rwa-vault to mint or burn the RWAIndexToken", async () => {
        await expect(rwaIndexToken.mint(owner.address, 100)).to.be.revertedWith("RWAIndexToken: caller is not vault")
        await expect(rwaIndexToken.mint(owner.address, 100)).to.be.revertedWith("RWAIndexToken: caller is not vault")
    })
    it("Should not all a non-owner to update the RWA Vault address in RWAIndexToken", async() => {
        await expect(rwaIndexToken.connect(user2).setVault(user2.address)).to.be.revertedWithCustomError(rwaIndexToken, "OwnableUnauthorizedAccount")
    })
    it("Should not allow to set fees above the maximum", async () => {
      await expect(rwaIndexToken.setFees(100_00, 0)).to.be.revertedWith("RWAIndexToken: swap fee exceeds maximum")
      await expect(rwaIndexToken.setFees(0, 100_00)).to.be.revertedWith("RWAIndexToken: burn fee exceeds maximum")
    })
    it("Should transfer with swap fee correctly", async function() {
      // temporary change the vault to owner so that we can mint index token
      await rwaIndexToken.setVault(owner.address)
      const SWAP_FEE = ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_SWAP_FEE"))
      const FeeCollector = await ethers.getContractFactory("FeeCollector")
      const feeCollector = await FeeCollector.deploy(owner.address);

      await feeCollector.addClaimableToken(rwaIndexToken.target);
      // 25% treasury, 0 repair, 0 burn, 25% veraac, 50% (RAAC Corp), 0
      await feeCollector.addFeeType(SWAP_FEE, 25_00, 0, 0, 25_00, 50_00, 0);

      const RWAIndexTokenCollector = await ethers.getContractFactory("RWAIndexTokenCollector")
      const rwaIndexTokenCollector = await RWAIndexTokenCollector.deploy(feeCollector.target, rwaIndexToken.target)

      await rwaIndexToken.setFeeCollector(rwaIndexTokenCollector.target);
      const swapBP = 2_00
      await rwaIndexToken.setFees(swapBP, 0);

      // whitelist user2 as a swap contract
      await rwaIndexToken.setSwapPair(user2.address, true);

      // mint some to user2 and transfer to user 1: behaves like transfer after swap from user2 being AMM
      const swapAmount = ethers.parseEther("100")
      await rwaIndexToken.connect(owner).mint(user2.address, swapAmount);
      await rwaIndexToken.connect(user2).approve(user1.address, swapAmount);

      // transfer to user 1
      await rwaIndexToken.connect(user2).transfer(user1.address, swapAmount);

      const swapFeeAmount = swapAmount * BigInt(swapBP) / BigInt(100_00)

      const expectedBalance = swapAmount - swapFeeAmount;
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedBalance)
      expect(await rwaIndexToken.balanceOf(rwaIndexTokenCollector.target)).to.equal(swapFeeAmount.toString())

      // distribute the fees to the fee collector
      await rwaIndexTokenCollector.distributeCollectedFees();
      expect(await rwaIndexToken.balanceOf(feeCollector.target)).to.equal(swapFeeAmount.toString())

      const collectedFee = await feeCollector.getCollectedFees(rwaIndexToken.target, SWAP_FEE)
      expect(collectedFee[0]).to.equal(swapAmount * 50n / 100_00n)
      expect(collectedFee[3]).to.equal(swapAmount * 50n / 100_00n)
      expect(collectedFee[4]).to.equal(swapAmount * 1_00n / 100_00n)
    })
  })

  describe.skip("LLama Perks", function() {
    let llamaLocker, llamaTemple, llamaNFT, llamaClass
    beforeEach(async function() {
      const LLamaNFT = await ethers.getContractFactory("RAACNFT")
      llamaNFT = await LLamaNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address)

      const LlamaLocker = await ethers.getContractFactory("LlamaLocker");
      llamaLocker = await LlamaLocker.deploy(
          owner.address,
          llamaNFT.target,
          ethers.ZeroHash // nerkle root
      );

      const LLamaTemple = await ethers.getContractFactory("LLamaTemple");
      llamaTemple = await LLamaTemple.deploy(
          llamaNFT.target,
          llamaLocker.target,
          owner.address
      );

      await rwaVault.setFeeCollector(feeCollector.target)

      await llamaTemple.connect(owner).addClass("HUNTER");
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);

      await llamaNFT.minterMint(user1.address, 1)
      await llamaNFT.minterMint(user1.address, 2)
      await llamaNFT.minterMint(user1.address, 3)

      await llamaNFT.connect(user1).approve(llamaTemple.target, 1);
      await llamaNFT.connect(user1).approve(llamaTemple.target, 2);
      await llamaNFT.connect(user1).approve(llamaTemple.target, 3);

      llamaClass = await llamaTemple.getClassHash("HUNTER")

      await llamaLocker.disableWhitelist();
    })
    it("should not apply discount if llama temple is not set", async function() {
      const asset = assets["ERC721"]

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const percentage = await rwaVault.indexTokenMintingFee();
      const expectedIndexTokenAmount = (ASSET_PRICE * (BigInt(100_00) - percentage)) / BigInt(100_00)
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())

      const feeAmount = ASSET_PRICE * percentage / 100_00n
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(feeAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(feeAmount * 20_00n / 100_00n)
    })
    it("should not apply if llama temple is set but no llama deposited", async function() {
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const asset = assets["ERC721"]

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const percentage = await rwaVault.indexTokenMintingFee();
      const expectedIndexTokenAmount = (ASSET_PRICE * (BigInt(100_00) - percentage)) / BigInt(100_00)
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())

      const feeAmount = ASSET_PRICE * percentage / 100_00n
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(feeAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(feeAmount * 20_00n / 100_00n)
    })
    it("should apply 1x discount on the index mint fee", async function() {
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const discount = 25_00
      const multiplier = 2;
      await rwaVault.setLlamaPerkDiscount(llamaClass, discount, multiplier);
      await llamaTemple.connect(user1).lock([1], llamaClass);

      const asset = assets["ERC721"]

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, 1);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const lockCount = await llamaTemple.getCategoryCount(user1.address, llamaClass)
      expect(lockCount).to.equal(1)
      
      const percentage = await rwaVault.indexTokenMintingFee(); // deposited 1 NFT
      const expectedDiscount = 25_00n * 1n;
      const mintingFeePercentage = percentage * (100_00n - expectedDiscount) / 100_00n;

      const expectedIndexTokenAmount = ASSET_PRICE - ASSET_PRICE * (mintingFeePercentage) / 100_00n
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())

      const feeAmount = ASSET_PRICE * mintingFeePercentage / 100_00n;
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(feeAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(feeAmount * 20_00n / 100_00n)
    })
    it("should apply 2x discount on the index mint fee", async function() {
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const discount = 25_00
      const multiplier = 2;
      await rwaVault.setLlamaPerkDiscount(llamaClass, discount, multiplier);
      await llamaTemple.connect(user1).lock([1, 2], llamaClass);

      const asset = assets["ERC721"]

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, 1);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const lockCount = await llamaTemple.getCategoryCount(user1.address, llamaClass)
      expect(lockCount).to.equal(2)

      const percentage = await rwaVault.indexTokenMintingFee(); // deposited 2 NFT
      const expectedDiscount = 25_00n * 2n;
      const mintingFeePercentage = percentage * (100_00n - expectedDiscount) / 100_00n;

      const expectedIndexTokenAmount = ASSET_PRICE - ASSET_PRICE * (mintingFeePercentage) / 100_00n
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())

      const feeAmount = ASSET_PRICE * mintingFeePercentage / 100_00n;
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(feeAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(feeAmount * 20_00n / 100_00n)
    })
    it("should apply 2x MAX discount on the index mint fee even with multiple locks", async function() {
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const discount = 25_00
      const multiplier = 2;
      await rwaVault.setLlamaPerkDiscount(llamaClass, discount, multiplier);
      await llamaTemple.connect(user1).lock([1, 2, 3], llamaClass);

      const asset = assets["ERC721"]

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, 1);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const percentage = await rwaVault.indexTokenMintingFee(); // deposited 3 NFT
      const expectedDiscount = 25_00n * 2n;
      const mintingFeePercentage = percentage * (100_00n - expectedDiscount) / 100_00n;

      const lockCount = await llamaTemple.getCategoryCount(user1.address, llamaClass)
      expect(lockCount).to.equal(3)

      const expectedIndexTokenAmount = ASSET_PRICE - ASSET_PRICE * (mintingFeePercentage) / 100_00n
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())

      const feeAmount = ASSET_PRICE * mintingFeePercentage / 100_00n;
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[2]).to.equal(feeAmount * 80_00n / 100_00n)
      expect((await feeCollector.getCollectedFees(rwaIndexToken.target, MINT_FEE))[0]).to.equal(feeAmount * 20_00n / 100_00n)
    })
    it("should disable the perks if llama temple removed", async function() {
      const asset = assets["ERC721"]
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const discount = 25_00
      const multiplier = 2;
      await rwaVault.setLlamaPerkDiscount(llamaClass, discount, multiplier);

      // disable
      await rwaVault.setLlamaTemple(ethers.ZeroAddress)

      await asset.baseAsset.connect(user1).approve(asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);

      const percentage = await rwaVault.indexTokenMintingFee();
      const expectedIndexTokenAmount = (ASSET_PRICE * (BigInt(100_00) - percentage)) / BigInt(100_00)
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedIndexTokenAmount.toString())
    })

    it("should prevent proxy exploitation by only applying discount when msg.sender equals receiver", async function() {
      await rwaVault.setLlamaTemple(llamaTemple.target)
      const discount = 25_00
      const multiplier = 2;
      await rwaVault.setLlamaPerkDiscount(llamaClass, discount, multiplier);
      await llamaTemple.connect(user1).lock([1, 2], llamaClass);

      const asset = assets["ERC721"]
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, FIRST_NFT_ID);
      
      // First test: user1 deposits for themselves - should get discount
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0);
      
      const lockCount = await llamaTemple.getCategoryCount(user1.address, llamaClass)
      expect(lockCount).to.equal(2)

      const percentage = await rwaVault.indexTokenMintingFee();
      const expectedDiscount = 25_00n * 2n;
      const discountedMintingFeePercentage = percentage * (100_00n - expectedDiscount) / 100_00n;

      // Calculate expected balance with discount
      const expectedDiscountedAmount = ASSET_PRICE - ASSET_PRICE * (discountedMintingFeePercentage) / 100_00n;
      expect(await rwaIndexToken.balanceOf(user1.address)).to.equal(expectedDiscountedAmount.toString());
      
      // Reset for next test - transfer any tokens user1 received
      await rwaIndexToken.connect(user1).transfer(owner.address, await rwaIndexToken.balanceOf(user1.address));
      
      // Second test: user1 (who has NFTs) deposits for user2 - should NOT get discount
      // Mint a new NFT for this test
      const SECOND_NFT_ID = 4; // Use a new ID that hasn't been minted yet
      // Set the house price for the new NFT
      await raacHousePrices.setHousePrice(SECOND_NFT_ID, ASSET_PRICE);
      await ethers.provider.send("evm_mine", []);
      
      // Mint the NFT to user1
      await crvusd.mint(user1.address, ASSET_PRICE);
      await crvusd.connect(user1).approve(raacNFT.target, ASSET_PRICE);
      await raacNFT.connect(user1).mint(SECOND_NFT_ID, ASSET_PRICE);
      const secondAssetData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [SECOND_NFT_ID]);
      await raacNFT.connect(user1).approve(asset.adapter.target, SECOND_NFT_ID);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, secondAssetData, user2.address, 0);
      
      // Calculate expected balance without discount (full fee)
      const expectedNonDiscountedAmount = ASSET_PRICE - ASSET_PRICE * percentage / 100_00n;
      expect(await rwaIndexToken.balanceOf(user2.address)).to.equal(expectedNonDiscountedAmount.toString());
    })
  })

  // do for all different types of asets
  describe("RWA Vault Statistics", () => {
    beforeEach(async function() {
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target)
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target)
    })
    it("should calculate correct price per share with only token deposits", async function () {
        // User deposits only tokens into the vault.
        const asset = assets["ERC20"]
        const tokenDeposit = ethers.parseEther("1000");
        await asset.baseAsset.mint(user1.address, tokenDeposit)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDeposit);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDeposit), user1.address, 0);
    
        // Total assets should equal the token deposit.
        const totalAssets = await rwaVault.totalAssets();
        expect(totalAssets).to.equal(tokenDeposit);
    
        // Initially, the vault minting is 1:1; price per share should be tokenDeposit / totalSupply.
        const totalSupply = await rwaIndexToken.totalSupply();
        const pricePerShare = await rwaVault.pricePerShare();
        // For a 1:1 mapping, price per share should equal 1 (in token units), meaning totalAssets == totalSupply.
        expect(totalSupply).to.equal(tokenDeposit);
        expect(pricePerShare).to.equal(tokenDeposit * BigInt(1e18) / totalSupply);
      });
      it("should update price per share correctly after NFT deposit", async function () {
        // Deposit tokens first.
        const asset = assets["ERC20"]
        const tokenDeposit = ethers.parseEther("500");
        await asset.baseAsset.mint(user1.address, tokenDeposit)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDeposit);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDeposit), user1.address, 0);
    
        // Deposit an NFT (with an appraised price, e.g., 100 tokens).
        const erc721Asset = assets["ERC721"]
        const nftPrice = await erc721Asset.baseAsset.getHousePrice(FIRST_NFT_ID)
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
        await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);
    
        // After deposit, total assets = tokenDeposit + nftPrice.
        const totalAssets = await rwaVault.totalAssets();
        expect(totalAssets).to.equal(tokenDeposit + nftPrice);
    
        // Check that individual asset stats match.
        const tokenAssets = await asset.adapter.totalValue()
        const nftAssets = await erc721Asset.adapter.totalValue()
        expect(tokenAssets).to.equal(tokenDeposit);
        expect(nftAssets).to.equal(nftPrice);
    
        // Price per share is now (tokenDeposit + nftPrice) / totalSupply.
        const totalSupply = await rwaIndexToken.totalSupply();
        const pricePerShare = await rwaVault.pricePerShare();
        const expectedPPS = totalAssets * BigInt(1e18) / totalSupply;
        expect(pricePerShare).to.equal(expectedPPS);
      });
      it("should reflect deviation in price per share when NFT price changes (simulate sale)", async function () {
        // Deposit tokens and an NFT.
        const asset = assets["ERC20"]
        const tokenDeposit = ethers.parseEther("500");
        await asset.baseAsset.mint(user1.address, tokenDeposit)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDeposit);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDeposit), user1.address, 0);
        
        const erc721Asset = assets["ERC721"]
        const nftInitialPrice = await raacNFT.getHousePrice(FIRST_NFT_ID);
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
        await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);
    
        const initialTotalAssets = await rwaVault.totalAssets();
        const initialTotalSupply = await rwaIndexToken.totalSupply();
        const initialPPS = await rwaVault.pricePerShare();
    
        // Simulate an NFT sale by changing its appraised price (e.g., price drops from 100 to 80 tokens).
        const newNFTPrice = ethers.parseEther("80");
        await erc721Asset.oracle.setHousePrice(FIRST_NFT_ID, newNFTPrice);
        await ethers.provider.send("evm_mine", []);
    
        const updatedNFTPrice = await erc721Asset.baseAsset.getHousePrice(FIRST_NFT_ID);
        expect(updatedNFTPrice).to.equal(newNFTPrice);
    
        // Updated total assets should now equal tokenDeposit + newNFTPrice.
        const updatedTotalAssets = await rwaVault.totalAssets();
        expect(updatedTotalAssets).to.equal(tokenDeposit + newNFTPrice);
    
        // Price per share should update accordingly.
        const updatedPPS = await rwaVault.pricePerShare();
        const expectedUpdatedPPS = updatedTotalAssets * BigInt(1e18) / initialTotalSupply;
        expect(updatedPPS).to.equal(expectedUpdatedPPS);
    
        // There must be a deviation: the new PPS should differ from the initial PPS.
        expect(updatedPPS).to.not.equal(initialPPS);
      });
      it("should correctly convert between assets and shares after multiple operations", async function () {
        // Initial token deposit.
        const asset = assets["ERC20"]
        const erc721Asset = assets["ERC721"]
        const tokenDeposit = ethers.parseEther("1000");
        await asset.baseAsset.mint(user1.address, tokenDeposit)
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDeposit);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDeposit), user1.address, 0);
    
        // Validate conversion functions with only token deposit.
        const sharesForToken = await rwaVault.convertToShares(tokenDeposit);
        const assetsFromShares = await rwaVault.convertToAssets(sharesForToken);
        expect(assetsFromShares).to.equal(tokenDeposit);
    
        // Deposit an NFT.
        const nftPrice = await erc721Asset.baseAsset.getHousePrice(FIRST_NFT_ID);
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
        await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);
    
        // After NFT deposit, total assets should include both token deposit and NFT appraisal.
        const updatedTotalAssets = await rwaVault.totalAssets();
        expect(updatedTotalAssets).to.equal(tokenDeposit + nftPrice);
    
        // Re-check conversion functions after NFT deposit.
        const newSharesForToken = await rwaVault.convertToShares(tokenDeposit);
        const newAssetsFromShares = await rwaVault.convertToAssets(newSharesForToken);
        // Due to the increased total assets, conversion now reflects a diluted share value for tokens.
        // Allow for a small deviation due to integer math.
        expect(newAssetsFromShares).to.be.closeTo(tokenDeposit, ethers.parseEther("0.01"));
      });
      it("should revert if the oracle returns a price of zero", async function () {
        // Deposit an NFT (with an unregistered price).
        // Mock and set the price to 0
        await raacHousePrices.setHousePrice(FIRST_NFT_ID, 0);

        const erc721Asset = assets["ERC721"]
        const nftPrice = await erc721Asset.baseAsset.getHousePrice(FIRST_NFT_ID)
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
        await expect(rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0)).to.be.revertedWith("ERC721VaultAdapter: price is zero, cannot deposit")      
    });
  })

  describe("Complex Multi-User and State Consistency", function () {
    it("should correctly update vault state after multiple deposits and redemptions", async function () {
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target)
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target)
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target)
      // --- Multiple Token Deposits ---
      // User1 deposits 500 tokens.
      const asset = assets["ERC20"]
      const erc721Asset = assets["ERC721"]
      const tokenDepositUser1 = ethers.parseEther("500");
      await asset.baseAsset.mint(user1.address, tokenDepositUser1)
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDepositUser1);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDepositUser1), user1.address, 0);
  
      // User2 deposits 300 tokens.
      const tokenDepositUser2 = ethers.parseEther("300");
      await asset.baseAsset.mint(user1.address, tokenDepositUser2)
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, tokenDepositUser2);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(tokenDepositUser2), user1.address, 0);
  
      // --- NFT Deposits from Multiple Users ---
      // For clarity, set a distinct house price for a second NFT.
      const nftPriceUser1 = ethers.parseEther("150");
      await erc721Asset.oracle.setHousePrice(SECOND_NFT_ID, nftPriceUser1);
      // Mint and deposit NFT for user1.
      await crvusd.mint(user1.address, nftPriceUser1);
      await crvusd.connect(user1).approve(raacNFT.target, nftPriceUser1);
      await raacNFT.connect(user1).mint(SECOND_NFT_ID, nftPriceUser1);
      await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, SECOND_NFT_ID);
      await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(SECOND_NFT_ID), user1.address, 0);
  
      // --- Verify Vault State After Deposits ---
      const totalTokenDeposits = tokenDepositUser1 + tokenDepositUser2;
      const totalTokenInVault = await asset.adapter.totalValue();
      expect(totalTokenInVault).to.equal(totalTokenDeposits);
      const totalNFTAssets = await erc721Asset.adapter.totalValue();
      expect(totalNFTAssets).to.equal(nftPriceUser1);

      const totalAssetsBefore = await rwaVault.totalAssets();
      expect(totalAssetsBefore).to.equal(totalTokenDeposits + nftPriceUser1);
      const totalSupplyBefore = await rwaIndexToken.totalSupply();
  
      // --- Check Price Per Share (PPS) Calculation ---
      const ppsBefore = await rwaVault.pricePerShare();
      const expectedPPSBefore = totalAssetsBefore * BigInt(1e18) / totalSupplyBefore;
      expect(ppsBefore).to.equal(expectedPPSBefore);
  
      // --- Simulate NFT Price Change (e.g., NFT sold externally) ---
      // For example, the NFT's value drops from 150 to 100 tokens.
      const newNFTPrice = ethers.parseEther("100");
      await erc721Asset.oracle.setHousePrice(SECOND_NFT_ID, newNFTPrice);
      await ethers.provider.send("evm_mine", []); // Advance the block to record state change.
  
      // Updated total assets should reflect the new NFT price.
      const totalAssetsAfterPriceChange = await rwaVault.totalAssets();
      expect(totalAssetsAfterPriceChange).to.equal(totalTokenDeposits + newNFTPrice);
  
      // Updated price per share should change accordingly.
      const ppsAfterPriceChange = await rwaVault.pricePerShare();
      const expectedPPSAfter = totalAssetsAfterPriceChange * BigInt(1e18) / totalSupplyBefore;
      expect(ppsAfterPriceChange).to.equal(expectedPPSAfter);
      expect(ppsAfterPriceChange).to.not.equal(ppsBefore);
  
      // --- Simulate Redemption ---
      // Assume user1 redeems the NFT.
      const nextNFT = await rwaVault.getNextRandomNFT();
      const priceInShares = await rwaVault.previewWithdraw(nftPriceUser1);
      await rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares);
      // --- Verify State Post-Redemption ---
      // Total assets should now only reflect the token deposits.
      const totalAssetsPostRedemption = await rwaVault.totalAssets();
      expect(totalAssetsPostRedemption).to.equal(totalTokenDeposits);
      // Conversion functions should reflect the new state.
      const sharesForTokens = await rwaVault.convertToShares(totalTokenDeposits);
      const assetsFromShares = await rwaVault.convertToAssets(sharesForTokens);
      // Allow for minor deviation due to integer division.
      expect(assetsFromShares).to.be.closeTo(totalTokenDeposits, ethers.parseEther("0.001"));
    });
  
    it("should allow depositing many and then redeeming based on the VRF randomization", async function () {
      // register adapters
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);
    
      const erc721Asset = assets["ERC721"];
      const adapterAddress = erc721Asset.adapter.target;
      const nfts        = [100, 101, 102, 103, 104];
      const nftPrices   = [
        ethers.parseEther("5"),
        ethers.parseEther("10"),
        ethers.parseEther("15"),
        ethers.parseEther("20"),
        ethers.parseEther("25")
      ];
    
      // mint + purchase each NFT
      for (let i = 0; i < nfts.length; i++) {
        await erc721Asset.oracle.setHousePrice(nfts[i], nftPrices[i]);
        await crvusd.connect(owner).mint(user3.address, nftPrices[i]);
        await crvusd.connect(user3).approve(erc721Asset.baseAsset.target, nftPrices[i]);
        await erc721Asset.baseAsset.connect(user3).mint(nfts[i], nftPrices[i]);
        expect(await erc721Asset.baseAsset.ownerOf(nfts[i])).to.equal(user3.address);
      }
    
      // deposit them all into the vault
      for (let i = 0; i < nfts.length; i++) {
        await erc721Asset.baseAsset.connect(user3).approve(adapterAddress, nfts[i]);
        await rwaVault.connect(user3).depositAsset(
          adapterAddress,
          encodeERC721Token(nfts[i]),
          user3.address,
          0
        );
        expect(await erc721Asset.baseAsset.ownerOf(nfts[i])).to.equal(adapterAddress);
      }
    
      let lastRandomWord = BigInt(RANDOM_NUMBER)
    
      // loop until the adapter has no more NFTs
      while ((await erc721Asset.baseAsset.balanceOf(adapterAddress)) > 0) {
        // grab the next NFT via view
        const { adapter, tokenId } = await rwaVault.getNextRandomNFT();
        expect(adapter).to.equal(adapterAddress);
    

        const nftBalance = await erc721Asset.baseAsset.balanceOf(adapterAddress)
        const slot = lastRandomWord % BigInt(nftBalance);
    
        // confirm tokenId matches enumeration
        const expectedId = await erc721Asset.baseAsset.tokenOfOwnerByIndex(
          adapterAddress,
          slot
        );
        expect(tokenId).to.equal(expectedId);
    
        // actually redeem it
        const nextNFT = await rwaVault.getNextRandomNFT();
        const priceInShares = await rwaVault.previewWithdraw(ASSET_PRICE)
        await rwaVault.connect(user3).redeemNFT(nextNFT[0], nextNFT[1], priceInShares);
    
        // user should now own that NFT again
        expect(
          await erc721Asset.baseAsset.ownerOf(expectedId)
        ).to.equal(user3.address);
    
        // generate & fulfill a fresh random word for next round
        lastRandomWord = BigInt(Math.floor(Math.random() * 100));
        await vrfCoordinator.fulfillRandomWordsWithOverride(
          await vrfConsumer.lastRequestId(),
          vrfConsumer.target,
          [ lastRandomWord ]
        );
      }
    });

    it("should test random adapter selection", async function() {
      // make some dummy erc721 adapters
      const ERC721Adapter = await ethers.getContractFactory("ERC721VaultAdapter")
      const adapter1 = await ERC721Adapter.deploy(assets["ERC721"].baseAsset.target, assets["ERC721"].oracle.target, rwaVault.target)
      const adapter2 = await ERC721Adapter.deploy(assets["ERC721"].baseAsset.target, assets["ERC721"].oracle.target, rwaVault.target)
      const adapter3 = await ERC721Adapter.deploy(assets["ERC721"].baseAsset.target, assets["ERC721"].oracle.target, rwaVault.target)

      await rwaVault.registerAdapter(adapter1.target)
      await rwaVault.registerAdapter(adapter2.target)
      await rwaVault.registerAdapter(adapter3.target)

      await rwaVault.registerDepositableAdapter(adapter1.target)
      await rwaVault.registerDepositableAdapter(adapter2.target)
      await rwaVault.registerDepositableAdapter(adapter3.target)

      await rwaVault.registerRedeemableERC721Adapter(adapter1.target)
      await rwaVault.registerRedeemableERC721Adapter(adapter2.target)
      await rwaVault.registerRedeemableERC721Adapter(adapter3.target)

      // mint some nfts
      const nfts = [100, 101, 102, 103, 104]

      // set prices
      for (let i = 0; i < nfts.length; i++) {
        await assets["ERC721"].oracle.setHousePrice(nfts[i], ethers.parseEther("100"))
      }

      // mint and approve the nfts
      for (let i = 0; i < nfts.length; i++) {
        await crvusd.connect(owner).mint(user3.address, ethers.parseEther("1000"))
        await crvusd.connect(user3).approve(assets["ERC721"].baseAsset.target, ethers.parseEther("1000"))
        await assets["ERC721"].baseAsset.connect(user3).mint(nfts[i], ethers.parseEther("100"))
      }

      // deposit some nfts
      await assets["ERC721"].baseAsset.connect(user3).approve(adapter1.target, nfts[0])
      await assets["ERC721"].baseAsset.connect(user3).approve(adapter2.target, nfts[1])
      await assets["ERC721"].baseAsset.connect(user3).approve(adapter3.target, nfts[2])
      await rwaVault.connect(user3).depositAsset(adapter1.target, encodeERC721Token(nfts[0]), user3.address, 0)
      await rwaVault.connect(user3).depositAsset(adapter2.target, encodeERC721Token(nfts[1]), user3.address, 0)
      await rwaVault.connect(user3).depositAsset(adapter3.target, encodeERC721Token(nfts[2]), user3.address, 0)

      // check the balance of the adapters
      expect(await adapter1.getDepositedTokensCount()).to.equal(1)
      expect(await adapter2.getDepositedTokensCount()).to.equal(1)
      expect(await adapter3.getDepositedTokensCount()).to.equal(1)

      // generate a random word
      const randomWord = BigInt(RANDOM_NUMBER)

      // check the random adapter
      const adapter = await rwaVault.getNextRandomNFT()
      console.log(adapter)
    })

    it("should keep the same NFT or genreate a new one if another NFT is deposited", async function() {
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);
    
      const erc721Asset = assets["ERC721"];
      const adapterAddress = erc721Asset.adapter.target;
      const nfts        = [100, 101, 102, 103, 104];
      const nftPrices   = [
        ethers.parseEther("5"),
        ethers.parseEther("10"),
        ethers.parseEther("15"),
        ethers.parseEther("20"),
        ethers.parseEther("25")
      ];

      // mint + purchase each NFT
      for (let i = 0; i < nfts.length; i++) {
        await erc721Asset.oracle.setHousePrice(nfts[i], nftPrices[i]);
        await crvusd.connect(owner).mint(user3.address, nftPrices[i]);
        await crvusd.connect(user3).approve(erc721Asset.baseAsset.target, nftPrices[i]);
        await erc721Asset.baseAsset.connect(user3).mint(nfts[i], nftPrices[i]);
        expect(await erc721Asset.baseAsset.ownerOf(nfts[i])).to.equal(user3.address);
      }
    
      // deposit them all into the vault
      for (let i = 0; i < nfts.length-2; i++) {
        await erc721Asset.baseAsset.connect(user3).approve(adapterAddress, nfts[i]);
        await rwaVault.connect(user3).depositAsset(
          adapterAddress,
          encodeERC721Token(nfts[i]),
          user3.address,
          0
        );
        expect(await erc721Asset.baseAsset.ownerOf(nfts[i])).to.equal(adapterAddress);
      }

      let lastRandomWord = BigInt(RANDOM_NUMBER);
      console.log(await rwaVault.getNextRandomNFT())

      // deposit anothe NFT
      await erc721Asset.baseAsset.connect(user3).approve(adapterAddress, nfts[nfts.length-1]);
      await rwaVault.connect(user3).depositAsset(
        adapterAddress,
        encodeERC721Token(nfts[nfts.length-1]),
        user3.address,
        0
      );
      expect(await erc721Asset.baseAsset.ownerOf(nfts[nfts.length-1])).to.equal(adapterAddress);

      console.log(await rwaVault.getNextRandomNFT())

      // Deposit another NFT
      await erc721Asset.baseAsset.connect(user3).approve(adapterAddress, nfts[nfts.length-2]);
      await rwaVault.connect(user3).depositAsset(
        adapterAddress,
        encodeERC721Token(nfts[nfts.length-2]),
        user3.address,
        0
      ); 
      expect(await erc721Asset.baseAsset.ownerOf(nfts[nfts.length-2])).to.equal(adapterAddress);

      console.log(await rwaVault.getNextRandomNFT())
    })

    // TODO: test with several adapters and nfts, with some which have 0 nfts in them, but make sure redemption always has an NFT in it
    
    it("should revert redemption for the second NFT if VRF random words are not fulfilled", async function () {
        const erc721Asset = assets["ERC721"];
        await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
        await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);

        // --- Deposit Two NFTs ---
        // Deposit first NFT.
        await erc721Asset.oracle.setHousePrice(FIRST_NFT_ID, ethers.parseEther("100"));
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
        await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);
      
        // Deposit second NFT.
        await erc721Asset.oracle.setHousePrice(SECOND_NFT_ID, ethers.parseEther("100"));
        // Mint a second NFT to user1.
        await crvusd.mint(user1.address, ethers.parseEther("100"));
        await crvusd.connect(user1).approve(raacNFT.target, ethers.parseEther("100"));
        await raacNFT.connect(user1).mint(SECOND_NFT_ID, ethers.parseEther("100"));
        await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, SECOND_NFT_ID);
        await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(SECOND_NFT_ID), user1.address, 0);
      
        // --- First Redemption ---
        // Redeem the first NFT (this will trigger a new VRF request).
        const nextNFT = await rwaVault.getNextRandomNFT();
        const priceInShares = await rwaVault.previewWithdraw(ASSET_PRICE);
        await rwaVault.connect(user1).redeemNFT(nextNFT[0], nextNFT[1], priceInShares);
        
        // --- Second Redemption Attempt ---
        // At this point, a new VRF request has been initiated but not fulfilled.
        // Attempting to redeem the second NFT should revert because the VRF random words are not yet fulfilled.
        await expect(
          rwaVault.connect(user1).redeemNFT(ethers.ZeroAddress, 0, priceInShares) // could be anything, we just wnat it to revert. it will revert before the parameter check.
        ).to.be.revertedWithCustomError(rwaVault, "RequestNotFulfilled");
    });

    it("should handle rounding correctly to prevent share manipulation", async function () {
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
      
      // First deposit a large amount to set initial price
      const largeDeposit = ethers.parseEther("1000000");
      await assets["ERC20"].baseAsset.mint(user1.address, largeDeposit);
      await assets["ERC20"].baseAsset.connect(user1).approve(assets["ERC20"].adapter.target, largeDeposit);
      await rwaVault.connect(user1).depositAsset(
        assets["ERC20"].adapter.target,
        encodeERC20Token(largeDeposit),
        user1.address,
        0
      );

      // Then try to deposit a very small amount to test rounding
      const tinyDeposit = ethers.parseEther("0.0000001");
      await assets["ERC20"].baseAsset.mint(user2.address, tinyDeposit);
      await assets["ERC20"].baseAsset.connect(user2).approve(assets["ERC20"].adapter.target, tinyDeposit);
      await rwaVault.connect(user2).depositAsset(
        assets["ERC20"].adapter.target,
        encodeERC20Token(tinyDeposit),
        user2.address,
        0
      );

      // Verify the tiny deposit didn't cause any rounding issues
      const user2Shares = await rwaIndexToken.balanceOf(user2.address);
      const user2Assets = await rwaVault.convertToAssets(user2Shares);
      
      // The assets should be very close to the tiny deposit amount
      expect(user2Assets).to.be.closeTo(tinyDeposit, 1n);
    });

    it("should handle NFT rounding correctly with non-integer values", async function () {
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);

      // Set NFT price to a non-integer value (100.5 tokens)
      const nftPrice = ethers.parseEther("100.5");
      await raacHousePrices.setHousePrice(FIRST_NFT_ID, nftPrice);
      
      // Deposit the NFT
      await assets["ERC721"].baseAsset.connect(user1).approve(assets["ERC721"].adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(
        assets["ERC721"].adapter.target,
        encodeERC721Token(FIRST_NFT_ID),
        user1.address,
        0
      );

      // Verify share calculation
      const userShares = await rwaIndexToken.balanceOf(user1.address);
      const userAssets = await rwaVault.convertToAssets(userShares);
      
      // The assets should be very close to the NFT price
      expect(userAssets).to.be.closeTo(nftPrice, 1n);

      // Verify price per share calculation
      const pricePerShare = await rwaVault.pricePerShare();
      const expectedPricePerShare = (nftPrice * BigInt(1e18)) / userShares;
      expect(pricePerShare).to.equal(expectedPricePerShare);
    });
  });
  describe("Burn Vault Token", function() {
    it("should allow burning the index token, resulting in increase of NAV", async function() {
      await rwaVault.addManager(owner.address)
      const erc721Asset = assets["ERC721"];
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);

      await erc721Asset.oracle.setHousePrice(FIRST_NFT_ID, ethers.parseEther("100"));
      await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);

      const totalSupplyBefore = await rwaIndexToken.totalSupply()
      // expect the vault to be 1:1
      expect(await rwaVault.pricePerShare()).to.equal(ethers.parseEther("1"))

      await rwaVault.connect(owner).burnVaultToken(user1.address, (ASSET_PRICE / 2n).toString())
      const totalSupplyAfter = await rwaIndexToken.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore / 2n)
      expect(await rwaVault.pricePerShare()).to.equal(ethers.parseEther("2"))
    })
    it("should block burn if user is not authorized", async function() {
      const erc721Asset = assets["ERC721"];
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);

      await erc721Asset.oracle.setHousePrice(FIRST_NFT_ID, ethers.parseEther("100"));
      await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);

      await expect(rwaVault.connect(owner).burnVaultToken(user1.address, (ASSET_PRICE / 2n).toString())).to.be.revertedWith("only manager or stability pool")
    })
  })

  describe("VRF Request Handling", function() {
    it("should prevent new requests while one is pending", async function() {
      // Enable VRF requests
      await rwaVault.setAllowVRFRequest(true);
      
      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Make first request
      await rwaVault.requestRandomSeed();
      const firstRequestId = await vrfConsumer.lastRequestId();
      
      // Try to make another request before the first one is fulfilled
      await expect(rwaVault.requestRandomSeed())
        .to.be.revertedWithCustomError(vrfConsumer, "RequestAlreadyPending");
      
      // Fulfill the first request
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        firstRequestId,
        vrfConsumer.target,
        [RANDOM_NUMBER]
      );
      
      // Wait for the VRF request delay again
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Now should be able to make a new request
      await rwaVault.requestRandomSeed();
      const secondRequestId = await vrfConsumer.lastRequestId();
      expect(secondRequestId).to.not.equal(firstRequestId);
    });

    it("should verify requestId matches on fulfillment", async function() {
      // Enable VRF requests
      await rwaVault.setAllowVRFRequest(true);
      
      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Make a request
      await rwaVault.requestRandomSeed();
      const requestId = await vrfConsumer.lastRequestId();
      
      // Try to fulfill with wrong requestId
      const wrongRequestId = requestId + 1n;
      await expect(
        vrfCoordinator.fulfillRandomWordsWithOverride(
          wrongRequestId,
          vrfConsumer.target,
          [RANDOM_NUMBER]
        )
      ).to.be.revertedWithCustomError(vrfCoordinator, "InvalidRequest");
      
      // Fulfill with correct requestId
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        vrfConsumer.target,
        [RANDOM_NUMBER]
      );
      
      // Verify request was fulfilled
      const request = await vrfConsumer.getRequestStatus();
      expect(request.fulfilled).to.be.true;
      expect(request.randomWords[0]).to.equal(RANDOM_NUMBER);
    });

    it("should handle multiple requests in sequence correctly", async function() {
      // Enable VRF requests
      await rwaVault.setAllowVRFRequest(true);
      
      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Make first request
      await rwaVault.requestRandomSeed();
      const firstRequestId = await vrfConsumer.lastRequestId();
      
      // Fulfill first request
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        firstRequestId,
        vrfConsumer.target,
        [RANDOM_NUMBER]
      );
      
      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Make second request
      await rwaVault.requestRandomSeed();
      const secondRequestId = await vrfConsumer.lastRequestId();
      expect(secondRequestId).to.not.equal(firstRequestId);
      
      // Fulfill second request
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        secondRequestId,
        vrfConsumer.target,
        [RANDOM_NUMBER]
      );
      
      // Verify both requests were handled correctly
      const firstRequest = await vrfConsumer.getRequestStatus();
      expect(firstRequest.fulfilled).to.be.true;
      expect(firstRequest.randomWords[0]).to.equal(RANDOM_NUMBER);
      
      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);
      
      // Make third request
      await rwaVault.requestRandomSeed();
      const thirdRequestId = await vrfConsumer.lastRequestId();
      expect(thirdRequestId).to.not.equal(secondRequestId);
    });
    it("should handle stall request by allowing new requests", async function() {
      // Enable VRF requests
      await rwaVault.setAllowVRFRequest(true);

      // Wait for the VRF request delay
      await time.increase(3 * 24 * 60 * 60); // 3 days
      await ethers.provider.send("evm_mine", []);

      // Make a request
      await rwaVault.requestRandomSeed();
      const requestId = await vrfConsumer.lastRequestId();

      console.log(await vrfConsumer.getRequestStatus())

      // If you send anothe request, it will revert
      await expect(rwaVault.requestRandomSeed()).to.be.revertedWithCustomError(vrfConsumer, "RequestAlreadyPending");

      // ti goes to 1 hour only
      await time.increase(60 * 60);
      await ethers.provider.send("evm_mine", []);

      await expect(rwaVault.requestRandomSeed()).to.be.revertedWithCustomError(vrfConsumer, "RequestAlreadyPending");

      // Request is not fulfilled after 1 hour + 1
      await time.increase(1);
      await ethers.provider.send("evm_mine", []);

      // Request is now stalled
      await expect(rwaVault.requestRandomSeed()).to.emit(vrfConsumer, "RequestStalled").withArgs(requestId);

      const secondRequestId = await vrfConsumer.lastRequestId();
      expect(secondRequestId).to.not.equal(requestId);

      // Request 2: fulfill the request: it will not revert but send a 
      await expect(vrfCoordinator.fulfillRandomWordsWithOverride(
        secondRequestId,
        vrfConsumer.target,
        [24]
      )).to.emit(vrfConsumer, "RequestFulfilled").withArgs(secondRequestId, [24])

      // check that the new number is correct
      const request = await vrfConsumer.getRequestStatus();
      expect(request.randomWords[0]).to.equal(24);

      // Request 1: fulfilled later
      await expect(vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        vrfConsumer.target,
        [26]
      )).to.emit(vrfConsumer, "RequestIdMismatch").withArgs(requestId, secondRequestId);

      // check that the new number is correct
      const request1 = await vrfConsumer.getRequestStatus();
      expect(request1.randomWords[0]).to.equal(24); // still does not change

      // after some time, i can sitll send a new request and eveyrhting works normally
      await time.increase(3 * 24 * 60 * 60);
      await ethers.provider.send("evm_mine", []);

      await rwaVault.requestRandomSeed();
      const thirdRequestId = await vrfConsumer.lastRequestId();
      expect(thirdRequestId).to.not.equal(secondRequestId);

      // fulfill the request
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        thirdRequestId,
        vrfConsumer.target,
        [27]
      );

      // check that the new number is correct
      const request2 = await vrfConsumer.getRequestStatus();
      expect(request2.randomWords[0]).to.equal(27);

      // send another request directly
      await vrfConsumer.requestRandomWords();
      const fourthRequestId = await vrfConsumer.lastRequestId();
      expect(fourthRequestId).to.not.equal(thirdRequestId);

      // fulfill the request
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        fourthRequestId,
        vrfConsumer.target,
        [28]
      );

      // check that the new number is correct
      const request3 = await vrfConsumer.getRequestStatus();
      expect(request3.randomWords[0]).to.equal(28);

      // send a request again with the same requestId
      // fulfill the request
      await expect(vrfCoordinator.fulfillRandomWordsWithOverride(
        fourthRequestId,
        vrfConsumer.target,
        [29]
      )).to.be.revertedWithCustomError(vrfCoordinator, "InvalidRequest");
    })
  });
  describe("First Deposit Attack", function() {
    beforeEach(async function() {
      await rwaVault.addManager(owner.address)
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
    })
    it("ERC20: should prevent the first person attack", async function() {
      // deposit 1 wei
      const asset = assets["ERC20"]

      await asset.baseAsset.mint(user1.address, 1);
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, 1);
      await rwaVault.connect(user1).depositAsset(asset.adapter.target, encodeERC20Token(1), user1.address, 0);

      // total supply is 1 and total asset value is 1 and user received 1 wei
      const totalSupplyBefore = await rwaIndexToken.totalSupply();
      const totalAssetsBefore = await rwaVault.totalAssets();
      const totalUserBalanceBefore = await rwaIndexToken.balanceOf(user1.address);
      expect(totalSupplyBefore).to.equal(1);
      expect(totalAssetsBefore).to.equal(1);
      expect(totalUserBalanceBefore).to.equal(1);

      // deposit 2e18: main attack
      await asset.baseAsset.mint(user1.address, ethers.parseEther("2"));
      await asset.baseAsset.connect(user1).approve(asset.adapter.target, ethers.parseEther("2"));
      await asset.baseAsset.connect(user1).transfer(asset.adapter.target, ethers.parseEther("2"));
      const totalSupplyAfter = await rwaIndexToken.totalSupply();
      const totalAssetsAfter = await rwaVault.totalAssets();
      const totalUserBalanceAfter = await rwaIndexToken.balanceOf(user1.address);
      // The donation should not have affect on the total supply, total assets, or user balance
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
      expect(totalAssetsAfter).to.equal(totalAssetsBefore);
      expect(totalUserBalanceAfter).to.equal(totalUserBalanceBefore);

      // we need to make sure that the next user who deposits, receives a good amount.
      await asset.baseAsset.mint(user2.address, ethers.parseEther("1000"));
      await asset.baseAsset.connect(user2).approve(asset.adapter.target, ethers.parseEther("1000"));
      await rwaVault.connect(user2).depositAsset(asset.adapter.target, encodeERC20Token(ethers.parseEther("1000")), user2.address, 0);

      const totalSupplyAfter2 = await rwaIndexToken.totalSupply();
      const totalAssetsAfter2 = await rwaVault.totalAssets();
      const totalUserBalanceAfter2 = await rwaIndexToken.balanceOf(user2.address);
      expect(totalSupplyAfter2).to.equal(1n + ethers.parseEther("1000"));
      expect(totalAssetsAfter2).to.equal(1n + ethers.parseEther("1000"));
      expect(totalUserBalanceAfter2).to.equal(ethers.parseEther("1000"));

      await asset.baseAsset.mint(user3.address, ethers.parseEther("1"));
      await asset.baseAsset.connect(user3).approve(asset.adapter.target, ethers.parseEther("1"));
      await rwaVault.connect(user3).depositAsset(asset.adapter.target, encodeERC20Token(ethers.parseEther("1")), user3.address, 0);

      const totalSupplyAfter3 = await rwaIndexToken.totalSupply();
      const totalAssetsAfter3 = await rwaVault.totalAssets();
      const totalUserBalanceAfter3 = await rwaIndexToken.balanceOf(user3.address);
      expect(totalSupplyAfter3).to.equal(1n + ethers.parseEther("1000") + ethers.parseEther("1"));
      expect(totalAssetsAfter3).to.equal(1n + ethers.parseEther("1000") + ethers.parseEther("1"));
      expect(totalUserBalanceAfter3).to.equal(ethers.parseEther("1"));

      expect(await asset.baseAsset.balanceOf(asset.adapter.target)).to.equal(1n+ ethers.parseEther("1000") + ethers.parseEther("1") + ethers.parseEther("2"));
    })
    it("ERC721: should prevent the first person attack", async function() {
      const erc721Asset = assets["ERC721"];
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);

      await erc721Asset.oracle.setHousePrice(FIRST_NFT_ID, 1);
      await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(erc721Asset.adapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);

      const totalSupplyBefore = await rwaIndexToken.totalSupply();
      const totalAssetsBefore = await rwaVault.totalAssets();
      const totalUserBalanceBefore = await rwaIndexToken.balanceOf(user1.address);
      expect(totalSupplyBefore).to.equal(1);
      expect(totalAssetsBefore).to.equal(1);
      expect(totalUserBalanceBefore).to.equal(1);

      await erc721Asset.oracle.setHousePrice(SECOND_NFT_ID, ethers.parseEther("100"));
      await crvusd.mint(user1.address, ethers.parseEther("100"));
      await crvusd.connect(user1).approve(raacNFT.target, ethers.parseEther("100"));
      await raacNFT.connect(user1).mint(SECOND_NFT_ID, ethers.parseEther("100"));
      await erc721Asset.baseAsset.connect(user1).approve(erc721Asset.adapter.target, SECOND_NFT_ID);
      await erc721Asset.baseAsset.connect(user1).transferFrom(user1.address, erc721Asset.adapter.target, SECOND_NFT_ID);

      const totalSupplyAfter = await rwaIndexToken.totalSupply();
      const totalAssetsAfter = await rwaVault.totalAssets();
      const totalUserBalanceAfter = await rwaIndexToken.balanceOf(user1.address);
      expect(totalSupplyAfter).to.equal(1);
      expect(totalAssetsAfter).to.equal(1);
      expect(totalUserBalanceAfter).to.equal(1);

      // mint another NFT and deposit normall
      const THIRD_NFT_ID = 3
      await erc721Asset.oracle.setHousePrice(THIRD_NFT_ID, ethers.parseEther("1000"));
      await crvusd.mint(user2.address, ethers.parseEther("1000"));
      await crvusd.connect(user2).approve(raacNFT.target, ethers.parseEther("1000"));
      await raacNFT.connect(user2).mint(THIRD_NFT_ID, ethers.parseEther("1000"));
      await erc721Asset.baseAsset.connect(user2).approve(erc721Asset.adapter.target, THIRD_NFT_ID);
      await rwaVault.connect(user2).depositAsset(erc721Asset.adapter.target, encodeERC721Token(THIRD_NFT_ID), user2.address, 0);

      const totalSupplyAfter2 = await rwaIndexToken.totalSupply();
      const totalAssetsAfter2 = await rwaVault.totalAssets();
      const totalUserBalanceAfter2 = await rwaIndexToken.balanceOf(user2.address);
      expect(totalSupplyAfter2).to.equal(1n + ethers.parseEther("1000"));
      expect(totalAssetsAfter2).to.equal(1n + ethers.parseEther("1000"));
      expect(totalUserBalanceAfter2).to.equal(ethers.parseEther("1000"));

    })
  })  
  
  describe("RAACNFTVaultAdapterV2", function() {
    let raacNFTAdapter;
    beforeEach(async function() {
      await rwaVault.addManager(owner.address)

      const RAACNFTVaultAdapterOracle = await ethers.getContractFactory("RAACNFTVaultAdapterOracle");
      const raacNFTVaultAdapterOracle = await RAACNFTVaultAdapterOracle.deploy(raacHousePrices.target);


      const RAACNFTVaultAdapter = await ethers.getContractFactory("RAACNFTVaultAdapterV2")
      raacNFTAdapter = await RAACNFTVaultAdapter.deploy(raacNFT.target, raacNFTVaultAdapterOracle.target, rwaVault.target, raacHousePrices.target)

      await raacHousePrices.addSyncer(raacNFTAdapter.target);
      await rwaVault.registerAdapter(raacNFTAdapter.target);
      await rwaVault.registerDepositableAdapter(raacNFTAdapter.target);
    })
    it("should change the price of the NFT", async function() {
      // deposit an asset
      await raacHousePrices.setHousePrice(FIRST_NFT_ID, ethers.parseEther("100"));
      await raacNFT.connect(user1).approve(raacNFTAdapter.target, FIRST_NFT_ID);
      await rwaVault.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(FIRST_NFT_ID), user1.address, 0);

      // check the total value in the adapter
      const totalValue = await raacNFTAdapter.totalValue();
      expect(totalValue).to.equal(ethers.parseEther("100"));

      // change the price of the NFT
      await raacHousePrices.setHousePrice(FIRST_NFT_ID, ethers.parseEther("200"));

      // check the total value in the adapter
      const totalValueAfter = await raacNFTAdapter.totalValue();
      expect(totalValueAfter).to.equal(ethers.parseEther("200"));
    })
    it("should change the price including multiple NFTs", async function() {
      // enable crvUSD oracle
      const MockChainlinkAggregator = await ethers.getContractFactory("MockChainlinkAggregator")
      const currencyValue = "1"
      const crvusdPriceFeed = await MockChainlinkAggregator.deploy(8, "crvUSD / USD", ethers.parseUnits(currencyValue, 8))
      await crvUSDToUSDOracle.setCrvUSDDataFeed(crvusdPriceFeed.target)

      let totalAssetValue = 0n;

      const nfts = [2, 3, 4, 5, 6]
      const prices = [ethers.parseEther("100"), ethers.parseEther("200"), ethers.parseEther("300"), ethers.parseEther("400"), ethers.parseEther("500")]
      for (let i = 0; i < nfts.length; i++) {
        await raacHousePrices.setHousePrice(nfts[i], prices[i])
        await raacNFT.minterMint(user1.address, nfts[i])
        await raacNFT.connect(user1).approve(raacNFTAdapter.target, nfts[i])
        await rwaVault.connect(user1).depositAsset(raacNFTAdapter.target, encodeERC721Token(nfts[i]), user1.address, 0)
        totalAssetValue += BigInt(prices[i])
      }
      expect(await raacNFTAdapter.totalValue()).to.equal((totalAssetValue *  BigInt(1e18)) / ethers.parseEther(currencyValue));
      expect(await rwaVault.totalAssets()).to.equal((totalAssetValue *  BigInt(1e18)) / ethers.parseEther(currencyValue));

      // randomly increase/decrease the prices of the NFTs and keep the value track
      for (let i = 0; i < nfts.length; i++) {
        const newPrice = (prices[i] * BigInt(100 + Math.floor(Math.random() * 100))) / 100n
        const oldPrice = prices[i]
        await raacHousePrices.setHousePrice(nfts[i], newPrice)
        totalAssetValue += BigInt(newPrice) - BigInt(oldPrice)
        expect(await raacNFTAdapter.totalValue()).to.equal((totalAssetValue *  BigInt(1e18)) / ethers.parseEther(currencyValue));
      }

      // update a random house that is not deposited
      await raacHousePrices.setHousePrice(100, ethers.parseEther("1000"))
      expect(await raacNFTAdapter.totalValue()).to.equal((totalAssetValue *  BigInt(1e18)) / ethers.parseEther(currencyValue));
      expect(await rwaVault.totalAssets()).to.equal((totalAssetValue *  BigInt(1e18)) / ethers.parseEther(currencyValue));
      // take all nfts out as admin
      for (let i = 0; i < nfts.length; i++) {
        await rwaVault.connect(owner).adminWithdrawAsset(raacNFTAdapter.target, encodeERC721Token(nfts[i]), owner.address, false, 0)
      }
      expect(await raacNFTAdapter.totalValue()).to.equal(0n);
      expect(await rwaVault.totalAssets()).to.equal(0n);
      // update any price and check that the total value is correct
      await raacHousePrices.setHousePrice(nfts[0], ethers.parseEther("1000"))
      expect(await raacNFTAdapter.totalValue()).to.equal(0);
      expect(await rwaVault.totalAssets()).to.equal(0n);
    })
  })

  describe("Slippage Protection", function() {
    beforeEach(async function() {
      await rwaVault.registerDepositableAdapter(assets["ERC20"].adapter.target);
      await rwaVault.registerDepositableAdapter(assets["ERC721"].adapter.target);
      await rwaVault.registerRedeemableERC721Adapter(assets["ERC721"].adapter.target);
      await rwaVault.setFeeCollector(feeCollector.target);
    });

    describe("Deposit Asset Slippage Protection", function() {
      it("Should revert when minimum shares expectation is not met due to fees (ERC20)", async function() {
        const assetType = "ERC20";
        const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, assetType);

        await baseAsset.mint(user1.address, ASSET_PRICE);
        await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
        
        const expectedSharesWithoutFees = await rwaVault.previewDeposit(ASSET_PRICE);
        await expect(
          rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, expectedSharesWithoutFees)
        ).to.be.revertedWithCustomError(rwaVault, "SlippageExceeded");
      });

      it("Should succeed when minimum shares expectation accounts for fees (ERC20)", async function() {
        const assetType = "ERC20";
        const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, assetType);
        
        await baseAsset.mint(user1.address, ASSET_PRICE);
        await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
        
        const indexTokenMintingFee = await rwaVault.indexTokenMintingFee();
        const expectedSharesAfterFees = (await rwaVault.previewDeposit(ASSET_PRICE)) * (BigInt(100_00) - indexTokenMintingFee) / BigInt(100_00);
        
        await expect(
          rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, expectedSharesAfterFees)
        ).to.not.be.reverted;
        
        const userBalance = await rwaIndexToken.balanceOf(user1.address);
        expect(userBalance).to.equal(expectedSharesAfterFees);
      });

      it("Should revert when minimum shares expectation is not met due to fees (ERC721)", async function() {
        const assetType = "ERC721";
        const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, assetType);
        
        await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
        
        const expectedSharesWithoutFees = await rwaVault.previewDeposit(ASSET_PRICE);
        
        await expect(
          rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, expectedSharesWithoutFees)
        ).to.be.revertedWithCustomError(rwaVault, "SlippageExceeded");
      });

      it("Should succeed when minimum shares expectation accounts for fees (ERC721)", async function() {
        const assetType = "ERC721";
        const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, assetType);
        
        await baseAsset.connect(user1).approve(vaultAdapter.target, FIRST_NFT_ID);
        
        const indexTokenMintingFee = await rwaVault.indexTokenMintingFee();
        const expectedSharesAfterFees = (await rwaVault.previewDeposit(ASSET_PRICE)) * (BigInt(100_00) - indexTokenMintingFee) / BigInt(100_00);
        
        await expect(
          rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, expectedSharesAfterFees)
        ).to.not.be.reverted;
        
        const userBalance = await rwaIndexToken.balanceOf(user1.address);
        expect(userBalance).to.equal(expectedSharesAfterFees);
      });

      it("Should allow deposit with zero minimum shares (no slippage protection)", async function() {
        const assetType = "ERC20";
        const [baseAsset, vaultAdapter, encodedAssetData] = extractAsset(assets, assetType);
        
        await baseAsset.mint(user1.address, ASSET_PRICE);
        await baseAsset.connect(user1).approve(vaultAdapter.target, ASSET_PRICE);
        
        await expect(
          rwaVault.connect(user1).depositAsset(vaultAdapter.target, encodedAssetData, user1.address, 0)
        ).to.not.be.reverted;
        
        const userBalance = await rwaIndexToken.balanceOf(user1.address);
        expect(userBalance).to.be.gt(0);
      });
    });

    describe("Redeem NFT Slippage Protection", function() {
      beforeEach(async function() {
        const asset = assets["ERC721"];
        await asset.baseAsset.connect(user1).approve(asset.adapter.target, FIRST_NFT_ID);
        await rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0); // 98 iRAAC because of 2% fees minted

        // mint some more shares to the user
        const erc20Asset = assets["ERC20"];
        await erc20Asset.baseAsset.mint(user1.address, ethers.parseEther("100"));
        await erc20Asset.baseAsset.connect(user1).approve(erc20Asset.adapter.target, ethers.parseEther("100")); 
        await rwaVault.connect(user1).depositAsset(erc20Asset.adapter.target, encodeERC20Token(ethers.parseEther("100")), user1.address, 0);
      });

      it("Should handle price changes affecting redemption value", async function() {
        // Change the NFT price to simulate market volatility
        const newNFTPrice = ethers.parseEther("150");
        await assets["ERC721"].oracle.setHousePrice(FIRST_NFT_ID, newNFTPrice);
        await ethers.provider.send("evm_mine", []);
        
        // Calculate new shares needed
        const priceInShares = await rwaVault.previewWithdraw(newNFTPrice);
        const pricePerShare = await rwaVault.pricePerShare();
        console.log("pricePerShare", ethers.formatEther(pricePerShare)); 
        console.log("priceInShares", ethers.formatEther(priceInShares)); 
        console.log("userBalance", ethers.formatEther(await rwaIndexToken.balanceOf(user1.address))); // 100 iRAAC


        // suppose that price changed when the user sent the transaction. This means that we are still sending a transaction based on the 100 price
        await expect(rwaVault.connect(user1).redeemNFT(assets["ERC721"].adapter.target, FIRST_NFT_ID, await rwaVault.previewWithdraw(ASSET_PRICE))).to.be.revertedWithCustomError(rwaVault, "SlippageExceeded");

        // User should still be able to redeem at the original deposited value
        await expect(rwaVault.connect(user1).redeemNFT(assets["ERC721"].adapter.target, FIRST_NFT_ID, priceInShares)).to.not.be.reverted;
      });
    });
  });
});