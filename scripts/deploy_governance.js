import hre from 'hardhat';
const { ethers } = hre;

async function main() {
    // Check if the local node is running
    try {
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        await provider.getNetwork();
    } catch (error) {
        console.error('\x1b[31mError: Local node not detected!\x1b[0m');
        console.log('\x1b[33mPlease start the local node first by running:\x1b[0m');
        console.log('\x1b[36mnpm run node\x1b[0m');
        process.exit(1);
    }

    console.log('\x1b[32mLocal node detected, proceeding with deployment...\x1b[0m');

    // Get signer (first account from local node)
    const [user, deployer, treasury, feeCollector] = await ethers.getSigners();
    console.log('Deploying contracts with account:', deployer.address);

    // ================ CRV ================
    // Deploy CRV Token
    console.log('\nDeploying CRV Token...');
    const CRVToken = await ethers.getContractFactory('crvUSDToken');
    const crvToken = await CRVToken.deploy(deployer.address);
    await crvToken.waitForDeployment();
    console.log('CRV Token deployed to:', await crvToken.getAddress());
    await crvToken.connect(deployer).setMinter(deployer.address);
    // Mint 100k to deployer
    await crvToken.connect(deployer).mint(deployer.address, ethers.parseEther('70000'));
    console.log('Minted', ethers.formatEther(ethers.parseEther('70000')), 'CRV tokens to deployer');
    
    // ================ USDC ================
    // Deploy USDC Token
    console.log('\nDeploying USDC Token...');
    const USDC = await ethers.getContractFactory('MockUSDC');
    const usdcToken = await USDC.deploy(ethers.parseEther('0'));
    await usdcToken.waitForDeployment();
    console.log('USDC Token deployed to:', await usdcToken.getAddress());
    // Mint 100k to deployer
    await usdcToken.connect(deployer).mint(deployer.address, ethers.parseEther('80000'));
    console.log('Minted', ethers.formatEther(ethers.parseEther('80000')), 'USDC tokens to deployer');

    // Check USDC & CRV balances
    console.log('Deployer CRV balance:', ethers.formatEther(await crvToken.balanceOf(deployer.address)));
    console.log('Deployer USDC balance:', ethers.formatEther(await usdcToken.balanceOf(deployer.address)));
    
    // ================ RAAC ================
    // Deploy RAAC Token
    console.log('\nDeploying RAAC Token...');
    const RAACToken = await ethers.getContractFactory('RAACToken');
    const raacToken = await RAACToken.deploy(
        deployer.address, // initialOwner
        100, // initialSwapTaxRate (1%)
        50  // initialBurnTaxRate (0.5%)
    );
    await raacToken.waitForDeployment();
    console.log('RAAC Token deployed to:', await raacToken.getAddress());

    // Setup
    await raacToken.connect(deployer).setFeeCollector(feeCollector.address);
    // Set owner as minter
    await raacToken.connect(deployer).setMinter(deployer.address);

    // Mint initial supply to deployer
    const initialSupply = ethers.parseEther('1000000'); // 1M tokens
    await raacToken.connect(deployer).mint(deployer.address, initialSupply);
    console.log('Minted', ethers.formatEther(initialSupply), 'RAAC tokens to deployer');

    // Send 100k to user
    await raacToken.connect(deployer).transfer(user.address, ethers.parseEther('100000'));
    console.log('Sent', ethers.formatEther(ethers.parseEther('100000')), 'RAAC tokens to user');

    // Check balances
    console.log('Deployer balance:', ethers.formatEther(await raacToken.balanceOf(deployer.address)));
    console.log('User balance:', ethers.formatEther(await raacToken.balanceOf(user.address)));

    // ================ VERAAC ================
    // Deploy veRAAC Token
    console.log('\nDeploying veRAAC Token...');
    const veRAACToken = await ethers.getContractFactory('veRAACToken');
    const veraacToken = await veRAACToken.deploy(await raacToken.getAddress());
    await veraacToken.waitForDeployment();
    console.log('veRAAC Token deployed to:', await veraacToken.getAddress());

    // ================ GAUGE CONTROLLER ================
    // Deploy Gauge Controller
    console.log('\nDeploying Gauge Controller...');
    const GaugeController = await ethers.getContractFactory('GaugeController');
    const gaugeController = await GaugeController.deploy(await veraacToken.getAddress());
    await gaugeController.waitForDeployment();
    console.log('Gauge Controller deployed to:', await gaugeController.getAddress());

    // ================ RAAC GAUGE ================
    // Deploy RAAC Gauge
    console.log('\nDeploying RAAC Gauge...');
    const RAACGauge = await ethers.getContractFactory('RAACGauge');
    const raacGauge = await RAACGauge.deploy(
        await usdcToken.getAddress(),
        await veraacToken.getAddress(),
        await gaugeController.getAddress()
    );

    await raacGauge.waitForDeployment();
    console.log('RAAC Gauge deployed to:', await raacGauge.getAddress());
    // Add RAAC Gauge to Gauge Controller
    // First grant GAUGE_ADMIN role to deployer
    await gaugeController.grantRole(await gaugeController.GAUGE_ADMIN(), deployer.address);
    await gaugeController.connect(deployer).addGauge(
        await raacGauge.getAddress(),
        // Gauge Type
        0, // GaugeType.RAAC = 0
        // Initial Weight
        10000 // WEIGHT_PRECISION
    );

    // ================ RWA GAUGE ================
    // Deploy RWA Gauge
    console.log('\nDeploying RWA Gauge...');
    const RWAGauge = await ethers.getContractFactory('RWAGauge');
    const rwaGauge = await RWAGauge.deploy(
        await usdcToken.getAddress(),
        await veraacToken.getAddress(),
        await gaugeController.getAddress()
    );
    await rwaGauge.waitForDeployment();

    await gaugeController.grantRole(await gaugeController.GAUGE_ADMIN(), deployer.address);
    await gaugeController.connect(deployer).addGauge(
        await rwaGauge.getAddress(),
        // Gauge Type
        1, // GaugeType.RWA = 1
        // Initial Weight
        10000 // WEIGHT_PRECISION
    );
    console.log('RWA Gauge deployed to:', await rwaGauge.getAddress());

    // ================ TIMELock Controller ================
    // Deploy Timelock Controller
    console.log('\nDeploying Timelock Controller...');
    const TimelockController = await ethers.getContractFactory('TimelockController');
    const timelockController = await TimelockController.deploy(
        2 * 24 * 60 * 60, // minDelay: 2 days
        [deployer.address], // proposers
        [deployer.address], // executors
        deployer.address // admin
    );
    await timelockController.waitForDeployment();
    console.log('Timelock Controller deployed to:', await timelockController.getAddress());

    // ================ GOVERNANCE ================
    // Deploy Governance
    console.log('\nDeploying Governance...');
    const Governance = await ethers.getContractFactory('Governance');
    const governance = await Governance.deploy(
        await veraacToken.getAddress(),
        await timelockController.getAddress()
    );
    await governance.waitForDeployment();
    console.log('Governance deployed to:', await governance.getAddress());

    // Print deployment summary
    console.log('\n\x1b[32m==== Deployment Complete ====\x1b[0m');
    console.log('RAAC Token:', await raacToken.getAddress());
    console.log('veRAAC Token:', await veraacToken.getAddress());
    console.log('Gauge Controller:', await gaugeController.getAddress());
    console.log('RAAC Gauge:', await raacGauge.getAddress());
    console.log('RWA Gauge:', await rwaGauge.getAddress());
    console.log('Timelock Controller:', await timelockController.getAddress());
    console.log('Governance:', await governance.getAddress());
    console.log('\nDeployer address:', deployer.address);
    console.log('Initial RAAC balance:', ethers.formatEther(await raacToken.balanceOf(deployer.address)));
    // Addresses copy-pastable only
    console.log({
        CRVToken: await crvToken.getAddress(),
        USDC: await usdcToken.getAddress(),
        RAAC: await raacToken.getAddress(),
        VERAAC: await veraacToken.getAddress(),
        GAUGE_CONTROLLER: await gaugeController.getAddress(),
        RAAC_GAUGE: await raacGauge.getAddress(),
        RWA_GAUGE: await rwaGauge.getAddress(),
        TIMELock_CONTROLLER: await timelockController.getAddress(),
        GOVERNANCE: await governance.getAddress(),
    })
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    }); 