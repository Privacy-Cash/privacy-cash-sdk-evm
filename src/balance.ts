import { BigNumber, ethers } from 'ethers';
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger';
import { findUnspentUtxos, toFixedHex } from './utils/utils.js';

export async function getBalance({ signature, address }: { signature: string, address: string }) {
    // const provider: ethers.providers.Provider = rawProvider?.request
    //     ? new ethers.providers.Web3Provider(rawProvider)
    //     : rawProvider;
    // Use a dedicated JSON-RPC provider for contract reads so they always
    // target the correct chain, regardless of which chain the wallet is on.
    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const etherPoolAddress = CONTRACT_ADDRESS;
    if (!etherPoolAddress) {
        throw new Error('Missing CONTRACT_ADDRESS in environment');
    }
    const contractAddress = ethers.utils.getAddress(etherPoolAddress);

    logger.debug(`Address: ${address}`);

    logger.debug('Signing in to derive keys...');
    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const etherPool = new ethers.Contract(contractAddress, EtherPoolAbi, readProvider);
    const poolBalance = await readProvider.getBalance(etherPool.address);
    logger.debug(`EtherPool: ${etherPool.address}`);
    logger.debug(`Pool on-chain balance: ${ethers.utils.formatEther(poolBalance)} ETH`);

    // Scan on-chain events and decrypt to find our UTXOs
    logger.debug('Scanning on-chain events...');
    const unspent = await findUnspentUtxos({
        etherPool,
        encryptionKey,
        keypair,
        address
    });

    logger.debug(`Unspent UTXOs: ${unspent.length}`);
    let total = BigNumber.from(0);
    for (let i = 0; i < unspent.length; i++) {
        const utxo = unspent[i];
        logger.debug(`  #${i}: ${ethers.utils.formatEther(utxo.amount)} ETH (index: ${utxo.index})`);
        total = total.add(utxo.amount);
    }

    let balance = ethers.utils.formatEther(total);

    logger.debug(`\nTotal unspent: ${ethers.utils.formatEther(total)} ETH`);

    return {
        balance
    };
}
