export { getBalance } from './balance.js'
export { deposit } from './deposit.js'
export { setLogger } from './utils/logger.js'
export { getRemoteConfig } from './utils/remoteConfig.js'
export type { FeeSnapshot, RemoteConfig } from './utils/remoteConfig.js'
export { withdraw } from './withdraw.js'

export { FEE_RECIPIENT_ADDRESS, INDEXER_URL, PRIVATE_USDC_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS, USDC_DECIMALS } from './utils/constants.js'
export { clearCache } from './utils/utils.js'

export {
    BASE_NETWORK,
    BNB_NETWORK,
    ETH_NETWORK, getDefaultNetworkConfig, getNetworkConfig, NETWORKS, resolveNetwork
} from './utils/networkConfig.js'
export type { Erc20Token, NativeToken, NetworkConfig, PrivacyToken, SupportedChain } from './utils/networkConfig.js'
