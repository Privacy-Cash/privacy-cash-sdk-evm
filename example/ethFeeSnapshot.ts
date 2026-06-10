import { getRemoteConfig } from '../src/index.js';
import type { NetworkConfig, PrivacyToken } from '../src/index.js';
import type { FeeSnapshot } from '../src/utils/remoteConfig.js';

const FEE_SNAPSHOT_SAFETY_MS = 90_000;

export async function getFreshEthFeeSnapshot(network: NetworkConfig, token: PrivacyToken): Promise<FeeSnapshot> {
    const config = await getRemoteConfig(network, { forceRefresh: true });
    const snapshot = config.feeSnapshot;

    if (!snapshot) {
        throw new Error('ETH fee snapshot is not available. Please try again shortly.');
    }
    if (snapshot.chain !== 'eth') {
        throw new Error(`Unsupported fee snapshot chain: ${snapshot.chain}`);
    }
    if (Date.now() + FEE_SNAPSHOT_SAFETY_MS > snapshot.expiresAt) {
        throw new Error('ETH fee snapshot is too close to expiry. Please try again shortly.');
    }
    if (!snapshot.rentFeeUnits?.[token]) {
        throw new Error(`${token.toUpperCase()} rent fee is missing from ETH fee snapshot`);
    }

    return snapshot;
}
