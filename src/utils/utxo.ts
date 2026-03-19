import { BigNumber } from 'ethers';
import { decrypt, encrypt } from './encryption.js';
import { Keypair } from './keypair.js';
import { poseidonHash, randomBN } from './utils.js';

const DUMMY_MINT = BigNumber.from(0);

export class Utxo {
    public amount: BigNumber;
    public blinding: BigNumber;
    public keypair: Keypair;
    public index: number | null;
    public mintAddress: BigNumber;

    constructor({
        amount = 0,
        keypair = new Keypair(),
        blinding = randomBN(),
        index = null,
        mintAddress = DUMMY_MINT,
    }: {
        amount?: any;
        keypair?: Keypair;
        blinding?: any;
        index?: number | null;
        mintAddress?: any;
    } = {}) {
        this.amount = BigNumber.from(amount);
        this.blinding = BigNumber.from(blinding);
        this.keypair = keypair;
        this.index = index;
        this.mintAddress = BigNumber.from(mintAddress);
    }

    getCommitment(): BigNumber {
        return poseidonHash([this.amount, this.keypair.pubkey, this.blinding, this.mintAddress]);
    }

    getNullifier(): BigNumber {
        if (this.amount.gt(0)) {
            if (this.index == null) {
                throw new Error('Can not compute nullifier without utxo index');
            }
            if (this.keypair.privkey == null) {
                throw new Error('Can not compute nullifier without utxo private key');
            }
        }
        const commitment = this.getCommitment();
        const idx = this.index || 0;
        const signature = this.keypair.sign(commitment, idx);
        return poseidonHash([commitment, idx, signature]);
    }

    encrypt(encryptionKey: Buffer): string {
        const utxoString = `${this.amount.toString()}|${this.blinding.toString()}|${this.index || 0}|${this.mintAddress.toString()}`;
        return encrypt(utxoString, encryptionKey);
    }

    static decrypt(encryptionKey: Buffer, data: string, index: number, keypair: Keypair): Utxo {
        const decrypted = decrypt(data, encryptionKey);
        const parts = decrypted.toString().split('|');
        if (parts.length !== 4) {
            throw new Error('Invalid UTXO format after decryption');
        }
        const [amount, blinding, , mintAddress] = parts;
        return new Utxo({
            amount: BigNumber.from(amount),
            blinding: BigNumber.from(blinding),
            keypair,
            index,
            mintAddress: BigNumber.from(mintAddress),
        });
    }
}
