import { expect } from "chai";
import { ethers } from "hardhat";
import { AppMarketplaceToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AppMarketplaceToken", function () {
  let contract: AppMarketplaceToken;
  let owner: HardhatEthersSigner;
  let developer1: HardhatEthersSigner;
  let developer2: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  
  const MARKETPLACE_FEE = 750; // 7.5%
  const CONTRACT_NAME = "AppMarketplace";
  const CONTRACT_SYMBOL = "APP";

  // Helper function to generate repoFingerprint from a commit hash string
  function generateRepoFingerprint(commitHash: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(commitHash));
  }

  // Helper function to generate repoFingerprint from a unique ID
  function generateFingerprintFromId(id: number): string {
    return ethers.keccak256(ethers.toUtf8Bytes(`commit-${id}`));
  }

  beforeEach(async function () {
    [owner, developer1, developer2, buyer, feeRecipient] = await ethers.getSigners();

    const AppMarketplaceTokenFactory = await ethers.getContractFactory("AppMarketplaceToken");
    contract = await AppMarketplaceTokenFactory.deploy(
      CONTRACT_NAME,
      CONTRACT_SYMBOL,
      MARKETPLACE_FEE,
      feeRecipient.address
    ) as unknown as AppMarketplaceToken;
    await contract.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      expect(await contract.name()).to.equal(CONTRACT_NAME);
      expect(await contract.symbol()).to.equal(CONTRACT_SYMBOL);
    });

    it("Should set the correct marketplace fee", async function () {
      expect(await contract.marketplaceFeeBps()).to.equal(MARKETPLACE_FEE);
    });

    it("Should set the correct fee recipient", async function () {
      expect(await contract.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("Should set the correct owner", async function () {
      expect(await contract.owner()).to.equal(owner.address);
    });

    it("Should reject deployment with fee exceeding MAX_FEE_BPS", async function () {
      const AppMarketplaceTokenFactory = await ethers.getContractFactory("AppMarketplaceToken");
      await expect(
        AppMarketplaceTokenFactory.deploy(
          CONTRACT_NAME,
          CONTRACT_SYMBOL,
          2001, // Exceeds MAX_FEE_BPS (2000)
          feeRecipient.address
        )
      ).to.be.revertedWith("Fee exceeds maximum");
    });
  });

  describe("Minting (mintAppToken)", function () {
    it("Should mint an app token with correct metadata", async function () {
      const repoFingerprint = generateRepoFingerprint("abc123def456");
      const metadataURI = "ipfs://QmExample123";

      const tx = await contract.mintAppToken(
        developer1.address,
        repoFingerprint,
        metadataURI
      );

      // Check events
      await expect(tx)
        .to.emit(contract, "AppCreated")
        .withArgs(1, 1, developer1.address, repoFingerprint);
      
      await expect(tx)
        .to.emit(contract, "AppMinted")
        .withArgs(1, 1, developer1.address);

      // Check app data
      const app = await contract.getApp(1);
      expect(app.appId).to.equal(1);
      expect(app.tokenId).to.equal(1);
      expect(app.developer).to.equal(developer1.address);
      expect(app.repoFingerprint).to.equal(repoFingerprint);
      expect(app.metadataURI).to.equal(metadataURI);

      // Check NFT ownership
      expect(await contract.ownerOf(1)).to.equal(developer1.address);
      expect(await contract.tokenURI(1)).to.equal(metadataURI);
    });

    it("Should increment appId and tokenId for multiple mints", async function () {
      const fingerprint1 = generateFingerprintFromId(1);
      const fingerprint2 = generateFingerprintFromId(2);

      await contract.mintAppToken(developer1.address, fingerprint1, "ipfs://app1");
      await contract.mintAppToken(developer2.address, fingerprint2, "ipfs://app2");

      const app1 = await contract.getApp(1);
      const app2 = await contract.getApp(2);

      expect(app1.appId).to.equal(1);
      expect(app1.tokenId).to.equal(1);
      expect(app2.appId).to.equal(2);
      expect(app2.tokenId).to.equal(2);
    });

    it("Should reject minting with duplicate repoFingerprint", async function () {
      const repoFingerprint = generateRepoFingerprint("duplicate-commit");

      await contract.mintAppToken(
        developer1.address,
        repoFingerprint,
        "ipfs://app1"
      );

      await expect(
        contract.mintAppToken(developer2.address, repoFingerprint, "ipfs://app2")
      ).to.be.revertedWith("Repo fingerprint already used");
    });

    it("Should reject minting with zero address", async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      
      await expect(
        contract.mintAppToken(
          ethers.ZeroAddress,
          repoFingerprint,
          "ipfs://app1"
        )
      ).to.be.revertedWith("Invalid developer address");
    });

    it("Should reject minting with zero fingerprint", async function () {
      await expect(
        contract.mintAppToken(
          developer1.address,
          ethers.ZeroHash,
          "ipfs://app1"
        )
      ).to.be.revertedWith("Invalid repo fingerprint");
    });

    it("Should only allow owner to mint", async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      
      await expect(
        contract.connect(developer1).mintAppToken(
          developer1.address,
          repoFingerprint,
          "ipfs://app1"
        )
      ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
    });
  });

  describe("Listing (listForSale)", function () {
    let appId: number;
    let tokenId: number;

    beforeEach(async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      appId = 1;
      tokenId = 1;
    });

    it("Should list an app for sale", async function () {
      const price = ethers.parseEther("1.5");

      await expect(contract.connect(developer1).listForSale(appId, price))
        .to.emit(contract, "AppListed")
        .withArgs(appId, tokenId, developer1.address, price);

      const listing = await contract.getListing(appId);
      expect(listing.isListed).to.be.true;
      expect(listing.price).to.equal(price);
      expect(listing.owner_).to.equal(developer1.address);
    });

    it("Should reject listing by non-owner", async function () {
      const price = ethers.parseEther("1.0");
      
      await expect(
        contract.connect(buyer).listForSale(appId, price)
      ).to.be.revertedWith("Not the token owner");
    });

    it("Should reject listing with zero price", async function () {
      await expect(
        contract.connect(developer1).listForSale(appId, 0)
      ).to.be.revertedWith("Price must be greater than zero");
    });

    it("Should reject listing non-existent app", async function () {
      const price = ethers.parseEther("1.0");
      
      await expect(
        contract.connect(developer1).listForSale(999, price)
      ).to.be.revertedWith("App does not exist");
    });

    it("Should reject listing already listed app", async function () {
      const price = ethers.parseEther("1.0");
      
      await contract.connect(developer1).listForSale(appId, price);
      
      await expect(
        contract.connect(developer1).listForSale(appId, price)
      ).to.be.revertedWith("Already listed");
    });

    it("Should reject listing when paused", async function () {
      await contract.pause();
      const price = ethers.parseEther("1.0");
      
      await expect(
        contract.connect(developer1).listForSale(appId, price)
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");
    });
  });

  describe("Cancel Listing (cancelListing)", function () {
    let appId: number;

    beforeEach(async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      appId = 1;
      
      const price = ethers.parseEther("1.0");
      await contract.connect(developer1).listForSale(appId, price);
    });

    it("Should cancel a listing", async function () {
      await expect(contract.connect(developer1).cancelListing(appId))
        .to.emit(contract, "AppUnlisted")
        .withArgs(appId, 1, developer1.address);

      const listing = await contract.getListing(appId);
      expect(listing.isListed).to.be.false;
      expect(listing.price).to.equal(0);
    });

    it("Should reject cancelling by non-owner", async function () {
      await expect(
        contract.connect(buyer).cancelListing(appId)
      ).to.be.revertedWith("Not the token owner");
    });

    it("Should reject cancelling unlisted app", async function () {
      await contract.connect(developer1).cancelListing(appId);
      
      await expect(
        contract.connect(developer1).cancelListing(appId)
      ).to.be.revertedWith("Not listed");
    });
  });

  describe("Purchase (buy)", function () {
    let appId: number;
    let tokenId: number;
    let price: bigint;

    beforeEach(async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      appId = 1;
      tokenId = 1;
      price = ethers.parseEther("1.0");
      
      await contract.connect(developer1).listForSale(appId, price);
    });

    it("Should buy a listed app with correct fee distribution", async function () {
      const fee = (price * BigInt(MARKETPLACE_FEE)) / 10000n;
      const sellerAmount = price - fee;

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      const sellerBalanceBefore = await ethers.provider.getBalance(developer1.address);
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient.address);

      const tx = await contract.connect(buyer).buy(appId, { value: price });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      // Check event
      await expect(tx)
        .to.emit(contract, "AppSold")
        .withArgs(appId, tokenId, buyer.address, developer1.address, price, fee);

      await expect(tx)
        .to.emit(contract, "OwnershipChanged")
        .withArgs(appId, tokenId, developer1.address, buyer.address);

      // Check NFT ownership transferred
      expect(await contract.ownerOf(tokenId)).to.equal(buyer.address);

      // Check listing cleared
      const listing = await contract.getListing(appId);
      expect(listing.isListed).to.be.false;
      expect(listing.price).to.equal(0);

      // Check balances
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
      const sellerBalanceAfter = await ethers.provider.getBalance(developer1.address);
      const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient.address);

      expect(buyerBalanceAfter).to.equal(buyerBalanceBefore - price - gasUsed);
      expect(sellerBalanceAfter).to.equal(sellerBalanceBefore + sellerAmount);
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore + fee);
    });

    it("Should reject buying with incorrect payment", async function () {
      const incorrectPrice = ethers.parseEther("0.5");
      
      await expect(
        contract.connect(buyer).buy(appId, { value: incorrectPrice })
      ).to.be.revertedWith("Incorrect payment amount");
    });

    it("Should reject buying unlisted app", async function () {
      await contract.connect(developer1).cancelListing(appId);
      
      await expect(
        contract.connect(buyer).buy(appId, { value: price })
      ).to.be.revertedWith("App not listed for sale");
    });

    it("Should reject buying own app", async function () {
      await expect(
        contract.connect(developer1).buy(appId, { value: price })
      ).to.be.revertedWith("Cannot buy your own app");
    });

    it("Should reject buying when paused", async function () {
      await contract.pause();
      
      await expect(
        contract.connect(buyer).buy(appId, { value: price })
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");
    });

    it("Should handle zero fee correctly", async function () {
      // Set fee to 0
      await contract.setMarketplaceFeeBps(0);
      
      const sellerBalanceBefore = await ethers.provider.getBalance(developer1.address);
      
      await contract.connect(buyer).buy(appId, { value: price });
      
      const sellerBalanceAfter = await ethers.provider.getBalance(developer1.address);
      expect(sellerBalanceAfter).to.equal(sellerBalanceBefore + price);
    });
  });

  describe("Admin Functions", function () {
    describe("setMarketplaceFeeBps", function () {
      it("Should update marketplace fee", async function () {
        const newFee = 1000; // 10%
        
        await expect(contract.setMarketplaceFeeBps(newFee))
          .to.emit(contract, "MarketplaceFeeUpdated")
          .withArgs(newFee);

        expect(await contract.marketplaceFeeBps()).to.equal(newFee);
      });

      it("Should reject fee exceeding maximum", async function () {
        await expect(
          contract.setMarketplaceFeeBps(2001)
        ).to.be.revertedWith("Fee exceeds maximum");
      });

      it("Should only allow owner to update fee", async function () {
        await expect(
          contract.connect(developer1).setMarketplaceFeeBps(1000)
        ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
      });
    });

    describe("setFeeRecipient", function () {
      it("Should update fee recipient", async function () {
        const newRecipient = developer2.address;
        
        await expect(contract.setFeeRecipient(newRecipient))
          .to.emit(contract, "FeeRecipientUpdated")
          .withArgs(newRecipient);

        expect(await contract.feeRecipient()).to.equal(newRecipient);
      });

      it("Should reject zero address", async function () {
        await expect(
          contract.setFeeRecipient(ethers.ZeroAddress)
        ).to.be.revertedWith("Invalid recipient");
      });

      it("Should only allow owner to update recipient", async function () {
        await expect(
          contract.connect(developer1).setFeeRecipient(developer2.address)
        ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
      });
    });

    describe("updateMetadataURI", function () {
      let appId: number;

      beforeEach(async function () {
        const repoFingerprint = generateFingerprintFromId(1);
        await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
        appId = 1;
      });

      it("Should allow token owner to update metadata", async function () {
        const newURI = "ipfs://updated-metadata";
        
        await expect(contract.connect(developer1).updateMetadataURI(appId, newURI))
          .to.emit(contract, "MetadataURIUpdated")
          .withArgs(appId, newURI);

        const app = await contract.getApp(appId);
        expect(app.metadataURI).to.equal(newURI);
        expect(await contract.tokenURI(1)).to.equal(newURI);
      });

      it("Should allow contract owner to update metadata", async function () {
        const newURI = "ipfs://admin-updated";
        
        await expect(contract.connect(owner).updateMetadataURI(appId, newURI))
          .to.emit(contract, "MetadataURIUpdated")
          .withArgs(appId, newURI);

        const app = await contract.getApp(appId);
        expect(app.metadataURI).to.equal(newURI);
      });

      it("Should reject update by unauthorized user", async function () {
        await expect(
          contract.connect(buyer).updateMetadataURI(appId, "ipfs://hacker")
        ).to.be.revertedWith("Not authorized");
      });
    });

    describe("Pausable", function () {
      it("Should pause the contract", async function () {
        await contract.pause();
        expect(await contract.paused()).to.be.true;
      });

      it("Should unpause the contract", async function () {
        await contract.pause();
        await contract.unpause();
        expect(await contract.paused()).to.be.false;
      });

      it("Should only allow owner to pause", async function () {
        await expect(
          contract.connect(developer1).pause()
        ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
      });

      it("Should only allow owner to unpause", async function () {
        await contract.pause();
        await expect(
          contract.connect(developer1).unpause()
        ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("Transfer Hooks (OwnershipChanged)", function () {
    let appId: number;
    let tokenId: number;

    beforeEach(async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      appId = 1;
      tokenId = 1;
    });

    it("Should emit OwnershipChanged on direct transfer", async function () {
      await expect(
        contract.connect(developer1).transferFrom(developer1.address, buyer.address, tokenId)
      )
        .to.emit(contract, "OwnershipChanged")
        .withArgs(appId, tokenId, developer1.address, buyer.address);
    });

    it("Should clear listing on transfer", async function () {
      const price = ethers.parseEther("1.0");
      await contract.connect(developer1).listForSale(appId, price);

      // Transfer token
      await contract.connect(developer1).transferFrom(developer1.address, buyer.address, tokenId);

      // Check listing cleared
      const listing = await contract.getListing(appId);
      expect(listing.isListed).to.be.false;
      expect(listing.price).to.equal(0);
    });

    it("Should emit OwnershipChanged on safeTransferFrom", async function () {
      await expect(
        contract.connect(developer1)["safeTransferFrom(address,address,uint256)"](
          developer1.address,
          buyer.address,
          tokenId
        )
      )
        .to.emit(contract, "OwnershipChanged")
        .withArgs(appId, tokenId, developer1.address, buyer.address);
    });
  });

  describe("View Functions", function () {
    it("Should get app details", async function () {
      const repoFingerprint = generateRepoFingerprint("test-commit-hash");
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");

      const app = await contract.getApp(1);
      expect(app.appId).to.equal(1);
      expect(app.tokenId).to.equal(1);
      expect(app.developer).to.equal(developer1.address);
      expect(app.repoFingerprint).to.equal(repoFingerprint);
    });

    it("Should get appId from tokenId", async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");

      expect(await contract.getAppIdFromTokenId(1)).to.equal(1);
    });

    it("Should check if fingerprint is used", async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      
      expect(await contract.isFingerprintUsed(repoFingerprint)).to.be.false;
      
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      
      expect(await contract.isFingerprintUsed(repoFingerprint)).to.be.true;
    });

    it("Should get listing details", async function () {
      const repoFingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, repoFingerprint, "ipfs://app1");
      
      const price = ethers.parseEther("2.5");
      await contract.connect(developer1).listForSale(1, price);

      const listing = await contract.getListing(1);
      expect(listing.isListed).to.be.true;
      expect(listing.price).to.equal(price);
      expect(listing.owner_).to.equal(developer1.address);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle multiple apps and listings correctly", async function () {
      // Mint 3 apps
      for (let i = 1; i <= 3; i++) {
        const fingerprint = generateFingerprintFromId(i);
        await contract.mintAppToken(developer1.address, fingerprint, `ipfs://app${i}`);
      }

      // List apps 1 and 3
      await contract.connect(developer1).listForSale(1, ethers.parseEther("1.0"));
      await contract.connect(developer1).listForSale(3, ethers.parseEther("3.0"));

      // Check listings
      const listing1 = await contract.getListing(1);
      const listing2 = await contract.getListing(2);
      const listing3 = await contract.getListing(3);

      expect(listing1.isListed).to.be.true;
      expect(listing2.isListed).to.be.false;
      expect(listing3.isListed).to.be.true;
    });

    it("Should handle re-listing after cancellation", async function () {
      const fingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, fingerprint, "ipfs://app1");

      // List, cancel, re-list
      await contract.connect(developer1).listForSale(1, ethers.parseEther("1.0"));
      await contract.connect(developer1).cancelListing(1);
      await contract.connect(developer1).listForSale(1, ethers.parseEther("2.0"));

      const listing = await contract.getListing(1);
      expect(listing.isListed).to.be.true;
      expect(listing.price).to.equal(ethers.parseEther("2.0"));
    });

    it("Should handle ownership transfer and re-listing by new owner", async function () {
      const fingerprint = generateFingerprintFromId(1);
      await contract.mintAppToken(developer1.address, fingerprint, "ipfs://app1");

      // Transfer to developer2
      await contract.connect(developer1).transferFrom(
        developer1.address,
        developer2.address,
        1
      );

      // New owner lists
      await contract.connect(developer2).listForSale(1, ethers.parseEther("5.0"));

      const listing = await contract.getListing(1);
      expect(listing.isListed).to.be.true;
      expect(listing.owner_).to.equal(developer2.address);
    });
  });
});
