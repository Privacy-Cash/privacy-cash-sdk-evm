import { ethers } from 'ethers';
import { BNB_NETWORK, clearCache, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';
import { waitForTxConfirmation } from './waitForTx.js';

const privateKey = process.env.BNB_PRIVATE_KEY;
if (!privateKey) {
    console.error('PRIVATE_KEY is required');
    process.exit(1);
}

const action = process.argv[2];
const amount = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const network = BNB_NETWORK;

function requireAmount(): number {
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
        throw new Error('A positive BNB amount is required');
    }
    return amount;
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
        const walletBalance = await provider.getBalance(address);
        const shielded = await getBalance({ signature, address, token: 'bnb', network });
        console.log(`Wallet balance: ${ethers.utils.formatEther(walletBalance)} BNB`);
        console.log(`Shielded balance: ${shielded.balance} BNB`);
        return;
    }

    if (action === 'deposit') {
        const txSender = async (unsignedTx: ethers.providers.TransactionRequest) => {
            const tx = await signer.sendTransaction(unsignedTx);
            await waitForTxConfirmation(provider, tx.hash, 'deposit');
            return tx.hash;
        };
        const result = await deposit({
            depositAmountInput: requireAmount(),
            keyBasePath: './circuits/transaction',
            signature,
            address,
            txSender,
            token: 'bnb',
            network,
        });
        console.log('Deposit submitted:', result);
        return;
    }

    if (action === 'withdraw') {
        const txHash = await withdraw({
            withdrawAmountInput: requireAmount(),
            recipient: address,
            keyBasePath: './circuits/transaction',
            signature,
            address,
            token: 'bnb',
            network,
        });
        console.log(`Withdrawal confirmed: ${network.blockExplorerUrl}tx/${txHash}`);
        return;
    }

    if (action === 'clear') {
        await clearCache(address, 'bnb', network);
        console.log('BNB cache cleared');
        return;
    }

    console.log('Usage: bun example/bnb-bnb.ts <balance|deposit|withdraw|clear> [amount_in_bnb]');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
