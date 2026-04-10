export const CONTRACT_ADDRESS = '0x7F673790C08Ddf27c0Aa6fa9526CCC8dAaB081Ec';
export const FEE_RECIPIENT_ADDRESS = '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce';
export const INDEXER_URL = process.env.NEXT_PUBLIC_BASE_INDEXER_URL || 'https://evm.privacycash.org';
export const BASE_SEPOLIA_RPC = process.env.NEXT_PUBLIC_BASE_RPC || 'https://mainnet.base.org';

export const RENT_FEE = 0.00025
export const FEE_RATE = 35; // 0.35% (basis points out of 10000)

export const SIGN_PRIVACY_MESSAGE = 'Privacy Money account sign in';

export const MIN_DEPOSIT_AMOUNT = 0.001; // Minimum deposit amount in ETH
export const MIN_WITHDRAWAL_AMOUNT = 0.001; // Minimum withdrawal amount in ETH


// usdc constants
export const PRIVATE_USDC_CONTRACT_ADDRESS = '0xe91dd4AB03909f5CEb87f42B4308B222995a905b'
export const USDC_CONTRACT_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;
export const MIN_USDC_DEPOSIT_AMOUNT = 2;
export const MIN_USDC_WITHDRAWAL_AMOUNT = 2;
export const USDC_RENT_FEE = 0.5;
