import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
let f: Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>,
  signed: string[];
async function sign(index: number, mutate = false) {
  const original = getTransactionDecoder().decode(
    Buffer.from(f.review.packets[index].transaction, 'base64'),
  );
  const messageBytes = Uint8Array.from(original.messageBytes);
  if (mutate) messageBytes[messageBytes.length - 1] ^= 1;
  const signatures = { ...original.signatures };
  const keys = [
    f.fixture.f.f.payerSigner,
    f.fixture.f.f.mintSigner,
    ...f.fixture.holderSigners,
  ];
  for (const key of keys) {
    if (!(key.address in signatures)) continue;
    signatures[address(key.address)] = new Uint8Array(
      await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, messageBytes),
    ) as SignatureBytes;
  }
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...original,
      messageBytes: messageBytes as unknown as typeof original.messageBytes,
      signatures,
    }),
  );
}
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
  signed = await Promise.all(f.review.packets.map((_, i) => sign(i)));
}, 15000);
afterEach(() => vi.restoreAllMocks());
it('verifies every exact complete group signature and produces bound evidence without permission', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Signature verification must not fetch'));
  const result = await verifyPumpLaunchGroupSignatures(f.review, signed);
  expect(result).toMatchObject({
    manifestSha256: f.review.manifestSha256,
    contextSha256: f.review.contextSha256,
    signatureSetVerified: true,
    approvalVerificationRequired: true,
    runtimeQualificationRequired: true,
    lifetimeValidationRequired: true,
    ownershipVerificationRequired: true,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(result.packets).toHaveLength(f.review.packets.length);
  expect(new Set(result.packets.map((p) => p.signature)).size).toBe(
    result.packets.length,
  );
  expect(result.packets.map((p) => p.unsignedPacketSha256)).toEqual(
    f.review.packets.map((p) => p.sha256),
  );
  expect(
    (await verifyPumpLaunchGroupSignatures(f.review, signed)).signedGroupSha256,
  ).toBe(result.signedGroupSha256);
  expect(network).not.toHaveBeenCalled();
});
it('rejects missing, duplicated and reordered packets', async () => {
  for (const packets of [
    signed.slice(1),
    [...signed].reverse(),
    signed.map((p, i) => (i === 1 ? signed[0] : p)),
  ])
    await expect(
      verifyPumpLaunchGroupSignatures(f.review, packets),
    ).rejects.toThrow();
});
it('rejects canonical valid signatures over a changed transaction message', async () => {
  const altered = [...signed];
  altered[0] = await sign(0, true);
  await expect(
    verifyPumpLaunchGroupSignatures(f.review, altered),
  ).rejects.toThrow('message, order');
});
it('requires the mint signature in the first packet', async () => {
  const tx = getTransactionDecoder().decode(Buffer.from(signed[0], 'base64'));
  const signatures = {
    ...tx.signatures,
    [address(f.review.input.create.mint)]: null,
  };
  const altered = [...signed];
  altered[0] = getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...tx, signatures }),
  );
  await expect(
    verifyPumpLaunchGroupSignatures(f.review, altered),
  ).rejects.toThrow('Every exact');
});
it('requires an active holder signature in the final packet', async () => {
  const index = signed.length - 1,
    tx = getTransactionDecoder().decode(Buffer.from(signed[index], 'base64'));
  const holder = f.review.packets[index].requiredSigners.find(
    (key) =>
      key !== f.review.input.create.payer && key !== f.review.input.create.mint,
  )!;
  const altered = [...signed];
  altered[index] = getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...tx,
      signatures: { ...tx.signatures, [address(holder)]: null },
    }),
  );
  await expect(
    verifyPumpLaunchGroupSignatures(f.review, altered),
  ).rejects.toThrow('Every exact');
});
it('rejects copying the payer signature between different packet messages', async () => {
  const first = getTransactionDecoder().decode(
      Buffer.from(signed[0], 'base64'),
    ),
    second = getTransactionDecoder().decode(Buffer.from(signed[1], 'base64'));
  const altered = [...signed];
  altered[1] = getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...second,
      signatures: {
        ...second.signatures,
        [address(f.review.input.create.payer)]:
          first.signatures[address(f.review.input.create.payer)],
      },
    }),
  );
  await expect(
    verifyPumpLaunchGroupSignatures(f.review, altered),
  ).rejects.toThrow('Every exact');
});
it('rejects noncanonical encoding and trailing bytes', async () => {
  for (const first of [
    signed[0] + '\n',
    Buffer.concat([
      Buffer.from(signed[0], 'base64'),
      Buffer.from([0]),
    ]).toString('base64'),
  ])
    await expect(
      verifyPumpLaunchGroupSignatures(f.review, [first, ...signed.slice(1)]),
    ).rejects.toThrow();
});
it('can verify expired saved signatures for recovery without granting lifetime permission', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.review.expiresAt) + 1);
  expect(
    (await verifyPumpLaunchGroupSignatures(f.review, signed))
      .lifetimeValidationRequired,
  ).toBe(true);
});
it('rejects cancellation before processing any group', async () => {
  const abort = new AbortController();
  abort.abort(new Error('Verification cancelled'));
  await expect(
    verifyPumpLaunchGroupSignatures(f.review, signed, abort.signal),
  ).rejects.toThrow('Verification cancelled');
});
