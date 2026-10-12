import { expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { restoreRegisteredWarmupPacket } from './warmup-approval-history';
import type { WarmupSigningReview } from './warmup-signing';
async function fixture(side: 'Buy' | 'Sell' = 'Buy') {
  const f = await nativeWarmupFixture({ side, v2: true, fee: 2, lookup: true });
  const review: WarmupSigningReview = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: f.wallet,
    network: 'mainnet',
    sha256: f.order.preparation.sha256,
    transaction: f.order.preparation.transaction,
    expiresAt: new Date(0).toISOString(),
    maximumFeeLamports: '5000',
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    lastValidBlockHeight: '1000',
  };
  return { f, review };
}
it.each(['Buy', 'Sell'] as const)(
  'restores the exact registered %s packet after expiry for receipt recovery without signing',
  async (side) => {
    const { f, review } = await fixture(side);
    expect(
      await restoreRegisteredWarmupPacket(review, f.signed.signature),
    ).toEqual(f.signed);
  },
);
it.each([
  'hash',
  'wallet',
  'network',
  'already signed',
  'signature',
  'trailing bytes',
] as const)('rejects recovered %s changes', async (kind) => {
  const { f, review } = await fixture();
  let signature = f.signed.signature;
  if (kind === 'hash') review.sha256 = '0'.repeat(64);
  if (kind === 'wallet') review.wallet = f.mint;
  if (kind === 'network') review.network = 'devnet' as 'mainnet';
  if (kind === 'already signed') {
    review.transaction = f.signed.transaction;
    const bytes = Uint8Array.from(atob(review.transaction), (c) =>
      c.charCodeAt(0),
    );
    review.sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  }
  if (kind === 'signature') signature = '1'.repeat(64);
  if (kind === 'trailing bytes') {
    const bytes = Uint8Array.from([
      ...Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
      0,
    ]);
    review.transaction = btoa(String.fromCharCode(...bytes));
    review.sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  }
  await expect(
    restoreRegisteredWarmupPacket(review, signature),
  ).rejects.toThrow();
});
