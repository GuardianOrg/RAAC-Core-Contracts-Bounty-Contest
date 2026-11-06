// // SPDX-License-Identifier: BUSL-1.1
// pragma solidity ^0.8.19;

// import "../../../core/tokens/veRAACToken.sol";
// import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// import "../../../libraries/governance/LockManager.sol";

// /**
//  * @title Mock Vote Escrowed Token
//  * @notice A mock implementation of veRAACToken that allows easier testing by bypassing lock requirements
//  * @dev Inherits from veRAACToken but overrides locking mechanism for testing flexibility
//  */
// contract MockVeToken is veRAACToken {
//     // Mock RAAC token for testing
//     MockRAACToken private immutable _mockRaac;

//     constructor() veRAACToken(address(_mockRaac = new MockRAACToken())) {
//         // Transfer initial tokens to this contract for distribution
//         _mockRaac.transfer(address(this), _mockRaac.balanceOf(msg.sender));
//     }

//     // Helper functions for testing
//     function mint(address to, uint256 amount) external {
//         require(_mockRaac.balanceOf(address(this)) >= amount, "Insufficient mock token balance");
//         _mockRaac.transfer(to, amount);
//         // Create a mock lock that lasts for 4 years
//         uint256 unlockTime = block.timestamp + 4 * 365 days;
        
//         // Create the lock directly by manipulating state
//         _checkpointUser(
//             to,
//             LockManager.Lock(0, 0, false), // Old lock (empty)
//             LockManager.Lock(amount, unlockTime, false) // New lock
//         );
//     }

//     function setBalance(address account, uint256 balance) external {
//         // Create a mock lock that lasts for 4 years
//         uint256 unlockTime = block.timestamp + 4 * 365 days;
        
//         // Create the lock directly by manipulating state
//         _checkpointUser(
//             account,
//             LockManager.Lock(0, 0, false), // Old lock (empty)
//             LockManager.Lock(balance, unlockTime, false) // New lock
//         );
//     }

//     function mock_setUserPoint(address user, uint256 bias, uint256 slope, uint256 ts) external {
//         Point memory userPoint = Point({
//             bias: int128(int256(bias)),
//             slope: int128(int256(slope)),
//             ts: ts,
//             blk: block.number
//         });
//         userPointHistory[user].push(userPoint);
//         epoch += 1;
//     }

//     // Override lock functions to be permissive for testing
//     function lock(uint256 amount, uint256 duration) external override {
//         // Skip normal validations, just create the lock
//         uint256 unlockTime = block.timestamp + duration;
//         _checkpointUser(
//             msg.sender,
//             LockManager.Lock(0, 0, false), // Old lock (empty)
//             LockManager.Lock(amount, unlockTime, false) // New lock
//         );
//     }

//     function extend(uint256 newDuration) external override {
//         // Skip validations, just extend the lock
//         uint256 newUnlockTime = block.timestamp + newDuration;
//         LockManager.Lock memory currentLock = LockManager.Lock(
//             balanceOf(msg.sender),
//             locks[msg.sender].end,
//             false
//         );
//         _checkpointUser(
//             msg.sender,
//             currentLock,
//             LockManager.Lock(currentLock.amount, newUnlockTime, false)
//         );
//     }

//     function increase(uint256 amount) external override {
//         // Skip validations, just increase the amount
//         LockManager.Lock memory currentLock = LockManager.Lock(
//             balanceOf(msg.sender),
//             locks[msg.sender].end,
//             false
//         );
//         _checkpointUser(
//             msg.sender,
//             currentLock,
//             LockManager.Lock(currentLock.amount + amount, currentLock.end, false)
//         );
//     }

//     function withdraw() external override {
//         // Skip validations, just clear the lock
//         LockManager.Lock memory currentLock = LockManager.Lock(
//             balanceOf(msg.sender),
//             locks[msg.sender].end,
//             false
//         );
//         _checkpointUser(
//             msg.sender,
//             currentLock,
//             LockManager.Lock(0, 0, false)
//         );
//     }

//     // Override any time-sensitive functions to be more testing-friendly
//     function balanceOfAt(address account, uint256) public view override returns (uint256) {
//         return balanceOf(account);
//     }

//     function totalSupplyAt(uint256) public view override returns (uint256) {
//         return totalSupply();
//     }
// }

// // Simple mock RAAC token for testing
// contract MockRAACToken is ERC20 {
//     constructor() ERC20("Mock RAAC", "mRAAC") {
//         _mint(msg.sender, 1000000 * 10**18); // Mint 1M tokens to deployer
//     }
// }

