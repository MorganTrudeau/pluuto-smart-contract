import { expect } from "chai";
import { ethers } from "hardhat";
import { AppToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AppToken", function () {
  let appToken: AppToken;
  let owner: HardhatEthersSigner;
  let developer1: HardhatEthersSigner;
  let developer2: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const CONTRACT_NAME = "AppMarketplace";
  const CONTRACT_SYMBOL = "APP";
  const MINT_FEE = ethers.parseEther("0.028");

  function generateFingerprint(seed: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  beforeEach(async function () {
    [owner, developer1, developer2, feeRecipient] = await ethers.getSigners();

    const AppTokenFactory = await ethers.getContractFactory("AppToken");
    appToken = (await AppTokenFactory.deploy(
      CONTRACT_NAME,
      CONTRACT_SYMBOL,
      MINT_FEE,
      feeRecipient.address
    )) as unknown as AppToken;
    await appToken.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      expect(await appToken.name()).to.equal(CONTRACT_NAME);
      expect(await appToken.symbol()).to.equal(CONTRACT_SYMBOL);
    });

    it("Should set the correct mint fee", async function () {
      expect(await appToken.mintFee()).to.equal(MINT_FEE);
    });

    it("Should set the correct fee recipient", async function () {
      expect(await appToken.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("Should set the correct owner", async function () {
      expect(await appToken.owner()).to.equal(owner.address);
    });

    it("Should reject deployment with zero fee recipient", async function () {
      const AppTokenFactory = await ethers.getContractFactory("AppToken");
      await expect(
        AppTokenFactory.deploy(CONTRACT_NAME, CONTRACT_SYMBOL, MINT_FEE, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid fee recipient");
    });
  });

  describe("Minting", function () {
    it("Should mint an app token", async function () {
      const fp = generateFingerprint("repo-1");
      const uri = "ipfs://QmExample1";

      await expect(
        appToken.connect(developer1).mintAppToken(fp, uri, { value: MINT_FEE })
      ).to.emit(appToken, "AppCreated").withArgs(1, developer1.address, fp);

      expect(await appToken.ownerOf(1)).to.equal(developer1.address);
      expect(await appToken.tokenURI(1)).to.equal(uri);

      const app = await appToken.getApp(1);
      expect(app.developer).to.equal(developer1.address);
      expect(app.repoFingerprint).to.equal(fp);
    });

    it("Should reject duplicate fingerprint", async function () {
      const fp = generateFingerprint("repo-dup");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE });
      await expect(
        appToken.connect(developer2).mintAppToken(fp, "ipfs://2", { value: MINT_FEE })
      ).to.be.revertedWith("Fingerprint used");
    });

    it("Should reject invalid fingerprint", async function () {
      await expect(
        appToken.connect(developer1).mintAppToken(ethers.ZeroHash, "ipfs://1", { value: MINT_FEE })
      ).to.be.revertedWith("Invalid fingerprint");
    });

    it("Should reject insufficient mint fee", async function () {
      const fp = generateFingerprint("repo-fee");
      await expect(
        appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: 0 })
      ).to.be.revertedWith("Insufficient mint fee");
    });

    it("Should transfer mint fee to fee recipient", async function () {
      const fp = generateFingerprint("repo-fee-transfer");
      const balBefore = await ethers.provider.getBalance(feeRecipient.address);

      await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE });

      const balAfter = await ethers.provider.getBalance(feeRecipient.address);
      expect(balAfter - balBefore).to.equal(MINT_FEE);
    });

    it("Should refund excess payment", async function () {
      const fp = generateFingerprint("repo-excess");
      const excess = ethers.parseEther("0.01");
      const totalSent = MINT_FEE + excess;

      const balBefore = await ethers.provider.getBalance(developer1.address);
      const tx = await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: totalSent });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(developer1.address);

      expect(balBefore - balAfter - gasUsed).to.equal(MINT_FEE);
    });

    it("Should reject minting when paused", async function () {
      await appToken.pause();
      const fp = generateFingerprint("repo-paused");
      await expect(
        appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE })
      ).to.be.revertedWithCustomError(appToken, "EnforcedPause");
    });
  });

  describe("Metadata", function () {
    it("Should allow token owner to update metadata URI", async function () {
      const fp = generateFingerprint("repo-meta");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://old", { value: MINT_FEE });

      await expect(
        appToken.connect(developer1).updateMetadataURI(1, "ipfs://new")
      ).to.emit(appToken, "MetadataURIUpdated").withArgs(1, "ipfs://new");

      expect(await appToken.tokenURI(1)).to.equal("ipfs://new");
    });

    it("Should allow contract owner to update metadata URI", async function () {
      const fp = generateFingerprint("repo-meta-owner");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://old", { value: MINT_FEE });

      await appToken.connect(owner).updateMetadataURI(1, "ipfs://admin-updated");
      expect(await appToken.tokenURI(1)).to.equal("ipfs://admin-updated");
    });

    it("Should reject unauthorized metadata update", async function () {
      const fp = generateFingerprint("repo-meta-unauth");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://old", { value: MINT_FEE });

      await expect(
        appToken.connect(developer2).updateMetadataURI(1, "ipfs://hacked")
      ).to.be.revertedWith("Not authorized");
    });
  });

  describe("Admin", function () {
    it("Should allow owner to update mint fee", async function () {
      const newFee = ethers.parseEther("0.05");
      await expect(appToken.setMintFee(newFee))
        .to.emit(appToken, "MintFeeUpdated")
        .withArgs(newFee);
      expect(await appToken.mintFee()).to.equal(newFee);
    });

    it("Should allow owner to update fee recipient", async function () {
      await expect(appToken.setFeeRecipient(developer2.address))
        .to.emit(appToken, "FeeRecipientUpdated")
        .withArgs(developer2.address);
      expect(await appToken.feeRecipient()).to.equal(developer2.address);
    });

    it("Should reject zero address fee recipient", async function () {
      await expect(
        appToken.setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid recipient");
    });

    it("Should reject non-owner admin calls", async function () {
      await expect(
        appToken.connect(developer1).setMintFee(0)
      ).to.be.revertedWithCustomError(appToken, "OwnableUnauthorizedAccount");
    });
  });

  describe("Lookup", function () {
    it("Should look up app by fingerprint", async function () {
      const fp = generateFingerprint("repo-lookup");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE });

      const app = await appToken.getAppByFingerprint(fp);
      expect(app.appId).to.equal(1);
      expect(app.developer).to.equal(developer1.address);
    });

    it("Should check fingerprint usage", async function () {
      const fp = generateFingerprint("repo-check");
      expect(await appToken.isFingerprintUsed(fp)).to.be.false;

      await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE });
      expect(await appToken.isFingerprintUsed(fp)).to.be.true;
    });

    it("Should check app existence", async function () {
      expect(await appToken.appExists(1)).to.be.false;

      const fp = generateFingerprint("repo-exists");
      await appToken.connect(developer1).mintAppToken(fp, "ipfs://1", { value: MINT_FEE });
      expect(await appToken.appExists(1)).to.be.true;
    });
  });
});
