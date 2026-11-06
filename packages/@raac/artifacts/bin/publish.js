#!/usr/bin/env node

/**
 * This script will ensure that the artifacts and typechain-types are at the latest version. 
 * It will then prepare and publish the artifacts and typechain-types to the npm registry.
 */

const fs = require("fs");
const path = require("path");

const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "..", "..", "contracts", "artifacts");
console.log({ARTIFACTS_DIR});
// const TYPECHAIN_TYPES_DIR = path.join(__dirname, "..", "..", "..", "core", "typechain-types");

const ARTIFACTS = fs.readdirSync(ARTIFACTS_DIR);
// const TYPECHAIN_TYPES = fs.readdirSync(TYPECHAIN_TYPES_DIR);

console.log(ARTIFACTS);
// console.log(TYPECHAIN_TYPES);

// console.log("Publishing artifacts and typechain-types...");

// console.log("Artifacts published successfully.");
// console.log("Typechain-types published successfully.");

// console.log("Publishing artifacts and typechain-types...");

// const artifacts = fs.readdirSync("artifacts");
// const typechainTypes = fs.readdirSync("typechain-types");

// console.log(artifacts);
// console.log(typechainTypes);

// console.log("Publishing artifacts and typechain-types...");

// console.log("Artifacts published successfully.");
// console.log("Typechain-types published successfully.");