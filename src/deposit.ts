import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { BASE_SEPOLIA_RPC, CONTRACT_ADDRESS, INDEXER_URL, PRIVATE_USDC_CONTRACT_ADDRESS, USDC_CONTRACT_ADDRESS } from './utils/constants.js';
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { getRemoteConfig } from './utils/remoteConfig.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

export async function deposit({ depositAmountInput, keyBasePath, signature, address, txSender, token = 'eth' }: {
    depositAmountInput: number,
    keyBasePath: string,
    signature: string,
    address: string,
    txSender: any,
    token?: 'eth' | 'usdc',
}) {
    const readProvider = new ethers.providers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const isUsdc = token === 'usdc';

    const remoteConfig = await getRemoteConfig();
    const minDepositEth = remoteConfig.minimum_deposit.eth;
    const minDepositUsdc = remoteConfig.minimum_deposit.usdc;

    if (isUsdc) {
        if (depositAmountInput < minDepositUsdc) {
            throw new Error(`Deposit amount must be at least ${minDepositUsdc} USDC`);
        }
    } else {
        if (depositAmountInput < minDepositEth) {
            throw new Error(`Deposit amount must be at least ${minDepositEth} ETH`);
        }
    }

    const poolAddress = ethers.utils.getAddress(isUsdc ? PRIVATE_USDC_CONTRACT_ADDRESS : CONTRACT_ADDRESS);
    const abi = isUsdc ? ERCPoolAbi : EtherPoolAbi;

    logger.debug(`Depositor: ${address}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const pool = new ethers.Contract(poolAddress, abi, readProvider);

    if (!isUsdc) {
        const poolBalance = await readProvider.getBalance(pool.address);
        logger.debug(`EtherPool: ${pool.address}`);
        logger.debug(`Pool balance: ${ethers.utils.formatEther(poolBalance)} ETH`);
    }

    const depositAmount = isUsdc
        ? ethers.utils.parseUnits(depositAmountInput.toString(), 6)
        : ethers.utils.parseEther(depositAmountInput.toString());

    const maxDeposit = await pool.maximumDepositAmount();
    if (depositAmount.gt(maxDeposit)) {
        const formatted = isUsdc
            ? `${ethers.utils.formatUnits(maxDeposit, 6)} USDC`
            : `${ethers.utils.formatEther(maxDeposit)} ETH`;
        throw new Error(`Please deposit less than ${formatted}`);
    }

    // post address to /screen_address of indexer to check if it's blacklisted
    logger.info('screening wallet')
    logger.debug(`screening address ${address}`)
    try {
        let res = await fetch(INDEXER_URL + '/screen_address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
        });
        let resJson = await res.json()
        if (resJson.isRisk) {
            throw new Error('Your wallet address is risky. Service rejected.', { cause: { type: 'RISKY_ADDRESS' } });
        }
    } catch (err: any) {
        if (err.cause?.type === 'RISKY_ADDRESS') {
            throw err;
        }
        logger.error('Failed to screen address, but proceeding with deposit. Error:', err);
    }
    logger.debug('Address screening passed');

    // Scan on-chain events to find unspent UTXOs
    logger.debug('Scanning on-chain events for unspent UTXOs...');
    const unspent = await findUnspentUtxos({
        etherPool: pool,
        encryptionKey,
        keypair,
        address,
        token,
    });
    logger.debug(`Unspent UTXOs found: ${unspent.length}`);

    let inputs: Utxo[] = [];
    let inputSum = BigNumber.from(0);

    if (unspent.length >= 2) {
        inputs = [unspent[0], unspent[1]];
        inputSum = inputs[0].amount.add(inputs[1].amount);
    } else if (unspent.length === 1) {
        inputs = [unspent[0]];
        inputSum = inputs[0].amount;
    }

    const outputAmount = inputSum.add(depositAmount);
    // For USDC, embed the token contract address as mintAddress in the UTXO
    const mintAddress = isUsdc ? BigNumber.from(USDC_CONTRACT_ADDRESS) : BigNumber.from(0);
    const outputUtxo = new Utxo({ amount: outputAmount, keypair, mintAddress });

    const formattedOutput = isUsdc
        ? `${ethers.utils.formatUnits(outputAmount, 6)} USDC`
        : `${ethers.utils.formatEther(outputAmount)} ETH`;
    logger.debug(`Depositing ${depositAmountInput} ${isUsdc ? 'USDC' : 'ETH'} (new output: ${formattedOutput})`);

    if (isUsdc) {
        // Step 1: send ERC20 approve tx first, BEFORE generating the ZK proof.
        // The proof fetches the Merkle root; if we generate it before the approve
        // is mined the root can advance while waiting, causing proof verification
        // to fail on-chain.
        const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
        const erc20 = new ethers.Contract(USDC_CONTRACT_ADDRESS, erc20Abi, readProvider);
        const approveTx = await erc20.populateTransaction.approve(poolAddress, depositAmount);
        const [network, feeData] = await Promise.all([
            readProvider.getNetwork(),
            readProvider.getFeeData(),
        ]);
        const unsignedApproveTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
            ...approveTx,
            chainId: network.chainId,
            gasPrice: feeData.gasPrice ?? undefined,
        };
        if (!feeData.gasPrice) {
            throw new Error('Failed to fetch network fee data for approve transaction');
        }
        logger.info('waiting for user signature [approve]');
        await txSender(unsignedApproveTx);
        // txSender is expected to wait for the approve to be mined before returning
        // (the UI's txSender calls waitForTransactionReceipt for USDC).

        // Step 2: generate ZK proof with a fresh Merkle root now that approve is confirmed
        logger.info('generating ZK proof')
        const { args, extData } = await prepareTransaction({
            inputs,
            outputs: [outputUtxo],
            encryptionKey,
            keyBasePath,
            token,
        });

        // Step 3: send transact tx (no ETH value for ERC pool)
        const partialTx = await pool.populateTransaction.transact(args, extData, { gasLimit: 2000000 });
        const [network2, feeData2] = await Promise.all([
            readProvider.getNetwork(),
            readProvider.getFeeData(),
        ]);
        const unsignedTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
            ...partialTx,
            chainId: network2.chainId,
            gasPrice: feeData2.gasPrice ?? undefined,
        };
        logger.info('waiting for user signature [deposit]');
        const tx = await txSender(unsignedTx);

        logger.info('confirming transaction');
        await confirmEncryptedOutput(extData.encryptedOutput1, token);
        return tx;
    } else {
        logger.info('generating ZK proof')
        const { args, extData } = await prepareTransaction({
            inputs,
            outputs: [outputUtxo],
            encryptionKey,
            keyBasePath,
            token,
        });
        const partialTx = await pool.populateTransaction.transact(args, extData, {
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

        logger.info('waiting for user signature [deposit]');
        const tx = await txSender(unsignedTx);
        logger.info('confirming transaction');
        await confirmEncryptedOutput(extData.encryptedOutput1, token);
        return tx;
    }
}

async function confirmEncryptedOutput(encryptedOutput1: string, token: 'eth' | 'usdc') {
    logger.debug('verifying transaction on indexer...', encryptedOutput1);
    let retryTimes = 0;
    const itv = 2;
    const start = Date.now();
    while (true) {
        logger.debug('Confirming transaction..');
        logger.debug(`retryTimes: ${retryTimes}`);
        await new Promise(resolve => setTimeout(resolve, itv * 1000));
        logger.debug('Fetching updated onchain state...');
        let res = await fetch(INDEXER_URL + '/check_encrypted_output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encryptedOutput: encryptedOutput1, token }),
        });
        let resJson = await res.json();
        if (resJson.exists) {
            logger.debug(`Top up successfully in ${((Date.now() - start) / 1000).toFixed(2)} seconds!`);
            break;
        }
        if (retryTimes >= 10) {
            throw new Error('Refresh the page to see latest balance.');
        }
        retryTimes++;
    }
}