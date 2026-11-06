// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title MockChainlinkAggregator
 * @dev Mock implementation of Chainlink AggregatorV3Interface for testing
 */
contract MockChainlinkAggregator is AggregatorV3Interface {
    uint8 private _decimals;
    string private _description;
    uint256 private _version;
    
    int256 private _latestAnswer;
    uint256 private _latestTimestamp;
    uint80 private _latestRound;
    
    // Store historical data for getRoundData
    mapping(uint80 => Round) private rounds;
    
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }
    
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    
    constructor(
        uint8 decimals_,
        string memory description_,
        int256 initialAnswer_
    ) {
        _decimals = decimals_;
        _description = description_;
        _version = 1;
        _latestAnswer = initialAnswer_;
        _latestTimestamp = block.timestamp;
        _latestRound = 1;
        
        // Store initial round
        rounds[_latestRound] = Round({
            answer: initialAnswer_,
            startedAt: block.timestamp,
            updatedAt: block.timestamp,
            answeredInRound: _latestRound
        });
    }
    
    /**
     * @dev Updates the price (only for testing)
     * @param newAnswer New price to set
     */
    function updateAnswer(int256 newAnswer) external {
        _latestRound++;
        _latestAnswer = newAnswer;
        _latestTimestamp = block.timestamp;
        
        rounds[_latestRound] = Round({
            answer: newAnswer,
            startedAt: block.timestamp,
            updatedAt: block.timestamp,
            answeredInRound: _latestRound
        });
        
        emit AnswerUpdated(newAnswer, _latestRound, block.timestamp);
    }
    
    /**
     * @dev Updates price with custom timestamp (for staleness testing)
     * @param newAnswer New price to set
     * @param timestamp Custom timestamp
     */
    function updateAnswerWithTimestamp(int256 newAnswer, uint256 timestamp) external {
        _latestRound++;
        _latestAnswer = newAnswer;
        _latestTimestamp = timestamp;
        
        rounds[_latestRound] = Round({
            answer: newAnswer,
            startedAt: timestamp,
            updatedAt: timestamp,
            answeredInRound: _latestRound
        });
        
        emit AnswerUpdated(newAnswer, _latestRound, timestamp);
    }

    // AggregatorV3Interface implementation
    function decimals() external view override returns (uint8) {
        return _decimals;
    }
    
    function description() external view override returns (string memory) {
        return _description;
    }
    
    function version() external view override returns (uint256) {
        return _version;
    }
    
    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (
            _latestRound,
            _latestAnswer,
            _latestTimestamp,
            _latestTimestamp,
            _latestRound
        );
    }
    
    function getRoundData(uint80 roundId)
        external
        view
        override
        returns (
            uint80 id,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        Round memory round = rounds[roundId];
        require(round.updatedAt > 0, "No data present");
        
        return (
            roundId,
            round.answer,
            round.startedAt,
            round.updatedAt,
            round.answeredInRound
        );
    }
}