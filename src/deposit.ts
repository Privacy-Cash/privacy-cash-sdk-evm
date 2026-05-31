import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { NetworkConfig, PrivacyToken, getErc20TokenConfig, resolveNetwork } from './utils/networkConfig.js';
import { getRemoteConfig } from './utils/remoteConfig.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

function getFeeBumpPercent(): number {
    const value = Number(process.env.NEXT_PUBLIC_EVM_FEE_BUMP_PERCENT || process.env.EVM_FEE_BUMP_PERCENT);
    if (Number.isFinite(value) && value >= 100) return Math.floor(value);
    return 110;
}

function bumpFee(value: BigNumber, percent = getFeeBumpPercent()): BigNumber {
    return value.mul(percent).div(100);
}

const MAX_PRIORITY_FEE_GWEI = '0.3';
const MAX_PRIORITY_FEE = ethers.utils.parseUnits(MAX_PRIORITY_FEE_GWEI, 'gwei');

function formatGwei(value?: BigNumber | null): string {
    return value ? ethers.utils.formatUnits(value, 'gwei') : 'null';
}

function getGasLimitBumpPercent(): number {
    const value = Number(process.env.NEXT_PUBLIC_EVM_GAS_LIMIT_BUMP_PERCENT || process.env.EVM_GAS_LIMIT_BUMP_PERCENT);
    if (Number.isFinite(value) && value >= 100) return Math.floor(value);
    return 120;
}

function bumpGasLimit(value: BigNumber, percent = getGasLimitBumpPercent()): BigNumber {
    return value.mul(percent).add(99).div(100);
}

function getMinPriorityFee(net: NetworkConfig): BigNumber | null {
    const configured = process.env.NEXT_PUBLIC_ETH_MIN_PRIORITY_FEE_GWEI || process.env.ETH_MIN_PRIORITY_FEE_GWEI;
    const gwei = configured || (net.chainKey === 'eth' ? '0.2' : '');
    return gwei ? ethers.utils.parseUnits(gwei, 'gwei') : null;
}

function selectPriorityFee(providerPriorityFee: BigNumber | null | undefined, minPriorityFee: BigNumber | null): BigNumber {
    const priorityFee = providerPriorityFee && !providerPriorityFee.isZero()
        ? providerPriorityFee
        : (minPriorityFee ?? BigNumber.from(0));
    return priorityFee.gt(MAX_PRIORITY_FEE) ? MAX_PRIORITY_FEE : priorityFee;
}

async function getFeeOverrides(
    net: NetworkConfig,
    provider: ethers.providers.JsonRpcProvider,
    feeData?: ethers.providers.FeeData,
): Promise<ethers.utils.Deferrable<ethers.providers.TransactionRequest>> {
    feeData ??= await provider.getFeeData();

    if (feeData.maxFeePerGas || feeData.maxPriorityFeePerGas) {
        const minPriorityFee = getMinPriorityFee(net);
        logger.debug(
            `Deposit feeData: gasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
            `maxFeePerGas=${formatGwei(feeData.maxFeePerGas)} gwei, ` +
            `maxPriorityFeePerGas=${formatGwei(feeData.maxPriorityFeePerGas)} gwei, ` +
            `lastBaseFeePerGas=${formatGwei(feeData.lastBaseFeePerGas)} gwei, ` +
            `defaultMinPriorityFee=${formatGwei(minPriorityFee)} gwei, ` +
            `maxPriorityFeeCap=${MAX_PRIORITY_FEE_GWEI} gwei, ` +
            `feeBumpPercent=${getFeeBumpPercent()}`,
        );
        const priorityFee = selectPriorityFee(feeData.maxPriorityFeePerGas, minPriorityFee);
        if (priorityFee.isZero()) {
            throw new Error('Failed to fetch network priority fee data');
        }

        let maxFeeBase = feeData.maxFeePerGas;
        let fallbackBaseFee: BigNumber | null = null;
        if (!maxFeeBase) {
            const latestBlock = await provider.getBlock('latest');
            fallbackBaseFee = latestBlock?.baseFeePerGas ?? null;
            maxFeeBase = latestBlock?.baseFeePerGas
                ? latestBlock.baseFeePerGas.mul(2).add(priorityFee)
                : null;
        }
        if (!maxFeeBase) {
            throw new Error('Failed to fetch network max fee data');
        }
        const maxFeePerGas = bumpFee(maxFeeBase);
        const finalMaxFeePerGas = maxFeePerGas.gt(priorityFee) ? maxFeePerGas : priorityFee.mul(2);
        logger.debug(
            `Deposit fee overrides: selectedPriorityFee=${formatGwei(priorityFee)} gwei, ` +
            `fallbackLatestBaseFee=${formatGwei(fallbackBaseFee)} gwei, ` +
            `maxFeeBase=${formatGwei(maxFeeBase)} gwei, ` +
            `finalMaxFeePerGas=${formatGwei(finalMaxFeePerGas)} gwei`,
        );
        return {
            type: 2,
            maxPriorityFeePerGas: priorityFee,
            maxFeePerGas: finalMaxFeePerGas,
        };
    }

    if (feeData.gasPrice) {
        const gasPrice = bumpFee(feeData.gasPrice);
        logger.debug(
            `Deposit legacy feeData: providerGasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
            `finalGasPrice=${formatGwei(gasPrice)} gwei, feeBumpPercent=${getFeeBumpPercent()}`,
        );
        return { gasPrice };
    }

    throw new Error('Failed to fetch network fee data');
}

async function estimateTransactGasLimit({
    pool,
    args,
    extData,
    estimateOverrides,
    fallback,
}: {
    pool: ethers.Contract,
    args: any,
    extData: any,
    estimateOverrides: ethers.providers.TransactionRequest,
    fallback: BigNumber,
}): Promise<BigNumber> {
    try {
        const estimated = await pool.estimateGas.transact(args, extData, estimateOverrides);
        const gasLimit = bumpGasLimit(estimated);
        logger.debug(`Estimated transact gas: ${estimated.toString()} (using limit ${gasLimit.toString()})`);
        return gasLimit;
    } catch (err) {
        logger.warn(`Failed to estimate transact gas; using fallback ${fallback.toString()}. Error:`, err);
        return fallback;
    }
}

export async function deposit({ depositAmountInput, keyBasePath, signature, address, txSender, token = 'eth', network }: {
    depositAmountInput: number,
    keyBasePath: string,
    signature: string,
    address: string,
    txSender: any,
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

    const remoteConfig = await getRemoteConfig(net);
    const minDeposit = remoteConfig.minimum_deposit[token];

    if (isErc20) {
        if (depositAmountInput < minDeposit) {
            throw new Error(`Deposit amount must be at least ${minDeposit} ${tokenSymbol}`);
        }
    } else {
        if (depositAmountInput < minDeposit) {
            throw new Error(`Deposit amount must be at least ${minDeposit} ETH`);
        }
    }

    const poolAddress = ethers.utils.getAddress(erc20Token ? erc20Token.poolAddress : net.etherPoolAddress);
    const abi = isErc20 ? ERCPoolAbi : EtherPoolAbi;

    logger.debug(`Depositor: ${address}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const pool = new ethers.Contract(poolAddress, abi, readProvider);

    if (!isErc20) {
        const poolBalance = await readProvider.getBalance(pool.address);
        logger.debug(`EtherPool: ${pool.address}`);
        logger.debug(`Pool balance: ${ethers.utils.formatEther(poolBalance)} ETH`);
    }

    const depositAmount = isErc20
        ? ethers.utils.parseUnits(depositAmountInput.toString(), tokenDecimals)
        : ethers.utils.parseEther(depositAmountInput.toString());

    const maxDeposit = await pool.maximumDepositAmount();
    if (depositAmount.gt(maxDeposit)) {
        const formatted = isErc20
            ? `${ethers.utils.formatUnits(maxDeposit, tokenDecimals)} ${tokenSymbol}`
            : `${ethers.utils.formatEther(maxDeposit)} ETH`;
        throw new Error(`Please deposit less than ${formatted}`);
    }

    // post address to /screen_address of indexer to check if it's blacklisted
    logger.info('screening wallet')
    logger.debug(`screening address ${address}`)
    try {
        let res = await fetch(net.indexerUrl + '/screen_address', {
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
        network: net,
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
    // For ERC20 pools, embed the token contract address as mintAddress in the UTXO.
    const mintAddress = erc20Token ? BigNumber.from(erc20Token.tokenAddress) : BigNumber.from(0);
    const outputUtxo = new Utxo({ amount: outputAmount, keypair, mintAddress });

    const formattedOutput = isErc20
        ? `${ethers.utils.formatUnits(outputAmount, tokenDecimals)} ${tokenSymbol}`
        : `${ethers.utils.formatEther(outputAmount)} ETH`;
    logger.debug(`Depositing ${depositAmountInput} ${tokenSymbol} (new output: ${formattedOutput})`);

    if (isErc20 && erc20Token) {
        // Step 1: send ERC20 approve tx first, BEFORE generating the ZK proof.
        // The proof fetches the Merkle root; if we generate it before the approve
        // is mined the root can advance while waiting, causing proof verification
        // to fail on-chain.
        const erc20Abi = [
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)',
        ];
        const erc20 = new ethers.Contract(erc20Token.tokenAddress, erc20Abi, readProvider);
        const [network, feeData] = await Promise.all([
            readProvider.getNetwork(),
            readProvider.getFeeData(),
        ]);
        const feeOverrides = await getFeeOverrides(net, readProvider, feeData);
        const allowance: BigNumber = await erc20.allowance(address, poolAddress);
        logger.debug(`Current ${tokenSymbol} allowance: ${ethers.utils.formatUnits(allowance, tokenDecimals)} ${tokenSymbol}`);
        if (allowance.lt(depositAmount)) {
            if (token === 'usdt' && allowance.gt(0)) {
                const resetApproveTx = await erc20.populateTransaction.approve(poolAddress, 0);
                const unsignedResetApproveTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
                    ...resetApproveTx,
                    chainId: network.chainId,
                    ...feeOverrides,
                };
                logger.info('waiting for user signature [approve-reset]');
                await txSender(unsignedResetApproveTx, { stage: 'approve-reset', token, chain: net.chainKey });
            }

            const approveTx = await erc20.populateTransaction.approve(poolAddress, depositAmount);
            const unsignedApproveTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
                ...approveTx,
                chainId: network.chainId,
                ...feeOverrides,
            };
            logger.info('waiting for user signature [approve]');
            await txSender(unsignedApproveTx, { stage: 'approve', token, chain: net.chainKey });
        } else {
            logger.info(`${tokenSymbol} allowance is sufficient; skipping approve`);
        }
        // txSender is expected to wait for the approve to be mined before returning
        // (the UI's txSender calls waitForTransactionReceipt for ERC20 deposits).

        // Step 2: generate ZK proof with a fresh Merkle root now that approve is confirmed
        logger.info('generating ZK proof')
        const { args, extData } = await prepareTransaction({
            inputs,
            outputs: [outputUtxo],
            encryptionKey,
            keyBasePath,
            token,
            network: net,
        });

        // Step 3: send transact tx (no ETH value for ERC pool)
        const gasLimit = await estimateTransactGasLimit({
            pool,
            args,
            extData,
            estimateOverrides: { from: address },
            fallback: BigNumber.from(2000000),
        });
        const partialTx = await pool.populateTransaction.transact(args, extData, { gasLimit });
        const [network2, feeData2] = await Promise.all([
            readProvider.getNetwork(),
            readProvider.getFeeData(),
        ]);
        const unsignedTx: ethers.utils.Deferrable<ethers.providers.TransactionRequest> = {
            ...partialTx,
            chainId: network2.chainId,
            ...(await getFeeOverrides(net, readProvider, feeData2)),
        };
        logger.info('waiting for user signature [deposit]');
        const tx = await txSender(unsignedTx, { stage: 'deposit', token, chain: net.chainKey });

        logger.info('confirming transaction');
        await confirmEncryptedOutput(extData.encryptedOutput1, token, net);
        return tx;
    } else {
        logger.info('generating ZK proof')
        const { args, extData } = await prepareTransaction({
            inputs,
            outputs: [outputUtxo],
            encryptionKey,
            keyBasePath,
            token,
            network: net,
        });
        const gasLimit = await estimateTransactGasLimit({
            pool,
            args,
            extData,
            estimateOverrides: {
                from: address,
                value: depositAmount,
            },
            fallback: BigNumber.from(3000000),
        });
        const partialTx = await pool.populateTransaction.transact(args, extData, {
            value: depositAmount,
            gasLimit,
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
        Object.assign(unsignedTx, await getFeeOverrides(net, readProvider, feeData));

        logger.info('waiting for user signature [deposit]');
        const tx = await txSender(unsignedTx);
        logger.info('confirming transaction');
        await confirmEncryptedOutput(extData.encryptedOutput1, token, net);
        return tx;
    }
}

async function confirmEncryptedOutput(encryptedOutput1: string, token: PrivacyToken, net: NetworkConfig) {
    logger.debug('verifying transaction on indexer...', encryptedOutput1);
    let retryTimes = 0;
    const intervalMs = 3000;
    const maxRetries = 10;
    const start = Date.now();
    while (true) {
        logger.debug('Confirming transaction..');
        logger.debug(`retryTimes: ${retryTimes}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        logger.debug('Fetching updated onchain state...');
        let res = await fetch(net.indexerUrl + '/check_encrypted_output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encryptedOutput: encryptedOutput1, token, chain: net.chainKey }),
        });
        let resJson = await res.json();
        if (resJson.exists) {
            logger.debug(`Top up successfully in ${((Date.now() - start) / 1000).toFixed(2)} seconds!`);
            break;
        }
        if (retryTimes >= maxRetries) {
            throw new Error('Refresh the page to see latest balance.');
        }
        retryTimes++;
    }
}
