import hre from "hardhat";
const { ethers } = hre;

export default function encodeERC721Token(tokenID) {
    return new ethers.AbiCoder().encode(["uint256"], [tokenID])
}