#!/bin/bash

set -e

echo "ERROR: USE SETUP.SH INSTEAD"
exit 1

LOG_FILE="sync-contracts-debug.log"
exec > >(tee -a "$LOG_FILE") 2>&1

# The script will compile the smart contracts from ./core, copy the abi to ./rpc/artifacts and then copy the typechain-types
# Assuming the following directory structure:
# .
# ├── core
# │   ├── artifacts
# │   |   └── contracts
# │   └── typechain-types
# ├── rpc
# │   ├── artifacts
# │   ├── typechain-types

# Compiling the contracts
echo "Compiling the contracts..."
cd ../core
npx hardhat compile
if [ $? -eq 0 ]; then
  echo "Contracts compiled successfully."
else
  echo "Failed to compile contracts. Exiting."
  exit 1
fi

# Moving the artifacts/contracts to core/library/RPCLibrary and renaming the folder to artifacts
echo "Moving the CORE/artifacts/contracts to RPC/artifacts and renaming the folder to artifacts..."
mv artifacts/contracts ../packages/@raac/artifacts/artifacts
if [ $? -eq 0 ]; then
  echo "Moved the CORE/artifacts/contracts to RPC/artifacts successfully."
else
  echo "Failed to move the CORE/artifacts/contracts to RPC/artifacts. Exiting."
  exit 1
fi

# Move to rpc folder
cd ../packages/@raac/artifacts


# 1. Move artifacts
# 2. Compile types
# 3. Move types here
# 4. Generate .d.ts version (will throw error but will compile)
# 5. Move .d.ts version to typechain-types
# convert from .ts to .d.ts
npx tsc --project tsconfig.dts.json
rm -rf typechain-types
mv typechain-types-dts typechain-types




# Compile types
# echo "Compiling the typechain-types..."
# node compile-types.js

# if [ $? -eq 0 ]; then
#   echo "Typechain-types compiled successfully."
# else
#   echo "Failed to compile typechain-types. Exiting."
#   exit 1
# fi

# # Moving the CORE/typechain-types to RPC/typechain-types
# echo "Moving the CORE/typechain-types to RPC/typechain-types..."
# mv typechain-types ../rpc/typechain-types
# if [ $? -eq 0 ]; then
#   echo "Moved the CORE/typechain-types to RPC/typechain-types successfully."
# else
#   echo "Failed to move the CORE/typechain-types to RPC/typechain-types. Exiting."
#   exit 1
# fi


# Success message
echo "Repositories cloned and linked successfully!"