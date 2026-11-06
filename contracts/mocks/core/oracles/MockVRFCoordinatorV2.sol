// SPDX-License-Identifier: BUSL-1.1
// A mock for testing code that relies on VRFCoordinatorV2_5.
pragma solidity ^0.8.19;

// https://docs.chain.link/vrf/v2-5/subscription/test-locally
// solhint-disable-next-line no-unused-import
import {IVRFCoordinatorV2Plus, IVRFSubscriptionV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {SubscriptionAPI} from "@chainlink/contracts/src/v0.8/vrf/dev/SubscriptionAPI.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

contract MockVRFCoordinatorV2 is VRFCoordinatorV2_5Mock {
    constructor(
        uint96 _baseFee, uint96 _gasPrice, int256 _weiPerUnitLink
    ) VRFCoordinatorV2_5Mock(_baseFee, _gasPrice, _weiPerUnitLink) {}
}
