// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../../interfaces/IComplianceRegistry.sol";

/// @dev Interface for the ChainAnalysis Oracle
interface SanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

/// @title ComplianceRegistry
/// @author RAAC Protocol Team
/// @notice Central registry for managing protocol‐wide blacklist of addresses.
/// @dev Uses AccessControl to restrict who can add/remove addresses.
/// @dev Using ChainAnalysis Oracle for sanctions: https://go.chainalysis.com/chainalysis-oracle-docs.html
/// @dev We are combining both our own blacklist and the ChainAnalysis Oracle for sanctions.
contract ComplianceRegistry is AccessControl, IComplianceRegistry {
    /// @notice Role identifier for accounts authorized to manage the blacklist.
    bytes32 public constant BLACKLIST_ADMIN_ROLE = keccak256("BLACKLIST_ADMIN_ROLE");

    /// @dev Mapping of blacklisted addresses.
    mapping(address => bool) private _blacklisted;

    /// @dev Address of the ChainAnalysis Oracle
    address public sanctionsList;

    /// @notice Sets up roles on deployment.
    /// @dev Grants `DEFAULT_ADMIN_ROLE` and `BLACKLIST_ADMIN_ROLE` to deployer.
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BLACKLIST_ADMIN_ROLE, msg.sender);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(AccessControl, IERC165) returns (bool) {
        return interfaceId == type(IComplianceRegistry).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IComplianceRegistry
    function isBlacklisted(address user) external view override returns (bool) {
        return _blacklisted[user] || (sanctionsList != address(0) && SanctionsList(sanctionsList).isSanctioned(user));
    }

    /// @notice Adds an address to the blacklist.
    /// @dev Caller must have `BLACKLIST_ADMIN_ROLE`.
    /// @param user The address to blacklist.
    function blacklist(address user) external onlyRole(BLACKLIST_ADMIN_ROLE) {
        if (_blacklisted[user]) revert AlreadyBlacklisted();
        if (user == address(0)) revert InvalidAddress();
        _blacklisted[user] = true;
        emit Blacklisted(user);
    }

    /// @notice Removes an address from the blacklist.
    /// @dev Caller must have `BLACKLIST_ADMIN_ROLE`.
    /// @param user The address to remove.
    function unblacklist(address user) external onlyRole(BLACKLIST_ADMIN_ROLE) {   
        if (!_blacklisted[user]) revert NotBlacklisted();
        if (user == address(0)) revert InvalidAddress();
        _blacklisted[user] = false;
        emit UnBlacklisted(user);
    }

    /// @notice Adds multiple addresses to the blacklist.
    /// @dev Caller must have `BLACKLIST_ADMIN_ROLE`.
    /// @dev If the user was already blacklisted, we will do nothing.
    /// @param users The addresses to blacklist.
    function blacklistBatch(address[] calldata users) external onlyRole(BLACKLIST_ADMIN_ROLE) {
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] == address(0)) revert InvalidAddress();
            if (!_blacklisted[users[i]]) {
                _blacklisted[users[i]] = true;
                emit Blacklisted(users[i]);
            }
        }
    }

    /// @notice Removes multiple addresses from the blacklist.
    /// @dev Caller must have `BLACKLIST_ADMIN_ROLE`.
    /// @dev If the user was not blacklisted, we will do nothing.
    /// @param users The addresses to remove.
    function unblacklistBatch(address[] calldata users) external onlyRole(BLACKLIST_ADMIN_ROLE) {
        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] == address(0)) revert InvalidAddress();
            if (_blacklisted[users[i]]) {
                _blacklisted[users[i]] = false;
                emit UnBlacklisted(users[i]);
            }
        }
    }

    /// @notice Sets the address of the ChainAnalysis Oracle.
    /// @dev Caller must have `DEFAULT_ADMIN_ROLE`.
    /// @param _sanctionsList The address of the ChainAnalysis Oracle.
    function setSanctionsList(address _sanctionsList) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sanctionsList = _sanctionsList;
    }
}