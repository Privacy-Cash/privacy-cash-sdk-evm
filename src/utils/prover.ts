// @ts-ignore
import { utils } from 'ffjavascript';
import { toFixedHex } from './utils.js';

/**
 * Generates a Zero-Knowledge proof for a transaction.
 * Works across Node.js, Bun, Deno, and Browser — fully in-memory, no tmp files.
 *
 * Bun/Deno use single-threaded mode: passing { singleThread: true } to both
 * wtnsCalcOptions (5th arg) and proverOptions (6th arg) of groth16.fullProve
 * prevents snarkjs from spawning web-worker threads entirely, avoiding the
 * Bun v1.3.x crash where worker threads dispatch plain Error objects to
 * EventTarget.dispatchEvent (which requires a proper Event instance in Bun).
 */
export async function prove(input: any, keyBasePath: string) {
    // @ts-ignore
    const useSingleThread = typeof Bun !== 'undefined' || typeof Deno !== 'undefined';
    const singleThreadOpts = useSingleThread ? { singleThread: true } : undefined;

    // @ts-ignore
    const snarkjs = await import('snarkjs');
    const { proof } = await snarkjs.groth16.fullProve(
        utils.stringifyBigInts(input),
        `${keyBasePath}.wasm`,
        `${keyBasePath}.zkey`,
        undefined,        // logger
        singleThreadOpts, // wtnsCalcOptions: controls witness calculation threading
        singleThreadOpts, // proverOptions:   controls proving threading
    );

    const pA = [toFixedHex(proof.pi_a[0]), toFixedHex(proof.pi_a[1])];
    const pB = [
        [toFixedHex(proof.pi_b[0][1]), toFixedHex(proof.pi_b[0][0])],
        [toFixedHex(proof.pi_b[1][1]), toFixedHex(proof.pi_b[1][0])],
    ];
    const pC = [toFixedHex(proof.pi_c[0]), toFixedHex(proof.pi_c[1])];

    return { pA, pB, pC };
}
