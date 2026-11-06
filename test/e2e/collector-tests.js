// Test the distribution of the fee to treasury
// Test that claimCollectorRewards works in lending pool
// Test that claimNFTUnderlying works in RAACNFT

import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("Fee Collector integration tests", function() {
    let feeCollector, raacNFT, lendingPool, treasury;
    let crvusd, raacHousePrices, complianceRegistry, crvUSDToUSDOracle;
    let owner, user1, user2;

    const INSURANCE_FEE = ethers.keccak256(ethers.toUtf8Bytes("INSURANCE_FEE"));
    const LENDING_FEE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_FEE"));
    const ROYALTY_FEE = ethers.keccak256(ethers.toUtf8Bytes("ROYALTY_FEE"));
    const RAACNFT_FEE = ethers.keccak256(ethers.toUtf8Bytes("RAACNFT_FEE"));

    beforeEach(async function() {
        [owner, user1, user2] = await ethers.getSigners();
        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvusd = await CrvUSDToken.deploy(owner.address);
  
        await crvusd.setMinter(owner.address);

        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address,0);

        const RAACHousePrices = await ethers.getContractFactory("RAACHousePrices");
        raacHousePrices = await RAACHousePrices.deploy(crvUSDToUSDOracle.target, owner.address);

        await raacHousePrices.setOracle(owner.address)

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        complianceRegistry = await ComplianceRegistry.deploy();

        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(owner.address);

        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(crvusd.target, raacHousePrices.target, complianceRegistry.target, owner.address);

        const Treasury = await ethers.getContractFactory("Treasury");
        treasury = await Treasury.deploy(owner.address);

        const MockLendingPoolCollector = await ethers.getContractFactory("MockLendingPoolCollector");
        lendingPool = await MockLendingPoolCollector.deploy(crvusd.target);

        await lendingPool.setFeeCollector(feeCollector.target);

        await feeCollector.addFeeType(LENDING_FEE, 10000, 0, 0, 0, 0, 0);
        await feeCollector.addFeeType(ROYALTY_FEE, 0, 0, 0, 0, 0, 10000);
        await feeCollector.addFeeType(INSURANCE_FEE, 0, 6667, 0, 3333, 0, 0);
        // putting 90 so that we can test that the extra is sent to the treasury (by default)
        await feeCollector.addFeeType(RAACNFT_FEE, 0, 0, 0, 0, 9000, 0);

        await treasury.addSupportedToken(crvusd.target);
        await feeCollector.addClaimableToken(crvusd.target);
        await feeCollector.addWhitelistedTarget(lendingPool.target);
        await feeCollector.addWhitelistedTarget(raacNFT.target);
        await feeCollector.setTargetFeeType(lendingPool.target, LENDING_FEE);
        await feeCollector.setTargetFeeType(raacNFT.target, RAACNFT_FEE);

        // setup the treasury target
        await feeCollector.setTargetAddress(ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), treasury.target);
        await feeCollector.setTargetAddress(ethers.keccak256(ethers.toUtf8Bytes("RAAC_CORP")), owner.address);

        // Grant the feeCollector the WITHDRAW_ROLE on the RAACNFT
        await raacNFT.grantRole(await raacNFT.WITHDRAW_ROLE(), feeCollector.target);
    })
    it("should distribute fees to treasury", async function() {
        await feeCollector.connect(owner).addWhitelistedTarget(user1.address);
        await crvusd.mint(user1.address, ethers.parseEther("1000"));
        await crvusd.connect(user1).approve(feeCollector.target, ethers.parseEther("1000"));
        await feeCollector.connect(user1).collectFee(crvusd.target, user1.address, ethers.parseEther("1"), LENDING_FEE);

        await feeCollector.connect(owner).distributeFees(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target);

        const treasuryBalance = await treasury.getBalance(crvusd.target);
        expect(treasuryBalance).to.equal(ethers.parseEther("1"));
    });
    it("should claim rewards from lending pool", async function() {
        await crvusd.mint(user1.address, ethers.parseEther("1000"));
        await crvusd.connect(user1).approve(lendingPool.target, ethers.parseEther("1000"));
        await lendingPool.connect(user1).depositToVault(ethers.parseEther("1000"));

        // we have rewards now that can be collected
        await feeCollector.connect(owner).claimCollectorRewards(crvusd.target, lendingPool.target, LENDING_FEE);

        // Get the balance of the fee collector for crvusd in treasury, should be 1000
        const feeCollectorBalance = await feeCollector.getTargetAmount(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target);
        expect(feeCollectorBalance).to.equal(ethers.parseEther("1000"));

        // Distribute the fees to the treasury
        await feeCollector.connect(owner).distributeFees(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target);

        // Get the balance of the treasury for crvusd, should be 1000
        const treasuryBalance = await treasury.getBalance(crvusd.target);
        expect(treasuryBalance).to.equal(ethers.parseEther("1000"));
        expect(await feeCollector.getTargetAmount(LENDING_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target)).to.equal(0);
    })
    it("should claim underlying fees from RAACNFT", async function() {

        // We mint one RAAC NFT to user2, who pays and then we collect the fees and send to treasury (or RAAC CORP)
        await raacHousePrices.connect(owner).setHousePrice(1, ethers.parseEther("100"));
        await crvusd.mint(user2.address, ethers.parseEther("100"));
        await crvusd.connect(user2).approve(raacNFT.target, ethers.parseEther("100"));

        await raacNFT.connect(user2).mint(1, ethers.parseEther("100"))

        expect(await crvusd.balanceOf(user2.address)).to.equal(ethers.parseEther("0"));
        expect(await crvusd.balanceOf(raacNFT.target)).to.equal(ethers.parseEther("100"));
        expect(await raacNFT.balanceOf(user2.address)).to.equal(1);

        // Collect the fees
        await feeCollector.connect(owner).claimNFTUnderlying(crvusd.target, raacNFT.target, ethers.parseEther("100"), RAACNFT_FEE);

        // Get the balance of the fee collector for crvusd in RAAC_CORP, should be 90
        const feeCollectorBalance = await feeCollector.getTargetAmount(RAACNFT_FEE, ethers.keccak256(ethers.toUtf8Bytes("RAAC_CORP")), crvusd.target);
        expect(feeCollectorBalance).to.equal(ethers.parseEther("90"));

        // Check the balance of treasury, should be 10 (since other 90 is sent to the treasury)
        let treasuryBalance = await feeCollector.getTargetAmount(RAACNFT_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target);
        expect(treasuryBalance).to.equal(ethers.parseEther("10"));

        // Distribute the fees to the treasury
        await feeCollector.connect(owner).distributeFees(RAACNFT_FEE, ethers.keccak256(ethers.toUtf8Bytes("RAAC_CORP")), crvusd.target);
        await feeCollector.connect(owner).distributeFees(RAACNFT_FEE, ethers.keccak256(ethers.toUtf8Bytes("TREASURY")), crvusd.target);

        // Get the balance of the treasury for crvusd, should be 10
        treasuryBalance = await treasury.getBalance(crvusd.target);
        expect(treasuryBalance).to.equal(ethers.parseEther("10"));
        expect(await feeCollector.getTargetAmount(RAACNFT_FEE, ethers.keccak256(ethers.toUtf8Bytes("RAAC_CORP")), crvusd.target)).to.equal(0);

        // Check the balance of RAAC_CORP, should be 90
        const raacCorpBalance = await crvusd.balanceOf(owner.address);
        expect(raacCorpBalance).to.equal(ethers.parseEther("90"));
    })
})