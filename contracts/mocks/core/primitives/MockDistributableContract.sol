// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../../../interfaces/core/collectors/IDistributionTarget.sol";

/**
 * @title Mock Distributable Contract
 * @notice A mock contract that implements distributeRewards for testing
 */
contract MockDistributableContract is IDistributionTarget, ERC165 {
    using SafeERC20 for IERC20;

    /**
     * @notice Distributes rewards to the contract
     * @param token The token to distribute
     * @param amount The amount to distribute
     */
    function distributeRewards(address token, uint256 amount) external returns (bool) {
        // Transfer tokens from sender to this contract
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return true;
    }

    /**
     * @notice Checks if contract supports a given interface
     * @dev Implements ERC165 interface detection
     * @param interfaceId The interface identifier to check
     * @return True if the interface is supported
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return 
            interfaceId == type(IDistributionTarget).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
