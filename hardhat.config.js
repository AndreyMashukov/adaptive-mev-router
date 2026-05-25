require("@nomicfoundation/hardhat-toolbox");
require("@tovarishfin/hardhat-yul");

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : 24596300;

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
        blockNumber: FORK_BLOCK,
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
