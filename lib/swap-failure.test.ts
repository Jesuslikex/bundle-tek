import { it, expect } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import { decodeSwapFailure } from './swap-failure-server';
import { validatedSwapFailure } from './swap-failure';
import { parseBalanceJson } from './wallet-balances';
it.each([false, true])(
  'retains exact v0 failed swap fee with lookups=%s and rejects changed evidence',
  async (lookup) => {
    const f = await nativeWarmupFixture({ lookup, v2: true }),
      review: WarmupSigningReview = {
        settlement: await requireWarmupSigningReview(f.order, f.simulation),
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
        id: crypto.randomUUID(),
        preparationId: crypto.randomUUID(),
      };
    const post = f.receipt.meta.preBalances.map((v, i) =>
      i === 0 ? (BigInt(v) - 5001n).toString() : v,
    );
    const raw = {
      ...f.receipt,
      meta: {
        ...f.receipt.meta,
        fee: '5001',
        postBalances: post,
        err: { InstructionError: [0, { Custom: 42 }] },
      },
    };
    const proof = await decodeSwapFailure(
      parseBalanceJson(JSON.stringify(raw)),
      review,
      f.signed.signature,
    );
    expect(proof).toMatchObject({
      failed: true,
      networkFeeLamports: '5001',
      walletChangeRaw: '-5001',
      feeLimitExceeded: true,
      error: { type: 'InstructionError', customCode: 42 },
    });
    expect(validatedSwapFailure(proof, review, f.signed.signature)).toBe(proof);
    await expect(
      decodeSwapFailure(
        {
          ...raw,
          meta: { ...raw.meta, postBalances: f.receipt.meta.postBalances },
        },
        review,
        f.signed.signature,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSwapFailure(
        {
          ...raw,
          meta: {
            ...raw.meta,
            err: { InstructionError: [255, 'InsufficientFunds'] },
          },
        },
        review,
        f.signed.signature,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSwapFailure(
        raw,
        { ...review, sha256: 'f'.repeat(64) },
        f.signed.signature,
      ),
    ).rejects.toThrow();
    await expect(
      decodeSwapFailure(raw, review, 'bad signature'),
    ).rejects.toThrow();
    expect(() =>
      validatedSwapFailure(
        { ...proof, walletChangeRaw: '0' },
        review,
        f.signed.signature,
      ),
    ).toThrow();
    if (lookup)
      await expect(
        decodeSwapFailure(
          {
            ...raw,
            meta: {
              ...raw.meta,
              loadedAddresses: { writable: [], readonly: [] },
            },
          },
          review,
          f.signed.signature,
        ),
      ).rejects.toThrow();
  },
);
