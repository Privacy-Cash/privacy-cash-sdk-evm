import { ethers } from 'ethers';
import { BASE_NETWORK, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';

if (!process.env.PRIVATE_KEY) {
    console.warn("Warning: PRIVATE_KEY is not set. Tests will fail.");
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const network = BASE_NETWORK;

// Minimal ERC20 ABI for approve
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
];

function parseRequiredAmount(amountArg: string | undefined, testType: 'deposit' | 'withdraw') {
    if (!amountArg) {
        throw new Error(`Missing amount. Usage: bun example/usdc.ts ${testType} <amount_in_usdc>`);
    }

    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount "${amountArg}". Please provide a positive number in USDC.`);
    }

    return amount;
}


async function testSDK(testType: string, amountArg?: string) {
    console.log('--- SDK USDC Testing Started ---');

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
            const usdc = new ethers.Contract(network.usdcTokenAddress, ERC20_ABI, provider);
            const raw = await usdc.balanceOf(address);
            console.log(`Wallet USDC balance: ${ethers.utils.formatUnits(raw, 6)} USDC`);

            console.log('\n Checking shielded balance...');
            const res = await getBalance({ signature, address, token: 'usdc', network });
            console.log(`Shielded balance: ${res.balance} USDC`);
        }

        else if (testType === 'deposit') {
            const depositAmount = parseRequiredAmount(amountArg, 'deposit');
            console.log(`\n Performing USDC Deposit of ${depositAmount} USDC...`);

            const txSender = async (unsignedTx: any) => {
                let tx = await signer.sendTransaction(unsignedTx);
                await tx.wait();
                return tx.hash;
            };

            const tx = await deposit({
                txSender,
                depositAmountInput: depositAmount,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                token: 'usdc',
                network,
            });
            console.log(`Deposit transaction sent! TX`, tx);
        }

        else if (testType === 'withdraw') {
            const withdrawAmount = parseRequiredAmount(amountArg, 'withdraw');
            console.log(`\n Performing USDC Withdrawal of ${withdrawAmount} USDC...`);

            const withdrawResult = await withdraw({
                withdrawAmountInput: withdrawAmount,
                recipient: address,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                token: 'usdc',
                network,
            });
            console.log(`Withdrawal successful! TX: ${withdrawResult}`);
        }

        else if (testType === 'clear') {
            console.log('\n Clearing USDC Cache...');
            const { clearCache } = await import('../src/utils/utils.js');
            await clearCache(address, 'usdc', network);
            console.log('Cache cleared successfully!');
        }

        else {
            console.log('Usage: bun example/usdc.ts <balance|deposit|withdraw|clear> [amount_in_usdc]');
            console.log('Examples:');
            console.log('  bun example/usdc.ts balance');
            console.log('  bun example/usdc.ts deposit 10');
            console.log('  bun example/usdc.ts withdraw 10');
            console.log('  bun example/usdc.ts clear');
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
    console.log('Usage: bun example/usdc.ts <balance|deposit|withdraw|clear> [amount_in_usdc]');
    console.log('Examples:');
    console.log('  bun example/usdc.ts balance');
    console.log('  bun example/usdc.ts deposit 10');
    console.log('  bun example/usdc.ts withdraw 10');
    console.log('  bun example/usdc.ts clear');
}
