import { ethers } from 'ethers';
import { ROBINHOOD_NETWORK, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';
import { waitForTxConfirmation } from './waitForTx.js';

if (!process.env.PRIVATE_KEY) {
    console.warn('Warning: PRIVATE_KEY is not set. Tests will fail.');
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const network = ROBINHOOD_NETWORK;

function parseRequiredAmount(amountArg: string | undefined, testType: 'deposit' | 'withdraw') {
    if (!amountArg) {
        throw new Error(`Missing amount. Usage: bun example/robin-eth.ts ${testType} <amount_in_eth>`);
    }

    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount "${amountArg}". Please provide a positive number in ETH.`);
    }

    return amount;
}

function printUsage() {
    console.log('Usage: bun example/robin-eth.ts <balance|deposit|withdraw|clear> [amount_in_eth]');
    console.log('Examples:');
    console.log('  bun example/robin-eth.ts balance');
    console.log('  bun example/robin-eth.ts deposit 0.001');
    console.log('  bun example/robin-eth.ts withdraw 0.005');
    console.log('  bun example/robin-eth.ts clear');
}

async function testSDK(testType: string, amountArg?: string) {
    console.log('--- SDK Robinhood ETH Testing Started ---');

    const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, {
        name: network.chainKey,
        chainId: network.chainId,
    });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const address = await signer.getAddress();
    const signature = await signer.signMessage(SIGN_PRIVACY_MESSAGE);

    console.log(address);
    console.log('signature', signature);

    try {
        if (testType === 'balance') {
            console.log('Wallet balance');
            const balance = await provider.getBalance(address);
            console.log(`Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);

            console.log('\nChecking shielded balance...');
            const result = await getBalance({ signature, address, network });
            console.log(`Shielded balance: ${result.balance} ETH`);
        }

        else if (testType === 'deposit') {
            const depositAmount = parseRequiredAmount(amountArg, 'deposit');
            console.log(`\nPerforming ETH deposit of ${depositAmount} ETH...`);

            const txSender = async (unsignedTx: ethers.providers.TransactionRequest) => {
                const tx = await signer.sendTransaction(unsignedTx);
                await waitForTxConfirmation(provider, tx.hash, 'deposit');
                return tx.hash;
            };

            const tx = await deposit({
                txSender,
                depositAmountInput: depositAmount,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                network,
            });
            console.log('Deposit transaction sent! TX:', tx);
        }

        else if (testType === 'withdraw') {
            const withdrawAmount = parseRequiredAmount(amountArg, 'withdraw');
            console.log(`\nPerforming ETH withdrawal of ${withdrawAmount} ETH...`);

            const withdrawResult = await withdraw({
                withdrawAmountInput: withdrawAmount,
                recipient: address,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                network,
            });
            console.log(`Withdrawal successful! TX: ${withdrawResult}`);
        }

        else if (testType === 'clear') {
            console.log('\nClearing cache...');
            const { clearCache } = await import('../src/utils/utils.js');
            await clearCache(address, 'eth', network);
            console.log('Cache cleared successfully!');
        }

        else {
            printUsage();
        }
    } catch (error: any) {
        console.error('\n--- Test Failed ---');
        console.error(error.message || error);
        if (error.stack) console.error(error.stack);
    }
}

const testType = process.argv[2];
const amountArg = process.argv[3];
if (testType) {
    testSDK(testType, amountArg);
} else {
    printUsage();
}
