import { BigNumber, ethers } from 'ethers';
import { poseidonHash, toFixedHex } from './utils.js';

export class Keypair {
    public privkey: string;
    public pubkey: BigNumber;

    constructor(privkey: string = ethers.Wallet.createRandom().privateKey) {
        this.privkey = privkey;
        this.pubkey = poseidonHash([this.privkey]);
    }

    toString(): string {
        return toFixedHex(this.pubkey);
    }

    address(): string {
        return this.toString();
    }

    sign(commitment: any, merklePath: any): BigNumber {
        return poseidonHash([this.privkey, commitment, merklePath]);
    }
}
