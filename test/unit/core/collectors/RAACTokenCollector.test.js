import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("RAACTokenCollector", function () {
    let owner, feeManager, user1, user2;

    let FeeCollector;
    // Fee & raacToken collector 
    let feeCollector, raacTokenCollector

    let raacToken;

    const TAX_RATE = 200n; // 2% in basis points
    const BURN_RATE = 50n; // 0.5% in basis points

    const RAAC_FEE = ethers.keccak256(ethers.toUtf8Bytes("RAAC_FEE"));

    const TREASURY_SHARE = 2500n;
    const REPAIR_FUND_SHARE = 5000n;
    const BURN_SHARE = 0n;
    const VE_RAAC_SHARE = 0n;
    const RAAC_CORP_SHARE = 2500n;
    const OTHER_SHARE = 0n;

    before(async function () {
        [owner, feeManager, user1, user2] = await ethers.getSigners();

        FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(owner.address);

        // Deploy core contracts
        const RAACToken = await ethers.getContractFactory("RAACToken", owner);
        raacToken = await RAACToken.deploy(
            owner.address    // initial owner
        );

        const RAACTokenCollector = await ethers.getContractFactory("RAACTokenCollector");
        raacTokenCollector = await RAACTokenCollector.deploy(feeCollector.target, raacToken.target);

        // Add fee type and claimable token to the fee collector
        await feeCollector.addFeeType(RAAC_FEE, TREASURY_SHARE, REPAIR_FUND_SHARE, BURN_SHARE, VE_RAAC_SHARE, RAAC_CORP_SHARE, OTHER_SHARE);
        await feeCollector.addClaimableToken(raacToken.target)

        // Set owner as minter
        await raacToken.setMinter(owner.address);

        // Mint 1000 raac tokens to the owner
        await raacToken.mint(user1.address, ethers.parseEther("1000"));
    });

    describe("Fee Collection Process", function () {
        it("should collect fee upon transfer", async function () {
            expect(await raacToken.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
            expect(await raacToken.balanceOf(user2.address)).to.equal(0);

            expect(await raacToken.balanceOf(raacTokenCollector.target)).to.equal(0);
            expect(await raacToken.balanceOf(feeCollector.target)).to.equal(0);
            
            expect(await raacToken.totalSupply()).to.equal(ethers.parseEther("1000"));

            // User 1 sends RAAC to user 2
            await raacToken.connect(user1).transfer(user2.address, ethers.parseEther("100"));

            expect(await raacToken.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
            expect(await raacToken.balanceOf(user2.address)).to.equal(ethers.parseEther("100"));

            // fee collector still has no balance
            expect(await raacToken.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("0"));

            expect(await raacToken.totalSupply()).to.equal(ethers.parseEther("1000"));
        });

        it('should ensure grant role to fee manager', async function () {
            // We grand feeManager the FEE_MANAGER_ROLE and ensure it has the role
            await raacTokenCollector.connect(owner).grantRole(await raacTokenCollector.FEE_MANAGER_ROLE(), feeManager.address);
            expect(await raacTokenCollector.hasRole(await raacTokenCollector.FEE_MANAGER_ROLE(), feeManager.address)).to.equal(true);

            // Fee Manager (e.g: governance) can switch to a fee collector (e.g: new fee collector from governance)
            const feeCollector2 = await FeeCollector.deploy(owner.address);

            // We set a new fee collector
            await raacTokenCollector.connect(feeManager).setFeeCollector(feeCollector2.target);
            expect(await raacTokenCollector.feeCollector()).to.equal(feeCollector2.target);

        });

        it('should not allow rescue tokens', async function () {
            const CRVUSDFactory = await ethers.getContractFactory("crvUSDToken");
            const crvusd = await CRVUSDFactory.deploy(owner.address);
            await crvusd.waitForDeployment();
            await crvusd.setMinter(owner.address);
            await crvusd.mint(user1.address, ethers.parseEther("1000"));

            await crvusd.connect(user1).transfer(raacTokenCollector.target, ethers.parseEther("100"));

            // non-fee manager cannot rescue tokens
            await expect(raacTokenCollector.connect(user1).rescueToken(crvusd.target, user1.address, ethers.parseEther("100"))).to.be.revertedWithCustomError(raacTokenCollector, "AccessControlUnauthorizedAccount");

            // fee manager can rescue tokens
            await raacTokenCollector.connect(feeManager).rescueToken(crvusd.target, user1.address, ethers.parseEther("100"));
            expect(await crvusd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
        });

    });
});