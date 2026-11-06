// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only mocks that let the REAL RAACLiquidLocker run end-to-end without the full veRAAC /
///      vault / zap stack. They implement only the functions the locker actually calls.

/// Mintable ERC20 used for both RAAC and leRAAC in the simulation.
contract SimToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function burn(uint256 amt) external { _burn(msg.sender, amt); }
    function burnFrom(address a, uint256 amt) external { _burn(a, amt); } // sim: no allowance check
}

/// Non-zero placeholder for zap (never called in the simulated flows).
contract SimStub {}

/// Minimal maturity vault: distribute() pulls the reward RAAC the locker just approved. Enough for the
/// locker's _distribute path so donate()/reward accrual works. Reward accounting (accRewardPerShare,
/// debt offset) all lives in the locker; the vault just custodies the reward RAAC.
contract SimVault {
    IERC20 public immutable raac;
    constructor(address _raac) { raac = IERC20(_raac); }
    function distribute(address from, uint256 amount) external { raac.transferFrom(from, address(this), amount); }
    function depositFor(address, uint256) external {}
}

/// Minimal veRAAC that models per-epoch lock buckets: lock() pulls RAAC and books it into the
/// unlockTime bucket (merging same-week locks, like the real aggregation); withdraw() returns every
/// expired bucket's RAAC to the caller. Enough for the locker's deposit / _processVaultExpiredLocks
/// / withdraw paths.
contract SimVe {
    struct LockedBalance { uint112 amount; uint40 unlockTime; }

    uint256 private constant WEEK = 7 days;
    IERC20 public immutable raac;
    uint256 public minLock = 1e18;
    mapping(address => LockedBalance[]) internal _lk;

    constructor(address _raac) { raac = IERC20(_raac); }

    function _roundUpToWeek(uint256 ts) private pure returns (uint256 r) {
        r = (ts / WEEK) * WEEK;
        r = r + (ts % WEEK == 0 ? 0 : WEEK);
    }

    function lock(uint256 amount, uint40 epochs) external {
        raac.transferFrom(msg.sender, address(this), amount);
        uint256 maxTime = uint256(epochs) * WEEK;
        uint256 ut = _roundUpToWeek(block.timestamp + maxTime);
        if (ut > block.timestamp + maxTime) ut -= WEEK;

        LockedBalance[] storage ls = _lk[msg.sender];
        for (uint256 i; i < ls.length; i++) {
            if (ls[i].unlockTime == uint40(ut)) { ls[i].amount += uint112(amount); return; }
        }
        ls.push(LockedBalance(uint112(amount), uint40(ut)));
        // keep ascending by unlockTime (the locker scans getLocks and breaks on first non-expired)
        for (uint256 i = ls.length - 1; i > 0; i--) {
            if (ls[i].unlockTime < ls[i - 1].unlockTime) {
                LockedBalance memory tmp = ls[i]; ls[i] = ls[i - 1]; ls[i - 1] = tmp;
            } else break;
        }
    }

    function withdraw() external returns (uint256 total) {
        LockedBalance[] storage ls = _lk[msg.sender];
        for (uint256 i; i < ls.length; i++) {
            if (ls[i].amount > 0 && ls[i].unlockTime <= block.timestamp) {
                total += ls[i].amount;
                ls[i].amount = 0;
            }
        }
        require(total > 0, "nothing expired");
        raac.transfer(msg.sender, total);
    }

    function getLocks(address a) external view returns (LockedBalance[] memory out) {
        LockedBalance[] storage ls = _lk[a];
        uint256 c;
        for (uint256 i; i < ls.length; i++) if (ls[i].amount > 0) c++;
        out = new LockedBalance[](c);
        uint256 j;
        for (uint256 i; i < ls.length; i++) if (ls[i].amount > 0) out[j++] = ls[i];
    }

    function getMinLockAmount() external view returns (uint256) { return minLock; }

    // matches the locker's deploy-time assert: maxLockEpochs == 52, epochDuration == 7 days
    function getGlobalLockInfo() external view returns (uint256, uint40, uint40) {
        return (0, 52, uint40(WEEK));
    }

    function lockedBalanceOf(address a) external view returns (uint256 t) {
        LockedBalance[] storage ls = _lk[a];
        for (uint256 i; i < ls.length; i++) t += ls[i].amount;
    }

    // unused-but-referenced surface kept minimal
    function getRewardTokens() external pure returns (address[] memory r) { r = new address[](0); }
}
