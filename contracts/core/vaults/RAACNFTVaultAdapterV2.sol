// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import "./ERC721VaultAdapter.sol";
import "../../interfaces/core/oracles/IRAACHousePrices.sol";

/**
 * @title RAACNFTVaultAdapterV2
 * @author RAAC Protocol Team
 * @notice Adapter for the ERC721VaultAdapter that allows to sync the price of the NFTs with the house prices
 * @dev The adapter inherits from ERC721VaultAdapter and IRAACHousePriceSyncer, and implements ERC165 for the interface
 * @dev The deposit/withdraw price is in USD. The raacHousePrices is RAACNFTVaultAdapterOracle that maps the RAACHousePrices
 * @dev The nftValue needs to remain in sync with the prices
 */
contract RAACNFTVaultAdapterV2 is ERC721VaultAdapter, IRAACHousePriceSyncer, ERC165 {
    /// @notice Running sum of the NFTs in the system (in USD)
    uint256 public nftsValue;
    /// @notice Used for notify() and isPendingRequest(). The price comes from the _oracle which is not _raacHousePrices
    address public raacHousePrices;

    constructor(address _token, address _oracle, address _vault, address _raacHousePrices) ERC721VaultAdapter(_token, _oracle, _vault) {
        require(_raacHousePrices != address(0), "ERC721VaultAdapter: Zero Address");
        raacHousePrices = _raacHousePrices;
    }

    /// @inheritdoc ERC721VaultAdapter
    function deposit(bytes calldata data, address from) public virtual override onlyVault returns(uint256 value) {
        uint256 tokenId = abi.decode(data, (uint256));
        if (IRAACHousePrices(raacHousePrices).isPendingRequest(tokenId)) revert HousePricePending();

        value = super.deposit(data, from);
        (uint256 usdPrice,) = priceOracle.getLatestPrice(tokenId);
        nftsValue += usdPrice;
        return value;
    }

    /// @inheritdoc ERC721VaultAdapter
    function withdraw(bytes calldata data, address to) public virtual override onlyVault returns(uint256 value) {
        uint256 tokenId = abi.decode(data, (uint256));
        if (IRAACHousePrices(raacHousePrices).isPendingRequest(tokenId)) revert HousePricePending();
        
        (uint256 usdValue,) = priceOracle.getLatestPrice(tokenId);
        if (nftsValue < usdValue) {
            nftsValue = 0;
        } else {
            nftsValue -= usdValue;
        }
        return super.withdraw(data, to);
    }

    /// @inheritdoc IRAACHousePriceSyncer
    /// @dev Notify provides the price in USD
    function notify(uint256 tokenId, uint256 previousPrice, uint256 newPrice) public {
        if (msg.sender != raacHousePrices) revert NotHousePrices();
        // we will take out the previous value and sum the new one
        // check that the nft is indeed inside the vault
        if (!isDeposited(tokenId)) return;

        nftsValue = nftsValue - previousPrice + newPrice;
        emit PriceSynced(tokenId, previousPrice, newPrice);
    }


    /// @dev Returning the running sum that is synced with the notify method
    /// @dev Returns price in USD
    function totalValue() public view override returns (uint256) {
        return nftsValue;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IRAACHousePriceSyncer).interfaceId || super.supportsInterface(interfaceId);
    }

    function setRAACHousePrices(address _raacHousePrices) external onlyOwner {
        require(_raacHousePrices != address(0), "ERC721VaultAdapter: Zero Address");
        raacHousePrices = _raacHousePrices;
        emit RAACHousePriceUpdated(_raacHousePrices);
    }

    error NotHousePrices();
    error HousePricePending();
    event RAACHousePriceUpdated(address _newAddress);
}
