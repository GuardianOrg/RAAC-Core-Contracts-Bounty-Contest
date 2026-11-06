// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/core/tokens/IVaultToken.sol";
import "../../interfaces/core/collectors/IFeeCollector.sol";
import "../primitives/WithCompliance.sol";

/**
 * @title RWAIndexToken
 * @author RAAC Protocol Team
 * @notice This contract is used to represent the index token for the RWA Vault.
 * @dev This contract is used to represent the index token for the RWA Vault.
 * @dev If the swap fee is implemented in the liquidity pool (e.g. Curve), do not add the Curve to swapPair.
 * @dev In curve pool or other pool, we can add 2.5% (2% for swap and 0.5% for burn) and then send to the feeCollection contract that would redirect the fee to the feeCollector.
 * @dev The swap fee and burn fee is enforced if permissionless LPs are used, in which case, we whitelist those LPs in the isSwapPair mapping.
 */
contract RWAIndexToken is ERC20, Ownable, IVaultToken, WithCompliance {
    uint256 public constant FEE_DENOM = 100_00;
    /// @notice swap fee in basis points
    uint256 public swapFeeBP = 2_00;
    /// @notice burn fee in basis points
    uint256 public burnFeeBP = 0;

    /// @notice address of the vault managing the token mint and burn
    address public vault;
    /// @notice feeCollector handing the swap fees
    address public feeCollector;

    /// @notice Event emitted when vault is updated
    event VaultUpdated(address _newAddress);
    /// @notice Event emitted when fee collector is updated
    event FeeCollectorUpdated(address _newAddress);
    /// @notice Event emitted when the fees are updated
    event FeesUpdated(uint256 _newSwapFee, uint256 _newBurnFee);
    /// @notice Event emitted wen swap pair is updated
    event SwapPairUpdated(address _pair, bool _enable);

    /// @notice mapping of all the AMM pair addresses
    mapping(address => bool) public isSwapPair;

    modifier onlyVault() {
        require(msg.sender == vault, "RWAIndexToken: caller is not vault");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address _complianceRegistry
    ) ERC20(name_, symbol_) Ownable(msg.sender) WithCompliance(_complianceRegistry) {}

    /// @notice Set the vault address
    /// @param _vault The address of the vault
    function setVault(address _vault) external override onlyOwner {
        require(_vault != address(0), "RWAIndexToken: vault address is zero");
        vault = _vault;
        emit VaultUpdated(_vault);
    }

    /// @notice Set the fee collector address
    /// @param _feeCollector The address of the fee collector (RWAIndexTokenCollector)
    function setFeeCollector(address _feeCollector) external override onlyOwner {
        require(_feeCollector != address(0), "RWAIndexToken: fee collector address is zero");
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    /// @notice Change fee or burn rates (in basis points, out of 10_000)
    /// @param _swapFeeBP The swap fee in basis points
    /// @param _burnFeeBP The burn fee in basis points
    function setFees(uint256 _swapFeeBP, uint256 _burnFeeBP) external onlyOwner {
        require(_swapFeeBP < FEE_DENOM, "RWAIndexToken: swap fee exceeds maximum");
        require(_burnFeeBP < FEE_DENOM, "RWAIndexToken: burn fee exceeds maximum");
        swapFeeBP = _swapFeeBP;
        burnFeeBP = _burnFeeBP;
        emit FeesUpdated(_swapFeeBP, _burnFeeBP);
    }

    /// @notice Owner can add/remove AMM pair addresses as they’re created
    /// @param pair The address of the AMM pair
    /// @param enabled Whether the AMM pair is enabled
    function setSwapPair(address pair, bool enabled) external onlyOwner {
        isSwapPair[pair] = enabled;
        emit SwapPairUpdated(pair, enabled);
    }

    /// ERC20 Actions

    /// @notice Mint tokens
    /// @param to The address to mint tokens to
    /// @param amount The amount of tokens to mint
    /// @dev Only the vault can mint tokens
    function mint(address to, uint256 amount) external override onlyVault {
        _mint(to, amount);
    }

    /// @notice Burn tokens
    /// @param from The address to burn tokens from
    /// @param amount The amount of tokens to burn
    /// @dev Only the vault can burn tokens
    function burn(address from, uint256 amount) external override onlyVault {
        _burn(from, amount);
    }

    /// @notice Transfer tokens
    /// @param to The address to transfer tokens to
    /// @param amount The amount of tokens to transfer
    function transfer(address to, uint256 amount) public virtual override(ERC20, IERC20) returns (bool) {
        _swapAwareTransfer(_msgSender(), to, amount);
        return true;
    }

    /// @notice Override ERC20.transferFrom
    function transferFrom(address from, address to, uint256 amount) public virtual override(ERC20, IERC20) returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        _swapAwareTransfer(from, to, amount);
        return true;
    }

    /// @notice core logic pulled out into one internal helper
    /// @param sender The address sending the tokens
    /// @param recipient The address receiving the tokens
    /// @param amount The amount of tokens to transfer
    function _swapAwareTransfer(address sender, address recipient, uint256 amount) internal notBlacklisted(sender) notBlacklisted(recipient) {
        if (isSwapPair[sender] || isSwapPair[recipient]) {
            uint256 feeAmount  = (amount * swapFeeBP)  / FEE_DENOM;
            uint256 burnAmount = (amount * burnFeeBP) / FEE_DENOM;
            uint256 rest       = amount - feeAmount - burnAmount;

            if (burnAmount > 0) {
                _burn(sender, burnAmount);
            }

            if (feeAmount > 0) {
                super._transfer(sender, feeCollector, feeAmount);
            }

            super._transfer(sender, recipient, rest);
        } else {
            // standard no‑fee move
            super._transfer(sender, recipient, amount);
        }
    }
}
