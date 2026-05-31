import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { NetworkConfig, PrivacyToken, getErc20TokenConfig, resolveNetwork } from './utils/networkConfig.js';
import type { RemoteConfig } from './utils/remoteConfig.js';
import { getRemoteConfig } from './utils/remoteConfig.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

const DYNAMIC_RENT_FEE_PERCENT = 102;
const RENT_BASE_FEE_BUMP_PERCENT = 102;
const DYNAMIC_RENT_FEE_GAS_ESTIMATE_PERCENT = 50;
const WITHDRAW_GAS_LIMIT = BigNumber.from(1600000);

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

function getFeeOverrides(net: NetworkConfig, feeData: ethers.providers.FeeData): ethers.utils.Deferrable<ethers.providers.TransactionRequest> {
    if (feeData.maxFeePerGas || feeData.maxPriorityFeePerGas) {
        const minPriorityFee = getMinPriorityFee(net);
        logger.debug(
            `Withdraw feeData: gasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
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

        const maxFeeBase = feeData.maxFeePerGas
            ?? (feeData.lastBaseFeePerGas ? feeData.lastBaseFeePerGas.mul(2).add(priorityFee) : null);
        if (!maxFeeBase) {
            throw new Error('Failed to fetch network max fee data');
        }
        const maxFeePerGas = bumpFee(maxFeeBase);
        const finalMaxFeePerGas = maxFeePerGas.gt(priorityFee) ? maxFeePerGas : priorityFee.mul(2);
        logger.debug(
            `Withdraw fee overrides: selectedPriorityFee=${formatGwei(priorityFee)} gwei, ` +
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
            `Withdraw legacy feeData: providerGasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
            `finalGasPrice=${formatGwei(gasPrice)} gwei, feeBumpPercent=${getFeeBumpPercent()}`,
        );
        return { gasPrice };
    }

    throw new Error('Failed to fetch network fee data');
}

function ceilDiv(value: BigNumber, divisor: BigNumber): BigNumber {
    return value.add(divisor).sub(1).div(divisor);
}

function scaleDynamicRentFeeGasEstimate(value: BigNumber): BigNumber {
    return value.mul(DYNAMIC_RENT_FEE_GAS_ESTIMATE_PERCENT).add(99).div(100);
}

async function getRentFeeGasPrice(
    net: NetworkConfig,
    provider: ethers.providers.JsonRpcProvider,
    feeData: ethers.providers.FeeData,
): Promise<BigNumber> {
    if (feeData.maxFeePerGas || feeData.maxPriorityFeePerGas) {
        const minPriorityFee = getMinPriorityFee(net);
        logger.debug(
            `Withdraw rent feeData: gasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
            `maxFeePerGas=${formatGwei(feeData.maxFeePerGas)} gwei, ` +
            `maxPriorityFeePerGas=${formatGwei(feeData.maxPriorityFeePerGas)} gwei, ` +
            `lastBaseFeePerGas=${formatGwei(feeData.lastBaseFeePerGas)} gwei, ` +
            `defaultMinPriorityFee=${formatGwei(minPriorityFee)} gwei, ` +
            `maxPriorityFeeCap=${MAX_PRIORITY_FEE_GWEI} gwei, ` +
            `baseFeeBumpPercent=${RENT_BASE_FEE_BUMP_PERCENT}`,
        );
        const priorityFee = selectPriorityFee(feeData.maxPriorityFeePerGas, minPriorityFee);
        if (priorityFee.isZero()) {
            throw new Error('Failed to fetch network priority fee data');
        }

        const latestBlock = await provider.getBlock('latest');
        const baseFee = latestBlock?.baseFeePerGas ?? null;
        if (baseFee) {
            const gasPrice = bumpFee(baseFee, RENT_BASE_FEE_BUMP_PERCENT).add(priorityFee);
            logger.debug(
                `Withdraw rent gas price: latestBaseFee=${formatGwei(baseFee)} gwei, ` +
                `selectedPriorityFee=${formatGwei(priorityFee)} gwei, ` +
                `finalGasPrice=${formatGwei(gasPrice)} gwei`,
            );
            return gasPrice;
        }
        if (feeData.maxFeePerGas) {
            logger.debug(`Withdraw rent gas price fallback: providerMaxFeePerGas=${formatGwei(feeData.maxFeePerGas)} gwei`);
            return BigNumber.from(feeData.maxFeePerGas);
        }
    }

    if (feeData.gasPrice) {
        const gasPrice = bumpFee(feeData.gasPrice);
        logger.debug(
            `Withdraw rent legacy gas price: providerGasPrice=${formatGwei(feeData.gasPrice)} gwei, ` +
            `finalGasPrice=${formatGwei(gasPrice)} gwei`,
        );
        return gasPrice;
    }

    throw new Error('Failed to calculate gas fee for rent fee');
}

function getEthPriceForToken(remoteConfig: RemoteConfig, token: PrivacyToken): number {
    const price = remoteConfig.prices?.eth;
    if (Number.isFinite(price) && price > 0) return price;

    const ethRentFee = remoteConfig.rent_fees.eth;
    const tokenRentFee = remoteConfig.rent_fees[token];
    if (token !== 'eth' && ethRentFee > 0 && Number.isFinite(tokenRentFee) && tokenRentFee > 0) {
        return tokenRentFee / ethRentFee;
    }

    throw new Error('ETH price is unavailable for dynamic rent fee calculation');
}

function gasFeeWeiToTokenUnits({
    gasFeeWei,
    isErc20,
    tokenDecimals,
    remoteConfig,
    token,
}: {
    gasFeeWei: BigNumber;
    isErc20: boolean;
    tokenDecimals: number;
    remoteConfig: RemoteConfig;
    token: PrivacyToken;
}): BigNumber {
    if (!isErc20) return gasFeeWei;

    const ethPrice = getEthPriceForToken(remoteConfig, token);
    const priceUnits = ethers.utils.parseUnits(ethPrice.toFixed(tokenDecimals), tokenDecimals);
    return ceilDiv(gasFeeWei.mul(priceUnits), ethers.constants.WeiPerEther);
}

async function estimateDynamicRentFee({
    readProvider,
    net,
    isErc20,
    tokenDecimals,
    remoteConfig,
    token,
}: {
    readProvider: ethers.providers.JsonRpcProvider;
    net: NetworkConfig;
    isErc20: boolean;
    tokenDecimals: number;
    remoteConfig: RemoteConfig;
    token: PrivacyToken;
}): Promise<BigNumber> {
    const feeData = await readProvider.getFeeData();
    const gasPrice = await getRentFeeGasPrice(net, readProvider, feeData);
    const rentFeeGasLimit = scaleDynamicRentFeeGasEstimate(WITHDRAW_GAS_LIMIT);
    const gasFeeWei = rentFeeGasLimit.mul(gasPrice).mul(DYNAMIC_RENT_FEE_PERCENT).add(99).div(100);
    return gasFeeWeiToTokenUnits({
        gasFeeWei,
        isErc20,
        tokenDecimals,
        remoteConfig,
        token,
    });
}

function formatTokenAmount(value: BigNumber, isErc20: boolean, tokenDecimals: number): string {
    return isErc20 ? ethers.utils.formatUnits(value, tokenDecimals) : ethers.utils.formatEther(value);
}

function assertFeeFitsWithdrawal(fee: BigNumber, withdrawAmount: BigNumber, isErc20: boolean, tokenDecimals: number, tokenSymbol: string) {
    if (fee.mul(2).gte(withdrawAmount)) {
        throw new Error(
            `Withdrawal amount must be more than twice the total fee. Fee is ${formatTokenAmount(fee, isErc20, tokenDecimals)} ${tokenSymbol}`,
        );
    }
}

function logWithdrawFeeBreakdown({
    flatFee,
    rateFee,
    totalFee,
    withdrawAmount,
    feeRate,
    isErc20,
    tokenDecimals,
    tokenSymbol,
}: {
    flatFee: BigNumber;
    rateFee: BigNumber;
    totalFee: BigNumber;
    withdrawAmount: BigNumber;
    feeRate: number;
    isErc20: boolean;
    tokenDecimals: number;
    tokenSymbol: string;
}) {
    logger.info(
        `Withdraw fee breakdown: rent/network fee=${formatTokenAmount(flatFee, isErc20, tokenDecimals)} ${tokenSymbol}, ` +
        `protocol fee=${formatTokenAmount(rateFee, isErc20, tokenDecimals)} ${tokenSymbol} (${feeRate / 100}% of ${formatTokenAmount(withdrawAmount, isErc20, tokenDecimals)} ${tokenSymbol}), ` +
        `total fee=${formatTokenAmount(totalFee, isErc20, tokenDecimals)} ${tokenSymbol}`,
    );
}

export async function withdraw({ withdrawAmountInput, recipient, keyBasePath, signature, address, token = 'eth', network }: {
    withdrawAmountInput: number,
    recipient: string,
    keyBasePath: string,
    signature: string,
    address: string,
    token?: PrivacyToken,
    network?: NetworkConfig | number,
}) {
    if (!ethers.utils.isAddress(recipient)) {
        throw new Error(`Invalid recipient address: ${recipient}`);
    }

    const net = resolveNetwork(network);
    const erc20Token = getErc20TokenConfig(net, token);
    const isErc20 = erc20Token !== null;
    const tokenSymbol = erc20Token?.symbol ?? 'ETH';
    const tokenDecimals = erc20Token?.decimals ?? 18;

    const remoteConfig = await getRemoteConfig(net);
    const minWithdrawal = remoteConfig.minimum_withdrawal[token];
    const rentFee = remoteConfig.rent_fees[token];
    const feeRate = remoteConfig.fee_rate;

    if (isErc20) {
        if (withdrawAmountInput < minWithdrawal) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawal} ${tokenSymbol}`);
        }
    } else {
        if (withdrawAmountInput < minWithdrawal) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawal} ETH`);
        }
    }

    const poolAddress = ethers.utils.getAddress(erc20Token ? erc20Token.poolAddress : net.etherPoolAddress);
    const abi = isErc20 ? ERCPoolAbi : EtherPoolAbi;
    const feeRecipient = net.feeRecipientAddress;

    logger.debug(`Withdrawing ${withdrawAmountInput} ${tokenSymbol} to recipient: ${recipient}`);

    const { encryptionKey, keypair } = deriveKeys(signature);
    logger.debug(`UTXO pubkey: ${toFixedHex(keypair.pubkey)}`);

    const readProvider = new ethers.providers.JsonRpcProvider(net.rpcUrl, {
        name: net.chainKey,
        chainId: net.chainId,
    });
    const pool = new ethers.Contract(poolAddress, abi, readProvider);

    const withdrawAmount = isErc20
        ? ethers.utils.parseUnits(withdrawAmountInput.toString(), tokenDecimals)
        : ethers.utils.parseEther(withdrawAmountInput.toString());

    // Scan on-chain events to find unspent UTXOs
    logger.info('loading utxos')
    const unspent = await findUnspentUtxos({
        etherPool: pool,
        encryptionKey,
        keypair,
        address,
        token,
        network: net,
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

    if (inputSum.lt(withdrawAmount)) {
        const have = isErc20 ? ethers.utils.formatUnits(inputSum, tokenDecimals) : ethers.utils.formatEther(inputSum);
        const need = isErc20 ? ethers.utils.formatUnits(withdrawAmount, tokenDecimals) : ethers.utils.formatEther(withdrawAmount);
        throw new Error(`Insufficient balance. Have ${have}, need ${need} (${withdrawAmountInput}).`);
    }

    const changeAmount = inputSum.sub(withdrawAmount);
    const outputs: Utxo[] = [];

    if (changeAmount.gt(0)) {
        // Change UTXOs for ERC20 pools must carry the same mintAddress.
        const mintAddress = erc20Token ? BigNumber.from(erc20Token.tokenAddress) : BigNumber.from(0);
        outputs.push(new Utxo({ amount: changeAmount, keypair, mintAddress }));
        const formattedChange = isErc20
            ? `${ethers.utils.formatUnits(changeAmount, tokenDecimals)} ${tokenSymbol}`
            : `${ethers.utils.formatEther(changeAmount)} ETH`;
        logger.debug(`Change UTXO: ${formattedChange}`);
    }

    const fixedFlatFee = isErc20
        ? ethers.utils.parseUnits(rentFee.toFixed(tokenDecimals), tokenDecimals)
        : ethers.utils.parseEther(rentFee.toFixed(18));
    let flatFee = fixedFlatFee;
    const rateFee = withdrawAmount.mul(feeRate).div(10000);
    let fee = flatFee.add(rateFee);

    logWithdrawFeeBreakdown({
        flatFee,
        rateFee,
        totalFee: fee,
        withdrawAmount,
        feeRate,
        isErc20,
        tokenDecimals,
        tokenSymbol,
    });
    assertFeeFitsWithdrawal(fee, withdrawAmount, isErc20, tokenDecimals, tokenSymbol);

    if (net.chainKey === 'eth') {
        logger.info('estimating dynamic rent fee');
        const dynamicFlatFee = await estimateDynamicRentFee({
            readProvider,
            net,
            isErc20,
            tokenDecimals,
            remoteConfig,
            token,
        });

        if (dynamicFlatFee.gt(flatFee)) {
            flatFee = dynamicFlatFee;
            fee = flatFee.add(rateFee);
            logger.debug(`Dynamic rent fee applied: ${formatTokenAmount(flatFee, isErc20, tokenDecimals)} ${tokenSymbol}`);
        } else {
            logger.debug(`Fixed rent fee retained: ${formatTokenAmount(flatFee, isErc20, tokenDecimals)} ${tokenSymbol}`);
        }

        logWithdrawFeeBreakdown({
            flatFee,
            rateFee,
            totalFee: fee,
            withdrawAmount,
            feeRate,
            isErc20,
            tokenDecimals,
            tokenSymbol,
        });
        assertFeeFitsWithdrawal(fee, withdrawAmount, isErc20, tokenDecimals, tokenSymbol);
    }

    if (isErc20) {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatUnits(inputSum, tokenDecimals)} ${tokenSymbol})`);
        logger.debug(`Fee: ${ethers.utils.formatUnits(fee, tokenDecimals)} ${tokenSymbol} (${ethers.utils.formatUnits(flatFee, tokenDecimals)} ${tokenSymbol} + ${feeRate / 100}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatUnits(withdrawAmount.sub(fee), tokenDecimals)} ${tokenSymbol}`);
    } else {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatEther(inputSum)} ETH)`);
        logger.debug(`Fee: ${ethers.utils.formatEther(fee)} ETH (${ethers.utils.formatEther(flatFee)} + ${feeRate / 100}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatEther(withdrawAmount.sub(fee))} ETH`);
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
        network: net,
    });

    logger.info('submitting transaction to relayer...');
    const response = await fetch(`${net.indexerUrl}/relayer/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, extData, token, chain: net.chainKey }),
    });

    const result = await response.json();

    if (response.ok && result.success) {
        logger.debug(`Transaction relayed successfully: ${result.txHash}`);
        logger.debug(`Confirmed in block ${result.blockNumber}`);
    } else {
        throw new Error(`Relayer error: ${result.error || response.statusText}`);
    }

    if (changeAmount.gt(0)) {
        const formattedChange = isErc20
            ? `${ethers.utils.formatUnits(changeAmount, tokenDecimals)} ${tokenSymbol}`
            : `${ethers.utils.formatEther(changeAmount)} ETH`;
        logger.debug(`\nChange UTXO created (${formattedChange})`);
    }

    logger.info('confirming transaction')
    let retryTimes = 0
    const itv = 3
    let start = Date.now()
    while (true) {
        logger.debug('Confirming transaction..')
        logger.debug(`retryTimes: ${retryTimes}`)
        await new Promise(resolve => setTimeout(resolve, itv * 1000));
        logger.debug('Fetching updated onchain state...');
        let res = await fetch(net.indexerUrl + '/check_encrypted_output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ encryptedOutput: extData.encryptedOutput1, token, chain: net.chainKey }),
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
