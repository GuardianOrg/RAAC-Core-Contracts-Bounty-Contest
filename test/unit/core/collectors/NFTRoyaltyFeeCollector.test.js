import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("NFTRoyaltyFeeCollector", function () {
    let mockWETH, feeCollector, nftRoyaltyFeeCollector, crvusd
    let owner, user1, user2
    const ROYALTY_FEE = ethers.keccak256(ethers.toUtf8Bytes("ROYALTY_FEE"));


    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();
        
        const FeeCollector = await ethers.getContractFactory("FeeCollector");
        feeCollector = await FeeCollector.deploy(owner.address);

        const MockWETH = await ethers.getContractFactory("MockWETH");
        mockWETH = await MockWETH.deploy();

        const NFTRoyaltyFeeCollector = await ethers.getContractFactory("NFTRoyaltyFeeCollector");
        nftRoyaltyFeeCollector = await NFTRoyaltyFeeCollector.deploy(mockWETH.target, feeCollector.target);

        const crvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvusd = await crvUSDToken.deploy(owner.address);
        await crvusd.setMinter(owner.address); 

        await feeCollector.addFeeType(ROYALTY_FEE, 2500, 5000, 2500, 0, 0, 0);
        await feeCollector.addClaimableToken(crvusd.target);
        await feeCollector.addClaimableToken(mockWETH.target)
    });

    it("ERC20: should allow transfer of token and then collect the token", async function() {
        await crvusd.mint(user1.address, ethers.parseEther("100"))
        await crvusd.connect(user1).approve(nftRoyaltyFeeCollector.target, ethers.parseEther("100"))
        await crvusd.connect(user1).transfer(nftRoyaltyFeeCollector.target, ethers.parseEther("100"));

        expect(await crvusd.balanceOf(nftRoyaltyFeeCollector.target)).to.equal(ethers.parseEther("100"))

        await nftRoyaltyFeeCollector.distributeCollectedFees(crvusd.target);

        expect(await crvusd.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("100"));
    })

    it("ETH: should allow transfer of token and then collect the token", async function() {
        await owner.sendTransaction({
            to: nftRoyaltyFeeCollector.target,
            value: ethers.parseEther("100"),
        });

        expect(await ethers.provider.getBalance(nftRoyaltyFeeCollector.target)).to.equal(ethers.parseEther("100"));

        await nftRoyaltyFeeCollector.distributeCollectedFees(ethers.ZeroAddress);

        expect(await mockWETH.balanceOf(feeCollector.target)).to.equal(ethers.parseEther("100"));
    })

    it("ERC20: should allow transfer of token and then emergency withdraw the funds", async function() {
        await crvusd.mint(user1.address, ethers.parseEther("100"))
        await crvusd.connect(user1).approve(nftRoyaltyFeeCollector.target, ethers.parseEther("100"))
        await crvusd.connect(user1).transfer(nftRoyaltyFeeCollector.target, ethers.parseEther("100"));

        expect(await crvusd.balanceOf(nftRoyaltyFeeCollector.target)).to.equal(ethers.parseEther("100"))

        await nftRoyaltyFeeCollector.emergencyWithdraw(crvusd.target, user2.address);

        expect(await crvusd.balanceOf(user2.address)).to.equal(ethers.parseEther("100"));
    })

    it("ETH: should allow transfer of token and then emergency withdraw the funds", async function() {
        await owner.sendTransaction({
            to: nftRoyaltyFeeCollector.target,
            value: ethers.parseEther("100"),
        });
        const user2BalanceBefore = await ethers.provider.getBalance(user2.address)
        expect(await ethers.provider.getBalance(nftRoyaltyFeeCollector.target)).to.equal(ethers.parseEther("100"));
        await nftRoyaltyFeeCollector.emergencyWithdraw(ethers.ZeroAddress, user2.address);
        const user2BalanceAfter = await ethers.provider.getBalance(user2.address);
        expect(user2BalanceAfter - user2BalanceBefore).to.equal(ethers.parseEther("100"));
    })
});