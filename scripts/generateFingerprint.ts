import { ethers } from "hardhat";

async function main() {
  // Generate repoFingerprint examples
  console.log("\n=== RepoFingerprint Examples for Remix ===\n");
  
  const example1 = ethers.keccak256(ethers.toUtf8Bytes("my-app-commit-hash-123"));
  console.log("Example 1:");
  console.log(example1);
  
  const example2 = ethers.keccak256(ethers.toUtf8Bytes("abc123def456"));
  console.log("\nExample 2:");
  console.log(example2);
  
  const example3 = ethers.id("test-app-v1.0.0");
  console.log("\nExample 3:");
  console.log(example3);
  
  console.log("\n=== Copy any of these values to use in Remix ===\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
