import { ethers } from 'ethers';
import { deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';

if (!process.env.PRIVATE_KEY) {
    console.warn("Warning: PRIVATE_KEY is not set. Tests will fail.");
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;

const RPC_URL = 'https://mainnet.base.org';

function parseRequiredAmount(amountArg: string | undefined, testType: 'deposit' | 'withdraw') {
    if (!amountArg) {
        throw new Error(`Missing amount. Usage: bun example/eth.ts ${testType} <amount_in_eth>`);
    }

    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount "${amountArg}". Please provide a positive number in ETH.`);
    }

    return amount;
}

async function testSDK(testType: string, amountArg?: string) {
    console.log('--- SDK Testing Started ---');

    // Setup provider and signer
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL, {
        name: 'base',
        chainId: 8453,
    });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);

    const signature = await signer.signMessage(SIGN_PRIVACY_MESSAGE);
    console.log(await signer.getAddress())
    console.log('signature', signature)
    // const transactionSigner = async (unsignedTx: any) => {
    //     return await signer.signTransaction(unsignedTx);
    // }

    try {
        // Check Balance
        if (testType === 'balance') {
            console.log('Wallet balance')
            // print wallet balance
            const balance = await provider.getBalance(await signer.getAddress());
            console.log(`Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);

            console.log('\n Checking Balance...');
            const res = await getBalance({ signature, address: await signer.getAddress() });
            console.log(`Initial total unspent: ${res.balance} ETH`);
        }

        // Deposit
        else if (testType === 'deposit') {
            const depositAmount = parseRequiredAmount(amountArg, 'deposit');
            console.log('\n Performing Deposit...');
            const txSender = async (unsignedTx: any) => {
                let tx = await signer.sendTransaction(unsignedTx);
                await tx.wait();
                return tx.hash;
            }
            const tx = await deposit({ txSender, depositAmountInput: depositAmount, keyBasePath: './circuits/transaction', signature, address: await signer.getAddress() });
            console.log(`Deposit transaction sent! TX`, tx);
        }

        // Withdrawal
        else if (testType === 'withdraw') {
            const withdrawAmount = parseRequiredAmount(amountArg, 'withdraw');
            console.log('\n Performing Withdrawal...');
            const withdrawResult = await withdraw({ withdrawAmountInput: withdrawAmount, recipient: await signer.getAddress(), keyBasePath: './circuits/transaction', signature, address: await signer.getAddress() });
            console.log(`Withdrawal successful! TX: ${withdrawResult}`);
        }

        // clear cache
        else if (testType === 'clear') {
            console.log('\n Clearing Cache...');
            const { clearCache } = await import('../src/utils/utils.js');
            await clearCache(await signer.getAddress());
            console.log('Cache cleared successfully!');
        }

        else {
            console.log('Usage: bun example/eth.ts <balance|deposit|withdraw> [amount_in_eth]');
            console.log('Examples:');
            console.log('  bun example/eth.ts balance');
            console.log('  bun example/eth.ts deposit 0.001');
            console.log('  bun example/eth.ts withdraw 0.001');
        }


    } catch (error: any) {
        console.error('\n--- Test Failed ---');
        console.error(error.message || error);
        if (error.stack) console.error(error.stack);
    }
}

// Get test type from command line arguments
const testType = process.argv[2];
const amountArg = process.argv[3];
if (testType) {
    testSDK(testType, amountArg);
} else {
    console.log('Usage: bun example/eth.ts <balance|deposit|withdraw> [amount_in_eth]');
    console.log('Examples:');
    console.log('  bun example/eth.ts balance');
    console.log('  bun example/eth.ts deposit 0.001');
    console.log('  bun example/eth.ts withdraw 0.001');
}
