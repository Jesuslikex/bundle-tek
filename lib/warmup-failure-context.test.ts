import { it, expect } from 'vitest';
import { validatedWarmupFailure } from './warmup-approval-history';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import { decodeSwapFailure } from './swap-failure-server';
import {
  isWarmupSigningEvent,
  type WarmupSigningEvent,
} from './warmup-signing-events';
it('requires exact warmup approval and captured event failure context, treating only null or absent proof as missing', async () => {
  const f = await nativeWarmupFixture({ lookup: true, v2: true }),
    review: WarmupSigningReview = {
      id: crypto.randomUUID(),
      preparationId: crypto.randomUUID(),
      wallet: f.wallet,
      sha256: f.order.preparation.sha256,
      transaction: f.order.preparation.transaction,
      network: 'mainnet',
      expiresAt: f.order.expiresAt,
      maximumFeeLamports: f.simulation.networkFeeLamports,
      inputRaw: f.order.inAmount,
      minimumOutputRaw: f.order.minimumOutAmount,
      inputMint: f.order.inputMint,
      outputMint: f.order.outputMint,
      lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
      settlement: await requireWarmupSigningReview(f.order, f.simulation),
    };
  const proof = await decodeSwapFailure(
      {
        ...f.receipt,
        meta: {
          ...f.receipt.meta,
          postBalances: f.receipt.meta.preBalances.map((v, i) =>
            i === 0 ? (BigInt(v) - 5000n).toString() : v,
          ),
          err: 'InsufficientFundsForFee',
        },
      },
      review,
      f.signed.signature,
    ),
    row = {
      document: review,
      state: 'failed',
      signature: f.signed.signature,
      failureReceipt: proof,
    };
  expect(validatedWarmupFailure(row)).toBe(proof);
  for (const failureReceipt of [
    false,
    0,
    '',
    {},
    { ...proof, walletChangeRaw: '0' },
  ])
    expect(() => validatedWarmupFailure({ ...row, failureReceipt })).toThrow();
  expect(validatedWarmupFailure({ ...row, failureReceipt: null })).toBeNull();
  expect(() =>
    validatedWarmupFailure({ ...row, state: 'submitted' }),
  ).toThrow();
  const event: WarmupSigningEvent = {
    id: 'a'.repeat(32),
    sequence: 1,
    intentId: review.id,
    preparationId: review.preparationId,
    planId: 'qa',
    planRevision: 1,
    cycle: 1,
    wallet: f.wallet,
    type: 'approval.failed',
    state: 'failed',
    signature: f.signed.signature,
    createdAt: new Date().toISOString(),
    failureReceipt: proof,
    document: {
      side: 'Buy',
      sha256: review.sha256,
      inputMint: review.inputMint,
      outputMint: review.outputMint,
      inputRaw: review.inputRaw,
      minimumOutputRaw: review.minimumOutputRaw,
    },
  };
  expect(isWarmupSigningEvent(event)).toBe(true);
  expect(isWarmupSigningEvent({ ...event, state: 'signed' })).toBe(false);
  expect(
    isWarmupSigningEvent({
      ...event,
      failureReceipt: { ...proof, sha256: 'f'.repeat(64) },
    }),
  ).toBe(false);
  expect(
    isWarmupSigningEvent({
      ...event,
      failureReceipt: false as unknown as typeof proof,
    }),
  ).toBe(false);
});
