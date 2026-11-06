#!/bin/bash
counter=1
while true; do
    echo "Test run #$counter"
    if ! npm run test; then
        echo "Test failed on run #$counter"
        exit 1
    fi
    ((counter++))
done
