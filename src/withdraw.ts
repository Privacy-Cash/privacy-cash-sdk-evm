import { BigNumber, ethers } from 'ethers';
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS, FEE_RATE, FEE_RECIPIENT_ADDRESS, INDEXER_URL, MIN_WITHDRAWAL_AMOUNT, RENT_FEE } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

const FLAT_FEE = ethers.utils.parseEther(RENT_FEE.toString())

export async function withdraw({ withdrawAmountInput, recipient, keyBasePath, signature, address }: {
    withdrawAmountInput: number,
    recipient: string,
    keyBasePath: string,
    signature: string,
    address: string
}) {

    if (!ethers.utils.isAddress(recipient)) {
        throw new Error(`Invalid recipient address: ${recipient}`);
    }

    const etherPoolAddress = CONTRACT_ADDRESS;
    if (!etherPoolAddress) {
        throw new Error('Missing CONTRACT_ADDRESS in environment');
    }

    // check if withdrawAmountInput is above minimum
    if (withdrawAmountInput < MIN_WITHDRAWAL_AMOUNT) {
        throw new Error(`Withdrawal amount must be at least ${MIN_WITHDRAWAL_AMOUNT} ETH`);
    }

    const feeRecipientEnv = FEE_RECIPIENT_ADDRESS;
    const contractAddress = ethers.utils.getAddress(etherPoolAddress);

    logger.debug(`Withdrawing ${withdrawAmountInput} ETH to recipient: ${recipient}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);

    const etherPool = new ethers.Contract(contractAddress, EtherPoolAbi, readProvider);

    const withdrawAmount = ethers.utils.parseEther(withdrawAmountInput.toString());

    // Scan on-chain events to find unspent UTXOs
    logger.info('loading utxos')
    const unspent = await findUnspentUtxos({
        etherPool,
        encryptionKey,
        keypair,
        address
    });
    logger.debug(`Unspent UTXOs found: ${unspent.length}`);

    if (unspent.length === 0) {
        throw new Error('No unspent UTXOs available to withdraw.');
    }

    let inputs: Utxo[];
    if (unspent.length >= 2) {
        inputs = [unspent[0], unspent[1]];
    } else {
        inputs = [unspent[0]];
    }

    const inputSum = inputs.reduce((sum, u) => sum.add(u.amount), BigNumber.from(0));
    logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatEther(inputSum)} ETH)`);

    const feeRecipient = feeRecipientEnv;
    const fee = FLAT_FEE.add(withdrawAmount.mul(FEE_RATE).div(10000));
    logger.debug(`Fee recipient: ${feeRecipient}`);
    logger.debug(`Fee: ${ethers.utils.formatEther(fee)} ETH (0.00025 + 0.35%)`);

    // withdrawAmount should includes fee
    let realAriveAmount = withdrawAmount.sub(fee);
    logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatEther(realAriveAmount)} ETH`);

    if (inputSum.lt(withdrawAmount)) {
        throw new Error(`Insufficient balance. Have ${ethers.utils.formatEther(inputSum)} ETH, need ${ethers.utils.formatEther(withdrawAmount)} ETH (${withdrawAmountInput}).`);
    }

    const changeAmount = inputSum.sub(withdrawAmount);
    const outputs: Utxo[] = [];

    if (changeAmount.gt(0)) {
        outputs.push(new Utxo({ amount: changeAmount, keypair }));
        logger.debug(`Change UTXO: ${ethers.utils.formatEther(changeAmount)} ETH`);
    }

    logger.debug(`\nWithdrawing ${realAriveAmount} ETH to ${recipient}...`);
    logger.info('generating ZK proof')

    const { args, extData } = await prepareTransaction({
        inputs,
        outputs,
        recipient,
        fee,
        feeRecipient,
        encryptionKey,
        keyBasePath,
    });

    logger.info(`submitting transaction to relayer`);
    const response = await fetch(`${INDEXER_URL}/relayer/withdraw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            args,
            extData
        }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
        logger.debug(`Transaction relayed successfully: ${result.txHash}`);
        logger.debug(`Confirmed in block ${result.blockNumber}`);
    } else {
        throw new Error(`Relayer error: ${result.error || response.statusText}`);
    }

    if (changeAmount.gt(0)) {
        logger.debug(`\nChange UTXO created (${ethers.utils.formatEther(changeAmount)} ETH)`);
    }

    logger.info('confirming transaction')
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

    logger.info('\nWithdrawal successful!');

    return result.txHash
}
