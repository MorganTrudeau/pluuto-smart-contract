import { ethers } from "hardhat";

async function main() {
  const name = process.env.CONTRACT_NAME || "MorganNFT";
  const symbol = process.env.CONTRACT_SYMBOL || "MORG";
  const platformFeePercentage = process.env.PLATFORM_FEE_PERCENTAGE || "250";
  const mintFee = process.env.MINT_FEE || "28000000000000000";
  const platformFeeRecipient = process.env.PLATFORM_FEE_RECIPIENT;
  const platformAddress = process.env.PLATFORM_ADDRESS;

  if (!platformFeeRecipient) {
    throw new Error("PLATFORM_FEE_RECIPIENT must be set in .env");
  }
  if (!platformAddress) {
    throw new Error("PLATFORM_ADDRESS must be set in .env");
  }

  // Deploy AppToken
  const AppTokenFactory = await ethers.getContractFactory("AppToken");
  console.log(`Deploying AppToken (${name} / ${symbol})...`);
  console.log(`Mint Fee: ${mintFee} wei`);
  console.log(`Fee Recipient: ${platformFeeRecipient}`);

  const appToken = await AppTokenFactory.deploy(
    name,
    symbol,
    mintFee,
    platformFeeRecipient
  );
  await appToken.deploymentTransaction()?.wait(1);

  const appTokenAddress = appToken.target ?? appToken.address;
  console.log("AppToken deployed to:", appTokenAddress);

  // Deploy AppMarketplace
  const marketplaceName = "AppMarketplace";
  const marketplaceVersion = "1";

  const AppMarketplaceFactory = await ethers.getContractFactory("AppMarketplace");
  console.log(`\nDeploying AppMarketplace...`);
  console.log(`Platform Fee: ${parseInt(platformFeePercentage) / 100}%`);
  console.log(`Fee Recipient: ${platformFeeRecipient}`);
  console.log(`Platform Address: ${platformAddress}`);

  const appMarketplace = await AppMarketplaceFactory.deploy(
    marketplaceName,
    marketplaceVersion,
    platformFeePercentage,
    platformFeeRecipient,
    platformAddress
  );
  await appMarketplace.deploymentTransaction()?.wait(1);

  const appMarketplaceAddress = appMarketplace.target ?? appMarketplace.address;
  console.log("AppMarketplace deployed to:", appMarketplaceAddress);

  console.log("\n--- Deployment Summary ---");
  console.log("AppToken:", appTokenAddress);
  console.log("AppMarketplace:", appMarketplaceAddress);

  console.log("\nVerify AppToken with:");
  console.log(`npx hardhat verify --network <network> ${appTokenAddress} "${name}" "${symbol}" ${mintFee} ${platformFeeRecipient}`);

  console.log("\nVerify AppMarketplace with:");
  console.log(`npx hardhat verify --network <network> ${appMarketplaceAddress} "${marketplaceName}" "${marketplaceVersion}" ${platformFeePercentage} ${platformFeeRecipient} ${platformAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
