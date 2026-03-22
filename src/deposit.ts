import { BigNumber, ethers } from 'ethers';
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS, INDEXER_URL, MIN_DEPOSIT_AMOUNT } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

export async function deposit({ depositAmountInput, keyBasePath, signature, address, txSender }: {
    depositAmountInput: number,
    keyBasePath: string,
    signature: string,
    address: string,
    txSender: any
}) {
    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const etherPoolAddress = CONTRACT_ADDRESS;
    if (!etherPoolAddress) {
        throw new Error('Missing CONTRACT_ADDRESS in environment');
    }

    // check if depositAmountInput is above minimum
    if (depositAmountInput < MIN_DEPOSIT_AMOUNT) {
        throw new Error(`Deposit amount must be at least ${MIN_DEPOSIT_AMOUNT} ETH`);
    }

    const contractAddress = ethers.utils.getAddress(etherPoolAddress);

    logger.debug(`Depositor: ${address}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const etherPool = new ethers.Contract(contractAddress, EtherPoolAbi, readProvider);

    const poolBalance = await readProvider.getBalance(etherPool.address);
    logger.debug(`EtherPool: ${etherPool.address}`);
    logger.debug(`Pool balance: ${ethers.utils.formatEther(poolBalance)} ETH`);

    const depositAmount = ethers.utils.parseEther(depositAmountInput.toString());

    const maxDeposit = await etherPool.maximumDepositAmount();
    if (depositAmount.gt(maxDeposit)) {
        throw new Error(`Deposit amount ${depositAmountInput} ETH exceeds pool limit of ${ethers.utils.formatEther(maxDeposit)} ETH`);
    }

    // post address to /screen_address of indexer to check if it's blacklisted
    logger.info('screening walleting')
    logger.debug(`screening address ${address}`)
    let res = await fetch(INDEXER_URL + '/screen_address', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address }),
    });
    let resJson = await res.json()
    if (resJson.isRisk) {
        throw new Error('Your wallet address is risky. Service rejected.');
    }
    logger.debug('Address screening passed');

    // Scan on-chain events to find unspent UTXOs
    logger.debug('Scanning on-chain events for unspent UTXOs...');
    const unspent = await findUnspentUtxos({
        etherPool,
        encryptionKey,
        keypair, address
    });
    logger.debug(`Unspent UTXOs found: ${unspent.length}`);

    let inputs: Utxo[] = [];
    let inputSum = BigNumber.from(0);

    if (unspent.length >= 2) {
        inputs = [unspent[0], unspent[1]];
        inputSum = inputs[0].amount.add(inputs[1].amount);
        logger.debug(`Using 2 existing UTXOs as inputs (${ethers.utils.formatEther(inputSum)} ETH)`);
    } else if (unspent.length === 1) {
        inputs = [unspent[0]];
        inputSum = inputs[0].amount;
        logger.debug(`Using 1 existing UTXO as input (${ethers.utils.formatEther(inputSum)} ETH)`);
    } else {
        logger.debug('No existing UTXOs, creating fresh deposit');
    }

    const outputAmount = inputSum.add(depositAmount);
    const outputUtxo = new Utxo({ amount: outputAmount, keypair });

    logger.debug(`Depositing ${depositAmountInput} ETH (new output: ${ethers.utils.formatEther(outputAmount)} ETH)`);

    logger.info('generating ZK proof')

    const { args, extData } = await prepareTransaction({
        inputs,
        outputs: [outputUtxo],
        encryptionKey,
        keyBasePath,
    });

    const partialTx = await etherPool.populateTransaction.transact(args, extData, {
        value: depositAmount,
        gasLimit: 3000000,
    });
    const [network, nonce, feeData] = await Promise.all([
        readProvider.getNetwork(),
        readProvider.getTransactionCount(address, 'pending'),
        readProvider.getFeeData(),
    ]);

    const unsignedTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
        ...partialTx,
        nonce,
        chainId: network.chainId,
    };
    if (feeData.gasPrice) {
        unsignedTx.gasPrice = feeData.gasPrice;
    } else {
        throw new Error('Failed to fetch network fee data for transaction signing');
    }

    logger.info('waiting for user signature')
    let tx = await txSender(unsignedTx)
    logger.info(`confirming transaction`);
    logger.debug('veryfying transaction on indexer...', extData.encryptedOutput1)
    let retryTimes = 0
    let itv = 2
    // const encryptedOutputStr = Buffer.from(extData.encryptedOutput1).toString('hex')
    let start = Date.now()
    while (true) {
        logger.debug('Confirming transaction..')
        logger.debug(`retryTimes: ${retryTimes}`)
        await new Promise(resolve => setTimeout(resolve, itv * 1000));
        logger.debug('Fetching updated onchain state...');
        // post to /check_encrypted_output with body encryptedOutput: extData.encryptedOutput1
        let res = await fetch(INDEXER_URL + '/check_encrypted_output', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ encryptedOutput: extData.encryptedOutput1 }),
        });
        let resJson = await res.json()
        if (resJson.exists) {
            logger.debug(`Top up successfully in ${((Date.now() - start) / 1000).toFixed(2)} seconds!`);
            // break while true loop
            break;
        }
        if (retryTimes >= 10) {
            throw new Error('Refresh the page to see latest balance.')
        }
        retryTimes++
    }

    return tx
}
