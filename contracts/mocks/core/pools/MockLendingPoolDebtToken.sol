// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "../../../interfaces/core/pools/LendingPool/ILendingPool.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../../../libraries/math/WadRayMath.sol";

contract MockLendingPoolDebtToken is ILendingPool {
    using WadRayMath for uint256;

    uint256 private _normalizedDebt;
    
    // We need to track the position index and raw debt balance for each position to ensure the debt token getPositionScaledDebt function works as expected
    struct Position {
        uint256 rawDebtBalance;
        uint256 positionIndex;
    }
    
    // user => adapter => data hash => Position
    mapping(address => mapping(address => mapping(bytes32 => Position))) private positions;
    
    struct UserPositionKey {
        address adapter;
        bytes32 dataHash;
    }
    mapping(address => UserPositionKey[]) private userPositions;
    
    function _getPositionKey(bytes calldata data) internal pure returns (bytes32) {
        return keccak256(data);
    }
    
    function _addUserPosition(address user, address adapter, bytes32 dataHash) internal {
        UserPositionKey[] storage userPos = userPositions[user];
        for (uint256 i = 0; i < userPos.length; i++) {
            if (userPos[i].adapter == adapter && userPos[i].dataHash == dataHash) {
                return; // Already exists
            }
        }
        userPos.push(UserPositionKey(adapter, dataHash));
    }
    
    function _removeUserPosition(address user, address adapter, bytes32 dataHash) internal {
        UserPositionKey[] storage userPos = userPositions[user];
        for (uint256 i = 0; i < userPos.length; i++) {
            if (userPos[i].adapter == adapter && userPos[i].dataHash == dataHash) {
                userPos[i] = userPos[userPos.length - 1];
                userPos.pop();
                break;
            }
        }
    }

    constructor() {
        _normalizedDebt = WadRayMath.RAY; // Initialize to 1.0 in RAY units
    }

    receive() external payable {}

    function setNormalizedDebt(uint256 newNormalizedDebt) external {
        _normalizedDebt = newNormalizedDebt;
    }

    function claimReward() external returns (bool) {
        // Empty implementation
        return true;
    }

    function getRAACNFTAddress() external view returns (address) {
        return address(0);
    }

    function getPositionScaledDebt(address adapter, address user, bytes calldata data) external view override returns (uint256) {
        bytes32 positionKey = _getPositionKey(data);
        Position memory position = positions[user][adapter][positionKey];
        
        if (position.positionIndex == 0 || position.rawDebtBalance == 0) {
            return position.rawDebtBalance;
        }
        
        uint256 indexMultiplier = _normalizedDebt.rayDiv(position.positionIndex);
        return position.rawDebtBalance.rayMul(indexMultiplier);
    }

    function claimCollectorRewards() external returns (address, uint256) {
        // Empty implementation
        return (address(0), 0);
    }

    function getNormalizedDebt() external view override returns (uint256) {
        return _normalizedDebt;
    }

    function getNormalizedIncome() external pure override returns (uint256) {
        return WadRayMath.RAY;
    }

    function getPendingProtocolFee() external pure override returns (uint256) {
        return 0;
    }

    function isUserDepositInSameBlock(address user) external view override returns (bool) {
        return false;
    }

    function deposit(uint256 amount) external override {
        // Empty implementation
    }

    function withdraw(uint256 amount) external override {
        // Empty implementation
    }

    function borrow(address adapter, bytes calldata data, uint256 amount) external override {
        // Empty implementation
    }

    function repay(address adapter, bytes calldata data, uint256 amount) external override {
        // Empty implementation
    }

    function repayOnBehalf(address adapter, bytes calldata data, uint256 amount, address onBehalfOf) external override {
        // Empty implementation
    }

    function depositAsset(address adapter, bytes calldata data) external override {
        // Empty implementation
    }

    function withdrawAsset(address adapter, bytes calldata data) external override {
        // Empty implementation
    }

    function updateState() external override {
        // Empty implementation
    }

    function rebalanceLiquidity() external override {
        // Empty implementation
    }

    function initiateLiquidation(address adapter, address user, bytes calldata data) external override {
        // Empty implementation
    }

    function closeLiquidation(address adapter, bytes calldata data) external override {
        // Empty implementation
    }

    function finalizeLiquidation(address adapter, address user, bytes calldata data) external override {
        // Empty implementation
    }

    function calculateHealthFactor(address adapter, address user, bytes calldata data) external pure override returns (uint256) {
        return 0;
    }

    function getUserCollateralValue(address user) external pure override returns (uint256) {
        return 0;
    }

    function getPositionDebt(address adapter, address user, bytes calldata data) external view override returns (uint256) {
        bytes32 positionKey = _getPositionKey(data);
        return positions[user][adapter][positionKey].rawDebtBalance;
    }

    function getPosition(address adapter, address user, bytes calldata data) external view override returns (CollateralPosition memory) {
        return CollateralPosition({
            rawDebtBalance: 0,
            isUnderLiquidation: false,
            liquidationStartTime: 0,
            positionIndex: 0,
            isInsured: false,
            rawInsuredBalance: 0
        });
    }

    function getPositionData(address adapter, address user, bytes calldata data) external view override returns (uint256, uint256) {
        bytes32 positionKey = _getPositionKey(data);
        Position memory position = positions[user][adapter][positionKey];
        return (position.positionIndex, position.rawDebtBalance);
    }

    function getPositionsScaledDebt(address userAddress) external view override returns (uint256) {
        uint256 totalScaledDebt = 0;
        
        // Iterate through all positions for this user
        UserPositionKey[] memory userPos = userPositions[userAddress];
        
        for (uint256 i = 0; i < userPos.length; i++) {
            Position memory position = positions[userAddress][userPos[i].adapter][userPos[i].dataHash];
            
            if (position.positionIndex > 0 && position.rawDebtBalance > 0) {
                // Scale the debt: raw * (currentIndex / positionIndex)
                uint256 indexMultiplier = _normalizedDebt.rayDiv(position.positionIndex);
                totalScaledDebt += position.rawDebtBalance.rayMul(indexMultiplier);
            }
        }
        
        return totalScaledDebt;
    }
    
    function getAssetValue(address, address, bytes calldata) external pure override returns (uint256) {
        return 0;
    }
    function setParameter(OwnerParameter param, uint256 newValue) external override {
        // Empty implementation
    }

    function setPrimeRate(uint256 newPrimeRate) external override {
        // Empty implementation
    }

    function setStabilityPool(address newStabilityPool) external override {
        // Empty implementation
    }

    function supportedAdapter(address _adapter) external override returns(bool) {
        return true;
    }

    function openVaultPosition() external {
        
    }
    
    function notifyMint(address adapter, address user, bytes calldata data, uint256 amount) external {
        bytes32 positionKey = _getPositionKey(data);
        Position storage position = positions[user][adapter][positionKey];
        
        if (position.positionIndex == 0) {
            position.positionIndex = _normalizedDebt;
            _addUserPosition(user, adapter, positionKey);
        }
        
        position.rawDebtBalance += amount;
    }
    
    function notifyBurn(address adapter, address user, bytes calldata data, uint256 amount) external {
        bytes32 positionKey = _getPositionKey(data);
        Position storage position = positions[user][adapter][positionKey];
        
        if (position.rawDebtBalance >= amount) {
            position.rawDebtBalance -= amount;
        } else {
            position.rawDebtBalance = 0;
        }
        
        if (position.rawDebtBalance == 0) {
            position.positionIndex = 0;
            _removeUserPosition(user, adapter, positionKey);
        }
    }
}