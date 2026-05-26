import { ethers } from 'ethers';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForTxConfirmation(
    provider: ethers.providers.Provider,
    txHash: string,
    stage = 'transaction',
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
        let receipt: ethers.providers.TransactionReceipt | null = null;
        try {
            receipt = await provider.getTransactionReceipt(txHash);
        } catch (err: any) {
            lastError = err;
            console.warn(`[${stage}] receipt polling failed: ${err?.message || String(err)}. Retrying...`);
        }

        if (receipt) {
            if (receipt.status === 0) {
                throw new Error(`[${stage}] transaction reverted: ${txHash}`);
            }
            return receipt;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
    throw new Error(`[${stage}] timed out waiting for confirmation. Tx may still be pending: ${txHash}.${suffix}`);
}
