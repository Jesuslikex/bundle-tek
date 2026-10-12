import React from 'react';
import { it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwapFailureEvidence } from './swap-failure-evidence';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import { decodeSwapFailure } from '@/lib/swap-failure-server';
import { importedApprovalPage } from '@/lib/imported-approval-history';
import { isImportedSigningEvent } from '@/lib/imported-signing-events';
vi.stubGlobal('React', React);
it('renders exact failed fee separately and validates captured approval/event context', async () => {
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
  const failureReceipt = await decodeSwapFailure(
    {
      ...f.receipt,
      meta: {
        ...f.receipt.meta,
        postBalances: f.receipt.meta.preBalances.map((v, i) =>
          i === 0 ? (BigInt(v) - 5000n).toString() : v,
        ),
        err: { InstructionError: [0, 'InsufficientFunds'] },
      },
    },
    review,
    f.signed.signature,
  );
  const html = renderToStaticMarkup(
    <SwapFailureEvidence receipt={failureReceipt} />,
  );
  expect(html).toContain('Actual network fee 0.000005');
  expect(html).toContain('InsufficientFunds');
  expect(html).toContain('separate from successful trade performance');
  expect(html).not.toContain('acquired');
  expect(renderToStaticMarkup(<SwapFailureEvidence />)).toContain(
    'not captured',
  );
  const projectId = crypto.randomUUID(),
    row = {
      id: review.id,
      preparationId: review.preparationId,
      projectId,
      projectRevision: 1,
      walletRevision: 1,
      wallet: f.wallet,
      state: 'failed',
      signature: f.signed.signature,
      side: 'Buy' as const,
      document: review,
      failureReceipt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  expect(
    importedApprovalPage(
      { projectId, intents: [row], nextCursor: null },
      projectId,
    ).intents[0],
  ).toBe(row);
  expect(() =>
    importedApprovalPage(
      {
        projectId,
        intents: [
          {
            ...row,
            failureReceipt: { ...failureReceipt, reviewedFeeLamports: '1' },
          },
        ],
        nextCursor: null,
      },
      projectId,
    ),
  ).toThrow();
  const event = {
    ...row,
    id: 'a'.repeat(32),
    intentId: row.id,
    sequence: 1,
    type: 'approval.failed' as const,
    document: {
      side: row.side,
      sha256: review.sha256,
      inputRaw: review.inputRaw,
      minimumOutputRaw: review.minimumOutputRaw,
      inputMint: review.inputMint,
      outputMint: review.outputMint,
    },
  };
  expect(isImportedSigningEvent(event)).toBe(true);
  expect(isImportedSigningEvent({ ...event, state: 'submitted' })).toBe(false);
  expect(
    isImportedSigningEvent({
      ...event,
      failureReceipt: { ...failureReceipt, sha256: 'f'.repeat(64) },
    }),
  ).toBe(false);
});
