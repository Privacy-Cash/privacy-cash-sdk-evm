import { BigNumber, ethers } from 'ethers';
import ERCPoolAbi from './utils/ERCPool.abi.json' with { type: 'json' };
import EtherPoolAbi from './utils/EtherPool.abi.json' with { type: 'json' };
import { deriveKeys } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import { NetworkConfig, PrivacyToken, getErc20TokenConfig, resolveNetwork, resolvePrivacyToken } from './utils/networkConfig.js';
import type { FeeSnapshot, RemoteConfig } from './utils/remoteConfig.js';
import { getRemoteConfig } from './utils/remoteConfig.js';
import { findUnspentUtxos, prepareTransaction, toFixedHex } from './utils/utils.js';
import { Utxo } from './utils/utxo.js';

function formatTokenAmount(value: BigNumber, isErc20: boolean, tokenDecimals: number): string {
    return isErc20 ? ethers.utils.formatUnits(value, tokenDecimals) : ethers.utils.formatEther(value);
}

const ROBINHOOD_REFERRAL_PROTOCOL_FEE_PERCENT = 90;

function hasReferralWithdrawDiscount(net: NetworkConfig, referId?: string): boolean {
    return net.chainKey === 'robinhood' && typeof referId === 'string' && referId.trim().length > 0;
}

function getProtocolFeeRatePercent(feeRateBps: number, isReferralDiscountActive: boolean): number {
    const multiplierPercent = isReferralDiscountActive ? ROBINHOOD_REFERRAL_PROTOCOL_FEE_PERCENT : 100;
    return feeRateBps * multiplierPercent / 10000;
}

function getRateFeeUnits(withdrawAmount: BigNumber, feeRateBps: number, isReferralDiscountActive: boolean): BigNumber {
    if (!isReferralDiscountActive) {
        return withdrawAmount.mul(feeRateBps).div(10000);
    }
    return withdrawAmount.mul(feeRateBps).mul(ROBINHOOD_REFERRAL_PROTOCOL_FEE_PERCENT).div(10000).div(100);
}

function assertFeeFitsWithdrawal(fee: BigNumber, withdrawAmount: BigNumber, isErc20: boolean, tokenDecimals: number, tokenSymbol: string) {
    if (fee.mul(2).gte(withdrawAmount)) {
        throw new Error(
            `Withdrawal amount must be more than twice the total fee. Fee is ${formatTokenAmount(fee, isErc20, tokenDecimals)} ${tokenSymbol}`,
        );
    }
}

function validateFeeSnapshot({
    net,
    token,
    feeSnapshot,
    expiredAsMissing = false,
}: {
    net: NetworkConfig;
    token: PrivacyToken;
    feeSnapshot?: FeeSnapshot | null;
    expiredAsMissing?: boolean;
}): FeeSnapshot | null {
    const snapshot = feeSnapshot ?? null;
    if (!snapshot || net.chainKey !== 'eth') return null;

    if (snapshot.chain !== 'eth') {
        throw new Error(`Unsupported fee snapshot chain: ${snapshot.chain}`);
    }
    if (Date.now() > snapshot.expiresAt) {
        if (expiredAsMissing) return null;
        throw new Error('Fee snapshot expired. Please refresh the quote and try again.');
    }
    if (!snapshot.rentFeeUnits?.[token]) {
        throw new Error(`${token.toUpperCase()} rent fee is missing from fee snapshot`);
    }

    return snapshot;
}

async function resolveFeeSnapshot({
    net,
    token,
    remoteConfig,
    feeSnapshot,
}: {
    net: NetworkConfig;
    token: PrivacyToken;
    remoteConfig: RemoteConfig;
    feeSnapshot?: FeeSnapshot | null;
}): Promise<{ remoteConfig: RemoteConfig; feeSnapshot: FeeSnapshot | null }> {
    const providedSnapshot = validateFeeSnapshot({ net, token, feeSnapshot });
    if (providedSnapshot || net.chainKey !== 'eth') {
        return { remoteConfig, feeSnapshot: providedSnapshot };
    }

    const configSnapshot = validateFeeSnapshot({
        net,
        token,
        feeSnapshot: remoteConfig.feeSnapshot,
        expiredAsMissing: true,
    });
    if (configSnapshot) {
        return { remoteConfig, feeSnapshot: configSnapshot };
    }

    logger.info('ETH fee snapshot missing from cached config, refreshing remote config');
    const refreshedConfig = await getRemoteConfig(net, { forceRefresh: true });
    const refreshedSnapshot = validateFeeSnapshot({
        net,
        token,
        feeSnapshot: refreshedConfig.feeSnapshot,
    });
    if (!refreshedSnapshot) {
        throw new Error('ETH fee snapshot is required. Please refresh the quote and try again.');
    }

    return { remoteConfig: refreshedConfig, feeSnapshot: refreshedSnapshot };
}

function getFlatFeeUnits({
    rentFee,
    feeSnapshot,
    token,
    isErc20,
    tokenDecimals,
}: {
    rentFee: number;
    feeSnapshot: FeeSnapshot | null;
    token: PrivacyToken;
    isErc20: boolean;
    tokenDecimals: number;
}): BigNumber {
    const snapshotRentFee = feeSnapshot?.rentFeeUnits?.[token];
    if (snapshotRentFee) return BigNumber.from(snapshotRentFee);

    return isErc20
        ? ethers.utils.parseUnits(rentFee.toFixed(tokenDecimals), tokenDecimals)
        : ethers.utils.parseEther(rentFee.toFixed(18));
}

function logWithdrawFeeBreakdown({
    flatFee,
    rateFee,
    totalFee,
    withdrawAmount,
    protocolFeeRatePercent,
    isErc20,
    tokenDecimals,
    tokenSymbol,
}: {
    flatFee: BigNumber;
    rateFee: BigNumber;
    totalFee: BigNumber;
    withdrawAmount: BigNumber;
    protocolFeeRatePercent: number;
    isErc20: boolean;
    tokenDecimals: number;
    tokenSymbol: string;
}) {
    logger.info(
        `Withdraw fee breakdown: rent/network fee=${formatTokenAmount(flatFee, isErc20, tokenDecimals)} ${tokenSymbol}, ` +
        `protocol fee=${formatTokenAmount(rateFee, isErc20, tokenDecimals)} ${tokenSymbol} (${protocolFeeRatePercent}% of ${formatTokenAmount(withdrawAmount, isErc20, tokenDecimals)} ${tokenSymbol}), ` +
        `total fee=${formatTokenAmount(totalFee, isErc20, tokenDecimals)} ${tokenSymbol}`,
    );
}

export async function withdraw({ withdrawAmountInput, recipient, keyBasePath, signature, address, token, network, feeSnapshot, referId }: {
    withdrawAmountInput: number,
    recipient: string,
    keyBasePath: string,
    signature: string,
    address: string,
    token?: PrivacyToken,
    network?: NetworkConfig | number,
    feeSnapshot?: FeeSnapshot | null,
    referId?: string,
}) {
    if (!ethers.utils.isAddress(recipient)) {
        throw new Error(`Invalid recipient address: ${recipient}`);
    }

    const net = resolveNetwork(network);
    const resolvedToken = resolvePrivacyToken(net, token);
    const erc20Token = getErc20TokenConfig(net, resolvedToken);
    const isErc20 = erc20Token !== null;
    const tokenSymbol = erc20Token?.symbol ?? net.nativeSymbol ?? (net.chainKey === 'bnb' ? 'BNB' : 'ETH');
    const tokenDecimals = erc20Token?.decimals ?? 18;

    let remoteConfig = await getRemoteConfig(net);
    const snapshotResolution = await resolveFeeSnapshot({
        net,
        token: resolvedToken,
        remoteConfig,
        feeSnapshot,
    });
    remoteConfig = snapshotResolution.remoteConfig;
    const activeFeeSnapshot = snapshotResolution.feeSnapshot;
    const minWithdrawal = remoteConfig.minimum_withdrawal[resolvedToken];
    const rentFee = remoteConfig.rent_fees[resolvedToken];
    const feeRate = activeFeeSnapshot?.feeRateBps ?? remoteConfig.fee_rate;
    const isReferralDiscountActive = hasReferralWithdrawDiscount(net, referId);
    const activeReferId = isReferralDiscountActive ? referId?.trim() : undefined;
    const protocolFeeRatePercent = getProtocolFeeRatePercent(feeRate, isReferralDiscountActive);

    if (isErc20) {
        if (withdrawAmountInput < minWithdrawal) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawal} ${tokenSymbol}`);
        }
    } else {
        if (withdrawAmountInput < minWithdrawal) {
            throw new Error(`Withdrawal amount must be at least ${minWithdrawal} ${tokenSymbol}`);
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
        token: resolvedToken,
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
            : `${ethers.utils.formatEther(changeAmount)} ${tokenSymbol}`;
        logger.debug(`Change UTXO: ${formattedChange}`);
    }

    const fixedFlatFee = getFlatFeeUnits({
        rentFee,
        feeSnapshot: activeFeeSnapshot,
        token: resolvedToken,
        isErc20,
        tokenDecimals,
    });
    let flatFee = fixedFlatFee;
    const rateFee = getRateFeeUnits(withdrawAmount, feeRate, isReferralDiscountActive);
    let fee = flatFee.add(rateFee);

    logWithdrawFeeBreakdown({
        flatFee,
        rateFee,
        totalFee: fee,
        withdrawAmount,
        protocolFeeRatePercent,
        isErc20,
        tokenDecimals,
        tokenSymbol,
    });
    assertFeeFitsWithdrawal(fee, withdrawAmount, isErc20, tokenDecimals, tokenSymbol);

    if (activeFeeSnapshot) {
        logger.info(`using ETH fee snapshot ${activeFeeSnapshot.id}`);
    }

    if (net.chainKey === 'eth' && !activeFeeSnapshot) {
        throw new Error('ETH fee snapshot is required. Please refresh the quote and try again.');
    }

    if (isErc20) {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatUnits(inputSum, tokenDecimals)} ${tokenSymbol})`);
        logger.debug(`Fee: ${ethers.utils.formatUnits(fee, tokenDecimals)} ${tokenSymbol} (${ethers.utils.formatUnits(flatFee, tokenDecimals)} ${tokenSymbol} + ${protocolFeeRatePercent}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatUnits(withdrawAmount.sub(fee), tokenDecimals)} ${tokenSymbol}`);
    } else {
        logger.debug(`Input UTXOs: ${inputs.length} (total: ${ethers.utils.formatEther(inputSum)} ${tokenSymbol})`);
        logger.debug(`Fee: ${ethers.utils.formatEther(fee)} ${tokenSymbol} (${ethers.utils.formatEther(flatFee)} + ${protocolFeeRatePercent}%)`);
        logger.debug(`Amount to arrive at recipient: ${ethers.utils.formatEther(withdrawAmount.sub(fee))} ${tokenSymbol}`);
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
        token: resolvedToken,
        network: net,
    });

    logger.info('submitting transaction to relayer...');
    const response = await fetch(`${net.indexerUrl}/relayer/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, extData, token: resolvedToken, chain: net.chainKey, feeSnapshotId: activeFeeSnapshot?.id, referId: activeReferId }),
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
            : `${ethers.utils.formatEther(changeAmount)} ${tokenSymbol}`;
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
            body: JSON.stringify({ encryptedOutput: extData.encryptedOutput1, token: resolvedToken, chain: net.chainKey }),
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
