import { ethers } from "hardhat";

async function main() {
  const name = process.env.CONTRACT_NAME || "MorganNFT";
  const symbol = process.env.CONTRACT_SYMBOL || "MORG";
  const platformFeePercentage = process.env.PLATFORM_FEE_PERCENTAGE || "250"; // Default 2.5%
  const platformFeeRecipient = process.env.PLATFORM_FEE_RECIPIENT;

  if (!platformFeeRecipient) {
    throw new Error("PLATFORM_FEE_RECIPIENT must be set in .env");
  }

  const MyERC721 = await ethers.getContractFactory("AppMarketplaceToken");
  console.log(`Deploying ${name} (${symbol})...`);
  console.log(`Platform Fee: ${parseInt(platformFeePercentage) / 100}%`);
  console.log(`Fee Recipient: ${platformFeeRecipient}`);
  
  const contract = await MyERC721.deploy(
    name,
    symbol,
    platformFeePercentage,
    platformFeeRecipient
  );
  await contract.deploymentTransaction()?.wait(1);

  console.log("Deployed to:", contract.target ?? contract.address);
  console.log("\nVerify with:");
  console.log(`npx hardhat verify --network <network> ${contract.target ?? contract.address} "${name}" "${symbol}" ${platformFeePercentage} ${platformFeeRecipient}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
