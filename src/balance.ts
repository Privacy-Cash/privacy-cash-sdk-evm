import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS, PRIVATE_USDC_CONTRACT_ADDRESS } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { findUnspentUtxos, toFixedHex } from './utils/utils.js';

export async function getBalance({ signature, address, offset, token = 'eth' }: { signature: string, address: string, offset?: number, token?: 'eth' | 'usdc' }) {
    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);

    const isUsdc = token === 'usdc';
    const contractAddress = ethers.utils.getAddress(isUsdc ? PRIVATE_USDC_CONTRACT_ADDRESS : CONTRACT_ADDRESS);
    const abi = isUsdc ? ERCPoolAbi : EtherPoolAbi;

    logger.debug(`Address: ${address}`);

    logger.debug('Signing in to derive keys...');
    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const pool = new ethers.Contract(contractAddress, abi, readProvider);

    if (!isUsdc) {
        const poolBalance = await readProvider.getBalance(pool.address);
        logger.debug(`EtherPool: ${pool.address}`);
        logger.debug(`Pool on-chain balance: ${ethers.utils.formatEther(poolBalance)} ETH`);
    }

    // Scan on-chain events and decrypt to find our UTXOs
    logger.debug('Scanning on-chain events...');
    const unspent = await findUnspentUtxos({
        etherPool: pool,
        encryptionKey,
        keypair,
        address,
        start: offset || 0,
        token,
    });

    logger.debug(`Unspent UTXOs: ${unspent.length}`);
    let total = BigNumber.from(0);
    for (let i = 0; i < unspent.length; i++) {
        const utxo = unspent[i];
        const formatted = isUsdc
            ? ethers.utils.formatUnits(utxo.amount, 6)
            : ethers.utils.formatEther(utxo.amount);
        logger.debug(`  #${i}: ${formatted} ${isUsdc ? 'USDC' : 'ETH'} (index: ${utxo.index})`);
        total = total.add(utxo.amount);
    }

    const balance = isUsdc
        ? ethers.utils.formatUnits(total, 6)
        : ethers.utils.formatEther(total);

    logger.debug(`\nTotal unspent: ${balance} ${isUsdc ? 'USDC' : 'ETH'}`);

    return { balance };
}
