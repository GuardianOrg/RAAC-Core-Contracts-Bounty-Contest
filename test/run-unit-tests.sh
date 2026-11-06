#!/bin/bash
# Runs every unit-test directory in its OWN hardhat process.
#
# Many suites (veRAAC, lockers, gauges, minter emission schedule) legitimately
# fast-forward the chain by dozens of epochs. When all files share a single
# hardhat network, the accumulated time travel pushes block.timestamp past the
# uint32 horizon (year 2106+), breaking timestamp-packed contracts and slowing
# the EVM until tests time out. A fresh chain per directory keeps every suite
# on a sane clock.

# commented as we want to see all the errors
# set -e
# 
# Failures are collected and re-printed in a summary once every directory ran.

cd "$(dirname "$0")/.."

# mocha colors to stdout via tee
export MOCHA_COLORS=1

log_dir=$(mktemp -d)
trap 'rm -rf "$log_dir"' EXIT

failed_dirs=()
passed_dirs=()

for dir in $(find test/unit -type d | sort); do
    files=$(find "$dir" -maxdepth 1 -name '*.test.js' ! -name 'index.test.js' | sort)
    [ -z "$files" ] && continue
    echo ""
    echo "=== $dir"
    # veRAAC models mainnet cadence: consecutive blocks must not share a timestamp
    same_ts=true
    case "$dir" in
        test/unit/core/tokens) same_ts=false ;;
    esac

    log_file="$log_dir/$(echo "$dir" | tr '/' '_').log"
    ALLOW_SAME_TIMESTAMP=$same_ts npx hardhat test $files 2>&1 | tee "$log_file"
    if [ "${PIPESTATUS[0]}" -ne 0 ]; then
        failed_dirs+=("$dir")
    else
        passed_dirs+=("$dir")
    fi
done

echo ""
echo "================================================================"
echo " SUMMARY"
echo "================================================================"
echo " Passed directories: ${#passed_dirs[@]}"
echo " Failed directories: ${#failed_dirs[@]}"

if [ ${#failed_dirs[@]} -eq 0 ]; then
    echo ""
    echo " All unit tests passed."
    exit 0
fi

for dir in "${failed_dirs[@]}"; do
    log_file="$log_dir/$(echo "$dir" | tr '/' '_').log"
    echo ""
    echo "----------------------------------------------------------------"
    echo " FAILED: $dir"
    echo "----------------------------------------------------------------"

    if grep -qE '[0-9]+ failing' "$log_file"; then
        awk '/[0-9]+ failing/ { found = 1 } found' "$log_file"
    else
        tail -n 40 "$log_file"
    fi
done

echo ""
echo " Failed:"
for dir in "${failed_dirs[@]}"; do
    echo "   - $dir"
done
exit 1
