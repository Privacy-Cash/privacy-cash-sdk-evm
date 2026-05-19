import { BASE_NETWORK } from './networkConfig.js';

// Backward-compatible re-exports — all resolve to the Base network.
// For multi-chain support, pass a `network` (NetworkConfig | chainId) to SDK functions.
export const CONTRACT_ADDRESS = BASE_NETWORK.etherPoolAddress;
export const FEE_RECIPIENT_ADDRESS = BASE_NETWORK.feeRecipientAddress;
export const INDEXER_URL = BASE_NETWORK.indexerUrl;
export const BASE_SEPOLIA_RPC = BASE_NETWORK.rpcUrl;

export const SIGN_PRIVACY_MESSAGE = 'Privacy Money account sign in';

export const PRIVATE_USDC_CONTRACT_ADDRESS = BASE_NETWORK.usdcPoolAddress;
export const USDC_CONTRACT_ADDRESS = BASE_NETWORK.usdcTokenAddress;
export const USDC_DECIMALS = 6;
