

import deployContract from "./deployContract.js";

export default async function deployCRV(owner) {
    const crvUSD = await deployContract('crvUSDToken',[owner.address]);
    await crvUSD.setMinter(owner.address);

    return crvUSD;
}