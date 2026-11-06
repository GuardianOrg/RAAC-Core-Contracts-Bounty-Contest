 // SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/**
 * @title ZKMEVerifyMock
 * @dev Simple mock contract for ZKME verification functionality
 * Main focus on hasApproved() function for testing purposes
 */
contract MockZKMEVerifyUpgradeable {
    // Mapping: cooperator => user => approved status
    mapping(address => mapping(address => bool)) private _approvals;
    
    // Mapping: cooperator => user => tokenId (for more advanced mocking if needed)
    mapping(address => mapping(address => uint256)) private _userTokenIds;
    
    // Events
    event Approve(address indexed cooperator, address indexed user, uint256 tokenId);
    event Revoke(address indexed cooperator, address indexed user, uint256 tokenId);
    
    /**
     * @dev Main function used by external contracts
     * Returns whether a user has been approved by a cooperator
     */
    function hasApproved(
        address cooperator,
        address user
    ) public view returns (bool) {
        return _approvals[cooperator][user];
    }

    /**
     * @dev Main function used by external contracts
     * Returns whether a user has been verified by a cooperator
     */
    function verify(
        address cooperator,
        address user
    ) public view returns (bool) {
        return _approvals[cooperator][user];
    }
    
    /**
     * @dev Mock function to set approval status for testing
     * In real contract, this would be done through complex approval process
     */
    function mockApprove(
        address cooperator,
        address user,
        uint256 tokenId
    ) external {
        _approvals[cooperator][user] = true;
        _userTokenIds[cooperator][user] = tokenId;
        emit Approve(cooperator, user, tokenId);
    }
    
    /**
     * @dev Mock function to revoke approval for testing
     */
    function mockRevoke(
        address cooperator,
        address user
    ) external {
        uint256 tokenId = _userTokenIds[cooperator][user];
        _approvals[cooperator][user] = false;
        _userTokenIds[cooperator][user] = 0;
        emit Revoke(cooperator, user, tokenId);
    }
    
    /**
     * @dev Get user's token ID (for testing purposes)
     */
    function getUserTokenId(
        address cooperator,
        address user
    ) external view returns (uint256) {
        return _userTokenIds[cooperator][user];
    }
    
    /**
     * @dev Batch approve multiple users for testing convenience
     */
    function mockBatchApprove(
        address cooperator,
        address[] calldata users,
        uint256[] calldata tokenIds
    ) external {
        require(users.length == tokenIds.length, "Arrays length mismatch");
        
        for (uint256 i = 0; i < users.length; i++) {
            _approvals[cooperator][users[i]] = true;
            _userTokenIds[cooperator][users[i]] = tokenIds[i];
            emit Approve(cooperator, users[i], tokenIds[i]);
        }
    }
    
    /**
     * @dev Check if user is approved and return token ID
     */
    function getApprovalInfo(
        address cooperator,
        address user
    ) external view returns (bool approved, uint256 tokenId) {
        approved = _approvals[cooperator][user];
        tokenId = _userTokenIds[cooperator][user];
    }
    
    /**
     * @dev Reset all approvals for a cooperator (useful for testing)
     */
    function mockResetCooperator(address cooperator, address[] calldata users) external {
        for (uint256 i = 0; i < users.length; i++) {
            _approvals[cooperator][users[i]] = false;
            _userTokenIds[cooperator][users[i]] = 0;
        }
    }
}