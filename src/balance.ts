import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { NetworkConfig, PrivacyToken, getErc20TokenConfig, resolveNetwork } from './utils/networkConfig.js';
import { findUnspentUtxos, toFixedHex } from './utils/utils.js';

export async function getBalance({ signature, address, offset, token = 'eth', network }: {
    signature: string,
    address: string,
    offset?: number,
    token?: PrivacyToken,
    network?: NetworkConfig | number,
}) {
    const net = resolveNetwork(network);
    const readProvider = new ethers.providers.JsonRpcProvider(net.rpcUrl, {
        name: net.chainKey,
        chainId: net.chainId,
    });

    const erc20Token = getErc20TokenConfig(net, token);
    const isErc20 = erc20Token !== null;
    const tokenSymbol = erc20Token?.symbol ?? 'ETH';
    const tokenDecimals = erc20Token?.decimals ?? 18;
    const contractAddress = ethers.utils.getAddress(erc20Token ? erc20Token.poolAddress : net.etherPoolAddress);
    const abi = isErc20 ? ERCPoolAbi : EtherPoolAbi;

    logger.debug(`Address: ${address}`);

    logger.debug('Signing in to derive keys...');
    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const pool = new ethers.Contract(contractAddress, abi, readProvider);

    if (!isErc20) {
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
        network: net,
    });

    logger.debug(`Unspent UTXOs: ${unspent.length}`);
    let total = BigNumber.from(0);
    for (let i = 0; i < unspent.length; i++) {
        const utxo = unspent[i];
        const formatted = isErc20
            ? ethers.utils.formatUnits(utxo.amount, tokenDecimals)
            : ethers.utils.formatEther(utxo.amount);
        logger.debug(`  #${i}: ${formatted} ${tokenSymbol} (index: ${utxo.index})`);
        total = total.add(utxo.amount);
    }

    const balance = isErc20
        ? ethers.utils.formatUnits(total, tokenDecimals)
        : ethers.utils.formatEther(total);

    logger.debug(`\nTotal unspent: ${balance} ${tokenSymbol}`);

    return { balance };
}
