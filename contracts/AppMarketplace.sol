// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract AppMarketplace is EIP712, Ownable, ReentrancyGuard, Pausable {
    uint256 public constant MAX_FEE_BPS = 2000;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address seller,address tokenAddress,uint256 tokenId,uint256 price,uint256 expiry,uint256 nonce,bytes32 assetHash)"
    );

    uint256 public marketplaceFeeBps;
    address public feeRecipient;
    address public platformAddress;

    enum EscrowStatus {
        NONE,
        PENDING,
        COMPLETED,
        REFUNDED
    }

    struct Order {
        address seller;
        address tokenAddress;
        uint256 tokenId;
        uint256 price;
        uint256 expiry;
        uint256 nonce;
        bytes32 assetHash;
    }

    struct EscrowRecord {
        bytes32 orderHash;
        address buyer;
        address seller;
        address tokenAddress;
        uint256 tokenId;
        uint256 amount;
        EscrowStatus status;
        uint256 createdAt;
    }

    mapping(bytes32 => bool) public cancelled;
    mapping(bytes32 => bool) public filled;
    mapping(bytes32 => EscrowRecord) public escrows;
    mapping(address => uint256) public minNonce;

    event OrderPurchasedToEscrow(
        bytes32 indexed orderHash,
        address indexed buyer,
        address indexed seller,
        address tokenAddress,
        uint256 tokenId,
        uint256 amount
    );

    event EscrowReleased(
        bytes32 indexed orderHash,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 fee
    );

    event EscrowRefunded(
        bytes32 indexed orderHash,
        address indexed buyer,
        uint256 amount
    );

    event OrderCancelled(
        bytes32 indexed orderHash,
        address indexed seller
    );

    event AllOrdersCancelled(
        address indexed seller,
        uint256 newMinNonce
    );

    event MarketplaceFeeUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address newRecipient);
    event PlatformAddressUpdated(address newPlatformAddress);
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory version_,
        uint256 initialFeeBps_,
        address feeRecipient_,
        address platformAddress_
    ) EIP712(name_, version_) Ownable(msg.sender) {
        require(initialFeeBps_ <= MAX_FEE_BPS, "Fee exceeds maximum");
        require(feeRecipient_ != address(0), "Invalid fee recipient");
        require(platformAddress_ != address(0), "Invalid platform address");

        marketplaceFeeBps = initialFeeBps_;
        feeRecipient = feeRecipient_;
        platformAddress = platformAddress_;
    }

    function executeOrder(
        Order calldata order,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused {
        bytes32 orderHash = getOrderHash(order);

        require(!cancelled[orderHash], "Order cancelled");
        require(!filled[orderHash], "Order already filled");
        require(order.expiry == 0 || block.timestamp <= order.expiry, "Order expired");
        require(order.nonce >= minNonce[order.seller], "Nonce too low");
        require(msg.value == order.price, "Incorrect payment");
        require(msg.sender != order.seller, "Cannot buy own order");

        bytes32 digest = _hashTypedDataV4(orderHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == order.seller, "Invalid signature");

        filled[orderHash] = true;

        IERC721(order.tokenAddress).transferFrom(order.seller, address(this), order.tokenId);

        escrows[orderHash] = EscrowRecord({
            orderHash: orderHash,
            buyer: msg.sender,
            seller: order.seller,
            tokenAddress: order.tokenAddress,
            tokenId: order.tokenId,
            amount: msg.value,
            status: EscrowStatus.PENDING,
            createdAt: block.timestamp
        });

        emit OrderPurchasedToEscrow(
            orderHash,
            msg.sender,
            order.seller,
            order.tokenAddress,
            order.tokenId,
            msg.value
        );
    }

    function releaseEscrow(bytes32 orderHash) external nonReentrant {
        EscrowRecord storage escrow = escrows[orderHash];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(
            msg.sender == platformAddress || msg.sender == escrow.buyer,
            "Only platform or buyer"
        );

        _releaseEscrow(orderHash, escrow);
    }

    function refundEscrow(bytes32 orderHash) external nonReentrant {
        EscrowRecord storage escrow = escrows[orderHash];
        require(escrow.status == EscrowStatus.PENDING, "Not pending");
        require(
            msg.sender == platformAddress || msg.sender == escrow.buyer,
            "Only platform or buyer"
        );

        _refundEscrow(orderHash, escrow);
    }

    function cancelOrder(Order calldata order) external {
        bytes32 orderHash = getOrderHash(order);
        require(msg.sender == order.seller, "Only seller");
        require(!filled[orderHash], "Order already filled");

        cancelled[orderHash] = true;

        emit OrderCancelled(orderHash, msg.sender);
    }

    function cancelAllOrders(uint256 newMinNonce) external {
        require(newMinNonce > minNonce[msg.sender], "Nonce must increase");

        minNonce[msg.sender] = newMinNonce;

        emit AllOrdersCancelled(msg.sender, newMinNonce);
    }

    function _releaseEscrow(bytes32 orderHash, EscrowRecord storage escrow) internal {
        uint256 fee = (escrow.amount * marketplaceFeeBps) / 10_000;
        uint256 sellerAmount = escrow.amount - fee;

        escrow.status = EscrowStatus.COMPLETED;

        IERC721(escrow.tokenAddress).safeTransferFrom(address(this), escrow.buyer, escrow.tokenId);

        if (fee > 0) {
            (bool feeSuccess, ) = feeRecipient.call{value: fee}("");
            require(feeSuccess, "Fee transfer failed");
        }

        (bool sellerSuccess, ) = escrow.seller.call{value: sellerAmount}("");
        require(sellerSuccess, "Payment failed");

        emit EscrowReleased(orderHash, escrow.buyer, escrow.seller, escrow.amount, fee);
    }

    function _refundEscrow(bytes32 orderHash, EscrowRecord storage escrow) internal {
        uint256 amount = escrow.amount;
        address buyer = escrow.buyer;

        escrow.status = EscrowStatus.REFUNDED;

        IERC721(escrow.tokenAddress).safeTransferFrom(address(this), escrow.seller, escrow.tokenId);

        (bool success, ) = buyer.call{value: amount}("");
        require(success, "Refund failed");

        emit EscrowRefunded(orderHash, buyer, amount);
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

    function emergencyWithdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");
        require(address(this).balance >= amount, "Insufficient balance");

        (bool success, ) = to.call{value: amount}("");
        require(success, "Withdrawal failed");

        emit EmergencyWithdrawal(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getOrderHash(Order memory order) public pure returns (bytes32) {
        return keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.seller,
            order.tokenAddress,
            order.tokenId,
            order.price,
            order.expiry,
            order.nonce,
            order.assetHash
        ));
    }

    function getOrderStatus(Order calldata order) external view returns (string memory) {
        bytes32 orderHash = getOrderHash(order);

        if (cancelled[orderHash]) return "CANCELLED";
        if (order.nonce < minNonce[order.seller]) return "CANCELLED";

        if (filled[orderHash]) {
            EscrowRecord storage escrow = escrows[orderHash];
            if (escrow.status == EscrowStatus.PENDING) return "ESCROWED";
            if (escrow.status == EscrowStatus.COMPLETED) return "COMPLETED";
            if (escrow.status == EscrowStatus.REFUNDED) return "REFUNDED";
        }

        if (order.expiry != 0 && block.timestamp > order.expiry) return "EXPIRED";

        return "OPEN";
    }

    function getEscrow(bytes32 orderHash) external view returns (EscrowRecord memory) {
        return escrows[orderHash];
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
