import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { FundingHistoryContent } from './funding-execution-history';
import type { FundingExecutionHistory } from '@/lib/funding-execution-history';
import {
  receiptWallet,
  receiptRecipient,
  receiptSignature,
} from '../../test/devnet-receipt-fixture';
vi.stubGlobal('React', React);
it('separates historical failed amounts, unresolved signatures and verified delivery', () => {
  const data: FundingExecutionHistory = {
    id: 'funding-test',
    revision: 2,
    archived: true,
    pendingTruncated: false,
    nextCursor: null,
    pending: [
      {
        id: crypto.randomUUID(),
        wallet: receiptWallet,
        recipient: receiptRecipient,
        amount: '0.5',
        mint: null,
        state: 'submitted',
        signature: receiptSignature,
        createdAt: '2026-10-10T06:00:00.000Z',
        fundingRevision: 1,
      },
    ],
    receipts: [
      {
        id: crypto.randomUUID(),
        wallet: receiptWallet,
        recipient: receiptRecipient,
        amount: '0.300000001',
        mint: null,
        decimals: 9,
        rawAmount: '300000001',
        signature: receiptSignature,
        slot: 12345,
        blockTime: null,
        verifiedAt: '2026-10-10T06:00:00.000Z',
        fundingRevision: 1,
        key: '0'.repeat(64),
        outcome: 'failed',
        feeLamports: '5000',
        transactionError: 'InstructionError',
      },
    ],
  };
  const html = renderToStaticMarkup(<FundingHistoryContent data={data} />);
  expect(html).toContain('Archived draft');
  expect(html).toContain('Amount not delivered');
  expect(html).toContain('0.300000001 SOL requested');
  expect(html).not.toContain('0.300000001 SOL delivered');
  expect(html).toContain('Signature recorded. Broadcast outcome unverified.');
  expect(html).toContain('5000 lamports');
  expect(html).toContain('?cluster=devnet');
  data.receipts[0] = {
    ...data.receipts[0],
    outcome: 'finalized',
    feeLamports: null,
    transactionError: null,
  };
  const success = renderToStaticMarkup(<FundingHistoryContent data={data} />);
  expect(success).toContain('0.300000001 SOL delivered');
  expect(success).toContain('not retained in this receipt');
});
