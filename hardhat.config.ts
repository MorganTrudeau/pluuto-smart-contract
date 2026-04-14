import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const { PRIVATE_KEY, SEPOLIA_RPC_URL, BASE_RPC_URL, ETHERSCAN_API_KEY } = process.env;

// Validate private key format (must be 64 hex chars, optionally prefixed with 0x)
const isValidPrivateKey = (key: string | undefined): boolean => {
  if (!key) return false;
  const cleanKey = key.startsWith('0x') ? key.slice(2) : key;
  return cleanKey.length === 64 && /^[0-9a-fA-F]+$/.test(cleanKey);
};

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/YOUR_KEY",
      accounts: isValidPrivateKey(PRIVATE_KEY) ? [PRIVATE_KEY!] : []
    },
    base: {
      url: BASE_RPC_URL || "https://mainnet.base.org",
      accounts: isValidPrivateKey(PRIVATE_KEY) ? [PRIVATE_KEY!] : []
    }
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: false
  }
};

export default config;
