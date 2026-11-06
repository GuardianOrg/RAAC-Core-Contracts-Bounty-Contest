// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {RAACPrimeRateOracle} from "../../../core/oracles/RAACPrimeRateOracle.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

/**
 * @dev Exposes the internal `fulfillRequest` as a public function so our mock
 *      can call it during tests.
 */
contract TestRAACPrimeRateOracle is RAACPrimeRateOracle {
    constructor(
        address router,
        bytes32 donId,
        string memory source,
        FunctionsRequest.Location secretsLocation,
        bytes memory encryptedSecretsReference,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        address _lendingPool
    ) RAACPrimeRateOracle(router, donId, source, secretsLocation, encryptedSecretsReference, subscriptionId, callbackGasLimit, _lendingPool) {}

    function publicFulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) public {
        fulfillRequest(requestId, response, err);
    }
}
