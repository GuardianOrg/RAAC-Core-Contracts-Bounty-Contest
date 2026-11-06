import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

const RAY = ethers.parseUnits("1", 27);

function encodeERC721Token(tokenID) {
    return new ethers.AbiCoder().encode(["uint256"], [tokenID])
  }
  function encodeERC20Token(amount) {
    return new ethers.AbiCoder().encode(["uint256"], [amount]);
  }

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
  await vrf.vrfCoordinator.fulfillRandomWordsWithOverride(await vrfConsumer.lastRequestId(), vrfConsumer.target, [12]);
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

describe("Compliance Registry", function () {
  let owner, user1, user2, user3;
  let crvusd;
  let stabilityPool, raacFCL, raacVault, complianceRegistry;
  let raacNFT, raacNFTAdapter, raacHousePrices;
  let erc20Token, erc20TokenAdapter, erc20PriceOracle;
  let lendingPool, rToken, debtToken;
  let deployer;
  let token;
  const INSURANCE_FEE = ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE"));
  const ASSET_PRICE = ethers.parseEther("100");
  let rwaVault, rwaIndexToken, vrf, crvUSDToUSDOracle;

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
    const StabilityPool = await ethers.getContractFactory("StabilityPool");
    stabilityPool = await StabilityPool.deploy(complianceRegistry.target);
  
    // Deploy tokens
    const RToken = await ethers.getContractFactory("RToken");
    rToken = await RToken.deploy("RToken", "RToken", owner.address, crvusd.target, complianceRegistry.target);
  
    const DebtToken = await ethers.getContractFactory("DebtToken");
    debtToken = await DebtToken.deploy("DebtToken", "DT", owner.address, crvusd.target);
  
    const initialPrimeRate = ethers.parseUnits("0.1", 27);

    [rwaIndexToken, rwaVault, vrf] = await deployRWAVault(crvusd, complianceRegistry)

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

    await lendingPool.registerAdapter(raacNFTAdapter.target);
    await lendingPool.registerAdapter(erc20TokenAdapter.target);
    await rwaVault.registerAdapter(raacNFTAdapter.target)
    await rwaVault.registerDepositableAdapter(raacNFTAdapter.target);

    // set the assets map
    assets["ERC20"] = {baseAsset: erc20Token, adapter: erc20TokenAdapter, data: encodeERC20Token(ASSET_PRICE)}
    assets["ERC721"] = {baseAsset: raacNFT, adapter: raacNFTAdapter, data: encodeERC721Token(1)}
  });

  it("should allow blacklisting users", async function() {
    await expect(complianceRegistry.blacklist(user1.address)).to.emit(complianceRegistry, "Blacklisted").withArgs(user1.address);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.true;

    await expect(complianceRegistry.blacklist(user2.address)).to.emit(complianceRegistry, "Blacklisted").withArgs(user2.address);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.true;
    expect(await complianceRegistry.isBlacklisted(user2.address)).to.be.true;
  })
  it("should not allow blacklisting twice", async function() {
    await expect(complianceRegistry.blacklist(user1.address)).to.emit(complianceRegistry, "Blacklisted").withArgs(user1.address);
    await expect(complianceRegistry.blacklist(user1.address)).to.be.revertedWithCustomError(complianceRegistry, "AlreadyBlacklisted")
  })
  it("should allow unblacklisting users", async function() {
    await expect(complianceRegistry.blacklist(user1.address)).to.emit(complianceRegistry, "Blacklisted").withArgs(user1.address);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.true; 
    await expect(complianceRegistry.unblacklist(user1.address)).to.emit(complianceRegistry, "UnBlacklisted").withArgs(user1.address);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.false; 
  })
  it("should not allow unblacklisting if already not blacklisted", async function() {
    await expect(complianceRegistry.unblacklist(user1.address)).to.be.revertedWithCustomError(complianceRegistry, "NotBlacklisted");
  })

  it("lending pool: should block blacklisted users", async function() {
    await complianceRegistry.blacklist(user1.address);
    const asset = assets["ERC721"]
    await expect(lendingPool.connect(user1).deposit(1)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).openVaultPosition()).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).depositAsset(asset.adapter.target, asset.data)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).borrow(asset.adapter.target, asset.data, ethers.parseEther("10"))).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).borrowWithInsurance(asset.adapter.target, asset.data, ethers.parseEther("10"))).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).initiateLiquidation(asset.adapter.target, user2.address, asset.data)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    await expect(lendingPool.connect(user1).closeLiquidation(asset.adapter.target, asset.data)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
  })
  it("stability pool: should block blacklisted users", async function() {
    await complianceRegistry.blacklist(user1.address);
    // block deposits
    await expect(stabilityPool.connect(user1).deposit(ethers.parseEther("1"))).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
  });
  it("raac nft: should block blacklisted users", async function() {
    await complianceRegistry.blacklist(user1.address);
    // block minting
    await expect(raacNFT.connect(user1).mint(1, ethers.parseEther("1"))).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
  })
  it("rwa vault: should block blacklisted users", async function() {
    await complianceRegistry.blacklist(user1.address);
    // block deposit of asset
    const asset = assets["ERC721"]
    await expect(rwaVault.connect(user1).depositAsset(asset.adapter.target, asset.data, user1.address, 0)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
    // block redemption
    await expect(rwaVault.connect(user1).redeemNFT(ethers.ZeroAddress, 0, 0)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
  });

  it("should allow batch blacklisting", async function() {
    const usersToBlacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    await complianceRegistry.blacklistBatch(usersToBlacklist);
    for (const user of usersToBlacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.true;
    }
  })
  it("should allow batch unblacklisting", async function() {
    const usersToUnblacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    await complianceRegistry.blacklistBatch(usersToUnblacklist);
    for (const user of usersToUnblacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.true;
    }
    await complianceRegistry.unblacklistBatch(usersToUnblacklist);
    for (const user of usersToUnblacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.false;
    }
  });
  it("should not allow batch blacklisting with invalid addresses", async function() {
    const usersToBlacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    usersToBlacklist.push(ethers.ZeroAddress);
    await expect(complianceRegistry.blacklistBatch(usersToBlacklist)).to.be.revertedWithCustomError(complianceRegistry, "InvalidAddress");
  })
  it("should not allow batch unblacklisting with invalid addresses", async function() {
    const usersToUnblacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    usersToUnblacklist.push(ethers.ZeroAddress);
    await expect(complianceRegistry.unblacklistBatch(usersToUnblacklist)).to.be.revertedWithCustomError(complianceRegistry, "InvalidAddress");
  })
  it("should allow batch blacklisting with already blacklisted addresses", async function() {
    const usersToBlacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    await complianceRegistry.blacklistBatch(usersToBlacklist);
    for (const user of usersToBlacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.true;
    }
  })
  it("should allow batch unblacklisting with not blacklisted addresses", async function() {
    const usersToUnblacklist = new Array(10).fill(0).map((_, i) => ethers.Wallet.createRandom().address);
    await complianceRegistry.blacklistBatch(usersToUnblacklist);
    for (const user of usersToUnblacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.true;
    }
    await complianceRegistry.unblacklistBatch(usersToUnblacklist);
    for (const user of usersToUnblacklist) {
      expect(await complianceRegistry.isBlacklisted(user)).to.be.false;
    }
  })
  it("should allow setting the sanctions list", async function() {
    const MockChainAnalysis = await ethers.getContractFactory("MockChainAnalysis");
    const mockChainAnalysis = await MockChainAnalysis.deploy();
    await complianceRegistry.setSanctionsList(mockChainAnalysis.target);
    await mockChainAnalysis.setSanctioned(user1.address, true);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.true;
  })
  it("should allow unsetting the sanctions list", async function() {
    const MockChainAnalysis = await ethers.getContractFactory("MockChainAnalysis");
    const mockChainAnalysis = await MockChainAnalysis.deploy();
    await complianceRegistry.setSanctionsList(mockChainAnalysis.target);
    await mockChainAnalysis.setSanctioned(user1.address, false);
    expect(await complianceRegistry.isBlacklisted(user1.address)).to.be.false;
  });
  it("should work with WithCompliance inherited contracts", async function() {
    const MockChainAnalysis = await ethers.getContractFactory("MockChainAnalysis");
    const mockChainAnalysis = await MockChainAnalysis.deploy();
    await complianceRegistry.setSanctionsList(mockChainAnalysis.target);
    await mockChainAnalysis.setSanctioned(user1.address, true);

    await expect(lendingPool.connect(user1).deposit(1)).to.be.revertedWithCustomError(complianceRegistry, "BlacklistedAddress");
  })
});




