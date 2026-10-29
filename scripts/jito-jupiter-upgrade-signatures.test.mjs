import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { verifyUpgradeMessageSignatures } from './jito-jupiter-upgrade-signatures.mjs';
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const address = bs58.encode(der.subarray(der.length - 32));
  const message = Buffer.from('synthetic message, never a real wallet');
  const signature = sign(null, message, privateKey);
  return { message, address, signature, signatures: { [address]: signature } };
}
void test('verifies a synthetic signature over the exact message without granting chain or source authority', () => {
  const f = fixture();
  const result = verifyUpgradeMessageSignatures(
    f.message,
    f.signatures,
    [f.address],
    bs58.encode(f.signature),
  );
  assert.equal(result.signaturesVerified, true);
  assert.equal(result.chainInclusionVerified, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.signingAllowed, false);
});
void test('rejects modified signed bytes', () => {
  const f = fixture();
  f.message[0] ^= 1;
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      f.signatures,
      [f.address],
      bs58.encode(f.signature),
    ),
  );
});
void test('rejects modified signature', () => {
  const f = fixture();
  f.signature[0] ^= 1;
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      f.signatures,
      [f.address],
      bs58.encode(f.signature),
    ),
  );
});
void test('rejects mismatched transaction signature', () => {
  const f = fixture();
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      f.signatures,
      [f.address],
      bs58.encode(new Uint8Array(64).fill(1)),
    ),
  );
});
void test('rejects missing, extra and duplicate signers', () => {
  const f = fixture();
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      {},
      [f.address],
      bs58.encode(f.signature),
    ),
  );
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      { ...f.signatures, other: f.signature },
      [f.address],
      bs58.encode(f.signature),
    ),
  );
  assert.throws(() =>
    verifyUpgradeMessageSignatures(
      f.message,
      f.signatures,
      [f.address, f.address],
      bs58.encode(f.signature),
    ),
  );
});
