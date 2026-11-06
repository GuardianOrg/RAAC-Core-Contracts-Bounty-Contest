// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IVaultToken
 * @author RAAC Protocol Team
 * @notice This interface is used to represent the index token for the RWA Vault.
 * @dev This interface is used to represent the index token for the RWA Vault.
 */
interface IVaultToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function setVault(address _vault) external;
    function setFeeCollector(address _feeCollector) external;
    function setFees(uint256 _swapFeeBP, uint256 _burnFeeBP) external;
    function setSwapPair(address pair, bool enabled) external;
}
