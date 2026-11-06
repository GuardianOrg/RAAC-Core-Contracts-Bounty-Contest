#!/bin/bash

if command -v yarn >/dev/null 2>&1; then
    echo "Yarn is available. Using Yarn for installation and commands."
    PM_INSTALL="yarn install"
    PM_COMPILE_HARDHAT="yarn hardhat compile"
    PM_TSC="yarn tsc --project tsconfig.dts.json"
else
    echo "Yarn not found. Using npm for installation and commands."
    PM_INSTALL="npm install"
    PM_COMPILE_HARDHAT="npx hardhat compile"
    PM_TSC="npx tsc --project tsconfig.dts.json"
fi

CORE_DIR="../../"

if [ ! -d "$CORE_DIR" ]; then
    echo "Error: Core repository not found at $CORE_DIR. Please ensure it is available."
    exit 1
fi

echo "Compiling contracts and types in the core repository..."
cd "$CORE_DIR" || exit

# echo "Installing packages in core..."
# $PM_INSTALL > /dev/null 2>&1
# echo "Core packages installed."

# echo "Compiling contracts with Hardhat..."
# $PM_COMPILE_HARDHAT > /dev/null 2>&1
# echo "Contracts compilation completed in core."

echo "Compiling types in core..."
node compile-types.js > /dev/null 2>&1
echo "Types compilation completed in core."

# Return to the rpc folder
cd - > /dev/null

echo "Setting up RPC repository..."

echo "Installing packages in rpc..."
$PM_INSTALL > /dev/null 2>&1
echo "RPC packages installed."

# Make articafts directory if it doesn't exist
mkdir -p artifacts

echo "Copying compiled contract artifacts from core..."
cp -r ../../../artifacts/contracts/* artifacts/
echo "Contract artifacts copied to rpc."

echo "Copying typechain-types folder from core..."
cp -r ../../../typechain-types .
echo "typechain-types folder copied to rpc."

echo "Compiling TypeScript definitions in rpc..."
$PM_TSC > /dev/null 2>&1
echo "TypeScript definitions compilation completed in rpc."

echo "Removing old typechain-types folder..."
rm -rf typechain-types > /dev/null 2>&1
echo "Old typechain-types folder removed."

echo "Renaming typechain-types-dts folder to typechain-types..."
mv typechain-types-dts typechain-types
echo "Renaming completed."

echo "RPC setup complete."
