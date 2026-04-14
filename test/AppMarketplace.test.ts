import { expect } from "chai";
import { ethers } from "hardhat";
import { AppMarketplace, AppToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AppMarketplace", function () {
  let marketplace: AppMarketplace;
  let appToken: AppToken;
  let owner: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let platformAddr: HardhatEthersSigner;

  const MARKETPLACE_FEE_BPS = 750; // 7.5%
  const MINT_FEE = ethers.parseEther("0.028");
  const MARKETPLACE_NAME = "AppMarketplace";
  const MARKETPLACE_VERSION = "1";

  function generateFingerprint(seed: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  async function signOrder(order: any, signer: HardhatEthersSigner) {
    const domain = {
      name: MARKETPLACE_NAME,
      version: MARKETPLACE_VERSION,
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await marketplace.getAddress(),
    };

    const types = {
      Order: [
        { name: "seller", type: "address" },
        { name: "tokenAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "price", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "assetHash", type: "bytes32" },
      ],
    };

    return signer.signTypedData(domain, types, order);
  }

  async function mintAndApprove(dev: HardhatEthersSigner, seed: string): Promise<bigint> {
    const fp = generateFingerprint(seed);
    const tx = await appToken.connect(dev).mintAppToken(fp, `ipfs://${seed}`, { value: MINT_FEE });
    const receipt = await tx.wait();
    const event = receipt!.logs.find(
      (log) => appToken.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "AppCreated"
    );
    const parsed = appToken.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
    const tokenId = parsed!.args.appId;

    await appToken.connect(dev).approve(await marketplace.getAddress(), tokenId);
    return tokenId;
  }

  beforeEach(async function () {
    [owner, seller, buyer, feeRecipient, platformAddr] = await ethers.getSigners();

    const AppTokenFactory = await ethers.getContractFactory("AppToken");
    appToken = (await AppTokenFactory.deploy(
      "AppToken",
      "APP",
      MINT_FEE,
      feeRecipient.address
    )) as unknown as AppToken;
    await appToken.waitForDeployment();

    const AppMarketplaceFactory = await ethers.getContractFactory("AppMarketplace");
    marketplace = (await AppMarketplaceFactory.deploy(
      MARKETPLACE_NAME,
      MARKETPLACE_VERSION,
      MARKETPLACE_FEE_BPS,
      feeRecipient.address,
      platformAddr.address
    )) as unknown as AppMarketplace;
    await marketplace.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set correct marketplace fee", async function () {
      expect(await marketplace.marketplaceFeeBps()).to.equal(MARKETPLACE_FEE_BPS);
    });

    it("Should set correct fee recipient", async function () {
      expect(await marketplace.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("Should set correct platform address", async function () {
      expect(await marketplace.platformAddress()).to.equal(platformAddr.address);
    });

    it("Should reject fee exceeding maximum", async function () {
      const AppMarketplaceFactory = await ethers.getContractFactory("AppMarketplace");
      await expect(
        AppMarketplaceFactory.deploy(MARKETPLACE_NAME, MARKETPLACE_VERSION, 2001, feeRecipient.address, platformAddr.address)
      ).to.be.revertedWith("Fee exceeds maximum");
    });

    it("Should reject zero fee recipient", async function () {
      const AppMarketplaceFactory = await ethers.getContractFactory("AppMarketplace");
      await expect(
        AppMarketplaceFactory.deploy(MARKETPLACE_NAME, MARKETPLACE_VERSION, 750, ethers.ZeroAddress, platformAddr.address)
      ).to.be.revertedWith("Invalid fee recipient");
    });

    it("Should reject zero platform address", async function () {
      const AppMarketplaceFactory = await ethers.getContractFactory("AppMarketplace");
      await expect(
        AppMarketplaceFactory.deploy(MARKETPLACE_NAME, MARKETPLACE_VERSION, 750, feeRecipient.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid platform address");
    });
  });

  describe("Execute Order", function () {
    it("Should execute a valid signed order into escrow", async function () {
      const tokenId = await mintAndApprove(seller, "order-1");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-1"),
      };

      const signature = await signOrder(order, seller);

      await expect(
        marketplace.connect(buyer).executeOrder(order, signature, { value: price })
      ).to.emit(marketplace, "OrderPurchasedToEscrow");

      // Token held by marketplace
      expect(await appToken.ownerOf(tokenId)).to.equal(await marketplace.getAddress());

      // Escrow record created
      const orderHash = await marketplace.getOrderHash(order);
      const escrow = await marketplace.getEscrow(orderHash);
      expect(escrow.buyer).to.equal(buyer.address);
      expect(escrow.seller).to.equal(seller.address);
      expect(escrow.amount).to.equal(price);
      expect(escrow.status).to.equal(1); // PENDING
    });

    it("Should reject incorrect payment", async function () {
      const tokenId = await mintAndApprove(seller, "order-bad-pay");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-bad-pay"),
      };

      const signature = await signOrder(order, seller);

      await expect(
        marketplace.connect(buyer).executeOrder(order, signature, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("Incorrect payment");
    });

    it("Should reject seller buying own order", async function () {
      const tokenId = await mintAndApprove(seller, "order-self");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-self"),
      };

      const signature = await signOrder(order, seller);

      await expect(
        marketplace.connect(seller).executeOrder(order, signature, { value: price })
      ).to.be.revertedWith("Cannot buy own order");
    });

    it("Should reject expired order", async function () {
      const tokenId = await mintAndApprove(seller, "order-expired");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 1, // already expired
        nonce: 0,
        assetHash: generateFingerprint("asset-expired"),
      };

      const signature = await signOrder(order, seller);

      await expect(
        marketplace.connect(buyer).executeOrder(order, signature, { value: price })
      ).to.be.revertedWith("Order expired");
    });

    it("Should reject cancelled order", async function () {
      const tokenId = await mintAndApprove(seller, "order-cancel");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-cancel"),
      };

      await marketplace.connect(seller).cancelOrder(order);

      const signature = await signOrder(order, seller);

      await expect(
        marketplace.connect(buyer).executeOrder(order, signature, { value: price })
      ).to.be.revertedWith("Order cancelled");
    });

    it("Should reject invalid signature", async function () {
      const tokenId = await mintAndApprove(seller, "order-badsig");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-badsig"),
      };

      // Sign with buyer instead of seller
      const signature = await signOrder(order, buyer);

      await expect(
        marketplace.connect(buyer).executeOrder(order, signature, { value: price })
      ).to.be.revertedWith("Invalid signature");
    });
  });

  describe("Release Escrow", function () {
    let orderHash: string;
    let price: bigint;

    beforeEach(async function () {
      const tokenId = await mintAndApprove(seller, "release-test");
      price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-release"),
      };

      const signature = await signOrder(order, seller);
      await marketplace.connect(buyer).executeOrder(order, signature, { value: price });
      orderHash = await marketplace.getOrderHash(order);
    });

    it("Should allow platform to release escrow", async function () {
      const sellerBalBefore = await ethers.provider.getBalance(seller.address);
      const feeBalBefore = await ethers.provider.getBalance(feeRecipient.address);

      await expect(
        marketplace.connect(platformAddr).releaseEscrow(orderHash)
      ).to.emit(marketplace, "EscrowReleased");

      const expectedFee = (price * BigInt(MARKETPLACE_FEE_BPS)) / 10_000n;
      const expectedSellerAmount = price - expectedFee;

      const sellerBalAfter = await ethers.provider.getBalance(seller.address);
      const feeBalAfter = await ethers.provider.getBalance(feeRecipient.address);

      expect(sellerBalAfter - sellerBalBefore).to.equal(expectedSellerAmount);
      expect(feeBalAfter - feeBalBefore).to.equal(expectedFee);
    });

    it("Should allow buyer to release escrow", async function () {
      await expect(
        marketplace.connect(buyer).releaseEscrow(orderHash)
      ).to.emit(marketplace, "EscrowReleased");
    });

    it("Should transfer token to buyer on release", async function () {
      const escrow = await marketplace.getEscrow(orderHash);
      await marketplace.connect(platformAddr).releaseEscrow(orderHash);
      expect(await appToken.ownerOf(escrow.tokenId)).to.equal(buyer.address);
    });

    it("Should reject release by unauthorized caller", async function () {
      await expect(
        marketplace.connect(seller).releaseEscrow(orderHash)
      ).to.be.revertedWith("Only platform or buyer");
    });

    it("Should reject release of non-pending escrow", async function () {
      await marketplace.connect(platformAddr).releaseEscrow(orderHash);
      await expect(
        marketplace.connect(platformAddr).releaseEscrow(orderHash)
      ).to.be.revertedWith("Not pending");
    });
  });

  describe("Refund Escrow", function () {
    let orderHash: string;
    let price: bigint;

    beforeEach(async function () {
      const tokenId = await mintAndApprove(seller, "refund-test");
      price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-refund"),
      };

      const signature = await signOrder(order, seller);
      await marketplace.connect(buyer).executeOrder(order, signature, { value: price });
      orderHash = await marketplace.getOrderHash(order);
    });

    it("Should refund buyer and return token to seller", async function () {
      const buyerBalBefore = await ethers.provider.getBalance(buyer.address);
      const escrow = await marketplace.getEscrow(orderHash);

      const tx = await marketplace.connect(buyer).refundEscrow(orderHash);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const buyerBalAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerBalAfter - buyerBalBefore + gasUsed).to.equal(price);

      expect(await appToken.ownerOf(escrow.tokenId)).to.equal(seller.address);
    });

    it("Should allow platform to refund", async function () {
      await expect(
        marketplace.connect(platformAddr).refundEscrow(orderHash)
      ).to.emit(marketplace, "EscrowRefunded");
    });

    it("Should reject refund by unauthorized caller", async function () {
      await expect(
        marketplace.connect(seller).refundEscrow(orderHash)
      ).to.be.revertedWith("Only platform or buyer");
    });
  });

  describe("Cancel Orders", function () {
    it("Should cancel a specific order", async function () {
      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: 1,
        price: ethers.parseEther("1.0"),
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("cancel-specific"),
      };

      await expect(
        marketplace.connect(seller).cancelOrder(order)
      ).to.emit(marketplace, "OrderCancelled");

      const orderHash = await marketplace.getOrderHash(order);
      expect(await marketplace.cancelled(orderHash)).to.be.true;
    });

    it("Should reject cancel by non-seller", async function () {
      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: 1,
        price: ethers.parseEther("1.0"),
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("cancel-unauth"),
      };

      await expect(
        marketplace.connect(buyer).cancelOrder(order)
      ).to.be.revertedWith("Only seller");
    });

    it("Should cancel all orders via nonce bump", async function () {
      await expect(
        marketplace.connect(seller).cancelAllOrders(100)
      ).to.emit(marketplace, "AllOrdersCancelled").withArgs(seller.address, 100);

      expect(await marketplace.minNonce(seller.address)).to.equal(100);
    });

    it("Should reject nonce that doesn't increase", async function () {
      await marketplace.connect(seller).cancelAllOrders(100);
      await expect(
        marketplace.connect(seller).cancelAllOrders(50)
      ).to.be.revertedWith("Nonce must increase");
    });
  });

  describe("Order Status", function () {
    it("Should return OPEN for valid unfilled order", async function () {
      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: 1,
        price: ethers.parseEther("1.0"),
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("status-open"),
      };

      expect(await marketplace.getOrderStatus(order)).to.equal("OPEN");
    });

    it("Should return CANCELLED for cancelled order", async function () {
      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: 1,
        price: ethers.parseEther("1.0"),
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("status-cancel"),
      };

      await marketplace.connect(seller).cancelOrder(order);
      expect(await marketplace.getOrderStatus(order)).to.equal("CANCELLED");
    });

    it("Should return ESCROWED for filled pending order", async function () {
      const tokenId = await mintAndApprove(seller, "status-escrow");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-status-escrow"),
      };

      const signature = await signOrder(order, seller);
      await marketplace.connect(buyer).executeOrder(order, signature, { value: price });

      expect(await marketplace.getOrderStatus(order)).to.equal("ESCROWED");
    });

    it("Should return COMPLETED for released escrow", async function () {
      const tokenId = await mintAndApprove(seller, "status-complete");
      const price = ethers.parseEther("1.0");

      const order = {
        seller: seller.address,
        tokenAddress: await appToken.getAddress(),
        tokenId: tokenId,
        price: price,
        expiry: 0,
        nonce: 0,
        assetHash: generateFingerprint("asset-status-complete"),
      };

      const signature = await signOrder(order, seller);
      await marketplace.connect(buyer).executeOrder(order, signature, { value: price });

      const orderHash = await marketplace.getOrderHash(order);
      await marketplace.connect(platformAddr).releaseEscrow(orderHash);

      expect(await marketplace.getOrderStatus(order)).to.equal("COMPLETED");
    });
  });

  describe("Admin", function () {
    it("Should update marketplace fee", async function () {
      await expect(marketplace.setMarketplaceFeeBps(500))
        .to.emit(marketplace, "MarketplaceFeeUpdated")
        .withArgs(500);
      expect(await marketplace.marketplaceFeeBps()).to.equal(500);
    });

    it("Should reject fee exceeding max", async function () {
      await expect(
        marketplace.setMarketplaceFeeBps(2001)
      ).to.be.revertedWith("Fee exceeds max");
    });

    it("Should update fee recipient", async function () {
      await expect(marketplace.setFeeRecipient(buyer.address))
        .to.emit(marketplace, "FeeRecipientUpdated")
        .withArgs(buyer.address);
    });

    it("Should update platform address", async function () {
      await expect(marketplace.setPlatformAddress(buyer.address))
        .to.emit(marketplace, "PlatformAddressUpdated")
        .withArgs(buyer.address);
    });

    it("Should reject non-owner admin calls", async function () {
      await expect(
        marketplace.connect(buyer).setMarketplaceFeeBps(100)
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
    });
  });
});
