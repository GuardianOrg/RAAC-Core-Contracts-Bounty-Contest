const { ethers } = await import("npm:ethers@6.10.0");

// Validate required secrets - updated to match oracle.env names
const requiredSecrets = ['SXT_API_KEY', 'ATTESTATIONS_AUDITOR_BISCUIT', 'ATTESTATION_BATCHES_BISCUIT', 'ATTESTATIONS_BISCUIT', 'BLOCKCHAINS_BISCUIT'];
for (const secret of requiredSecrets) {
    if (!secrets[secret]) {
        throw new Error(`Missing required secret: ${secret}`);
    }
}

console.log('All secrets validated successfully');

try {
    // Parse and validate arguments - FIXED: Handle single string argument
    if (!args || args.length < 3) {
        throw new Error("Missing required arguments: [chain_id, asset_contract_address, token_id]");
    }

    const chainId = parseInt(args[0]);
    const assetContractAddress = args[1];
    const tokenId = parseInt(args[2]);

    console.log(`Input params - Chain: ${chainId}, Asset: ${assetContractAddress}, Token: ${tokenId}`);

    // Validate inputs
    if (isNaN(chainId) || chainId <= 0) {
        throw new Error(`Invalid chain_id: ${chainId}`);
    }

    if (isNaN(tokenId) || tokenId < 0) {
        throw new Error(`Invalid token_id: ${tokenId}`);
    }

    // Validate and format address
    let formattedAddress;
    try {
        formattedAddress = ethers.getAddress(assetContractAddress);
        console.log(`Address formatted: ${formattedAddress}`);
    } catch (error) {
        throw new Error(`Invalid Ethereum address: ${assetContractAddress}`);
    }

    // Prepare headers - updated to use correct secret name
    const headers = {
        "accept": "application/json",
        "apikey": secrets.SXT_API_KEY,
        "content-type": "application/json"
    };

    // Prepare SQL query
    const sqlQuery = `SELECT a.fractional_amount, a.token_id, a.asset_contract_address, a.audited, ab.fractional_unit, ab.fractional_decimals, ab.fractional_token_contract_address, ab.audit_timestamp, a.updated_at, b.chain_id FROM IDM.ATTESTATIONS a JOIN IDM.ATTESTATION_BATCHES ab ON a.attestation_batch_id = ab.id JOIN IDM.BLOCKCHAINS b on ab.blockchain_id = b.id WHERE a.asset_contract_address = '${formattedAddress}' AND a.token_id = ${tokenId} AND a.audited = true AND ab.active = true AND ab.public = true and b.chain_id = '${chainId}' ORDER BY ab.audit_timestamp DESC, a.updated_at DESC LIMIT 1`;

    console.log('SQL query prepared');

    // Validate biscuits before creating payload - updated to use correct secret names
    const biscuitValues = [
        secrets.ATTESTATIONS_AUDITOR_BISCUIT,
        secrets.ATTESTATION_BATCHES_BISCUIT,
        secrets.ATTESTATIONS_BISCUIT,
        secrets.BLOCKCHAINS_BISCUIT
    ];

    console.log('Checking individual biscuits...');
    biscuitValues.forEach((biscuit, index) => {
        const biscuitNames = ['ATTESTATIONS_AUDITOR_BISCUIT', 'ATTESTATION_BATCHES_BISCUIT', 'ATTESTATIONS_BISCUIT', 'BLOCKCHAINS_BISCUIT'];
        console.log(`Biscuit ${index} (${biscuitNames[index]}): ${biscuit ? 'present' : 'MISSING/UNDEFINED'}`);
        if (!biscuit || biscuit === 'undefined' || typeof biscuit === 'undefined') {
            throw new Error(`Biscuit ${biscuitNames[index]} is undefined or missing`);
        }
    });

    // Prepare payload with validated biscuits
    const payload = {
        biscuits: biscuitValues,
        sqlText: sqlQuery,
        parameters: []
    };

    console.log(`Payload prepared with ${biscuitValues.length} validated biscuits`);

    // Make API request
    console.log('Making API request...');
    const response = await Functions.makeHttpRequest({
        url: "https://proxy.api.makeinfinite.dev/v1/sql",
        method: "POST",
        headers: headers,
        data: payload,
        timeout: 30000
    });

    console.log(`Response status: ${response.status}`);

    // Check for errors
    if (response.status !== 200) {
        throw new Error(`API request failed with status ${response.status}`);
    }

    if (!response.data) {
        throw new Error('No data in API response');
    }

    // Extract data array
    let dataArray;
    if (Array.isArray(response.data)) {
        dataArray = response.data;
    } else if (response.data.data && Array.isArray(response.data.data)) {
        dataArray = response.data.data;
    } else {
        throw new Error('Unexpected API response format');
    }

    if (dataArray.length === 0) {
        throw new Error('No attestation records found');
    }

    const attestationData = dataArray[0];
    console.log(`Found attestation data for token ${attestationData.TOKEN_ID || attestationData.token_id}`);

    // Extract fractional amount
    const fractionalAmount = attestationData.FRACTIONAL_AMOUNT || attestationData.fractional_amount;
    const fractionalDecimals = attestationData.FRACTIONAL_DECIMALS || attestationData.fractional_decimals || 18;

    console.log(`Extracted - Amount: ${fractionalAmount}, Decimals: ${fractionalDecimals}`);

    if (fractionalAmount === undefined || fractionalAmount === null) {
        throw new Error('Fractional amount not found in response');
    }

    if (fractionalAmount <= 0) {
        throw new Error(`Invalid fractional amount: ${fractionalAmount}`);
    }

    // Convert to wei
    const decimals = Number(fractionalDecimals);
    const weiAmount = Math.floor(fractionalAmount * Math.pow(10, decimals));

    console.log(`Final calculation: ${fractionalAmount} * 10^${decimals} = ${weiAmount}`);

    if (weiAmount <= 0) {
        throw new Error(`Calculated wei amount is zero or negative: ${weiAmount}`);
    }

    // Return encoded uint256
    return Functions.encodeUint256(weiAmount);

} catch (error) {
    console.log(`ERROR: ${error.message}`);
    console.log(`Error stack: ${error.stack}`);
    throw error;
}