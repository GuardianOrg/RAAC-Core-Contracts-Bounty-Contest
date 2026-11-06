// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {RAACHousePriceOracle} from "../../../core/oracles/RAACHousePriceOracle.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

/**
 * @dev Exposes the internal `fulfillRequest` as a public function so our mock
 *      can call it during tests.
 */
contract TestRAACHousePriceOracle is RAACHousePriceOracle {
    constructor(
        address router,
        bytes32 donId,
        string memory source,
        FunctionsRequest.Location secretsLocation,
        bytes memory encryptedSecretsReference,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        address housePricesAddress,
        string memory raacNFTAddress
    ) RAACHousePriceOracle(router, donId, source, secretsLocation, encryptedSecretsReference, subscriptionId, callbackGasLimit, housePricesAddress, raacNFTAddress) {}

    function publicFulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) public {
        fulfillRequest(requestId, response, err);
    }
}
