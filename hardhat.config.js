require("@nomicfoundation/hardhat-toolbox");
require("@tovarishfin/hardhat-yul");

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
// FORK_BLOCK is opt-in: fork at HEAD by default so a non-archive public RPC works.
// Pool reserves and balances are overridden in tests via hardhat_setStorageAt, so the
// specific block doesn't matter — pin one only when you need byte-for-byte replay.
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined;

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      hardfork: "cancun",
      forking: process.env.HARDHAT_FORK ? {
        url: MAINNET_RPC_URL,
        ...(FORK_BLOCK !== undefined ? { blockNumber: FORK_BLOCK } : {}),
      } : undefined,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: process.env.GAS_REPORT_FILE ? true : false,
  },
};
