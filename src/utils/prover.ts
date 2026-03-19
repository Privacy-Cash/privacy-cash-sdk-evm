// @ts-ignore
import { utils } from 'ffjavascript';
import { toFixedHex } from './utils.js';

/**
 * Generates a Zero-Knowledge proof for a transaction.
 * Supports both Node.js (optimized CLI) and Web Browser (via snarkjs library).
 */
export async function prove(input: any, keyBasePath: string) {
    // Check if running in browser (most reliable method for Next.js compatibility)
    const isBrowser = typeof window !== 'undefined';

    if (isBrowser) {
        return await proveBrowser(input, keyBasePath);
    } else {
        return await proveNode(input, keyBasePath);
    }
}

async function proveBrowser(input: any, keyBasePath: string) {
    // @ts-ignore
    const snarkjs = await import('snarkjs');

    // Browser-based snarkjs proof generation
    const { proof } = await snarkjs.groth16.fullProve(
        utils.stringifyBigInts(input),
        `${keyBasePath}.wasm`,
        `${keyBasePath}.zkey`
    );

    const pA = [toFixedHex(proof.pi_a[0]), toFixedHex(proof.pi_a[1])];
    const pB = [
        [toFixedHex(proof.pi_b[0][1]), toFixedHex(proof.pi_b[0][0])],
        [toFixedHex(proof.pi_b[1][1]), toFixedHex(proof.pi_b[1][0])],
    ];
    const pC = [toFixedHex(proof.pi_c[0]), toFixedHex(proof.pi_c[1])];

    return { pA, pB, pC };
}

async function proveNode(input: any, keyBasePath: string) {
    // @ts-ignore webpackIgnore: true prevents bundler from trying to include Node.js modules in browser
    const { execFile } = await import(/* webpackIgnore: true */ 'child_process');
    // @ts-ignore
    const { promises: fs } = await import(/* webpackIgnore: true */ 'fs');
    // @ts-ignore
    const os = (await import(/* webpackIgnore: true */ 'os')).default;
    // @ts-ignore
    const path = (await import(/* webpackIgnore: true */ 'path')).default;
    // @ts-ignore
    const { promisify } = await import(/* webpackIgnore: true */ 'util');
    const execFileAsync = promisify(execFile);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'privacycash-proof-'));
    const inputPath = path.join(tmpDir, 'input.json');
    const proofPath = path.join(tmpDir, 'proof.json');
    const publicPath = path.join(tmpDir, 'public.json');

    try {
        await fs.writeFile(inputPath, JSON.stringify(utils.stringifyBigInts(input)));

        await execFileAsync(
            path.resolve(process.cwd(), 'node_modules/.bin/snarkjs'),
            ['groth16', 'fullprove', inputPath, `${keyBasePath}.wasm`, `${keyBasePath}.zkey`, proofPath, publicPath],
            { maxBuffer: 1024 * 1024 * 10 },
        );

        const proofRaw = await fs.readFile(proofPath, 'utf8');
        const proof = JSON.parse(proofRaw);

        const pA = [toFixedHex(proof.pi_a[0]), toFixedHex(proof.pi_a[1])];
        const pB = [
            [toFixedHex(proof.pi_b[0][1]), toFixedHex(proof.pi_b[0][0])],
            [toFixedHex(proof.pi_b[1][1]), toFixedHex(proof.pi_b[1][0])],
        ];
        const pC = [toFixedHex(proof.pi_c[0]), toFixedHex(proof.pi_c[1])];

        return { pA, pB, pC };
    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // ignore cleanup errors
        }
    }
}
