import hre from "hardhat";
const { ethers } = hre;

export default async function deployIndexTokenWithMock(lendingPool) {
    let erc20Token, erc20TokenAdapter, erc20PriceOracle;
  
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    erc20Token = await ERC20Mock.deploy("RWA Vault Token", "RWAToken", 18);
  
    const MockERC20PriceOracle = await ethers.getContractFactory("MockERC20PriceOracle");
    erc20PriceOracle = await MockERC20PriceOracle.deploy();
  
    await erc20PriceOracle.setLatestPrice(ethers.parseEther("1"));
  
    const ERC20Adapter = await ethers.getContractFactory("ERC20AssetAdapter");
    erc20TokenAdapter = await ERC20Adapter.deploy(erc20Token.target, erc20PriceOracle.target, lendingPool.target)
  
    return {
        erc20Token,
        erc20TokenAdapter,
        erc20PriceOracle,
    };
  }
  