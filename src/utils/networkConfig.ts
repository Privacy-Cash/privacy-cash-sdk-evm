export type Erc20Token = 'usdc' | 'usdt';
export type NativeToken = 'eth' | 'bnb';
export type PrivacyToken = NativeToken | Erc20Token;
export type SupportedChain = 'base' | 'eth' | 'bnb';

const EVM_INDEXER_URL = process.env.NEXT_PUBLIC_EVM_INDEXER_URL || process.env.EVM_INDEXER_URL || 'https://evm.privacycash.org';

function getIndexerRpcUrl(chain: SupportedChain) {
    return `${EVM_INDEXER_URL.replace(/\/$/, '')}/rpc/${chain}`;
}

export interface NetworkConfig {
    chainId: number;
    /** Short identifier used in API calls and DB table prefixes. */
    chainKey: SupportedChain;
    rpcUrl: string;
    indexerUrl: string;
    etherPoolAddress: string;
    usdcPoolAddress: string;
    usdcTokenAddress: string;
    usdcDecimals: number;
    usdtPoolAddress: string;
    usdtTokenAddress: string;
    usdtDecimals: number;
    feeRecipientAddress: string;
    /** Namespace prefix for local UTXO cache files. Base keeps legacy names. */
    cachePrefix: string;
    /** Average block time in ms — used to scale confirmation polling timeouts. */
    blockTimeMs: number;
    /** Native token used by this chain. */
    nativeToken?: NativeToken;
    /** Human-readable native token symbol used in logs and errors. */
    nativeSymbol?: 'ETH' | 'BNB';
    /** Optional block explorer base URL. */
    blockExplorerUrl?: string;
}

export const BASE_NETWORK: NetworkConfig = {
    chainId: 8453,
    chainKey: 'base',
    rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC || process.env.BASE_RPC || getIndexerRpcUrl('base'),
    indexerUrl: EVM_INDEXER_URL,
    etherPoolAddress: '0x7F673790C08Ddf27c0Aa6fa9526CCC8dAaB081Ec',
    usdcPoolAddress: '0xe91dd4AB03909f5CEb87f42B4308B222995a905b',
    usdcTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDecimals: 6,
    usdtPoolAddress: '',
    usdtTokenAddress: '',
    usdtDecimals: 6,
    feeRecipientAddress: '0x8D772A68f2327409a7bb3F96f549297AEdf9312B',
    cachePrefix: 'base',
    blockTimeMs: 2000,
    nativeToken: 'eth',
    nativeSymbol: 'ETH',
};

export const ETH_NETWORK: NetworkConfig = {
    chainId: 1,
    chainKey: 'eth',
    rpcUrl: process.env.NEXT_PUBLIC_ETH_RPC || process.env.ETH_RPC || getIndexerRpcUrl('eth'),
    indexerUrl: EVM_INDEXER_URL,
    etherPoolAddress: process.env.NEXT_PUBLIC_ETH_ETHER_POOL_ADDRESS || '0x77A10AE3E513c2D73D73eb52212c6918C8830dd0',
    usdcPoolAddress: '',
    usdcTokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdcDecimals: 6,
    usdtPoolAddress: process.env.NEXT_PUBLIC_ETH_USDT_POOL_ADDRESS || '0xC88F4dF2B6EdDd6B6Bdf95A0177f50C90Fa7527f',
    usdtTokenAddress: process.env.NEXT_PUBLIC_ETH_USDT_TOKEN_ADDRESS || '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdtDecimals: 6,
    feeRecipientAddress: process.env.NEXT_PUBLIC_ETH_FEE_RECIPIENT_ADDRESS || '0x8D772A68f2327409a7bb3F96f549297AEdf9312B',
    cachePrefix: 'eth',
    blockTimeMs: 12000,
    nativeToken: 'eth',
    nativeSymbol: 'ETH',
};

const BNB_ALCHEMY_RPC = process.env.ALCHEMY_KEY
    ? `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`
    : getIndexerRpcUrl('bnb');

export const BNB_NETWORK: NetworkConfig = {
    chainId: 56,
    chainKey: 'bnb',
    rpcUrl: process.env.NEXT_PUBLIC_BNB_RPC || process.env.BNB_RPC || BNB_ALCHEMY_RPC,
    indexerUrl: EVM_INDEXER_URL,
    etherPoolAddress: '0x22D8509E7AF58b1EaFB311f8F76E81dC3a391F77',
    usdcPoolAddress: '',
    usdcTokenAddress: '',
    usdcDecimals: 6,
    usdtPoolAddress: '',
    usdtTokenAddress: '',
    usdtDecimals: 18,
    feeRecipientAddress: '0x8D772A68f2327409a7bb3F96f549297AEdf9312B',
    cachePrefix: 'bnb',
    blockTimeMs: 1000,
    nativeToken: 'bnb',
    nativeSymbol: 'BNB',
    blockExplorerUrl: 'https://bscscan.com/',
};

export const NETWORKS: Record<number, NetworkConfig> = {
    8453: BASE_NETWORK,
    1: ETH_NETWORK,
    56: BNB_NETWORK,
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

/** Resolve an omitted token to the selected chain's native token and reject cross-chain native symbols. */
export function resolvePrivacyToken(net: NetworkConfig, token?: PrivacyToken): PrivacyToken {
    const nativeToken: NativeToken = net.nativeToken ?? (net.chainKey === 'bnb' ? 'bnb' : 'eth');
    const resolved = token ?? nativeToken;
    if ((resolved === 'eth' || resolved === 'bnb') && resolved !== nativeToken) {
        throw new Error(`${resolved.toUpperCase()} is not supported on ${net.chainKey}`);
    }
    return resolved;
}

export function isNativeToken(net: NetworkConfig, token: PrivacyToken): boolean {
    const nativeToken: NativeToken = net.nativeToken ?? (net.chainKey === 'bnb' ? 'bnb' : 'eth');
    return token === nativeToken;
}

export function getErc20TokenConfig(net: NetworkConfig, token: PrivacyToken) {
    if (isNativeToken(net, token)) return null;
    if (token === 'eth' || token === 'bnb') {
        throw new Error(`${token.toUpperCase()} is not supported on ${net.chainKey}`);
    }
    const config = token === 'usdc'
        ? {
            token,
            symbol: 'USDC' as const,
            poolAddress: net.usdcPoolAddress,
            tokenAddress: net.usdcTokenAddress,
            decimals: net.usdcDecimals,
        }
        : {
            token,
            symbol: 'USDT' as const,
            poolAddress: net.usdtPoolAddress,
            tokenAddress: net.usdtTokenAddress,
            decimals: net.usdtDecimals,
        };

    if (!config.poolAddress || !config.tokenAddress) {
        throw new Error(`${token.toUpperCase()} is not supported on ${net.chainKey}`);
    }
    return config;
}
