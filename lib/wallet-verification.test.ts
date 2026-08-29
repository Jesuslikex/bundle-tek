import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { assertSolanaAddress, createWalletChallenge, verifyWalletChallenge } from '@/lib/wallet-verification';

describe('wallet ownership verification', () => {
  it('accepts the exact server challenge signed by its wallet', () => {
    const signer = nacl.sign.keyPair();
    const address = bs58.encode(signer.publicKey);
    const message = createWalletChallenge(address, crypto.randomUUID(), new Date().toISOString());
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey));
    expect(verifyWalletChallenge(message, signature, address)).toBe(true);
  });

  it('rejects tampering and invalid addresses', () => {
    const signer = nacl.sign.keyPair();
    const address = bs58.encode(signer.publicKey);
    const message = createWalletChallenge(address, crypto.randomUUID(), new Date().toISOString());
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey));
    expect(verifyWalletChallenge(`${message}!`, signature, address)).toBe(false);
    expect(() => assertSolanaAddress('not-a-wallet')).toThrow(/Invalid Solana/);
  });
});
