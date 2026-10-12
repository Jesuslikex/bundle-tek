import { it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { solanaTransferMessage } from './solana-funding';
import {
  signApprovedWarmupPacket,
  restoreWarmupOrder,
  type WarmupSigningReview,
} from './warmup-signing';
import type { VaultSession } from './browser-wallet-vault';
import { preparationHistoryFixture } from '../test/imported-preparation-history-fixture';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
async function fixture() {
  const seed = new Uint8Array(32).fill(7),
    pair = nacl.sign.keyPair.fromSeed(seed),
    wallet = bs58.encode(pair.publicKey),
    destination = bs58.encode(new Uint8Array(32).fill(2));
  const message = Uint8Array.from([
    128,
    ...solanaTransferMessage(
      wallet,
      destination,
      '11111111111111111111111111111111',
      1n,
    ),
    0,
  ]);
  const bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]),
    transaction = btoa(String.fromCharCode(...bytes)),
    sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const review: WarmupSigningReview = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet,
    sha256,
    transaction,
    network: 'mainnet',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    maximumFeeLamports: '5000',
    inputRaw: '1',
    minimumOutputRaw: '1',
    inputMint: destination,
    outputMint: destination,
    lastValidBlockHeight: '999999999',
  };
  const session = {
    payload: {
      wallets: [{ family: 'solana', address: wallet, seed: '07'.repeat(32) }],
    },
  } as VaultSession;
  return { review, session, message, bytes };
}
it('signs only the immutable approved envelope using the matching local vault key', async () => {
  const f = await fixture();
  const signed = await signApprovedWarmupPacket(f.session, f.review, () => {});
  const bytes = Uint8Array.from(atob(signed.transaction), (c) =>
    c.charCodeAt(0),
  );
  expect(bytes.slice(65)).toEqual(f.message);
  expect(bs58.encode(bytes.slice(1, 65))).toBe(signed.signature);
  expect(
    nacl.sign.detached.verify(
      f.message,
      bytes.slice(1, 65),
      bs58.decode(f.review.wallet),
    ),
  ).toBe(true);
  for (const patch of [
    { sha256: 'a'.repeat(64) },
    { expiresAt: new Date(0).toISOString() },
    { wallet: bs58.encode(new Uint8Array(32).fill(4)) },
  ])
    await expect(
      signApprovedWarmupPacket(f.session, { ...f.review, ...patch }, () => {}),
    ).rejects.toThrow();
  await expect(
    signApprovedWarmupPacket(f.session, f.review, () => {
      throw new Error('changed');
    }),
  ).rejects.toThrow('changed');
});
it('restores server-owned quote fields and refuses changed or expired packets', async () => {
  const f = await fixture();
  const saved = {
    id: f.review.preparationId,
    planId: 'qa',
    planRevision: 1,
    cycle: 1,
    walletRevision: 1,
    createdAt: new Date().toISOString(),
    document: {
      ...preparationHistoryFixture(),
      wallet: f.review.wallet,
      expiresAt: f.review.expiresAt,
      transaction: {
        ...preparationHistoryFixture().transaction,
        sha256: f.review.sha256,
        bytes: f.bytes.length,
      },
      inventory: null,
    },
  } as SavedWarmupPreparation;
  expect(
    (await restoreWarmupOrder(saved, f.review.transaction)).preparation.sha256,
  ).toBe(f.review.sha256);
  await expect(
    restoreWarmupOrder(
      {
        ...saved,
        document: { ...saved.document, expiresAt: new Date(0).toISOString() },
      },
      f.review.transaction,
    ),
  ).rejects.toThrow('expired');
});

it('checks conditional capture freshness and exact units before invoking local signing', async () => {
  const f = await fixture();
  const now = Date.now();
  const conditional = {
    format: 'conditional-preparation-v1' as const,
    orderId: crypto.randomUUID(),
    orderRevision: 1,
    level: 1,
    termsSha256: 'a'.repeat(64),
    pair: f.review.inputMint,
    direction: 'at-or-above' as const,
    targetUsd: '100',
    unitsRaw: '1',
    observedMarketCapUsd: '100',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    source: 'api.dexscreener.com' as const,
  };
  expect(
    (
      await signApprovedWarmupPacket(
        f.session,
        { ...f.review, conditional },
        () => {},
      )
    ).signature,
  ).toBeTruthy();
  await expect(
    signApprovedWarmupPacket(
      f.session,
      { ...f.review, conditional: { ...conditional, unitsRaw: '2' } },
      () => {},
    ),
  ).rejects.toThrow('Conditional');
  await expect(
    signApprovedWarmupPacket(
      f.session,
      {
        ...f.review,
        conditional: {
          ...conditional,
          observedAt: new Date(now - 31000).toISOString(),
          expiresAt: new Date(now - 1000).toISOString(),
        },
      },
      () => {},
    ),
  ).rejects.toThrow('Conditional');
});
