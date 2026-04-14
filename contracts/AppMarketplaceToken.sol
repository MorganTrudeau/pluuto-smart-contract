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

    // appId == tokenId — single incrementing counter
    uint256 private _nextId;
    uint256 public marketplaceFeeBps;
    uint256 public mintFee;
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
        address developer;
        bytes32 repoFingerprint;
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
    mapping(uint256 => Listing) public listings;
    mapping(bytes32 => uint256) public repoFingerprintToAppId;
    mapping(uint256 => Escrow) public escrows;

    event AppCreated(
        uint256 indexed appId,
        address indexed developer,
        bytes32 repoFingerprint
    );

    event AppListed(
        uint256 indexed appId,
        address indexed seller,
        uint256 price
    );

    event AppUnlisted(
        uint256 indexed appId,
        address indexed seller
    );

    event OwnershipChanged(
        uint256 indexed appId,
        address indexed from,
        address to
    );

    event MarketplaceFeeUpdated(uint256 newFeeBps);
    event MintFeeUpdated(uint256 newMintFee);
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
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialFeeBps_,
        uint256 mintFee_,
        address feeRecipient_,
        address platformAddress_
    ) ERC721(name_, symbol_) Ownable(msg.sender) {
        require(initialFeeBps_ <= MAX_FEE_BPS, "Fee exceeds maximum");
        require(feeRecipient_ != address(0), "Invalid fee recipient");
        require(platformAddress_ != address(0), "Invalid platform address");

        _nextId = 1;
        marketplaceFeeBps = initialFeeBps_;
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
        platformAddress = platformAddress_;
    }

    function _appExists(uint256 appId) internal view returns (bool) {
        return apps[appId].developer != address(0);
    }

    function mintAppToken(
        bytes32 repoFingerprint,
        string memory metadataURI
    ) public payable whenNotPaused returns (uint256 appId) {
        require(repoFingerprint != bytes32(0), "Invalid fingerprint");
        require(repoFingerprintToAppId[repoFingerprint] == 0, "Fingerprint used");
        require(msg.value >= mintFee, "Insufficient mint fee");

        appId = _nextId++;

        repoFingerprintToAppId[repoFingerprint] = appId;

        apps[appId] = App({
            appId: appId,
            developer: msg.sender,
            repoFingerprint: repoFingerprint
        });

        _safeMint(msg.sender, appId);
        _setTokenURI(appId, metadataURI);

        if (mintFee > 0) {
            (bool success, ) = feeRecipient.call{value: mintFee}("");
            require(success, "Mint fee transfer failed");
        }

        uint256 excess = msg.value - mintFee;
        if (excess > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: excess}("");
            require(refundSuccess, "Refund failed");
        }

        emit AppCreated(appId, msg.sender, repoFingerprint);

        return appId;
    }

    function mintAndListAppToken(
        bytes32 repoFingerprint,
        string memory metadataURI,
        uint256 listingPrice
    ) external payable whenNotPaused returns (uint256 appId) {
        require(listingPrice > 0, "Price must be > 0");

        appId = mintAppToken(repoFingerprint, metadataURI);

        listings[appId] = Listing({isListed: true, price: listingPrice});

        emit AppListed(appId, msg.sender, listingPrice);

        return appId;
    }

    function listForSale(uint256 appId, uint256 price) external whenNotPaused {
        require(_appExists(appId), "App does not exist");
        require(price > 0, "Price must be > 0");
        require(ownerOf(appId) == msg.sender, "Not owner");
        require(!listings[appId].isListed, "Already listed");
        require(escrows[appId].status != EscrowStatus.PENDING, "Pending escrow");

        listings[appId] = Listing({isListed: true, price: price});

        emit AppListed(appId, msg.sender, price);
    }

    function cancelListing(uint256 appId) external {
        require(_appExists(appId), "App does not exist");
        require(listings[appId].isListed, "Not listed");
        require(ownerOf(appId) == msg.sender, "Not owner");

        listings[appId].isListed = false;
        listings[appId].price = 0;

        emit AppUnlisted(appId, msg.sender);
    }

    function purchaseWithEscrow(uint256 appId) external payable nonReentrant whenNotPaused {
        require(_appExists(appId), "App does not exist");
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

        address seller = ownerOf(appId);
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

        _transfer(seller, address(this), appId);

        emit EscrowCreated(appId, msg.sender, seller, msg.value);
    }

    function completeEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(
            msg.sender == platformAddress || msg.sender == escrow.buyer,
            "Only platform or buyer"
        );

        _releaseEscrow(appId, escrow);
    }

    function refundEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not refundable");
        require(msg.sender == escrow.buyer, "Only buyer");

        _refundEscrow(appId, escrow);
    }

    function expireEscrow(uint256 appId) external nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(block.timestamp >= escrow.createdAt + ESCROW_TIMEOUT, "Not expired");

        escrow.status = EscrowStatus.EXPIRED;

        _transfer(address(this), escrow.seller, appId);

        listings[appId].isListed = true;
        listings[appId].price = escrow.amount;

        (bool success, ) = escrow.buyer.call{value: escrow.amount}("");
        require(success, "Refund failed");

        emit EscrowExpired(appId, escrow.buyer, escrow.amount);
        emit EscrowRefunded(appId, escrow.buyer, escrow.amount);
    }

    function resolveEscrowDispute(uint256 appId, bool refundToBuyer) external onlyOwner nonReentrant {
        Escrow storage escrow = escrows[appId];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");

        if (refundToBuyer) {
            _refundEscrow(appId, escrow);
        } else {
            _releaseEscrow(appId, escrow);
        }
    }

    function _releaseEscrow(uint256 appId, Escrow storage escrow) internal {
        uint256 fee = (escrow.amount * marketplaceFeeBps) / 10_000;
        uint256 sellerAmount = escrow.amount - fee;

        escrow.status = EscrowStatus.COMPLETED;

        _safeTransfer(address(this), escrow.buyer, appId);

        if (fee > 0) {
            (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
            require(feeSuccess, "Fee transfer failed");
        }

        (bool sellerSuccess, ) = escrow.seller.call{value: sellerAmount}("");
        require(sellerSuccess, "Payment failed");

        emit EscrowReleased(appId, escrow.buyer, escrow.seller, escrow.amount, fee);
    }

    function _refundEscrow(uint256 appId, Escrow storage escrow) internal {
        uint256 amount = escrow.amount;
        address buyer = escrow.buyer;

        escrow.status = EscrowStatus.REFUNDED;

        _transfer(address(this), escrow.seller, appId);

        listings[appId].isListed = true;
        listings[appId].price = amount;

        (bool success, ) = buyer.call{value: amount}("");
        require(success, "Refund failed");

        emit EscrowRefunded(appId, buyer, amount);
    }

    function setMarketplaceFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "Fee exceeds max");
        marketplaceFeeBps = newFeeBps;
        emit MarketplaceFeeUpdated(newFeeBps);
    }

    function setMintFee(uint256 newMintFee) external onlyOwner {
        mintFee = newMintFee;
        emit MintFeeUpdated(newMintFee);
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

    /// @notice Emergency function to withdraw ETH stuck in the contract due to failed transfers.
    function emergencyWithdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient balance");

        (bool success, ) = to.call{value: amount}("");
        require(success, "Withdrawal failed");

        emit EmergencyWithdrawal(to, amount);
    }

    function updateMetadataURI(uint256 appId, string memory newURI) external {
        require(_appExists(appId), "App does not exist");
        require(msg.sender == ownerOf(appId) || msg.sender == owner(), "Not authorized");

        _setTokenURI(appId, newURI);

        emit MetadataURIUpdated(appId, newURI);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getApp(uint256 appId) external view returns (App memory) {
        require(_appExists(appId), "App does not exist");
        return apps[appId];
    }

    function getListing(uint256 appId) external view returns (bool isListed, uint256 price, address owner_) {
        require(_appExists(appId), "App does not exist");
        Listing memory listing = listings[appId];
        return (listing.isListed, listing.price, ownerOf(appId));
    }

    function isFingerprintUsed(bytes32 fingerprint) external view returns (bool) {
        return repoFingerprintToAppId[fingerprint] != 0;
    }

    function getAppByFingerprint(bytes32 fingerprint) external view returns (App memory) {
        uint256 appId = repoFingerprintToAppId[fingerprint];
        require(appId != 0, "App does not exist");
        return apps[appId];
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
            if (listings[tokenId].isListed) {
                listings[tokenId].isListed = false;
                listings[tokenId].price = 0;
            }
        }

        address previousOwner = super._update(to, tokenId, auth);

        if (from != address(0) && to != address(0)) {
            emit OwnershipChanged(tokenId, from, to);
        }

        return previousOwner;
    }
}
