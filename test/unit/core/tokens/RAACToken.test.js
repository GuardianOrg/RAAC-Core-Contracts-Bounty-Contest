import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;


describe("RAACToken", () => {
    let raacToken;
    let treasury;
    let owner;
    let users;

    beforeEach(async () => {
        // Get signers
        [owner, ...users] = await ethers.getSigners();

        // Deploy core contracts
        const RAACToken = await ethers.getContractFactory("RAACToken", owner);
        raacToken = await RAACToken.deploy(
            owner.address    // initial owner
        );

        const Treasury = await ethers.getContractFactory("Treasury", owner);
        treasury = await Treasury.deploy(owner.address);

        // Set owner as minter
        await raacToken.setMinter(owner.address);
    });

    describe("Balance and Supply", () => {
        it("should correctly calculate and distribute balances and supply", async () => {
            const transferAmount = BigInt("1000000000000000000000"); // 1000 tokens
            // Track balances before transfer
            const initialSupply = await raacToken.totalSupply();
            expect(initialSupply).to.equal(0n);
            // Mint tokens to first user (using owner who is now minter)
            await raacToken.mint(users[0].address, transferAmount);

            const supplyAfterMint = await raacToken.totalSupply();
            expect(supplyAfterMint).to.equal(transferAmount);
            expect(await raacToken.totalSupply()).to.equal(transferAmount);

            // Perform transfer
            await raacToken.connect(users[0]).transfer(users[1].address, transferAmount);

            // Verify recipient received correct amount
            const expectedRecipientAmount = transferAmount;
            expect(await raacToken.balanceOf(users[1].address))
                .to.equal(expectedRecipientAmount);
        });
    });
});