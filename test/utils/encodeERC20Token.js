import hre from "hardhat";
const { ethers } = hre;

export default function encodeERC20Token(amount) {
    return new ethers.AbiCoder().encode(["uint256"], [amount]);
}