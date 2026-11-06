import hre from "hardhat";
const { ethers } = hre;

export default async function deployVRFConsumerWithMock(rwaVaultAddress) {
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