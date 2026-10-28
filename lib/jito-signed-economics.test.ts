import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import { jitoSequentialEconomicsFixture } from '../test/jito-sequential-economics-fixture';
import { jitoOwnerScope } from './jito-owner-scope';
import * as frameChecks from './jito-bundle-simulation-frames';
import {
  verifyJitoBundleEconomicObservation,
  verifySignedJitoBundleEconomicObservation,
} from './jito-bundle-economics';

async function fixture(
  options: Parameters<typeof jitoSequentialEconomicsFixture>[0] = {},
) {
  const economic = await jitoSequentialEconomicsFixture(options);
  const m = economic.manifest;
  const signed = (transaction: string, seedByte: number) => {
    const tx = getTransactionDecoder().decode(
      Buffer.from(transaction, 'base64'),
    );
    const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
    const address = bs58.encode(pair.publicKey);
    const signature = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair.secretKey,
    ) as SignatureBytes;
    pair.secretKey.fill(0);
    return {
      transaction: Buffer.from(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { [address]: signature },
        }),
      ).toString('base64'),
      signature: bs58.encode(signature),
    };
  };
  const values = [
    ...m.swaps.map((swap, index) => signed(swap.transaction, 7 + index)),
    signed(m.tip.transaction, 7),
  ];
  const attempts = values.map((value, packet) => ({
    bundleId: m.id,
    packet,
    attemptId: crypto.randomUUID(),
    manifestSha256: m.sha256,
    signer: m.swaps[packet]?.wallet ?? m.tip.wallet,
    intentId: m.swaps[packet]?.id ?? null,
    ...value,
    state: 'registered',
  }));
  const rawSnapshot = {
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundle: {
      manifest: m,
      state: 'reviewed',
      bundleId: null,
      signatures: values.map((v) => v.signature),
      updatedAt: m.createdAt,
      finalization: null,
    },
    attempts,
    legacyReadOnly: false,
  };
  return {
    economic,
    values,
    attempts,
    rawSnapshot,
    input: {
      economic,
      ownerId: 'alice',
      responseOwnerScope: await jitoOwnerScope('alice'),
      projectId: m.projectId,
      sessionId: m.sessionId,
      bundleId: m.id,
      manifestSha256: m.sha256,
      rawSnapshot,
    },
  };
}
for (const options of [
  { side: 'Buy', wallets: 1 },
  { side: 'Sell', wallets: 2, lookup: true },
  { side: 'Buy', wallets: 4, lookup: true, token2022: true },
  { side: 'Sell', wallets: 1, token2022: true },
] as const)
  it(`replays exact signed frames with unchanged unsigned economic checks ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    const spy = vi.spyOn(frameChecks, 'verifyJitoBundleSimulationFrames');
    try {
      const result = await verifySignedJitoBundleEconomicObservation(f.input);
      expect(result.outcomes).toHaveLength(options.wallets);
      expect(result.signedVectorFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result).toMatchObject({
        sourceAuthenticated: false,
        sourceCurrent: false,
        providerQualified: false,
        signatureVerified: false,
        executionAllowed: false,
        signingAllowed: false,
        automaticExecutionAllowed: false,
        networkVerified: false,
        receiptVerified: false,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].packets.map((p) => p.transaction)).toEqual(
        f.values.map((v) => v.transaction),
      );
      expect(f.values.map((v) => v.transaction)).not.toEqual(
        f.economic.packets.map((p) => p.transaction),
      );
    } finally {
      spy.mockRestore();
    }
  });
it('retains the existing unsigned API and its full behavior', async () => {
  const f = await fixture();
  const result = await verifyJitoBundleEconomicObservation(f.economic);
  expect(result.frameEconomicChecksPassed).toBe(true);
  expect(result.executionAllowed).toBe(false);
});
it('rejects signature tampering, swapped signed packets and mismatched ownership', async () => {
  for (const change of ['signature', 'reorder', 'owner', 'digest'] as const) {
    const f = await fixture({ wallets: 2 });
    if (change === 'signature') {
      const bytes = Buffer.from(f.attempts[0].transaction, 'base64');
      bytes[1] ^= 1;
      f.attempts[0].transaction = bytes.toString('base64');
    }
    if (change === 'reorder')
      [f.attempts[0].transaction, f.attempts[1].transaction] = [
        f.attempts[1].transaction,
        f.attempts[0].transaction,
      ];
    if (change === 'owner') f.input.ownerId = 'bob';
    if (change === 'digest') f.input.manifestSha256 = 'ab'.repeat(32);
    await expect(
      verifySignedJitoBundleEconomicObservation(f.input),
    ).rejects.toThrow();
  }
});
it('retains fee, bank, raw-frame, mint and Rent refusals in signed replay', async () => {
  for (const change of [
    'fee',
    'bank',
    'partial',
    'mint',
    'rent',
    'span',
  ] as const) {
    const f = await fixture();
    if (change === 'fee')
      f.economic.result.value.transactionResults[0].fee = '5001';
    if (change === 'bank') f.economic.result.context.slot++;
    if (change === 'partial') f.economic.result.value.transactionResults.pop();
    if (change === 'mint')
      (
        f.economic.observations[0].mintAccounts.after[1] as { data: string[] }
      ).data[0] = 'AAAA';
    if (change === 'rent')
      (f.economic.rentAccounts.after as { data: string[] }).data[0] = 'AAAA';
    if (change === 'span') f.economic.minimumSlot = 1;
    await expect(
      verifySignedJitoBundleEconomicObservation(f.input),
    ).rejects.toThrow();
  }
});
it('detaches signed context and effects before the first asynchronous check', async () => {
  const f = await fixture();
  const pending = verifySignedJitoBundleEconomicObservation(f.input);
  f.attempts[0].transaction = 'bad';
  f.input.ownerId = 'bob';
  f.economic.result.value.transactionResults[0].fee = '1';
  const result = await pending;
  expect(result.frameEconomicChecksPassed).toBe(true);
  expect(result.sourceAuthenticated).toBe(false);
});
