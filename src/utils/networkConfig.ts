export interface NetworkConfig {
    chainId: number;
    /** Short identifier used in API calls and DB table prefixes: 'base' | 'eth' */
    chainKey: 'base' | 'eth';
    rpcUrl: string;
    indexerUrl: string;
    etherPoolAddress: string;
    usdcPoolAddress: string;
    usdcTokenAddress: string;
    feeRecipientAddress: string;
    /** Namespace prefix for local UTXO cache files. Base keeps legacy names. */
    cachePrefix: string;
    usdcDecimals: number;
    /** Average block time in ms — used to scale confirmation polling timeouts. */
    blockTimeMs: number;
}

export const BASE_NETWORK: NetworkConfig = {
    chainId: 8453,
    chainKey: 'base',
    rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC || 'https://mainnet.base.org',
    indexerUrl: process.env.NEXT_PUBLIC_EVM_INDEXER_URL || 'https://evm.privacycash.org',
    etherPoolAddress: '0x7F673790C08Ddf27c0Aa6fa9526CCC8dAaB081Ec',
    usdcPoolAddress: '0xe91dd4AB03909f5CEb87f42B4308B222995a905b',
    usdcTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    feeRecipientAddress: '0x9f1d0c72a50088172220990474f97A63854949CF',
    cachePrefix: 'base',
    usdcDecimals: 6,
    blockTimeMs: 2000,
};

export const ETH_NETWORK: NetworkConfig = {
    chainId: 1,
    chainKey: 'eth',
    rpcUrl: process.env.NEXT_PUBLIC_ETH_RPC || 'https://eth.drpc.org',
    indexerUrl: process.env.NEXT_PUBLIC_EVM_INDEXER_URL || 'https://evm.privacycash.org',
    etherPoolAddress: process.env.NEXT_PUBLIC_ETH_ETHER_POOL_ADDRESS || '0x77A10AE3E513c2D73D73eb52212c6918C8830dd0',
    usdcPoolAddress: process.env.NEXT_PUBLIC_ETH_USDC_POOL_ADDRESS || '',
    usdcTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    feeRecipientAddress: process.env.NEXT_PUBLIC_ETH_FEE_RECIPIENT_ADDRESS || '0x9f1d0c72a50088172220990474f97A63854949CF',
    cachePrefix: 'eth',
    usdcDecimals: 6,
    blockTimeMs: 12000,
};

export const NETWORKS: Record<number, NetworkConfig> = {
    8453: BASE_NETWORK,
    1: ETH_NETWORK,
};

export function getNetworkConfig(chainId: number): NetworkConfig {
    const config = NETWORKS[chainId];
    if (!config) {
        throw new Error(
            `Unsupported chain ID: ${chainId}. Supported: ${Object.keys(NETWORKS).join(', ')}`,
        );
    }
    return config;
}

/** Returns the default network driven by NEXT_PUBLIC_CHAIN_ID env var, falling back to Base. */
export function getDefaultNetworkConfig(): NetworkConfig {
    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID) || 8453;
    return getNetworkConfig(chainId);
}

/** Resolve a NetworkConfig from an object, a chain ID number, or the env-driven default. */
export function resolveNetwork(network?: NetworkConfig | number): NetworkConfig {
    if (network === undefined || network === null) return getDefaultNetworkConfig();
    if (typeof network === 'number') return getNetworkConfig(network);
    return network;
}
