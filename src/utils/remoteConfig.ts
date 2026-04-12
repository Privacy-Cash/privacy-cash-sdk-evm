import { INDEXER_URL } from './constants.js';
import { logger } from './logger.js';

export interface RemoteConfig {
    prices: { eth: number };
    minimum_withdrawal: { eth: number; usdc: number };
    minimum_deposit: { eth: number; usdc: number };
    rent_fees: { eth: number; usdc: number };
    fee_rate: number;
}

const CONFIG_URL = `${INDEXER_URL}/config`;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedConfig: RemoteConfig | null = null;
let cacheExpiresAt = 0;

export async function getRemoteConfig(): Promise<RemoteConfig> {
    const now = Date.now();
    if (cachedConfig && now < cacheExpiresAt) {
        return cachedConfig;
    }

    const res = await fetch(CONFIG_URL);
    if (!res.ok) {
        throw new Error(`Failed to fetch remote config: HTTP ${res.status}`);
    }
    const data = await res.json() as RemoteConfig;
    cachedConfig = data;
    cacheExpiresAt = now + CACHE_TTL_MS;
    logger.debug('Remote config loaded successfully');
    return data;
}
