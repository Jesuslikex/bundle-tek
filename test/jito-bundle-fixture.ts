import { nativeWarmupFixture } from './warmup-native-fixture';
import { nativeWithdrawalFixture } from './native-withdrawal-fixture';
import { bundleFingerprint, type JitoBundleManifest } from '../lib/jito-bundle';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '../lib/warmup-signing';
export async function jitoBundleFixture(wallets = 1, token2022 = false) {
  const swap = await nativeWarmupFixture({ v2: true, token2022 }),
    tip = await nativeWithdrawalFixture();
  const projectId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    now = new Date().toISOString();
  const review: WarmupSigningReview = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: swap.wallet,
    sha256: swap.order.preparation.sha256,
    expiresAt: swap.order.expiresAt,
    network: 'mainnet',
    maximumFeeLamports: swap.simulation.networkFeeLamports,
    inputRaw: swap.order.inAmount,
    minimumOutputRaw: swap.order.minimumOutAmount,
    inputMint: swap.order.inputMint,
    outputMint: swap.order.outputMint,
    transaction: swap.order.preparation.transaction,
    lastValidBlockHeight: swap.order.preparation.lastValidBlockHeight,
    settlement: await requireWarmupSigningReview(swap.order, swap.simulation),
    session: {
      format: 'trade-session-entry-v1',
      sessionId,
      sessionRevision: 1,
      entry: 1,
      termsSha256: 'ab'.repeat(32),
      unitsRaw: swap.order.inAmount,
    },
  };
  const swaps = [swap];
  const reviews = [review];
  for (let i = 1; i < wallets; i++) {
    const f = await nativeWarmupFixture({
      v2: true,
      token2022,
      walletSeed: 7 + i,
    });
    swaps.push(f);
    reviews.push({
      ...review,
      id: crypto.randomUUID(),
      preparationId: crypto.randomUUID(),
      wallet: f.wallet,
      sha256: f.order.preparation.sha256,
      transaction: f.order.preparation.transaction,
      expiresAt: f.order.expiresAt,
      settlement: await requireWarmupSigningReview(f.order, f.simulation),
      session: { ...review.session!, entry: i + 1 },
    });
  }
  const terms = {
    format: 'jito-atomic-bundle-v1' as const,
    id: crypto.randomUUID(),
    projectId,
    sessionId,
    sessionRevision: 1,
    createdAt: now,
    expiresAt: new Date(
      Math.min(...reviews.map((r) => Date.parse(r.expiresAt))),
    ).toISOString(),
    swaps: reviews,
    tip: tip.review,
  };
  const manifest: JitoBundleManifest = {
    ...terms,
    sha256: await bundleFingerprint(terms),
  };
  return { manifest, swap, swaps, tip, review };
}
