import crypto from 'crypto';
import { ethers } from 'ethers';
import { Keypair } from './keypair.js';

export function deriveKeys(signature: string) {
    const encryptionKeyHex = ethers.utils.keccak256(signature);
    const encryptionKey = Buffer.from(encryptionKeyHex.slice(2), 'hex');
    const utxoPrivateKey = ethers.utils.keccak256(encryptionKey);
    const keypair = new Keypair(utxoPrivateKey);
    return { encryptionKey, utxoPrivateKey, keypair };
}

// export async function signMessage(signer: ethers.Signer) {
//     const signature = await signer.signMessage(SIGN_IN_MESSAGe);
//     return deriveKeys(signature);
// }

export function encrypt(data: string | Buffer, encryptionKey: Buffer): string {
    const dataBuffer = typeof data === 'string' ? Buffer.from(data) : data;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey as any, iv as any);
    const encrypted = Buffer.concat([cipher.update(dataBuffer as any), cipher.final()] as any[]);
    const authTag = cipher.getAuthTag();
    const result = Buffer.concat([iv, authTag, encrypted] as any[]);
    return '0x' + result.toString('hex');
}

export function decrypt(encryptedData: string | Buffer, encryptionKey: Buffer): Buffer {
    const buf = typeof encryptedData === 'string'
        ? Buffer.from(encryptedData.replace(/^0x/, ''), 'hex')
        : (encryptedData as any);

    const iv = buf.slice(0, 12);
    const authTag = buf.slice(12, 28);
    const data = buf.slice(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey as any, iv as any);
    decipher.setAuthTag(authTag as any);
    return Buffer.concat([decipher.update(data as any), decipher.final()] as any[]);
}
