import crypto from 'crypto';
import { BigNumber, ethers } from 'ethers';
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { INDEXER_URL } from './constants.js';
import { UniversalStorage } from './db.js';
import { logger } from './logger.js';
import { prove } from './prover.js';
import { Utxo } from './utxo.js';

const storage = new UniversalStorage('PrivacyCashDB', 'evm');

export const FIELD_SIZE = BigNumber.from(
    '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

export function poseidonHash(items: any[]): BigNumber {
    if (items.length === 1) return BigNumber.from(poseidon1([items[0]]));
    if (items.length === 2) return BigNumber.from(poseidon2([items[0], items[1]]));
    if (items.length === 3) return BigNumber.from(poseidon3([items[0], items[1], items[2]]));
    if (items.length === 4) return BigNumber.from(poseidon4([items[0], items[1], items[2], items[3]]));
    throw new Error(`Unsupported poseidon input length: ${items.length}`);
}

export const poseidonHash2 = (a: any, b: any) => poseidonHash([a, b]);

/** Generate random number of specified byte length */
export const randomBN = (nbytes = 31) => BigNumber.from(crypto.randomBytes(nbytes));

/** BigNumber to hex string of specified length */
export function toFixedHex(number: any, length = 32): string {
    let result =
        '0x' +
        (number instanceof Buffer
            ? number.toString('hex')
            : BigNumber.from(number).toHexString().replace('0x', '')
        ).padStart(length * 2, '0');
    if (result.indexOf('-') > -1) {
        result = '-' + result.replace('-', '');
    }
    return result;
}

/** Convert value into buffer of specified byte length */
export const toBuffer = (value: any, length: number) =>
    Buffer.from(
        BigNumber.from(value)
            .toHexString()
            .slice(2)
            .padStart(length * 2, '0'),
        'hex',
    );

function getExtDataHash({
    recipient,
    extAmount,
    feeRecipient,
    fee,
    encryptedOutput1,
    encryptedOutput2,
}: {
    recipient: any;
    extAmount: any;
    relayer?: any;
    feeRecipient?: any;
    fee: any;
    encryptedOutput1: string;
    encryptedOutput2: string;
}): BigNumber {
    const abi = new ethers.utils.AbiCoder();

    const encodedData = abi.encode(
        [
            'tuple(address recipient,int256 extAmount,address feeRecipient,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2)',
        ],
        [
            {
                recipient: toFixedHex(recipient, 20),
                extAmount: toFixedHex(extAmount),
                feeRecipient,
                fee: toFixedHex(fee),
                encryptedOutput1: encryptedOutput1,
                encryptedOutput2: encryptedOutput2,
            },
        ],
    );
    const hash = ethers.utils.keccak256(encodedData);
    return BigNumber.from(hash).mod(FIELD_SIZE);
}

export async function getProof({
    inputs,
    outputs,
    extAmount,
    fee,
    recipient,
    feeRecipient,
    encryptionKey,
    keyBasePath,
}: {
    inputs: Utxo[];
    outputs: Utxo[];
    extAmount: BigNumber;
    fee: BigNumber;
    recipient: string;
    feeRecipient: string;
    encryptionKey: Buffer;
    keyBasePath: string;
}) {
    let inputMerklePathIndices: number[] = [];
    let inputMerklePathElements: any[] = [];

    // fetch /merkle/root from indexer url
    const res = await fetch(`${INDEXER_URL}/merkle/root`);
    if (!res.ok) {
        throw new Error(`Failed to fetch merkle root: ${res.status} ${res.statusText}`);
    }
    const { root, nextIndex: initialNextIndex } = await res.json();
    let nextIndex = initialNextIndex;

    for (const input of inputs) {
        if (input.amount.gt(0)) {
            let res = await fetch(`${INDEXER_URL}/commitment/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commitment: toFixedHex(input.getCommitment()) }),
            });
            if (!res.ok) {
                throw new Error(`Failed to fetch commitment info`);
            }
            const { index, pathElements } = await res.json();
            input.index = index;
            if (input.index == null) {
                throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`);
            }
            inputMerklePathIndices.push(input.index);
            inputMerklePathElements.push(pathElements);
        } else {
            inputMerklePathIndices.push(0);
            inputMerklePathElements.push(new Array(26).fill(0));
        }
    }

    // update nextIndex to outputs
    for (let output of outputs) {
        output.index = nextIndex++;
    }
    const extData = {
        recipient,
        extAmount: toFixedHex(extAmount),
        feeRecipient,
        fee: toFixedHex(fee),
        encryptedOutput1: outputs[0].encrypt(encryptionKey),
        encryptedOutput2: (outputs[1] || new Utxo()).encrypt(encryptionKey),
    };

    const extDataHash = getExtDataHash(extData);
    let input = {
        root,
        inputNullifier: inputs.map((x) => x.getNullifier().toString()),
        outputCommitment: outputs.map((x) => x.getCommitment().toString()),
        publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
        extDataHash: extDataHash.toString(),
        mintAddress: inputs[0].mintAddress.toString(),

        inAmount: inputs.map((x) => x.amount.toString()),
        inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
        inBlinding: inputs.map((x) => x.blinding.toString()),
        inPathIndices: inputMerklePathIndices,
        inPathElements: inputMerklePathElements,

        outAmount: outputs.map((x) => x.amount.toString()),
        outBlinding: outputs.map((x) => x.blinding.toString()),
        outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
    };

    const { pA, pB, pC } = await prove(input, `${keyBasePath}${inputs.length}`);

    const args = {
        pA,
        pB,
        pC,
        root: toFixedHex(input.root),
        inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
        outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
        publicAmount: toFixedHex(input.publicAmount),
        extDataHash: toFixedHex(extDataHash),
    };

    return { extData, args };
}

export async function prepareTransaction({
    inputs = [],
    outputs = [],
    fee = BigNumber.from(0),
    recipient = '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce',
    feeRecipient = '0x44eb9939cfdE7C394f1632C6890191d695f0a3ce',
    encryptionKey,
    keyBasePath,
}: {
    inputs?: Utxo[];
    outputs?: Utxo[];
    fee?: BigNumber;
    recipient?: string;
    feeRecipient?: string;
    encryptionKey: Buffer;
    keyBasePath: string;
}) {
    if (inputs.length > 2 || outputs.length > 2) {
        throw new Error('Only 2 inputs and 2 outputs are supported');
    }

    while (inputs.length < 2) inputs.push(new Utxo());
    while (outputs.length < 2) outputs.push(new Utxo());

    let extAmount = outputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0))
        .sub(inputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
        .add(fee);

    const { extData, args } = await getProof({
        inputs,
        outputs,
        extAmount,
        fee,
        recipient,
        feeRecipient,
        encryptionKey,
        keyBasePath,
    });

    return { extData, args };
}

export async function findUnspentUtxos({
    address,
    etherPool,
    encryptionKey,
    keypair,
    start = 0,
}: {
    address: string;
    etherPool: ethers.Contract;
    encryptionKey: Buffer;
    keypair: any;
    start?: number;
}) {
    await storage.init();
    const offsetKey = `offset_${address}`;
    const knownKey = `keo_${address}`;
    const cachedOffset = (await storage.get(offsetKey)) || start;
    const cachedKnown = (await storage.get(knownKey)) || [];
    let knownEncryptedOutputs = new Map<number, string>();
    const candidates: { utxo: Utxo; nullifier: string }[] = [];

    // print number of knownEncryptedOutputs
    logger.debug(`Cached offset: ${cachedOffset}`);
    logger.debug(`Cached known encrypted outputs: ${cachedKnown.length}`);

    // Process cached known encrypted outputs
    for (const item of cachedKnown) {
        knownEncryptedOutputs.set(item.index, item.encrypted);
        try {
            const utxo = Utxo.decrypt(encryptionKey, item.encrypted, item.index, keypair);
            if (!utxo.amount.isZero()) {
                utxo.index = item.index;
                const nullifier = toFixedHex(utxo.getNullifier());
                candidates.push({ utxo, nullifier });
            }
        } catch {
            // Decryption failed — this output belongs to someone else
        }
    }

    let startIndex = cachedOffset;
    const limit = 1000;
    let hasMore = true;
    while (hasMore) {
        let url = `${INDEXER_URL}/get_encrypted?start=${startIndex}&end=${startIndex + limit}`;
        logger.debug(`Fetching encrypted UTXOs from indexer: ${url}`);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch encrypted UTXOs: ${res.statusText}`);
        }
        const data = await res.json();
        const { encrypted_outputs, hasMore: more, start: realStart, total } = data;
        logger.info(`decrypting utxo ${startIndex}/${total}`)
        if (encrypted_outputs && encrypted_outputs.length > 0) {
            encrypted_outputs.forEach((encryptedOutput: string, i: number) => {
                const index = (realStart ?? startIndex) + i;
                if (!knownEncryptedOutputs.has(index)) {
                    try {
                        const utxo = Utxo.decrypt(encryptionKey, encryptedOutput, index, keypair);
                        if (!utxo.amount.isZero()) {
                            knownEncryptedOutputs.set(index, encryptedOutput);
                            utxo.index = index;
                            const nullifier = toFixedHex(utxo.getNullifier());
                            candidates.push({ utxo, nullifier });
                        }
                    } catch {
                        // Decryption failed — this output belongs to someone else
                    }
                }
            });
        }

        hasMore = more;
        startIndex += encrypted_outputs.length;
    }
    // Cache the updated offset and known encrypted outputs
    await storage.set(offsetKey, startIndex);
    await storage.set(knownKey, Array.from(knownEncryptedOutputs.entries()).map(([index, encrypted]) => ({ encrypted, index })));

    // log candidates length
    logger.debug(`Found ${candidates.length} candidate UTXOs, checking which are unspent...`);

    const unspent: Utxo[] = []
    const spentCheckChunkSize = 256

    for (let i = 0; i < candidates.length; i += spentCheckChunkSize) {
        const chunk = candidates.slice(i, i + spentCheckChunkSize)
        const nullifiers = chunk.map((x) => x.nullifier)
        try {
            const spentFlags: boolean[] = await etherPool.isSpentArray(nullifiers)

            for (let j = 0; j < chunk.length; j++) {
                if (!spentFlags[j]) {
                    unspent.push(chunk[j].utxo)
                }
            }
        } catch (error) {
            throw new Error(`Failed to check spent status of UTXOs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return unspent
}

export async function clearCache(address: string): Promise<void> {
    await storage.init();
    await storage.set(`offset_${address}`, 0);
    await storage.set(`keo_${address}`, []);
}
