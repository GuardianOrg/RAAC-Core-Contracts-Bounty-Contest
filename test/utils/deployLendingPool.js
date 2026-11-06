import hre from "hardhat";
const { ethers } = hre;

const RAY = ethers.parseUnits("1", 27);

import deployContract from "./deployContract.js";

function isNullOrUndefined(value) {
    return value === undefined || value === null;
}

// Deploy lending pool with no supported assets
async function deployLendingPool(
  owner,
  feeCollector,
  _supplyAsset,
  _rToken,
  _debtToken,
  _liquidationProxy,
  _vaultProxy,
  _complianceRegistry,
  _initialPrimeRate
) {
    if(isNullOrUndefined(_supplyAsset)) {
        console.info("Supply asset not provided, deploying crvUSDToken");
    }
    const supplyAsset = _supplyAsset ?? await deployContract("crvUSDToken", [owner.address]);
    
    const complianceRegistry = _complianceRegistry ?? await deployContract("ComplianceRegistry", []);


    const rToken = _rToken ?? await deployContract("RToken", ['RToken', 'RToken', owner.address, supplyAsset.target, complianceRegistry.target]);
    const debtToken = _debtToken ?? await deployContract("DebtToken", ['DebtToken', 'DT', owner.address, supplyAsset.target]);
    const liquidationProxy = _liquidationProxy ?? await deployContract("LiquidationProxy", []);
    const vaultProxy = _vaultProxy ?? await deployContract("VaultProxy", []);
    const initialPrimeRate = _initialPrimeRate ?? ethers.parseUnits("0.1", 27);

    const LendingPoolFeeLibrary = await ethers.getContractFactory("LendingPoolFeeLibrary");
    const lendingPoolFeeLibrary = await LendingPoolFeeLibrary.deploy();
    const LendingPool = await ethers.getContractFactory("LendingPool", {
        libraries: {
            LendingPoolFeeLibrary: lendingPoolFeeLibrary.target
        }
    });

    const lendingPool = await LendingPool.deploy(
        supplyAsset.target,
        rToken.target,
        debtToken.target,
        liquidationProxy.target,
        vaultProxy.target,
        complianceRegistry.target,
        initialPrimeRate,
        owner.address,
    );

    /**
     *   address _reserveAssetAddress,
        address _rTokenAddress,
        address _debtTokenAddress,
        address _liquidationProxyAddress,
        address _vaultProxy,
        address _complianceRegistry,
        uint256 _initialPrimeRate,
        address _admin
     */

    await rToken.setLendingPool(lendingPool.target);
    await debtToken.setLendingPool(lendingPool.target);
    await lendingPool.setParameter(8, ethers.parseEther("10000000")); // supply cap
    await lendingPool.setParameter(9, ethers.parseEther("10000000")); // borrow cap

    await rToken.transferOwnership(lendingPool.target);
    await debtToken.transferOwnership(lendingPool.target);

    return {
        lendingPool,
        supplyAsset,
        rToken,
        debtToken,
        liquidationProxy,
        vaultProxy,
        complianceRegistry,
        initialPrimeRate,
    };
}
export default deployLendingPool;