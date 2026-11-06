export default async function deployLiquidityPool(supplyAsset, rwaIndexToken, owner, liquidationSwap, stabilityPool, feeCollector) {
    const MockLiquidityPool = await ethers.getContractFactory("MockLiquidityPool");
    const liquidityPoolFee = 100; // 1% in base

    // From curve
    const liquidityPool = await MockLiquidityPool.deploy(
        [supplyAsset.target, rwaIndexToken.target],  // coin addresses - crvUSD first, IndexToken second
        [ethers.parseUnits("1", 18), ethers.parseUnits("1", 18)],  // rate multipliers
        100,                            // A parameter
        liquidityPoolFee,               // fee (1%)
        "Mock Curve Pool",              // name
        "mCRV"                          // symbol
    );

    await liquidationSwap.setLiquidityPool(liquidityPool.target, liquidityPoolFee, 1, 0); // swap indexToken (1) -> crvUSD (0)

    const CurveLiquidityGaugeV5 = await ethers.getContractFactory("CurveLiquidityGaugeV5Mock");
    const curveLiquidityGaugeV5 = await CurveLiquidityGaugeV5.deploy();

    // await stabilityPool.setLiquidityGauge(curveLiquidityGaugeV5.target)
    await stabilityPool.setFeeCollector(feeCollector.target)
    await feeCollector.addFeeType(ethers.keccak256(ethers.toUtf8Bytes("RWA_INDEX_TOKEN_LIQUIDITY_REWARDS")), 0, 0, 0, 0, 0, 10000)
    await feeCollector.addClaimableToken(rwaIndexToken.target)

    return {
        liquidityPool,
    };
}