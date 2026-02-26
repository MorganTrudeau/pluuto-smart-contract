// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract AppMarketplaceToken is
    ERC721URIStorage,
    Ownable,
    ReentrancyGuard,
    Pausable
{
    uint256 public constant MAX_FEE_BPS = 2000;
    uint256 public constant ESCROW_TIMEOUT = 7 days;

    uint256 private _nextTokenId;
    uint256 private _nextAppId;
    uint256 public marketplaceFeeBps;
    address public feeRecipient;
    address public platformAddress;

    enum EscrowStatus {
        NONE,
        PENDING,
        COMPLETED,
        REFUNDED,
        EXPIRED
    }

    struct App {
        uint256 appId;
        uint256 tokenId;
        address developer;
        bytes32 repoFingerprint;
        string metadataURI;
    }

    struct Listing {
        bool isListed;
        uint256 price;
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        EscrowStatus status;
        uint256 createdAt;
    }

    mapping(uint256 => App) public apps;
    mapping(uint256 => uint256) public tokenIdToAppId;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => bool) public appIdExists;
    mapping(bytes32 => bool) public repoFingerprintUsed;
    mapping(uint256 => Escrow) public escrows;

    event AppCreated(
        uint256 indexed appId,
        uint256 indexed tokenId,
        address indexed developer,
        bytes32 repoFingerprint
    );

    event AppMinted(
        uint256 indexed appId,
        uint256 indexed tokenId,
        address indexed developer
    );

    event AppListed(
        uint256 indexed appId,
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price
    );

    event AppUnlisted(
        uint256 indexed appId,
        uint256 indexed tokenId,
        address indexed seller
    );

    event OwnershipChanged(
        uint256 indexed appId,
        uint256 indexed tokenId,
        address indexed from,
        address to
    );

    event MarketplaceFeeUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address newRecipient);
    event MetadataURIUpdated(uint256 indexed appId, string newURI);

    event EscrowCreated(
        uint256 indexed appId,
        address indexed buyer,
        address indexed seller,
        uint256 amount
    );

    event EscrowReleased(
        uint256 indexed appId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 fee
    );

    event EscrowRefunded(
        uint256 indexed appId,
        address indexed buyer,
        uint256 amount
    );

    event EscrowExpired(
        uint256 indexed appId,
        address indexed buyer,
        uint256 amount
    );

    event PlatformAddressUpdated(address newPlatformAddress);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialFeeBps_,
        address feeRecipient_,
        address platformAddress_
    ) ERC721(name_, symbol_) Ownable(msg.sender) {
        require(initialFeeBps_ <= MAX_FEE_BPS, "Fee exceeds maximum");
        require(feeRecipient_ != address(0), "Invalid fee recipient");
        require(platformAddress_ != address(0), "Invalid platform address");

        _nextTokenId = 1;
        _nextAppId = 1;
        marketplaceFeeBps = initialFeeBps_;
        feeRecipient = feeRecipient_;
        platformAddress = platformAddress_;
    }

    function mintAppToken(
        bytes32 repoFingerprint,
        string memory metadataURI,
        uint256 listingPrice
    ) external whenNotPaused returns (uint256 appId, uint256 tokenId) {
        require(repoFingerprint != bytes32(0), "Invalid fingerprint");
        require(!repoFingerprintUsed[repoFingerprint], "Fingerprint used");
        require(listingPrice > 0, "Price must be > 0");

        appId = _nextAppId++;
        tokenId = _nextTokenId++;

        repoFingerprintUsed[repoFingerprint] = true;
        appIdExists[appId] = true;

        apps[appId] = App({
            appId: appId,
            tokenId: tokenId,
            developer: msg.sender,
            repoFingerprint: repoFingerprint,
            metadataURI: metadataURI
        });

        tokenIdToAppId[tokenId] = appId;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, metadataURI);

        // Auto-list the app for sale
        listings[appId] = Listing({isListed: true, price: listingPrice});

        emit AppCreated(appId, tokenId, msg.sender, repoFingerprint);
        emit AppMinted(appId, tokenId, msg.sender);
        emit AppListed(appId, tokenId, msg.sender, listingPrice);

        return (appId, tokenId);
    }

    function listForSale(uint256 appId, uint256 price) external whenNotPaused {
        require(appIdExists[appId], "App does not exist");
        require(price > 0, "Price must be > 0");

        uint256 tokenId = apps[appId].tokenId;
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(!listings[appId].isListed, "Already listed");
        require(escrows[appId].status != EscrowStatus.PENDING, "Pending escrow");

        listings[appId] = Listing({isListed: true, price: price});

        emit AppListed(appId, tokenId, msg.sender, price);
    }

    function cancelListing(uint256 appId) external {
        require(appIdExists[appId], "App does not exist");
        require(listings[appId].isListed, "Not listed");

        uint256 tokenId = apps[appId].tokenId;
        require(ownerOf(tokenId) == msg.sender, "Not owner");

        listings[appId].isListed = false;
        listings[appId].price = 0;

        emit AppUnlisted(appId, tokenId, msg.sender);
    }

    function purchaseWithEscrow(uint256 appId) external payable nonReentrant whenNotPaused {
        require(appIdExists[appId], "App does not exist");
        require(listings[appId].isListed, "Not listed");
        
        EscrowStatus status = escrows[appId].status;
        require(
            status == EscrowStatus.NONE ||
            status == EscrowStatus.COMPLETED ||
            status == EscrowStatus.REFUNDED ||
            status == EscrowStatus.EXPIRED,
            "Active escrow"
        );

        uint256 price = listings[appId].price;
        require(msg.value == price, "Incorrect payment");

        uint256 tokenId = apps[appId].tokenId;
        address seller = ownerOf(tokenId);
        require(seller != msg.sender, "Cannot buy own app");

        listings[appId].isListed = false;
        listings[appId].price = 0;

        escrows[appId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: msg.value,
            status: EscrowStatus.PENDING,
            createdAt: block.timestamp
        });

        // Custody NFT in contract to prevent seller from transferring it away
        _transfer(seller, address(this), tokenId);

        emit EscrowCreated(appId, msg.sender, seller, msg.value);
    }

    function completeEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(
            msg.sender == platformAddress || msg.sender == escrow.buyer,
            "Only platform or buyer"
        );

        uint256 fee = (escrow.amount * marketplaceFeeBps) / 10_000;
        uint256 sellerAmount = escrow.amount - fee;

        escrow.status = EscrowStatus.COMPLETED;

        uint256 tokenId = apps[appId].tokenId;
        // NFT is held by contract during escrow; release to buyer
        _transfer(address(this), escrow.buyer, tokenId);

        if (fee > 0) {
            (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
            require(feeSuccess, "Fee transfer failed");
        }

        (bool sellerSuccess, ) = escrow.seller.call{value: sellerAmount}("");
        require(sellerSuccess, "Payment failed");

        emit EscrowReleased(appId, escrow.buyer, escrow.seller, escrow.amount, fee);
    }

    function refundEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(
            escrow.status == EscrowStatus.PENDING,
            "Not refundable"
        );
        require(msg.sender == escrow.buyer, "Only buyer");

        uint256 amount = escrow.amount;
        address buyer = escrow.buyer;

        escrow.status = EscrowStatus.REFUNDED;

        uint256 tokenId_ = apps[appId].tokenId;
        // Return NFT from contract custody back to seller
        _transfer(address(this), escrow.seller, tokenId_);

        listings[appId].isListed = true;
        listings[appId].price = amount;

        (bool success, ) = buyer.call{value: amount}("");
        require(success, "Refund failed");

        emit EscrowRefunded(appId, buyer, amount);
    }

    function expireEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(block.timestamp >= escrow.createdAt + ESCROW_TIMEOUT, "Not expired");

        uint256 amount = escrow.amount;
        address buyer = escrow.buyer;

        escrow.status = EscrowStatus.EXPIRED;

        uint256 tokenId_ = apps[appId].tokenId;
        // Return NFT from contract custody back to seller
        _transfer(address(this), escrow.seller, tokenId_);

        // Re-list the app at its original price so the seller can sell again
        listings[appId].isListed = true;
        listings[appId].price = amount;

        // Auto-refund the buyer immediately
        (bool success, ) = buyer.call{value: amount}("");
        require(success, "Refund failed");

        emit EscrowExpired(appId, buyer, amount);
        emit EscrowRefunded(appId, buyer, amount);
    }

    function resolveEscrowDispute(uint256 appId, bool refundToBuyer) external onlyOwner nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");

        if (refundToBuyer) {
            uint256 amount = escrow.amount;
            address buyer = escrow.buyer;

            escrow.status = EscrowStatus.REFUNDED;

            uint256 tokenId_ = apps[appId].tokenId;
            // Return NFT from contract custody back to seller
            _transfer(address(this), escrow.seller, tokenId_);

            listings[appId].isListed = true;
            listings[appId].price = amount;

            (bool success, ) = buyer.call{value: amount}("");
            require(success, "Refund failed");

            emit EscrowRefunded(appId, buyer, amount);
        } else {
            uint256 fee = (escrow.amount * marketplaceFeeBps) / 10_000;
            uint256 sellerAmount = escrow.amount - fee;

            escrow.status = EscrowStatus.COMPLETED;

            uint256 tokenId = apps[appId].tokenId;
            // NFT is held by contract during escrow; release to buyer
            _transfer(address(this), escrow.buyer, tokenId);

            if (fee > 0) {
                (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
                require(feeSuccess, "Fee transfer failed");
            }

            (bool sellerSuccess, ) = escrow.seller.call{value: sellerAmount}("");
            require(sellerSuccess, "Payment failed");

            emit EscrowReleased(appId, escrow.buyer, escrow.seller, escrow.amount, fee);
        }
    }

    function setMarketplaceFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "Fee exceeds max");
        marketplaceFeeBps = newFeeBps;
        emit MarketplaceFeeUpdated(newFeeBps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient");
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function setPlatformAddress(address newPlatformAddress) external onlyOwner {
        require(newPlatformAddress != address(0), "Invalid platform address");
        platformAddress = newPlatformAddress;
        emit PlatformAddressUpdated(newPlatformAddress);
    }

    function updateMetadataURI(uint256 appId, string memory newURI) external {
        require(appIdExists[appId], "App does not exist");

        uint256 tokenId = apps[appId].tokenId;
        address tokenOwner = ownerOf(tokenId);

        require(msg.sender == tokenOwner || msg.sender == owner(), "Not authorized");

        apps[appId].metadataURI = newURI;
        _setTokenURI(tokenId, newURI);

        emit MetadataURIUpdated(appId, newURI);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getApp(uint256 appId) external view returns (App memory) {
        require(appIdExists[appId], "App does not exist");
        return apps[appId];
    }

    function getAppIdFromTokenId(uint256 tokenId) external view returns (uint256) {
        require(tokenIdToAppId[tokenId] != 0, "No associated app");
        return tokenIdToAppId[tokenId];
    }

    function getListing(uint256 appId) external view returns (bool isListed, uint256 price, address owner_) {
        require(appIdExists[appId], "App does not exist");
        Listing memory listing = listings[appId];
        uint256 tokenId = apps[appId].tokenId;
        address currentOwner = ownerOf(tokenId);

        return (listing.isListed, listing.price, currentOwner);
    }

    function isFingerprintUsed(bytes32 fingerprint) external view returns (bool) {
        return repoFingerprintUsed[fingerprint];
    }

    function getEscrowDetails(uint256 appId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint256 amount,
            EscrowStatus status,
            uint256 createdAt
        )
    {
        Escrow storage escrow = escrows[appId];
        return (escrow.buyer, escrow.seller, escrow.amount, escrow.status, escrow.createdAt);
    }

    function isEscrowExpired(uint256 appId) external view returns (bool) {
        Escrow storage escrow = escrows[appId];
        if (escrow.status != EscrowStatus.PENDING) {
            return false;
        }
        return block.timestamp >= escrow.createdAt + ESCROW_TIMEOUT;
    }

    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = _ownerOf(tokenId);

        if (from != address(0) && to != address(0)) {
            uint256 appId = tokenIdToAppId[tokenId];
            if (appId != 0 && listings[appId].isListed) {
                listings[appId].isListed = false;
                listings[appId].price = 0;
            }
        }

        address previousOwner = super._update(to, tokenId, auth);

        if (from != address(0) && to != address(0)) {
            uint256 appId = tokenIdToAppId[tokenId];
            if (appId != 0) {
                emit OwnershipChanged(appId, tokenId, from, to);
            }
        }

        return previousOwner;
    }
}