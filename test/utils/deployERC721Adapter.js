export default async function deployERC721Adapter(erc721Collateral, erc721Oracle, lendingPool) {
    const ERC721Adapter = await ethers.getContractFactory("ERC721AssetAdapter");
    const erc721Adapter = await ERC721Adapter.deploy(erc721Collateral, erc721Oracle, lendingPool);
    return erc721Adapter;
}
