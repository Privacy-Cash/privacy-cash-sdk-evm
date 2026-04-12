import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS, FEE_RECIPIENT_ADDRESS, INDEXER_URL, PRIVATE_USDC_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { getRemoteConfig } from './utils/remoteConfig.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

export async function withdraw({ withdrawAmountInput, recipient, keyBasePath, signature, address, token = 'eth' }: {
    withdrawAmountInput: number,
    recipient: string,
    keyBasePath: string,
    signature: string,
    address: string,
    token?: 'eth' | 'usdc',
}) {
    if (!ethers.utils.isAddress(recipient)) {
        throw new Error(`Invalid recipient address: ${recipient}`);
    }

    const isUsdc = token === 'usdc';

    const remoteConfig = await getRemoteConfig();
    const minWithdrawalEth = remoteConfig.minimum_withdrawal.eth;
    const minWithdrawalUsdc = remoteConfig.minimum_withdrawal.usdc;
    const rentFeeEth = remoteConfig.rent_fees.eth;
    const rentFeeUsdc = remoteConfig.rent_fees.usdc;
    const feeRate = remoteConfig.fee_rate;

    const ETH_FLAT_FEE = ethers.utils.parseEther(rentFeeEth.toFixed(18));
    const USDC_FLAT_FEE = ethers.utils.parseUnits(rentFeeUsdc.toFixed(6), 6);

    if (isUsdc) {
        if (withdrawAmountInput < minWithdrawalUsdc) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawalUsdc} USDC`);
        }
    } else {
        if (withdrawAmountInput < minWithdrawalEth) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawalEth} ETH`);
        }
    }

    const poolAddress = ethers.utils.getAddress(isUsdc ? PRIVATE_USDC_CONTRACT_ADDRESS : CONTRACT_ADDRESS);
    const abi = isUsdc ? ERCPoolAbi : EtherPoolAbi;
    const feeRecipient = FEE_RECIPIENT_ADDRESS;

    logger.debug(`Withdrawing ${withdrawAmountInput} ${isUsdc ? 'USDC' : 'ETH'} to recipient: ${recipient}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const pool = new ethers.Contract(poolAddress, abi, readProvider);

    const withdrawAmount = isUsdc
        ? ethers.utils.parseUnits(withdrawAmountInput.toString(), 6)
        : ethers.utils.parseEther(withdrawAmountInput.toString());

    // Scan on-chain events to find unspent UTXOs
    logger.info('loading utxos')
    const unspent = await findUnspentUtxos({
        etherPool: pool,
        encryptionKey,
        keypair,
        address,
        token,
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
    const flatFee = isUsdc ? USDC_FLAT_FEE : ETH_FLAT_FEE;
    const fee = flatFee.add(withdrawAmount.mul(feeRate).div(10000));

    if (isUsdc) {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatUnits(inputSum, 6)} USDC)`);
        logger.debug(`Fee: ${ethers.utils.formatUnits(fee, 6)} USDC (${rentFeeUsdc} USDC + ${feeRate / 100}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatUnits(withdrawAmount.sub(fee), 6)} USDC`);
    } else {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatEther(inputSum)} ETH)`);
        logger.debug(`Fee: ${ethers.utils.formatEther(fee)} ETH (${rentFeeEth} + ${feeRate / 100}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatEther(withdrawAmount.sub(fee))} ETH`);
    }

    if (inputSum.lt(withdrawAmount)) {
        const have = isUsdc ? ethers.utils.formatUnits(inputSum, 6) : ethers.utils.formatEther(inputSum);
        const need = isUsdc ? ethers.utils.formatUnits(withdrawAmount, 6) : ethers.utils.formatEther(withdrawAmount);
        throw new Error(`Insufficient balance. Have ${have}, need ${need} (${withdrawAmountInput}).`);
    }

    const changeAmount = inputSum.sub(withdrawAmount);
    const outputs: Utxo[] = [];

    if (changeAmount.gt(0)) {
        // Change UTXOs for USDC must carry the same mintAddress
        const mintAddress = isUsdc ? BigNumber.from(USDC_CONTRACT_ADDRESS) : BigNumber.from(0);
        outputs.push(new Utxo({ amount: changeAmount, keypair, mintAddress }));
        const formattedChange = isUsdc
            ? `${ethers.utils.formatUnits(changeAmount, 6)} USDC`
            : `${ethers.utils.formatEther(changeAmount)} ETH`;
        logger.debug(`Change UTXO: ${formattedChange}`);
    }

    logger.info('generating ZK proof')

    const { args, extData } = await prepareTransaction({
        inputs,
        outputs,
        recipient,
        fee,
        feeRecipient,
        encryptionKey,
        keyBasePath,
        token,
    });

    logger.info('submitting transaction to relayer...');
    const response = await fetch(`${INDEXER_URL}/relayer/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, extData, token }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
        logger.debug(`Transaction relayed successfully: ${result.txHash}`);
        logger.debug(`Confirmed in block ${result.blockNumber}`);
    } else {
        throw new Error(`Relayer error: ${result.error || response.statusText}`);
    }

    if (changeAmount.gt(0)) {
        const formattedChange = isUsdc
            ? `${ethers.utils.formatUnits(changeAmount, 6)} USDC`
            : `${ethers.utils.formatEther(changeAmount)} ETH`;
        logger.debug(`\nChange UTXO created (${formattedChange})`);
    }

    logger.info('confirming transaction')
    let retryTimes = 0
    const itv = 2
    let start = Date.now()
    while (true) {
        logger.debug('Confirming transaction..')
        logger.debug(`retryTimes: ${retryTimes}`)
        await new Promise(resolve => setTimeout(resolve, itv * 1000));
        logger.debug('Fetching updated onchain state...');
        let res = await fetch(INDEXER_URL + '/check_encrypted_output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encryptedOutput: extData.encryptedOutput1, token }),
        });
        let resJson = await res.json()
        if (resJson.exists) {
            logger.debug(`Withdrawal confirmed in ${((Date.now() - start) / 1000).toFixed(2)} seconds!`);
            break;
        }
        if (retryTimes >= 10) {
            throw new Error('Refresh the page to see latest balance.')
        }
        retryTimes++
    }

    logger.debug('\nwithdrawal successful!');
    return result.txHash
}
