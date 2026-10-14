import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { ed25519 } from '@noble/curves/ed25519';
import {
  validSolanaSigningKey,
  verifySolanaSignature,
} from './solana-signature';
const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
it('verifies the public RFC 8032 empty-message vector and rejects a changed message', () => {
  const key = hex(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  );
  const signature = hex(
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
      '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  );
  expect(validSolanaSigningKey(key)).toBe(true);
  expect(verifySolanaSignature(new Uint8Array(), signature, key)).toBe(true);
  expect(verifySolanaSignature(Uint8Array.of(1), signature, key)).toBe(false);
});
it('rejects a degenerate identity forgery that the previous verifier accepts for any message', () => {
  const key = new Uint8Array(32);
  key[0] = 1;
  const signature = new Uint8Array(64);
  signature[0] = 1;
  const message = new TextEncoder().encode('fresh domain-bound nonce');
  expect(nacl.sign.detached.verify(message, signature, key)).toBe(true);
  expect(validSolanaSigningKey(key)).toBe(false);
  expect(verifySolanaSignature(message, signature, key)).toBe(false);
  expect(validSolanaSigningKey(new Uint8Array(32))).toBe(false);
});
it('rejects a malleated high-S signature while retaining the canonical signature', () => {
  const pair = nacl.sign.keyPair(),
    message = new TextEncoder().encode('approved packet'),
    canonical = nacl.sign.detached(message, pair.secretKey),
    altered = canonical.slice();
  let scalar = 0n;
  for (let index = 63; index >= 32; index--)
    scalar = (scalar << 8n) + BigInt(canonical[index]);
  scalar += (1n << 252n) + 27742317777372353535851937790883648493n;
  for (let index = 32; index < 64; index++) {
    altered[index] = Number(scalar & 255n);
    scalar >>= 8n;
  }
  expect(nacl.sign.detached.verify(message, altered, pair.publicKey)).toBe(
    true,
  );
  expect(verifySolanaSignature(message, canonical, pair.publicKey)).toBe(true);
  expect(verifySolanaSignature(message, altered, pair.publicKey)).toBe(false);
  pair.secretKey.fill(0);
});
it('rejects a mixed-torsion public key and malformed signature/point encodings', () => {
  const key = nacl.sign.keyPair(),
    point = ed25519.Point.fromBytes(key.publicKey, false),
    torsion = ed25519.Point.fromBytes(new Uint8Array(32), false);
  expect(validSolanaSigningKey(point.add(torsion).toBytes())).toBe(false);
  expect(validSolanaSigningKey(new Uint8Array(32).fill(255))).toBe(false);
  expect(
    verifySolanaSignature(new Uint8Array(), new Uint8Array(63), key.publicKey),
  ).toBe(false);
  key.secretKey.fill(0);
});
