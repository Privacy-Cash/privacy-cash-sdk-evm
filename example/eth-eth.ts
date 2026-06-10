import { ethers } from 'ethers';
import { ETH_NETWORK, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';
import { getFreshEthFeeSnapshot } from './ethFeeSnapshot.js';
import { waitForTxConfirmation } from './waitForTx.js';

if (!process.env.PRIVATE_KEY) {
    console.warn("Warning: PRIVATE_KEY is not set. Tests will fail.");
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const network = ETH_NETWORK;

function parseRequiredAmount(amountArg: string | undefined, testType: 'deposit' | 'withdraw') {
    if (!amountArg) {
        throw new Error(`Missing amount. Usage: bun example/eth-eth.ts ${testType} <amount_in_eth>`);
    }

    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount "${amountArg}". Please provide a positive number in ETH.`);
    }

    return amount;
}

async function testSDK(testType: string, amountArg?: string) {
    console.log('--- SDK ETH/ETH Testing Started ---');

    const provider = new ethers.providers.JsonRpcProvider(network.rpcUrl, {
        name: network.chainKey,
        chainId: network.chainId,
    });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);

    const signature = await signer.signMessage(SIGN_PRIVACY_MESSAGE);
    console.log(await signer.getAddress());
    console.log('signature', signature);

    try {
        if (testType === 'balance') {
            console.log('Wallet balance');
            const balance = await provider.getBalance(await signer.getAddress());
            console.log(`Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);

            console.log('\n Checking shielded balance...');
            const res = await getBalance({ signature, address: await signer.getAddress(), network });
            console.log(`Shielded balance: ${res.balance} ETH`);
        }

        else if (testType === 'deposit') {
            const depositAmount = parseRequiredAmount(amountArg, 'deposit');
            console.log(`\n Performing ETH Deposit of ${depositAmount} ETH...`);

            const txSender = async (unsignedTx: any) => {
                let tx = await signer.sendTransaction(unsignedTx);
                await waitForTxConfirmation(provider, tx.hash, 'deposit');
                return tx.hash;
            };

            const tx = await deposit({
                txSender,
                depositAmountInput: depositAmount,
                keyBasePath: './circuits/transaction',
                signature,
                address: await signer.getAddress(),
                network,
            });
            console.log(`Deposit transaction sent! TX`, tx);
        }

        else if (testType === 'withdraw') {
            const withdrawAmount = parseRequiredAmount(amountArg, 'withdraw');
            console.log(`\n Performing ETH Withdrawal of ${withdrawAmount} ETH...`);
            const feeSnapshot = await getFreshEthFeeSnapshot(network, 'eth');
            console.log(`Using fee snapshot ${feeSnapshot.id}, expires in ${Math.floor((feeSnapshot.expiresAt - Date.now()) / 1000)}s`);

            const withdrawResult = await withdraw({
                withdrawAmountInput: withdrawAmount,
                recipient: await signer.getAddress(),
                keyBasePath: './circuits/transaction',
                signature,
                address: await signer.getAddress(),
                network,
                feeSnapshot,
            });
            console.log(`Withdrawal successful! TX: ${withdrawResult}`);
        }

        else if (testType === 'clear') {
            console.log('\n Clearing Cache...');
            const { clearCache } = await import('../src/utils/utils.js');
            await clearCache(await signer.getAddress(), 'eth', network);
            console.log('Cache cleared successfully!');
        }

        else {
            console.log('Usage: bun example/eth-eth.ts <balance|deposit|withdraw|clear> [amount_in_eth]');
            console.log('Examples:');
            console.log('  bun example/eth-eth.ts balance');
            console.log('  bun example/eth-eth.ts deposit 0.001');
            console.log('  bun example/eth-eth.ts withdraw 0.001');
            console.log('  bun example/eth-eth.ts clear');
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
    console.log('Usage: bun example/eth-eth.ts <balance|deposit|withdraw|clear> [amount_in_eth]');
    console.log('Examples:');
    console.log('  bun example/eth-eth.ts balance');
    console.log('  bun example/eth-eth.ts deposit 0.001');
    console.log('  bun example/eth-eth.ts withdraw 0.001');
    console.log('  bun example/eth-eth.ts clear');
}
