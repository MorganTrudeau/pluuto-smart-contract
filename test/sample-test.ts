import { expect } from "chai";
import { ethers } from "hardhat";

describe("MyERC721 Marketplace", function () {
  let contract: any;
  let owner: any;
  let seller: any;
  let buyer: any;
  let feeRecipient: any;
  const PLATFORM_FEE = 250; // 2.5%

  beforeEach(async function () {
    [owner, seller, buyer, feeRecipient] = await ethers.getSigners();

    const MyERC721 = await ethers.getContractFactory("MyERC721");
    contract = await MyERC721.deploy("TestNFT", "TNFT", PLATFORM_FEE, feeRecipient.address);
    await contract.deploymentTransaction()?.wait(1);
  });

  describe("Minting", function () {
    it("should mint an NFT and emit Minted event", async function () {
      await expect(contract.connect(seller).mint(seller.address, "ipfs://example-uri"))
        .to.emit(contract, "Minted")
        .withArgs(1, seller.address, "ipfs://example-uri");

      expect(await contract.ownerOf(1)).to.equal(seller.address);
      expect(await contract.tokenURI(1)).to.equal("ipfs://example-uri");
    });
  });

  describe("Listing", function () {
    beforeEach(async function () {
      await contract.connect(seller).mint(seller.address, "ipfs://token1");
    });

    it("should list an NFT for sale", async function () {
      const price = ethers.parseEther("1.0");
      
      await expect(contract.connect(seller).listNFT(1, price))
        .to.emit(contract, "Listed")
        .withArgs(1, seller.address, price);

      const listing = await contract.getListing(1);
      expect(listing.price).to.equal(price);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.isActive).to.be.true;
    });

    it("should not allow non-owners to list", async function () {
      const price = ethers.parseEther("1.0");
      await expect(contract.connect(buyer).listNFT(1, price))
        .to.be.revertedWith("Not the owner");
    });

    it("should cancel a listing", async function () {
      const price = ethers.parseEther("1.0");
      await contract.connect(seller).listNFT(1, price);
      
      await expect(contract.connect(seller).cancelListing(1))
        .to.emit(contract, "ListingCancelled")
        .withArgs(1, seller.address);

      const listing = await contract.getListing(1);
      expect(listing.isActive).to.be.false;
    });
  });

  describe("Buying", function () {
    const listingPrice = ethers.parseEther("1.0");

    beforeEach(async function () {
      await contract.connect(seller).mint(seller.address, "ipfs://token1");
      await contract.connect(seller).listNFT(1, listingPrice);
    });

    it("should allow buying a listed NFT with correct payment", async function () {
      const platformFee = (listingPrice * BigInt(PLATFORM_FEE)) / BigInt(10000);
      const sellerProceeds = listingPrice - platformFee;

      const initialSellerBalance = await ethers.provider.getBalance(seller.address);
      const initialFeeRecipientBalance = await ethers.provider.getBalance(feeRecipient.address);

      await expect(contract.connect(buyer).buyNFT(1, { value: listingPrice }))
        .to.emit(contract, "Bought")
        .withArgs(1, buyer.address, seller.address, listingPrice, platformFee);

      expect(await contract.ownerOf(1)).to.equal(buyer.address);

      const listing = await contract.getListing(1);
      expect(listing.isActive).to.be.false;

      const finalSellerBalance = await ethers.provider.getBalance(seller.address);
      const finalFeeRecipientBalance = await ethers.provider.getBalance(feeRecipient.address);

      expect(finalSellerBalance - initialSellerBalance).to.equal(sellerProceeds);
      expect(finalFeeRecipientBalance - initialFeeRecipientBalance).to.equal(platformFee);
    });

    it("should refund excess payment", async function () {
      const overpayment = ethers.parseEther("2.0");
      const initialBuyerBalance = await ethers.provider.getBalance(buyer.address);

      const tx = await contract.connect(buyer).buyNFT(1, { value: overpayment });
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const finalBuyerBalance = await ethers.provider.getBalance(buyer.address);
      const expectedBalance = initialBuyerBalance - listingPrice - gasUsed;

      expect(finalBuyerBalance).to.equal(expectedBalance);
    });

    it("should not allow buying with insufficient payment", async function () {
      const insufficientPayment = ethers.parseEther("0.5");
      await expect(contract.connect(buyer).buyNFT(1, { value: insufficientPayment }))
        .to.be.revertedWith("Insufficient payment");
    });

    it("should not allow buying unlisted NFT", async function () {
      await contract.connect(seller).mint(seller.address, "ipfs://token2");
      await expect(contract.connect(buyer).buyNFT(2, { value: listingPrice }))
        .to.be.revertedWith("Not listed for sale");
    });
  });

  describe("Platform Fee Management", function () {
    it("should update platform fee percentage", async function () {
      const newFee = 500; // 5%
      await expect(contract.connect(owner).setPlatformFeePercentage(newFee))
        .to.emit(contract, "PlatformFeeUpdated")
        .withArgs(newFee);

      expect(await contract.platformFeePercentage()).to.equal(newFee);
    });

    it("should not allow fee > 100%", async function () {
      await expect(contract.connect(owner).setPlatformFeePercentage(10001))
        .to.be.revertedWith("Fee cannot exceed 100%");
    });

    it("should update platform fee recipient", async function () {
      const newRecipient = buyer.address;
      await expect(contract.connect(owner).setPlatformFeeRecipient(newRecipient))
        .to.emit(contract, "PlatformFeeRecipientUpdated")
        .withArgs(newRecipient);

      expect(await contract.platformFeeRecipient()).to.equal(newRecipient);
    });
  });
});
