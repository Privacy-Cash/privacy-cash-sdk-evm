import { logger } from './logger.js';
import { NetworkConfig, PrivacyToken, resolveNetwork } from './networkConfig.js';

export interface FeeSnapshot {
    id: string;
    chain: 'eth';
    feeRateBps: number;
    validFrom: number;
    expiresAt: number;
    rentFeeUnits: Partial<Record<PrivacyToken, string>>;
    rentFees?: Partial<Record<PrivacyToken, number>>;
}

export interface RemoteConfig {
    prices: Partial<Record<PrivacyToken, number>>;
    minimum_withdrawal: Record<PrivacyToken, number>;
    minimum_deposit: Record<PrivacyToken, number>;
    rent_fees: Record<PrivacyToken, number>;
    fee_rate: number;
    feeSnapshot?: FeeSnapshot | null;
}

const CACHE_TTL_MS = 60 * 1000; // 1 minute

type CacheEntry = { config: RemoteConfig; expiresAt: number };
const configCache = new Map<number, CacheEntry>();

export async function getRemoteConfig(network?: NetworkConfig | number, options?: { forceRefresh?: boolean }): Promise<RemoteConfig> {
    const net = resolveNetwork(network);
    const now = Date.now();
    const cached = configCache.get(net.chainId);
    if (!options?.forceRefresh && cached && now < cached.expiresAt) return cached.config;

    if (!net.indexerUrl) {
        throw new Error(`No indexer URL configured for chain ${net.chainId} (${net.chainKey})`);
    }

    const configUrl = new URL(`${net.indexerUrl.replace(/\/$/, '')}/config`);
    configUrl.searchParams.set('chain', net.chainKey);

    const res = await fetch(configUrl.toString());
    if (!res.ok) {
        throw new Error(`Failed to fetch remote config: HTTP ${res.status}`);
    }
    const data = await res.json() as RemoteConfig;
    configCache.set(net.chainId, { config: data, expiresAt: now + CACHE_TTL_MS });
    logger.debug('Remote config loaded successfully');
    return data;
}
