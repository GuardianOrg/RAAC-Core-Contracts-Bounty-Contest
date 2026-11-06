import fs from 'fs';
import path from 'path';
import { id } from 'ethers';

interface ErrorMapping {
  [selector: string]: {
    name: string;
    signature: string;
    message: string;
    contract?: string;
    inputs?: Array<{
      name: string;
      type: string;
      internalType: string;
    }>;
  };
}

// Custom error messages based on error names
const ERROR_MESSAGES: Record<string, string> = {
  // Access Control
  'AccessControlBadConfirmation': 'Invalid access control confirmation',
  'AccessControlUnauthorizedAccount': 'Account does not have required permissions',
  'AccessDenied': 'Access denied - insufficient permissions',
  
  // Adapter Errors
  'AdapterAlreadySupported': 'This adapter is already supported',
  'AdapterNotSupported': 'This adapter is not supported',
  
  // Address Errors
  'AddressCannotBeZero': 'Address cannot be zero',
  'AddressEmptyCode': 'Target address has no code',
  'AddressInsufficientBalance': 'Insufficient balance for operation',
  
  // Amount Errors
  'AmountDifferentThanRequested': 'Amount differs from requested amount',
  'ApprovalFailed': 'Token approval failed',
  
  // Compliance
  'BlacklistedAddress': 'Address is blacklisted',
  
  // Pool Errors
  'BorrowCapReached': 'Borrow cap has been reached',
  'BorrowThresholdTooHigh': 'Borrow threshold is too high',
  'CannotBorrowUnderLiquidation': 'Cannot borrow while under liquidation',
  'CannotDepositWhenUnderLiquidation': 'Cannot deposit while under liquidation',
  'CannotRepayUnderLiquidationWithoutInsurance': 'Cannot repay under liquidation without insurance',
  'CannotWithdrawInSameBlock': 'Cannot withdraw in the same block',
  'CannotWithdrawUnderLiquidation': 'Cannot withdraw while under liquidation',
  'CapExceedSupply': 'Cap exceeds available supply',
  'CapZero': 'Cap cannot be zero',
  'DebtNotZero': 'Debt must be zero for this operation',
  'SupplyCapReached': 'Supply cap has been reached',
  
  // Pause Errors
  'EnforcedPause': 'Contract is paused',
  'ExpectedPause': 'Contract should be paused',
  
  // General Errors
  'FailedInnerCall': 'Internal call failed',
  'GracePeriodExpired': 'Grace period has expired',
  'InsufficientAllowance': 'Insufficient allowance for operation',
  'InsufficientBalance': 'Insufficient balance for operation',
  'InvalidAmount': 'Invalid amount provided',
  'InvalidCollateralRatio': 'Invalid collateral ratio',
  'InvalidHealthFactor': 'Invalid health factor',
  'InvalidLiquidationThreshold': 'Invalid liquidation threshold',
  'InvalidParameter': 'Invalid parameter provided',
  'InvalidPrice': 'Invalid price provided',
  'InvalidToken': 'Invalid token address',
  'LiquidationNotAllowed': 'Liquidation is not allowed',
  'NoLiquidationAvailable': 'No liquidation available',
  'NotEnoughLiquidity': 'Not enough liquidity available',
  'OperationNotAllowed': 'Operation is not allowed',
  'Overflow': 'Arithmetic overflow occurred',
  'Paused': 'Contract is paused',
  'ReentrancyGuardReentrantCall': 'Reentrant call detected',
  'ReserveAlreadyInitialized': 'Reserve is already initialized',
  'ReserveNotActive': 'Reserve is not active',
  'ReserveNotInitialized': 'Reserve is not initialized',
  'SafeERC20FailedOperation': 'SafeERC20 operation failed',
  'TransferFailed': 'Token transfer failed',
  'Unauthorized': 'Unauthorized operation',
  'Underflow': 'Arithmetic underflow occurred',
  'VaultNotOpen': 'Vault is not open',
  'WithdrawalNotAllowed': 'Withdrawal is not allowed',
  
  // Custom contract-specific errors
  'InvalidOraclePrice': 'Invalid oracle price received',
  'PriceStale': 'Oracle price is stale',
  'InvalidRandomSeed': 'Invalid random seed provided',
  'RandomSeedNotReady': 'Random seed is not ready',
  'NFTNotAvailable': 'NFT is not available',
  'InvalidNFTId': 'Invalid NFT ID provided',
  'NFTAlreadyDeposited': 'NFT is already deposited',
  'NFTNotDeposited': 'NFT is not deposited',
  'InvalidVaultPosition': 'Invalid vault position',
  'PositionNotOpen': 'Position is not open',
  'InvalidCollateral': 'Invalid collateral provided',
  'CollateralNotSupported': 'Collateral is not supported',
  'InvalidDebtToken': 'Invalid debt token',
  'DebtTokenNotSupported': 'Debt token is not supported',
  'InvalidLiquidationProxy': 'Invalid liquidation proxy',
  'InvalidVaultProxy': 'Invalid vault proxy',
  'InvalidComplianceRegistry': 'Invalid compliance registry',
  'InvalidPrimeRate': 'Invalid prime rate',
  'InvalidAdmin': 'Invalid admin address',
  'InvalidReserveAsset': 'Invalid reserve asset',
  'InvalidRToken': 'Invalid R token',
  'InvalidDebtTokenAddress': 'Invalid debt token address',
  'InvalidLiquidationProxyAddress': 'Invalid liquidation proxy address',
  'InvalidVaultProxyAddress': 'Invalid vault proxy address',
  'InvalidComplianceRegistryAddress': 'Invalid compliance registry address',
  'InvalidInitialPrimeRate': 'Invalid initial prime rate',
  'InvalidAdminAddress': 'Invalid admin address',
};

function walkDir(dir: string): string[] {
  const files: string[] = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (item.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

function generateErrorMap(): ErrorMapping {
  const errorMap: ErrorMapping = {};
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  
  if (!fs.existsSync(artifactsDir)) {
    console.error('Artifacts directory not found');
    process.exit(1);
  }
  
  const jsonFiles = walkDir(artifactsDir);
  
  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(content);
      
      if (!json.abi || !Array.isArray(json.abi)) continue;
      
      const contractName = json.contractName || path.basename(filePath, '.json');
      
      for (const item of json.abi) {
        if (item.type !== 'error') continue;
        
        const inputs = item.inputs || [];
        const signature = `${item.name}(${inputs.map((input: any) => input.type).join(',')})`;
        const selector = id(signature).slice(0, 10).toLowerCase();
        
        // Skip if already processed (first occurrence wins)
        if (errorMap[selector]) continue;
        
        const customMessage = ERROR_MESSAGES[item.name] || 
          `${item.name.replace(/([A-Z])/g, ' $1').trim()} error occurred`;
        
        errorMap[selector] = {
          name: item.name,
          signature,
          message: customMessage,
          contract: contractName,
          inputs: inputs.map((input: any) => ({
            name: input.name || '',
            type: input.type,
            internalType: input.internalType || input.type,
          })),
        };
      }
    } catch (error) {
      console.warn(`Failed to process ${filePath}:`, error);
    }
  }
  
  return errorMap;
}

function main() {
  console.log('🔍 Scanning ABIs for error definitions...');
  
  const errorMap = generateErrorMap();
  const outputPath = path.join(process.cwd(), 'generated', 'errorMap.json');
  
  // Ensure generated directory exists
  const generatedDir = path.dirname(outputPath);
  if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true });
  }
  
  // Write the error map
  fs.writeFileSync(outputPath, JSON.stringify(errorMap, null, 2));
  
  console.log(`✅ Generated error map with ${Object.keys(errorMap).length} errors`);
  console.log(`📁 Output: ${outputPath}`);
  
  // Show some examples
  const examples = Object.entries(errorMap).slice(0, 5);
  console.log('\n📋 Examples:');
  for (const [selector, info] of examples) {
    console.log(`  ${selector} → ${info.name}: ${info.message}`);
  }
}

if (require.main === module) {
  main();
} 