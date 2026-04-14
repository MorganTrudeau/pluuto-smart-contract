import dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// Load environment-specific .env file based on --network flag
const network = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : undefined;

if (network === "base") {
  dotenv.config({ path: ".env.base" });
} else if (network === "sepolia") {
  dotenv.config({ path: ".env.sepolia" });
} else {
  dotenv.config(); // fallback to .env for local/hardhat
}

const { PRIVATE_KEY, RPC_URL, ETHERSCAN_API_KEY } = process.env;

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
      url: RPC_URL || "https://sepolia.infura.io/v3/YOUR_KEY",
      accounts: isValidPrivateKey(PRIVATE_KEY) ? [PRIVATE_KEY!] : []
    },
    base: {
      url: RPC_URL || "https://mainnet.base.org",
      accounts: isValidPrivateKey(PRIVATE_KEY) ? [PRIVATE_KEY!] : []
    }
  },
  etherscan: {
    apiKey: {
      base: ETHERSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  sourcify: {
    enabled: false
  }
};

export default config;
