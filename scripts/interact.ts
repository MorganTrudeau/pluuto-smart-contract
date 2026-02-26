import { ethers } from "hardhat";

/**
 * Example script showing how to interact with the deployed marketplace contract
 * 
 * Usage:
 *   1. Set CONTRACT_ADDRESS in your .env
 *   2. Run: npx hardhat run --network sepolia scripts/interact.ts
 */

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  
  if (!contractAddress) {
    throw new Error("Please set CONTRACT_ADDRESS in your .env file");
  }

  const [signer] = await ethers.getSigners();
  console.log("Interacting with account:", signer.address);

  // Attach to deployed contract
  const MyERC721 = await ethers.getContractFactory("MyERC721");
  const contract = MyERC721.attach(contractAddress);

  console.log("\n=== Contract Info ===");
  console.log("Contract address:", contractAddress);
  console.log("Name:", await contract.name());
  console.log("Symbol:", await contract.symbol());
  console.log("Platform fee:", (await contract.platformFeePercentage()).toString(), "basis points");
  console.log("Fee recipient:", await contract.platformFeeRecipient());

  // Example: Mint an NFT
  console.log("\n=== Minting NFT ===");
  const mintTx = await contract.mint(
    signer.address,
    "ipfs://QmExample123/metadata.json"
  );
  const mintReceipt = await mintTx.wait();
  const mintEvent = mintReceipt.logs.find((log: any) => {
    try {
      return contract.interface.parseLog(log)?.name === 'Minted';
    } catch {
      return false;
    }
  });
  
  if (mintEvent) {
    const parsed = contract.interface.parseLog(mintEvent);
    const tokenId = parsed?.args[0];
    console.log("Minted token ID:", tokenId.toString());

    // Example: List the NFT
    console.log("\n=== Listing NFT ===");
    const listPrice = ethers.parseEther("0.1"); // 0.1 ETH
    const listTx = await contract.listNFT(tokenId, listPrice);
    await listTx.wait();
    console.log("Listed token", tokenId.toString(), "for", ethers.formatEther(listPrice), "ETH");

    // Check listing
    const listing = await contract.getListing(tokenId);
    console.log("Listing details:");
    console.log("  Price:", ethers.formatEther(listing.price), "ETH");
    console.log("  Seller:", listing.seller);
    console.log("  Active:", listing.isActive);

    // Example: Cancel listing (uncomment to test)
    // console.log("\n=== Canceling Listing ===");
    // const cancelTx = await contract.cancelListing(tokenId);
    // await cancelTx.wait();
    // console.log("Listing cancelled for token", tokenId.toString());
  }

  console.log("\n=== Complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
