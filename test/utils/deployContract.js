async function deployContract(name, args = []) {
    try {
        const Factory = await ethers.getContractFactory(name);
        const contract = await Factory.deploy(...args);
        await contract.waitForDeployment();
        return contract;
    } catch (error) {
        console.error(`Error deploying ${name}:`, error);
        throw error;
    }
}

export default deployContract;