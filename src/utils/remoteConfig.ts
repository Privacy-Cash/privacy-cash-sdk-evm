import { logger } from './logger.js';
import { NetworkConfig, resolveNetwork } from './networkConfig.js';

export interface RemoteConfig {
    prices: { eth: number };
    minimum_withdrawal: { eth: number; usdc: number };
    minimum_deposit: { eth: number; usdc: number };
    rent_fees: { eth: number; usdc: number };
    fee_rate: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type CacheEntry = { config: RemoteConfig; expiresAt: number };
const configCache = new Map<number, CacheEntry>();

export async function getRemoteConfig(network?: NetworkConfig | number): Promise<RemoteConfig> {
    const net = resolveNetwork(network);
    const now = Date.now();
    const cached = configCache.get(net.chainId);
    if (cached && now < cached.expiresAt) return cached.config;

    if (!net.indexerUrl) {
        throw new Error(`No indexer URL configured for chain ${net.chainId} (${net.chainKey})`);
    }

    const res = await fetch(`${net.indexerUrl}/config`);
    if (!res.ok) {
        throw new Error(`Failed to fetch remote config: HTTP ${res.status}`);
    }
    const data = await res.json() as RemoteConfig;
    configCache.set(net.chainId, { config: data, expiresAt: now + CACHE_TTL_MS });
    logger.debug('Remote config loaded successfully');
    return data;
}
