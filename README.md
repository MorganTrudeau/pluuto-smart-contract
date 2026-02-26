# Morgan ERC721 NFT Marketplace

A complete ERC721 NFT marketplace smart contract with minting, listing, buying, and platform fee distribution built with Hardhat + TypeScript and OpenZeppelin. Deployable to Sepolia and Base mainnet.

## Features

- **Minting**: Anyone can mint NFTs with metadata URIs
- **Listing**: NFT owners can list their tokens for sale at any price
- **Buying**: Purchase listed NFTs with automatic fee distribution
- **Platform Fees**: Configurable platform fee percentage with designated recipient
- **Events**: Full event emission for Minted, Listed, Bought, Transfer, and admin actions
- **Security**: ReentrancyGuard protection and comprehensive validation

## Quick Setup

### 1. Install dependencies

```bash
cd /Volumes/Work/2025/Wu/Morgan-ERC721/smart-contract
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set:
- `PRIVATE_KEY`: Your deployer wallet private key
- `SEPOLIA_RPC_URL`: Sepolia RPC endpoint (Alchemy/Infura)
- `BASE_RPC_URL`: Base mainnet RPC endpoint
- `ETHERSCAN_API_KEY`: For contract verification
- `PLATFORM_FEE_RECIPIENT`: **Required** - Address to receive platform fees
- `PLATFORM_FEE_PERCENTAGE`: Fee in basis points (default 250 = 2.5%)

### 3. Compile

```bash
npm run compile
```

### 4. Run tests

```bash
npm test
```

### 5. Deploy

**Sepolia testnet:**
```bash
npm run deploy:sepolia
```

**Base mainnet:**
```bash
npm run deploy:base
```

### 6. Interact with deployed contract

After deployment, add `CONTRACT_ADDRESS` to your `.env`, then:

```bash
npm run interact:sepolia
# or
npm run interact:base
```

## Contract Functions

### Minting
```solidity
function mint(address to, string memory uri) external returns (uint256)
```
Mint a new NFT to any address with metadata URI.

### Listing
```solidity
function listNFT(uint256 tokenId, uint256 price) external
function cancelListing(uint256 tokenId) external
```
List your NFT for sale or cancel an active listing.

### Buying
```solidity
function buyNFT(uint256 tokenId) external payable
```
Purchase a listed NFT. Payment is split between seller and platform automatically.

### Admin Functions (Owner Only)
```solidity
function setPlatformFeePercentage(uint256 newFeePercentage) external
function setPlatformFeeRecipient(address newRecipient) external
```

## Events

- `Minted(uint256 tokenId, address to, string uri)`
- `Listed(uint256 tokenId, address seller, uint256 price)`
- `Bought(uint256 tokenId, address buyer, address seller, uint256 price, uint256 platformFee)`
- `ListingCancelled(uint256 tokenId, address seller)`
- `Transfer(address from, address to, uint256 tokenId)` - Standard ERC721

## Project Structure

- `contracts/MyERC721.sol` — Full marketplace contract with ERC721URIStorage, listing logic, and fee distribution
- `scripts/deploy.ts` — Deployment script with platform fee configuration
- `test/sample-test.ts` — Comprehensive test suite covering minting, listing, buying, and fee management
- `hardhat.config.ts` — Network configs for Sepolia and Base with Etherscan verification

## Security Features

- ReentrancyGuard on purchase function
- Automatic listing cancellation on transfer
- Input validation on all state-changing functions
- Platform fee capped at 100%
- Overpayment refund mechanism

## Usage Example

After deploying, interact with your contract:

```typescript
// Mint an NFT
const tx = await contract.mint(userAddress, "ipfs://metadata-uri");
// Event: Minted(tokenId, userAddress, "ipfs://metadata-uri")

// List NFT for sale
await contract.listNFT(tokenId, ethers.parseEther("1.0"));
// Event: Listed(tokenId, sellerAddress, price)

// Buy listed NFT (from different account)
await contract.buyNFT(tokenId, { value: ethers.parseEther("1.0") });
// Event: Bought(tokenId, buyerAddress, sellerAddress, price, platformFee)
// Seller receives: price - (price * platformFeePercentage / 10000)
// Platform receives: price * platformFeePercentage / 10000

// Cancel listing
await contract.cancelListing(tokenId);
// Event: ListingCancelled(tokenId, sellerAddress)
```

See `scripts/interact.ts` for a complete working example.

## Notes

- Platform fee is calculated in basis points (100 = 1%, 250 = 2.5%, 1000 = 10%)
- Listings are automatically cancelled when NFT is transferred
- Sellers receive `price - platformFee`, platform receives `platformFee`
- Uses `@nomicfoundation/hardhat-toolbox` with ethers v6
- Keep your private key secure and never commit `.env`