import { config as dotEnvConfig } from "dotenv";
import { toBigInt } from "ethers";
import hre from "hardhat";
const { network } = hre;

dotEnvConfig();

// eslint-disable-next-line camelcase
export async function request_fork(blockNumber, accounts) {

  if (!process.env.HARDHAT_FORK_URL) {
    throw new Error(
      "HARDHAT_FORK_URL is not set: this suite forks mainnet. Set it in .env locally, " +
      "or map the repository secret in the workflow's `env:` block for CI."
    );
  }
  await network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: process.env.HARDHAT_FORK_URL,
          blockNumber: blockNumber,
        },
      },
    ],
  });
  for (const address of accounts) {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [address],
    });
  }
}

export async function mockETHBalance(account, amount) {
  await network.provider.send("hardhat_setBalance", [account, "0x" + toBigInt(amount).toString(16)]);
}
