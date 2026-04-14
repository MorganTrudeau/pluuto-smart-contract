// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract AppToken is ERC721URIStorage, Ownable, Pausable {
    uint256 private _nextId;
    uint256 public mintFee;
    address public feeRecipient;

    struct App {
        uint256 appId;
        address developer;
        bytes32 repoFingerprint;
    }

    mapping(uint256 => App) public apps;
    mapping(bytes32 => uint256) public repoFingerprintToAppId;

    event AppCreated(
        uint256 indexed appId,
        address indexed developer,
        bytes32 repoFingerprint
    );

    event MintFeeUpdated(uint256 newMintFee);
    event FeeRecipientUpdated(address newRecipient);
    event MetadataURIUpdated(uint256 indexed appId, string newURI);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 mintFee_,
        address feeRecipient_
    ) ERC721(name_, symbol_) Ownable(msg.sender) {
        require(feeRecipient_ != address(0), "Invalid fee recipient");

        _nextId = 1;
        mintFee = mintFee_;
        feeRecipient = feeRecipient_;
    }

    function appExists(uint256 appId) public view returns (bool) {
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

    function updateMetadataURI(uint256 appId, string memory newURI) external {
        require(appExists(appId), "App does not exist");
        require(msg.sender == ownerOf(appId) || msg.sender == owner(), "Not authorized");

        _setTokenURI(appId, newURI);

        emit MetadataURIUpdated(appId, newURI);
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getApp(uint256 appId) external view returns (App memory) {
        require(appExists(appId), "App does not exist");
        return apps[appId];
    }

    function getAppByFingerprint(bytes32 fingerprint) external view returns (App memory) {
        uint256 appId = repoFingerprintToAppId[fingerprint];
        require(appId != 0, "App does not exist");
        return apps[appId];
    }

    function isFingerprintUsed(bytes32 fingerprint) external view returns (bool) {
        return repoFingerprintToAppId[fingerprint] != 0;
    }
}
