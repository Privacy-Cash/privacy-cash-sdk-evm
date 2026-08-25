import { ethers } from 'ethers';
import { ROBINHOOD_NETWORK, clearCache, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';
import { waitForTxConfirmation } from './waitForTx.js';

function getPrivateKey(): string {
    const value = process.env.PRIVATE_KEY;
    if (!value) throw new Error('PRIVATE_KEY is required');
    return value;
}

const privateKey = getPrivateKey();
const action = process.argv[2];
const amount = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const network = ROBINHOOD_NETWORK;
const token = 'usdg' as const;

const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
];

function requireAmount(): number {
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('A positive USDG amount is required');
    }
    return amount;
}

function printUsage() {
    console.log('Usage: bun example/robin-usdg.ts <balance|deposit|withdraw|clear> [amount_in_usdg]');
    console.log('Examples:');
    console.log('  bun example/robin-usdg.ts balance');
    console.log('  bun example/robin-usdg.ts deposit 10');
    console.log('  bun example/robin-usdg.ts withdraw 10');
    console.log('  bun example/robin-usdg.ts clear');
}

async function main() {
    const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, {
        name: network.chainKey,
        chainId: network.chainId,
    });
    const signer = new ethers.Wallet(privateKey, provider);
    const address = await signer.getAddress();
    const signature = await signer.signMessage(SIGN_PRIVACY_MESSAGE);

    if (action === 'balance') {
        const usdg = new ethers.Contract(network.usdgTokenAddress, ERC20_ABI, provider);
        const walletBalance = await usdg.balanceOf(address);
        const shielded = await getBalance({ signature, address, token, network });
        console.log(`Wallet balance: ${ethers.utils.formatUnits(walletBalance, network.usdgDecimals)} USDG`);
        console.log(`Shielded balance: ${shielded.balance} USDG`);
        return;
    }

    if (action === 'deposit') {
        const txSender = async (
            unsignedTx: ethers.providers.TransactionRequest,
            meta?: { stage?: string },
        ) => {
            const stage = meta?.stage ?? 'deposit';
            const tx = await signer.sendTransaction(unsignedTx);
            console.log(`[${stage}] submitted: ${tx.hash}`);
            await waitForTxConfirmation(provider, tx.hash, stage);
            return tx.hash;
        };
        const txHash = await deposit({
            depositAmountInput: requireAmount(),
            keyBasePath: './circuits/transaction',
            signature,
            address,
            txSender,
            token,
            network,
        });
        console.log(`Deposit confirmed: ${network.blockExplorerUrl}tx/${txHash}`);
        return;
    }

    if (action === 'withdraw') {
        const txHash = await withdraw({
            withdrawAmountInput: requireAmount(),
            recipient: address,
            keyBasePath: './circuits/transaction',
            signature,
            address,
            token,
            network,
        });
        console.log(`Withdrawal confirmed: ${network.blockExplorerUrl}tx/${txHash}`);
        return;
    }

    if (action === 'clear') {
        await clearCache(address, token, network);
        console.log('USDG cache cleared');
        return;
    }

    printUsage();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
