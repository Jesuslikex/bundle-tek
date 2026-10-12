import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi } from 'vitest';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import { decodeTokenWithdrawalReceipt } from '@/lib/token-withdrawal-server';
import { validatedWithdrawalActivity } from '@/lib/withdrawal-activity';
import { WithdrawalActivityRecord } from './withdrawal-activity-record';
vi.stubGlobal('React', React);
it('renders exact captured token fee, net receipt and wallet history handoff', async () => {
  const f = await tokenWithdrawalFixture(false, true, true),
    receipt = await decodeTokenWithdrawalReceipt(
      f.receipt,
      f.review,
      f.signed.signature,
    );
  if ('failed' in receipt) throw new Error();
  const event = await validatedWithdrawalActivity({
    sequence: 1,
    createdAt: f.review.preparedAt,
    withdrawal: {
      id: f.review.id,
      wallet: f.wallet,
      walletRevision: 1,
      state: 'finalized',
      signature: f.signed.signature,
      document: f.review,
      receipt,
      createdAt: f.review.preparedAt,
      updatedAt: f.review.preparedAt,
    },
  });
  const html = renderToStaticMarkup(
    <WithdrawalActivityRecord
      event={event}
      onClose={() => {}}
      onOpenWallet={() => {}}
    />,
  );
  expect(html).toContain('recipient received 9007199254.740893 tokens');
  expect(html).toContain('token fee 0.0001 tokens');
  expect(html).toContain('actual account rent 0.0021576 SOL');
  expect(html).toContain('Open wallet withdrawal history');
  expect(html).not.toContain('Approve and sign');
  await expect(
    validatedWithdrawalActivity({ ...event, sequence: 0 }),
  ).rejects.toThrow();
  await expect(
    validatedWithdrawalActivity({
      ...event,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  ).rejects.toThrow();
  await expect(
    validatedWithdrawalActivity({
      ...event,
      withdrawal: { ...event.withdrawal, state: 'signed' },
    }),
  ).rejects.toThrow();
});

it('renders captured failure cost without claiming delivery, and keeps missing older evidence explicit', async () => {
  const f = await tokenWithdrawalFixture(false, true, true),
    post = [...f.receipt.meta.preBalances];
  post[0] = (BigInt(post[0]) - 5000n).toString();
  const failureReceipt = await decodeTokenWithdrawalReceipt(
    {
      ...f.receipt,
      meta: {
        ...f.receipt.meta,
        postBalances: post,
        err: { InstructionError: [0, 'InsufficientFunds'] },
      },
    },
    f.review,
    f.signed.signature,
  );
  const event = await validatedWithdrawalActivity({
    sequence: 1,
    createdAt: f.review.preparedAt,
    withdrawal: {
      id: f.review.id,
      wallet: f.wallet,
      walletRevision: 1,
      state: 'failed',
      signature: f.signed.signature,
      document: f.review,
      receipt: null,
      failureReceipt,
      createdAt: f.review.preparedAt,
      updatedAt: f.review.preparedAt,
    },
  });
  const html = renderToStaticMarkup(
    <WithdrawalActivityRecord event={event} onClose={() => {}} />,
  );
  expect(html).toContain('Actual network fee 0.000005');
  expect(html).toContain('InsufficientFunds');
  expect(html).not.toContain('recipient received');
  expect(html).not.toContain('Approve and sign');
  const old = renderToStaticMarkup(
    <WithdrawalActivityRecord
      event={{
        ...event,
        withdrawal: { ...event.withdrawal, failureReceipt: null },
      }}
      onClose={() => {}}
    />,
  );
  expect(old).toContain('Failure fee and error evidence was not captured');
  expect(old).not.toContain('Actual network fee');
});
