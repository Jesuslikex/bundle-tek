import { beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import {
  createPumpOrganicBatchReview,
  requirePumpOrganicBatchReview,
  signPumpOrganicBatch,
  verifyPumpOrganicBatchSigned,
  type PumpOrganicBatchConsent,
  type PumpOrganicBatchReview,
} from './pump-organic-batch';

let vault: VaultSession,
  review: PumpOrganicBatchReview,
  consent: PumpOrganicBatchConsent,
  sessions: Map<string, VaultSession>;
const lifetime = {
  blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  lastValidBlockHeight: 900n,
};
const build = async (holder: string, overrides = lifetime) =>
  buildPumpOrganicBuyMessage({
    create: await pumpCreateFixture(),
    holder,
    tokenAmountRaw: '1000000000',
    maximumQuoteCostRaw: '5000000',
    ...overrides,
  });
beforeAll(async () => {
  vault = generateVaultWallets(
    await createVault('synthetic organic batch test vault'),
    'solana',
    3,
  );
  const holders = vault.payload.wallets.map((w) => w.address);
  const packets = await Promise.all(holders.map((h) => build(h)));
  review = await createPumpOrganicBatchReview({
    id: crypto.randomUUID(),
    sequenceId: crypto.randomUUID(),
    batch: 0,
    mint: packets[0].mint,
    quoteMint: packets[0].quoteMint,
    buys: packets.map((p, index) => ({
      index,
      holder: p.holder,
      batchOffsetMs: index * 5_000,
      tokenAmountRaw: p.tokenAmountRaw,
      maximumQuoteCostRaw: p.maximumQuoteCostRaw,
      transaction: p.transaction,
      packetSha256: p.packetSha256,
    })),
    lastValidBlockHeight: '900',
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  });
  consent = {
    approved: true,
    reviewId: review.id,
    sha256: review.sha256,
    scope: 'organic-holder-buy-batch',
    acknowledgePriceMovesBetweenBuys: true,
  };
  sessions = new Map(holders.map((h) => [h, vault]));
});

it('signs every buy in an approved batch with its own holder key only', async () => {
  const result = await signPumpOrganicBatch(
    sessions,
    review,
    consent,
    () => {},
  );
  expect(result.signed.map((s) => s.holder)).toEqual(
    review.buys.map((b) => b.holder),
  );
  expect(
    await verifyPumpOrganicBatchSigned(
      review,
      result.signed.map((s) => s.transaction),
    ),
  ).toEqual(result.signed.map((s) => s.signature));
});

it('refuses without exact consent, with wrong sessions or when tampered', async () => {
  await expect(
    signPumpOrganicBatch(
      sessions,
      review,
      { ...consent, acknowledgePriceMovesBetweenBuys: false as never },
      () => {},
    ),
  ).rejects.toThrow('Explicit approval');
  const missing = new Map(sessions);
  missing.delete(review.buys[0].holder);
  await expect(
    signPumpOrganicBatch(missing, review, consent, () => {}),
  ).rejects.toThrow('exactly the holder');
  await expect(
    requirePumpOrganicBatchReview({
      ...review,
      buys: review.buys.map((b, n) =>
        n ? b : { ...b, maximumQuoteCostRaw: '9999999' },
      ),
    }),
  ).rejects.toThrow('changed');
});

it('never returns a partial batch when the context is cancelled mid-signing', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached');
  let calls = 0;
  await expect(
    signPumpOrganicBatch(sessions, review, consent, () => {
      if (detached.mock.calls.length >= 1 && ++calls > 0)
        throw new Error('UI context changed');
    }),
  ).rejects.toThrow('UI context changed');
  detached.mockRestore();
});

it('rejects expired batches, mixed lifetimes and signed-transaction swaps', async () => {
  const expired = await createPumpOrganicBatchReview({
    ...review,
    id: crypto.randomUUID(),
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  await expect(
    signPumpOrganicBatch(
      sessions,
      expired,
      { ...consent, reviewId: expired.id, sha256: expired.sha256 },
      () => {},
    ),
  ).rejects.toThrow('expired');
  const other = await build(review.buys[1].holder, {
    blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
    lastValidBlockHeight: 950n,
  });
  await expect(
    createPumpOrganicBatchReview({
      ...review,
      id: crypto.randomUUID(),
      buys: review.buys.map((b, n) =>
        n === 1
          ? {
              ...b,
              transaction: other.transaction,
              packetSha256: other.packetSha256,
            }
          : b,
      ),
    }),
  ).rejects.toThrow('one lifetime');
  const { signed } = await signPumpOrganicBatch(
    sessions,
    review,
    consent,
    () => {},
  );
  const swapped = signed.map((s) => s.transaction);
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  await expect(verifyPumpOrganicBatchSigned(review, swapped)).rejects.toThrow(
    'differs',
  );
  await expect(
    verifyPumpOrganicBatchSigned(review, swapped.slice(1)),
  ).rejects.toThrow('every reviewed buy');
});
