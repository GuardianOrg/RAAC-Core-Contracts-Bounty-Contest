// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import "./BaseChainlinkFunctionsOracle.sol";
import "../../interfaces/core/pools/LendingPool/ILendingPool.sol";

/**
 * @title RAACPrimeRateOracle
 * @author RAAC Protocol Team
 * @dev Contract for using oracles to fetch prime rate from off-chain api
 */
contract RAACPrimeRateOracle is BaseChainlinkFunctionsOracle {
    uint256 public lastPrimeRate;
    uint256 public lastUpdateTimestamp;
    ILendingPool public lendingPool;

    /// @notice Emitted when the prime rate is updated
    event PrimeRateUpdated(uint256 primeRate);
    /// @notice Emitted when an oracle request is sent
    event PrimeRateRequestSent(bytes32 indexed requestId);

    constructor(
        address router,
        bytes32 donId,
        string memory source,
        FunctionsRequest.Location secretsLocation,
        bytes memory encryptedSecretsReference,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        address _lendingPool
    ) BaseChainlinkFunctionsOracle(router, donId, source, secretsLocation, encryptedSecretsReference, subscriptionId, callbackGasLimit) {
        lendingPool = ILendingPool(_lendingPool);
    }

    /**
     * @notice Emits request sent events
     * @param requestId The ID of the request
     */
    function _emitRequestEvents(
        bytes32 requestId,
        string[] calldata /* args */
    ) internal override {
        emit PrimeRateRequestSent(requestId);
    }

    /**
     * @notice Hook called before fulfillment to handle any pre-processing
     * @param args The arguments passed to sendRequest
     */
    function _beforeFulfill(string[] calldata args) internal override {}

    /**
     * @notice Process the response from the oracle
     * @param response The response from the oracle
     */
    function _processResponse(bytes32 requestId, bytes memory response) internal override {
        lastPrimeRate = abi.decode(response, (uint256));
        lastUpdateTimestamp = block.timestamp;
        lendingPool.setPrimeRate(lastPrimeRate);
        emit PrimeRateUpdated(lastPrimeRate);
    }

    /**
     * @notice Get the latest prime rate
     * @return The latest prime rate
     */
    function getPrimeRate() external view returns (uint256) {
        return lastPrimeRate;
    }
}
