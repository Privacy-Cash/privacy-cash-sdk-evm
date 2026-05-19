import { ethers } from 'ethers';
import { ETH_NETWORK, deposit, getBalance, withdraw } from '../src/index.js';
import { SIGN_PRIVACY_MESSAGE } from '../src/utils/constants.js';

if (!process.env.PRIVATE_KEY) {
    console.warn("Warning: PRIVATE_KEY is not set. Tests will fail.");
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const network = ETH_NETWORK;

// Minimal ERC20 ABI for approve
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
];

const TOKEN = 'usdt' as const;
const TOKEN_SYMBOL = 'USDT';
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function parseRequiredAmount(amountArg: string | undefined, testType: 'deposit' | 'withdraw') {
    if (!amountArg) {
        throw new Error(`Missing amount. Usage: bun example/eth-usdt.ts ${testType} <amount_in_usdt>`);
    }

    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount "${amountArg}". Please provide a positive number in ${TOKEN_SYMBOL}.`);
    }

    return amount;
}

async function testSDK(testType: string, amountArg?: string) {
    console.log(`--- SDK ETH/${TOKEN_SYMBOL} Testing Started ---`);

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
            const erc20 = new ethers.Contract(network.usdtTokenAddress, ERC20_ABI, provider);
            const raw = await erc20.balanceOf(address);
            console.log(`Wallet ${TOKEN_SYMBOL} balance: ${ethers.utils.formatUnits(raw, network.usdtDecimals)} ${TOKEN_SYMBOL}`);

            console.log('\n Checking shielded balance...');
            const res = await getBalance({ signature, address, token: TOKEN, network });
            console.log(`Shielded balance: ${res.balance} ${TOKEN_SYMBOL}`);
        }

        else if (testType === 'deposit') {
            const depositAmount = parseRequiredAmount(amountArg, 'deposit');
            console.log(`\n Performing ${TOKEN_SYMBOL} Deposit of ${depositAmount} ${TOKEN_SYMBOL}...`);

            const txSender = async (unsignedTx: any, meta?: { stage?: string }) => {
                const stage = meta?.stage ?? 'transaction';
                console.log(`[${stage}] submitting tx to ${unsignedTx.to}`);
                console.log(
                    `[${stage}] gasLimit=${unsignedTx.gasLimit?.toString?.() ?? 'auto'} `
                    + `gasPrice=${unsignedTx.gasPrice?.toString?.() ?? 'auto'} `
                    + `maxFeePerGas=${unsignedTx.maxFeePerGas?.toString?.() ?? 'auto'} `
                    + `maxPriorityFeePerGas=${unsignedTx.maxPriorityFeePerGas?.toString?.() ?? 'auto'}`,
                );

                const tx = await signer.sendTransaction(unsignedTx);
                console.log(`[${stage}] tx hash: ${tx.hash}`);
                console.log(`[${stage}] waiting for confirmation...`);

                await Promise.race([
                    tx.wait(),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error(`[${stage}] timed out waiting for confirmation. Tx may still be pending: ${tx.hash}`)),
                        WAIT_TIMEOUT_MS,
                    )),
                ]);
                console.log(`[${stage}] confirmed`);
                return tx.hash;
            };

            const tx = await deposit({
                txSender,
                depositAmountInput: depositAmount,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                token: TOKEN,
                network,
            });
            console.log(`Deposit transaction sent! TX`, tx);
            process.exit(0);
        }

        else if (testType === 'withdraw') {
            const withdrawAmount = parseRequiredAmount(amountArg, 'withdraw');
            console.log(`\n Performing ${TOKEN_SYMBOL} Withdrawal of ${withdrawAmount} ${TOKEN_SYMBOL}...`);

            const withdrawResult = await withdraw({
                withdrawAmountInput: withdrawAmount,
                recipient: address,
                keyBasePath: './circuits/transaction',
                signature,
                address,
                token: TOKEN,
                network,
            });
            console.log(`Withdrawal successful! TX: ${withdrawResult}`);
        }

        else if (testType === 'clear') {
            console.log(`\n Clearing ${TOKEN_SYMBOL} Cache...`);
            const { clearCache } = await import('../src/utils/utils.js');
            await clearCache(address, TOKEN, network);
            console.log('Cache cleared successfully!');
        }

        else {
            console.log('Usage: bun example/eth-usdt.ts <balance|deposit|withdraw|clear> [amount_in_usdt]');
            console.log('Examples:');
            console.log('  bun example/eth-usdt.ts balance');
            console.log('  bun example/eth-usdt.ts deposit 10');
            console.log('  bun example/eth-usdt.ts withdraw 10');
            console.log('  bun example/eth-usdt.ts clear');
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
    console.log('Usage: bun example/eth-usdt.ts <balance|deposit|withdraw|clear> [amount_in_usdt]');
    console.log('Examples:');
    console.log('  bun example/eth-usdt.ts balance');
    console.log('  bun example/eth-usdt.ts deposit 10');
    console.log('  bun example/eth-usdt.ts withdraw 10');
    console.log('  bun example/eth-usdt.ts clear');
}
