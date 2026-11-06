import {expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;


describe("RAACHousePriceOracle (MockedTest)", function () {
    let deployer, address2, testOracle, mockOracle, mockRouter, housePrices, crvUSDToUSDOracle, raacNFT, crvUSD, complianceRegistry;

    const HOUSES = {
      HOUSE_1: {
        ID: 1,
        PRICE: 130000
      },
      HOUSE_2: {
        ID: 2,
        PRICE: 250000
      },
      HOUSE_3: {
        ID: 3,
        PRICE: 370000
      },
      HOUSE_4: {
        ID: 4,
        PRICE: 490000
      },
      HOUSE_5: {
        ID: 5,
        PRICE: 600000
      }
    };

    const HOUSES_FULFILEMENT_ORDER = [
      HOUSES.HOUSE_5,
      HOUSES.HOUSE_3,
      HOUSES.HOUSE_4,
      HOUSES.HOUSE_1,
      HOUSES.HOUSE_2,
    ];

    beforeEach(async function () {
        [deployer, address2] = await ethers.getSigners();
        const donId = ethers.encodeBytes32String("1");

        const crvUSDToken = await ethers.getContractFactory("crvUSDToken");
        crvUSD = await crvUSDToken.deploy(deployer.address);
        await crvUSD.waitForDeployment();

        const CrvUSDToUSDOracle = await ethers.getContractFactory("CrvUSDToUSDOracle");
        crvUSDToUSDOracle = await CrvUSDToUSDOracle.deploy(deployer.address, 0);

        const ComplianceRegistry = await ethers.getContractFactory("ComplianceRegistry");
        complianceRegistry = await ComplianceRegistry.deploy();
        await complianceRegistry.waitForDeployment();

        // Deploy house prices contract;
        const HousePrices = await ethers.getContractFactory("RAACHousePrices");
        housePrices = await HousePrices.deploy(crvUSDToUSDOracle.target, deployer.address);
        await housePrices.waitForDeployment();

        const RAACNFT = await ethers.getContractFactory("RAACNFT");
        raacNFT = await RAACNFT.deploy(crvUSD.target, housePrices.target, complianceRegistry.target, deployer.address);
        await raacNFT.waitForDeployment();

        // Deploy mock functions router
        const MockRouter = await ethers.getContractFactory("MockFunctionsRouter");
        mockRouter = await MockRouter.deploy();
        await mockRouter.waitForDeployment();

        // Deploy test RAACHousePriceOracle
        const RAACHousePriceOracle = await ethers.getContractFactory("TestRAACHousePriceOracle");
        testOracle = await RAACHousePriceOracle.deploy(
          await mockRouter.getAddress(), 
          donId, 
          "console.log('hello world'); return 129999.99;", 
          1, 
          "0x", 
          1, 
          200000, 
          await housePrices.getAddress(), 
          await raacNFT.getAddress()
        );
        console.log(await raacNFT.getAddress())
        await testOracle.waitForDeployment();

        // Deploy mock 1 DON Oracle
        const MockOracle = await ethers.getContractFactory("MockOracle");
        mockOracle = await MockOracle.deploy(donId);
        await mockOracle.waitForDeployment();

        // Set the oracle address on the house price contract
        await housePrices.setOracle(await testOracle.getAddress());
    });

    it("Should revert an error if non-oracleOnly address tries to update price", async function () {
        // revert Unauthorized()
        await expect(housePrices.setHousePrice(1, 129999)).to.be.revertedWithCustomError(housePrices, "NotOracle");
    });

    it("Should revert if non-owner tries to set oracle", async function () {
        // use address2 to simulate non owner
        await expect(housePrices.connect(address2).setOracle(await testOracle.getAddress())).to.be.revertedWithCustomError(housePrices, "OwnableUnauthorizedAccount")
    });

    it("Should revert if non-owner tries to send request", async function () {
        await expect(testOracle.connect(address2).sendRequest(
            [],     // string[] args
            [],     // bytes[] bytesArgs
        )).to.be.revertedWith("Only callable by owner");
    });

    it("Should revert if no houseId is provided in args", async function () {
        await expect(testOracle.sendRequest(
            [],     // empty args - missing houseId
            [],     // bytes[] bytesArgs
        )).to.be.revertedWith("Request must have 3 arguments");
    });

    it("Should send a request and store the houseId mapped to requestId", async function () {
        // Call `sendRequest` with dummy values
        const tx = await testOracle.sendRequest(
            ["8453", raacNFT.target, "1"],  // string[] args - [chainId, contractAddress, houseId]
            [],     // bytes[] bytesArgs
        );
        
        const receipt = await tx.wait();
        
        // Check that s_lastRequestId is now non-zero
        const lastRequestId = await testOracle.s_lastRequestId();
        expect(lastRequestId).to.not.equal(
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        
        // Check that the requestToHouseId mapping contains the correct value
        const mappedHouseId = await testOracle.requestToHouseId(lastRequestId);
        expect(mappedHouseId).to.equal(1n);
        
        // Check for the event emission
        const events = receipt.logs.filter(log => 
            log.fragment && log.fragment.name === 'HousePriceRequestSent'
        );
        expect(events.length).to.be.greaterThan(0);
    });

    it("Should simulate fulfillment and update housePrice", async function () {
        // First price update
        const tx = await testOracle.sendRequest(
            ["8453", raacNFT.target, "1"],  // string[] args - [chainId, contractAddress, houseId]
            [],     // bytes[] bytesArgs
        );
        
        const receipt = await tx.wait();
        const firstRequestId = receipt.logs[0].args[0];
        const fakePrice1 = 129999; // the response is the house price
        const responseBytes1 = new ethers.AbiCoder().encode(["uint256"], [fakePrice1]);
    
        // Simulate the DON calling fulfillRequest for first request
        await mockOracle.fulfillRequest(
            await testOracle.getAddress(),
            firstRequestId,
            responseBytes1,
            "0x"
        );

        let [housePrice1, lastUpdateTimestamp1] = await housePrices.getLatestPrice(1);
        expect(housePrice1).to.equal(fakePrice1);
    });

    it("Should correctly handle multiple requests for different houses", async function () {
      // Store request IDs for each house
      const requestIds = {};

      // Send requests for each house (in order)
      for (const house of Object.values(HOUSES)) {
        console.log(`Sending request for house ${house.ID} with price ${house.PRICE}`);
        
        // Send request for this house
        const tx = await testOracle.sendRequest(
            ["8453", raacNFT.target, house.ID.toString()],  // string[] args - [chainId, contractAddress, houseId]
            [],     // bytes[] bytesArgs
        );
        
        const receipt = await tx.wait();
        const s_requestIdFromReceipt = receipt.logs[0].args[0];
        const requestId = s_requestIdFromReceipt.toString();
        requestIds[house.ID] = requestId;
        
        // Verify requestId is correctly mapped to houseId
        const mappedHouseId = await testOracle.requestToHouseId(requestId);
        console.log(`Mapped house ID for request ${requestId}: ${mappedHouseId}`);
        expect(mappedHouseId).to.equal(BigInt(house.ID));
      }

      console.log("All requests sent. Starting to fulfill in unordered order...");
      
      // Save current value to check later
      const initialHouseData = {};
      for (const house of Object.values(HOUSES)) {
        const [price, timestamp] = await housePrices.getLatestPrice(house.ID);
        initialHouseData[house.ID] = { price, timestamp };
      }

      // Fulfill requests in reverse order
      for (const house of HOUSES_FULFILEMENT_ORDER.reverse()) {
        const requestId = requestIds[house.ID];
        const responseBytes = new ethers.AbiCoder().encode(["uint256"], [house.PRICE]);

        // Fulfill this request
        const fulfillTx = await mockOracle.fulfillRequest(
          await testOracle.getAddress(),
          requestId,
          responseBytes,
          "0x"
        );
        await fulfillTx.wait();
        
        // Verify the price was updated correctly
        const [price, timestamp] = await housePrices.getLatestPrice(house.ID);
        console.log(`After fulfillment: house ${house.ID} price is ${price} and timestamp is ${timestamp}`);
        expect(price).to.equal(house.PRICE);
      }
      
      // Final verification that all house prices are correct
      for (const house of Object.values(HOUSES)) {
        const [price, timestamp] = await housePrices.getLatestPrice(house.ID);
        expect(price).to.equal(house.PRICE);
      }
    });
});