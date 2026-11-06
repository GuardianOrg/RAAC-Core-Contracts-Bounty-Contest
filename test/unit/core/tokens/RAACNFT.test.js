import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

describe("RAACNFT", () => {
    let raacNFT;
    let crvUSD;
    let crvUSDToUSDOracle;
    let housePrices;
    let owner;
    let user1;
    let user2;
    let user3;
    let feeCollector;
    const INITIAL_BATCH_SIZE = 3n;
    const HOUSE_PRICE = ethers.parseEther("100");
    const TOKEN_ID = 1;
    let complianceRegistry;

    const MINT_FEE = ethers.keccak256(ethers.toUtf8Bytes("MINT_FEE"));

    beforeEach(async () => {
        [owner, user1, user2, user3] = await ethers.getSigners();

        const CrvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvUSD = await CrvUSDToken.deploy(owner.address);
        await crvUSD.setMinter(owner.address);

        const FeeCollector = await ethers.getContractFactory("FeeCollector")
        feeCollector = await FeeCollector.deploy(owner.address);
        await feeCollector.addFeeType(MINT_FEE, 20_00, 0, 80_00, 0, 0, 0);
        await feeCollector.addClaimableToken(crvUSD.target)

        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(owner.address, 0);

        const HousePrices = await ethers.getContractFactory("RAACHousePrices");
        housePrices = await HousePrices.deploy(crvUSDToUSDOracle.target, owner.address);
        await housePrices.setOracle(owner.address);

        await housePrices.setHousePrice(TOKEN_ID, HOUSE_PRICE);
        await housePrices.setHousePrice(TOKEN_ID + 1, HOUSE_PRICE);

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry")
        complianceRegistry = await ComplianceRegistry.deploy()
        
        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(
            crvUSD.target,
            housePrices.target,
            complianceRegistry.target,
            owner.address
        );

        await crvUSD.mint(user1.address, ethers.parseEther("1000"));
        await crvUSD.mint(user2.address, ethers.parseEther("1000"));
    });

    describe("Initialization", () => {
        const newBaseURI = "ipfs://squawk7700/";

        it("should initialize with correct values", async () => {
            expect(await raacNFT.token()).to.equal(await crvUSD.getAddress());
            expect(await raacNFT.raac_hp()).to.equal(await housePrices.getAddress());
            expect(await raacNFT.owner()).to.equal(owner.address);
        });

        it("should revert with zero addresses", async () => {
            const RAACNFT = await ethers.getContractFactory("RAACNFT");
            await expect(
                RAACNFT.deploy(ethers.ZeroAddress, await housePrices.getAddress(), complianceRegistry.target, owner.address)
            ).to.be.revertedWithCustomError(RAACNFT, "InvalidAddress");

            await expect(
                RAACNFT.deploy(await crvUSD.getAddress(), ethers.ZeroAddress, complianceRegistry.target, owner.address)
            ).to.be.revertedWithCustomError(RAACNFT, "InvalidAddress");

            await expect(
                RAACNFT.deploy(await crvUSD.getAddress(), await housePrices.getAddress(), complianceRegistry.target, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(RAACNFT, "OwnableInvalidOwner");
        });
        it("should return correct house price", async () => {
            const price = await raacNFT.getHousePrice(TOKEN_ID);
            expect(price).to.equal(HOUSE_PRICE);
        });

        it("should update base URI successfully", async () => {
            await raacNFT.connect(owner).setBaseUri(newBaseURI);
            expect(await raacNFT.baseURI()).to.equal(newBaseURI);
        });

        it("should return correct token URI for a specific token", async () => {
            await raacNFT.connect(owner).minterMint(user1.address, TOKEN_ID);
            const tokenURI = await raacNFT.tokenURI(TOKEN_ID);
            expect(tokenURI).to.equal("ipfs://QmZzEbTnUWs5JDzrLKQ9yGk1kvszdnwdMaVw9vNgjCFLo2/1");
            expect(tokenURI).to.equal(await raacNFT.baseURI() + TOKEN_ID);

            const nonExistentTokenId = 999;
            await expect(raacNFT.tokenURI(nonExistentTokenId))
            .to.be.revertedWithCustomError(raacNFT, "ERC721NonexistentToken")
            .withArgs(nonExistentTokenId);
        });

        it("should revert when non-owner tries to update base URI", async () => {
            await expect(
                raacNFT.connect(user1).setBaseUri(newBaseURI)
            ).to.be.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount");
        });
    });

    describe("Minting", () => {
        beforeEach(async () => {
            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
        });

        it("should mint NFT successfully", async () => {
            await expect(raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE))
                .to.emit(raacNFT, "NFTMinted")
                .withArgs(user1.address, TOKEN_ID, HOUSE_PRICE, 0);

            await expect(raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE))
            .to.be.revertedWithCustomError(raacNFT, "ERC721InvalidSender");

            expect(await raacNFT.ownerOf(TOKEN_ID)).to.equal(user1.address);
            expect(await crvUSD.balanceOf(raacNFT.getAddress())).to.equal(HOUSE_PRICE);
        });

        it("should refund excess payment", async () => {
            const excessAmount = ethers.parseEther("2");
            const initialBalance = await crvUSD.balanceOf(user1.address);

            const payAmount = HOUSE_PRICE + excessAmount;

            await raacNFT.connect(user1).mint(TOKEN_ID, payAmount);

            const finalBalance = await crvUSD.balanceOf(user1.address);
            expect(await raacNFT.MINT_FEE_PERCENTAGE()).to.equal(0);

            const expectedRefund = payAmount - HOUSE_PRICE;
            expect(finalBalance).to.equal(initialBalance - payAmount + expectedRefund);
            // expect(initialBalance - finalBalance).to.equal(expectedRefund);
        });

        it("should revert with insufficient funds", async () => {
            const insufficientAmount = HOUSE_PRICE - ethers.parseEther("1");
            await expect(
                raacNFT.connect(user1).mint(TOKEN_ID, insufficientAmount)
            ).to.be.revertedWithCustomError(raacNFT, "InsufficientFundsMint");
        });

        it("should revert with invalid house price", async () => {
            await housePrices.setHousePrice(TOKEN_ID, 0);
            await expect(
                raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE)
            ).to.be.revertedWithCustomError(raacNFT, "HousePriceZero");
        });

        it("should track total supply correctly", async () => {
            const initialSupply = await raacNFT.totalSupply();
            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
            expect(await raacNFT.totalSupply()).to.equal(initialSupply + 1n);
        });

        it("should allow owner to withdraw funds from sale", async () => {
            const initialOwnerBalance = await crvUSD.balanceOf(owner.address);
            expect(initialOwnerBalance).to.equal(0);
            const initialNFTBalance = await crvUSD.balanceOf(raacNFT.getAddress());
            expect(initialNFTBalance).to.equal(0);

            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);

            const postMintOwnerBalance = await crvUSD.balanceOf(owner.address);
            const postMintNFTBalance = await crvUSD.balanceOf(raacNFT.getAddress());

            expect(postMintOwnerBalance).to.equal(0);
            expect(postMintNFTBalance).to.equal(HOUSE_PRICE);
            
            await raacNFT.connect(owner).withdrawUnderlying(await crvUSD.getAddress(), owner.address, HOUSE_PRICE);
            expect(await crvUSD.balanceOf(raacNFT.getAddress())).to.equal(0);
            expect(await crvUSD.balanceOf(owner.address)).to.equal(initialOwnerBalance + HOUSE_PRICE);

            await expect(raacNFT.connect(user1).withdrawUnderlying(await crvUSD.getAddress(), owner.address, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount");
        });

        it("should revert if the house price is pending", async () => {
            const donId = ethers.encodeBytes32String("1");
            // Deploy mock functions router
            const MockRouter = await ethers.getContractFactory("MockFunctionsRouter");
            const mockRouter = await MockRouter.deploy();
            await mockRouter.waitForDeployment();

            // Deploy test RAACHousePriceOracle
            const RAACHousePriceOracle = await ethers.getContractFactory("TestRAACHousePriceOracle");
            const testOracle = await RAACHousePriceOracle.deploy(await mockRouter.getAddress(), donId, "return 100000000000000000000", 1, "0x", 1, 200000, await housePrices.getAddress(), raacNFT.target);
            await testOracle.waitForDeployment();

            // Deploy mock 1 DON Oracle
            const MockDONOracle = await ethers.getContractFactory("MockOracle");
            const mockDONOracle = await MockDONOracle.deploy(donId);
            await mockDONOracle.waitForDeployment();

            // Set the oracle address on the house price contract
            await housePrices.setOracle(await testOracle.getAddress());

            await testOracle.sendRequest(
                ["8453", raacNFT.target, "5"],
                []
            );

            const lastRequestId = await testOracle.s_lastRequestId();

            const mappedHouseId = await testOracle.requestToHouseId(lastRequestId);
            expect(mappedHouseId).to.equal(5);
            const pendingRequest = await testOracle.isPendingRequest(5);
            expect(pendingRequest).to.equal(true);

            // Try minting a house
            await expect(raacNFT.connect(user1).mint(5, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "HousePricePending");
            
            // Fulfill the request
            const fakePrice1 = ethers.parseEther("100"); // the response is the house price
            const responseBytes1 = new ethers.AbiCoder().encode(["uint256"], [fakePrice1]);
    
            // Simulate the DON calling fulfillRequest for first request
            await mockDONOracle.fulfillRequest(
                await testOracle.getAddress(),
                lastRequestId,
                responseBytes1,
                "0x"
            );

            const pendingRequest2 = await testOracle.isPendingRequest(5);
            expect(pendingRequest2).to.equal(false);

            // Try minting again
            await raacNFT.connect(user1).mint(5, HOUSE_PRICE);
            expect(await raacNFT.ownerOf(5)).to.equal(user1.address);
            expect(await crvUSD.balanceOf(raacNFT.getAddress())).to.equal(fakePrice1);
        })
    });
    describe('Enumerable', ()=>{
         it("should allow to enumerate NFTs", async () => {
            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));

            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_ID + 1, HOUSE_PRICE);
            
            await housePrices.setHousePrice(TOKEN_ID + 10, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(TOKEN_ID + 10, HOUSE_PRICE);

            await housePrices.setHousePrice(TOKEN_ID + 7700, HOUSE_PRICE);
            await crvUSD.connect(user2).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await raacNFT.connect(user2).mint(TOKEN_ID + 7700, HOUSE_PRICE);

            expect(await raacNFT.totalSupply()).to.equal(4);

            // Get from enumerable
            expect(await raacNFT.getTokensByOwner(user1.address)).to.deep.equal([TOKEN_ID, TOKEN_ID + 1, TOKEN_ID + 10]);
            expect(await raacNFT.getAllTokens()).to.deep.equal([TOKEN_ID, TOKEN_ID + 1, TOKEN_ID + 10, TOKEN_ID + 7700]);

            expect(await raacNFT.getAllTokens(0, 1)).to.to.deep.equal([TOKEN_ID]);
            expect(await raacNFT.getAllTokens(1, 2)).to.to.deep.equal([TOKEN_ID + 1]);
            expect(await raacNFT.getAllTokens(2, 3)).to.to.deep.equal([TOKEN_ID + 10]);
            expect(await raacNFT.getAllTokens(3, 4)).to.to.deep.equal([TOKEN_ID + 7700]);
            expect(await raacNFT.getAllTokens(1, 4)).to.to.deep.equal([TOKEN_ID + 1, TOKEN_ID + 10, TOKEN_ID + 7700]);

            expect(await raacNFT.getTokensByOwner(user2.address)).to.deep.equal([TOKEN_ID + 7700]);
        });
        it("should return empty if no tokens", async () => {
            expect(await raacNFT.getTokensByOwner(user1.address)).to.deep.equal([]);
            expect(await raacNFT.getAllTokens()).to.deep.equal([]);
        });
    })
   
    describe('Admin minting', ()=>{
        it('should allow admin to mint tokens', async () => {
            await raacNFT.connect(owner).minterMint(user1.address, TOKEN_ID);
            expect(await raacNFT.ownerOf(TOKEN_ID)).to.equal(user1.address);
        });
        it('should revert if non-admin tries to mint', async () => {
            await expect(raacNFT.connect(user1).minterMint(user1.address, TOKEN_ID)).to.be.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount");
        });
        it('should change the minter role', async () => {
            await raacNFT.connect(owner).transferRole(await raacNFT.MINTER_ROLE(), owner.address, user1.address);
            expect(await raacNFT.hasRole(await raacNFT.MINTER_ROLE(), user1.address)).to.equal(true);
            await expect(raacNFT.connect(owner).minterMint(user2.address, TOKEN_ID)).to.be.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount");
            await expect(raacNFT.connect(user1).minterMint(user2.address, TOKEN_ID)).to.emit(raacNFT, "Transfer").withArgs(ethers.ZeroAddress, user2.address, TOKEN_ID);
        });
    });
    describe('Allow for optional fees', ()=>{
        it('should allow for optional fees sent to feeCollector', async () => {
            // 2% fee
            await raacNFT.connect(owner).setMintFee(2_00);
            const absoluteFee = HOUSE_PRICE * 2_00n / 100_00n;
            await raacNFT.connect(owner).setFeeCollector(feeCollector.target);

            const initialUser1Balance = await crvUSD.balanceOf(user1.address);
            const initialNFTBalance = await crvUSD.balanceOf(raacNFT.getAddress());

            const getHousePrice = await raacNFT.getHousePrice(TOKEN_ID);
            expect(getHousePrice).to.equal(HOUSE_PRICE);

            const priceWithFee = await raacNFT.getMintPrice(TOKEN_ID);
            expect(priceWithFee).to.equal(HOUSE_PRICE + absoluteFee);

            await crvUSD.connect(user1).approve(raacNFT.getAddress(), priceWithFee);
            // This will reject with not enough funds
            await expect(raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "InsufficientFundsMint");

            await raacNFT.connect(user1).mint(TOKEN_ID, priceWithFee);

            const postMintUser1Balance = await crvUSD.balanceOf(user1.address);
            const postMintNFTBalance = await crvUSD.balanceOf(raacNFT.getAddress());
            const postMintFeeCollectorBalance = await crvUSD.balanceOf(feeCollector.target);

            expect(postMintUser1Balance).to.equal(initialUser1Balance - HOUSE_PRICE - absoluteFee);
            expect(postMintNFTBalance).to.equal(initialNFTBalance + HOUSE_PRICE);
            expect(postMintFeeCollectorBalance).to.equal(absoluteFee);

            // check that the split happened
            const feeCollectorSplit = await feeCollector.getCollectedFees(crvUSD.target, MINT_FEE);
            expect(feeCollectorSplit[0]).to.equal(absoluteFee * 20_00n / 100_00n)
            expect(feeCollectorSplit[2]).to.equal(absoluteFee * 80_00n / 100_00n)
        });
        it('should revert if max fee is exceeded', async () => {
            await raacNFT.connect(owner).setMaxFee(1_00);
            expect(await raacNFT.MAX_FEE_PERCENTAGE()).to.equal(1_00);
            await expect(raacNFT.connect(owner).setMintFee(1_01)).to.be.revertedWithCustomError(raacNFT, "ExceedsMaxFee");
            
            // Set back to 0 to disable max fee
            await raacNFT.connect(owner).setMaxFee(0);
            expect(await raacNFT.MAX_FEE_PERCENTAGE()).to.equal(0);
            await raacNFT.connect(owner).setMintFee(100000);
            expect(await raacNFT.MINT_FEE_PERCENTAGE()).to.equal(100000);
        });
        it('should revert if trade fee exceeds maximum', async () => {
            await expect(raacNFT.connect(owner).setTradeFee(100_00)).to.be.revertedWithCustomError(raacNFT, "ExceedsMaxFee");
        });
        it('should allow for optional trade fees', async () => {
            const initialFeeStructure = await raacNFT.getFeeStructure();
            expect(initialFeeStructure.mintFee).to.equal(0);
            expect(initialFeeStructure.tradeFee).to.equal(0);

            await raacNFT.connect(owner).setTradeFee(1_00);
            expect(await raacNFT.TRADE_FEE_PERCENTAGE()).to.equal(1_00);

            const NFTRoyaltyFeeCollector = await ethers.getContractFactory("NFTRoyaltyFeeCollector")
            const nftRoyaltyFeeCollector = await NFTRoyaltyFeeCollector.deploy(user1.address, feeCollector.target)

            await raacNFT.connect(owner).setNFTRoyaltyFeeCollector(nftRoyaltyFeeCollector.target);
            const tradeFee = await raacNFT.getFeeStructure();
            expect(tradeFee.mintFee).to.equal(0);
            expect(tradeFee.tradeFee).to.equal(1_00);

            const tradePrice = 100000000000000000000n;
            // 1% trade fee
            const expectedRoyaltyAmount = tradePrice * 1_00n / 100_00n;
            
            const royaltyInfo = await raacNFT.royaltyInfo(TOKEN_ID, tradePrice);
            expect(royaltyInfo.receiver).to.equal(nftRoyaltyFeeCollector.target);
            expect(royaltyInfo.royaltyAmount).to.equal(expectedRoyaltyAmount);
        });
    });
    describe('Burning', () => {
        beforeEach(async () => {
            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
        });

        it('should not allow owner to burn their token when enabled', async () => {
            await raacNFT.connect(owner).setAllowBurning(true);
            await expect(raacNFT.connect(user1).burn(TOKEN_ID, false))
                .to.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount")
        });

        it('should allow admin only to burn any token when enabled', async () => {
            await raacNFT.connect(owner).setAllowBurning(true);

            await expect(raacNFT.connect(owner).burn(TOKEN_ID, false))
                .to.emit(raacNFT, "Transfer")
                .withArgs(user1.address, ethers.ZeroAddress, TOKEN_ID);
            
            await expect(raacNFT.ownerOf(TOKEN_ID))
                .to.be.revertedWithCustomError(raacNFT, "ERC721NonexistentToken");
        });

        it('should not allow non-owner to burn any token', async () => {
            await raacNFT.connect(owner).setAllowBurning(true);
            await expect(raacNFT.connect(user2).burn(TOKEN_ID, false))
                .to.be.revertedWithCustomError(raacNFT, "AccessControlUnauthorizedAccount");
        });
        it("should not allow reminting after burning if flag is set", async () => {
            await raacNFT.connect(owner).setAllowBurning(true);
            await expect(raacNFT.connect(owner).burn(TOKEN_ID, true))
                .to.emit(raacNFT, "Transfer")
                .withArgs(user1.address, ethers.ZeroAddress, TOKEN_ID);

            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await expect(raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE)).to.revertedWithCustomError(raacNFT, "CannotRemint");
            await expect(raacNFT.connect(owner).minterMint(owner.address, TOKEN_ID)).to.revertedWithCustomError(raacNFT, "CannotRemint");

            // reset the flag
            await raacNFT.connect(owner).resetRemintFlag(TOKEN_ID);
            expect (raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE)).to.not.reverted;
        })
    });
    describe('Blacklist', ()=>{
        it('should not allow minting to blacklisted address', async () => {
            await complianceRegistry.blacklist(user1.address)
            await expect(raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "BlacklistedAddress");
        });
        it("should not allow transfer to blacklisted address", async () => {
            // user 1 owns nft and then blacklisted
            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
            await complianceRegistry.blacklist(user1.address)
            await expect(raacNFT.connect(user1).transferFrom(user1.address, user2.address, TOKEN_ID)).to.be.revertedWithCustomError(raacNFT, "BlacklistedAddress");

            // someone else cannot send nft to blacklisted user
            await crvUSD.connect(user2).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await raacNFT.connect(user2).mint(TOKEN_ID + 1, HOUSE_PRICE);
            await expect(raacNFT.connect(user2).transferFrom(user2.address, user1.address, TOKEN_ID + 1)).to.be.revertedWithCustomError(raacNFT, "BlacklistedAddress");
        });
        it("should transfer normally between non-blacklisted addresses", async () => {
            await crvUSD.connect(user1).approve(raacNFT.getAddress(), ethers.parseEther("1000"));
            await raacNFT.connect(user1).mint(TOKEN_ID, HOUSE_PRICE);
            await raacNFT.connect(user1).transferFrom(user1.address, user2.address, TOKEN_ID);
            expect(await raacNFT.ownerOf(TOKEN_ID)).to.equal(user2.address);

            await raacNFT.connect(user2).transferFrom(user2.address, user1.address, TOKEN_ID);
            expect(await raacNFT.ownerOf(TOKEN_ID)).to.equal(user1.address);
        });
    });
    describe.skip('Bomb minting', ()=>{
        // Will mint a LOT of tokens and test the enumerable
        // Our tests might work, but the RPC might not
        it('should bomb minting a lot of tokens', async () => {
            await crvUSD.mint(user3.address, ethers.parseEther("10000"));

            await crvUSD.connect(user3).approve(raacNFT.getAddress(), ethers.parseEther("1000"));

            for(let i = 0; i < 5000; i++){
                await housePrices.setHousePrice(i, ethers.parseEther('0.01'));
                await raacNFT.connect(user3).mint(i, ethers.parseEther('0.01'));
            }
            
            expect(await raacNFT.totalSupply()).to.equal(5000);
            
            expect(await raacNFT.getTokensByOwner(user3.address)).to.deep.equal(Array.from({length: 5000}, (_, i) => i));
            expect(await raacNFT.getAllTokens()).to.deep.equal(Array.from({length: 5000}, (_, i) => i));
            expect(await raacNFT.getAllTokens(0, 1)).to.to.deep.equal([0]);
            expect(await raacNFT.getAllTokens(1, 2)).to.to.deep.equal([1]);
            expect(await raacNFT.getAllTokens(4999, 5000)).to.to.deep.equal([4999]);
        });
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

            await raacNFT.connect(owner).setKYCVerifyModule(kycVerifyModule.target);
        })
        it("should allow minting if user is approved", async function() {
            await mockZKMEVerify.mockApprove(cooperatorAddress, user1.address, 1);

            await crvUSD.mint(user1.address, ethers.parseEther("1000"));
            await crvUSD.connect(user1).approve(raacNFT.target, HOUSE_PRICE);
            await raacNFT.connect(user1).mint(1, HOUSE_PRICE);

            expect(await raacNFT.ownerOf(1)).to.equal(user1.address);

            await expect(raacNFT.connect(user2).mint(2, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "KYCNotVerified");
        });
        it("should revert if user is not approved", async function() {
            await expect(raacNFT.connect(user1).mint(1, HOUSE_PRICE)).to.be.revertedWithCustomError(raacNFT, "KYCNotVerified");
        });
    })
}); 
