import { expect, it } from 'vitest';
import {
  fundingReceipt,
  fundingPendingOperation,
} from './funding-execution-history';
import { verifyNativeFundingReceipt } from './solana-transfer-receipt';
import { operationDocument, type WalletOperation } from './wallet-operation';
import {
  nativeFundingInput,
  nativeReceiptFixture,
  receiptWallet,
  receiptSignature,
} from '../test/devnet-receipt-fixture';
async function fixture(failed = false) {
  const intent = await operationDocument(nativeFundingInput);
  if (intent.kind !== 'sol') throw new Error();
  return {
    id: crypto.randomUUID(),
    walletAddress: receiptWallet,
    network: 'devnet',
    eventType: failed ? 'native_transfer_failed' : 'native_transfer_finalized',
    transactionSignature: receiptSignature,
    createdAt: '2026-10-10T06:00:00.000Z',
    details: JSON.stringify(
      verifyNativeFundingReceipt(
        nativeReceiptFixture(failed),
        receiptSignature,
        intent,
        failed,
      ),
    ),
  };
}
it('retains exact amounts and distinguishes finalized delivery from fee-only failure', async () => {
  expect(await fundingReceipt(await fixture(), 'funding-test')).toMatchObject({
    amount: '0.300000001',
    rawAmount: '300000001',
    outcome: 'finalized',
    decimals: 9,
    feeLamports: '5000',
  });
  expect(
    await fundingReceipt(await fixture(true), 'funding-test'),
  ).toMatchObject({
    amount: '0.300000001',
    outcome: 'failed',
    feeLamports: '5000',
    transactionError: expect.any(String),
  });
});
it('rejects corrupted retained evidence rather than rendering it as a completed allocation', async () => {
  const event = await fixture();
  for (const patch of [
    { amount: '0.3' },
    { rawAmount: '1' },
    { fundingKey: '0'.repeat(64) },
    { fundingId: 'another-draft' },
    { commitment: 'confirmed' },
    { slot: 1.5 },
    { feeLamports: '5e3' },
    { blockTime: 'unknown' },
  ]) {
    await expect(
      fundingReceipt(
        {
          ...event,
          details: JSON.stringify({ ...JSON.parse(event.details), ...patch }),
        },
        'funding-test',
      ),
    ).rejects.toThrow();
  }
  await expect(
    fundingReceipt({ ...event, network: 'mainnet' }, 'funding-test'),
  ).rejects.toThrow();
});
it('labels retained reservations without inferring delivery and rejects inconsistent signature states', async () => {
  const op: WalletOperation = {
    id: crypto.randomUUID(),
    walletAddress: receiptWallet,
    kind: 'sol',
    document: JSON.stringify(await operationDocument(nativeFundingInput)),
    state: 'awaiting_signature',
    signature: null,
    createdAt: '2026-10-10T06:00:00.000Z',
    expiresAt: '2026-10-10T06:01:00.000Z',
    armedAt: '2026-10-10T06:00:01.000Z',
    minimumSlot: 100,
    updatedAt: '2026-10-10T06:00:01.000Z',
  };
  expect(await fundingPendingOperation(op, 'funding-test')).toMatchObject({
    state: 'awaiting_signature',
    signature: null,
    fundingRevision: 1,
  });
  expect(
    await fundingPendingOperation(
      { ...op, state: 'submitted', signature: receiptSignature },
      'funding-test',
    ),
  ).toMatchObject({ state: 'submitted', signature: receiptSignature });
  await expect(
    fundingPendingOperation({ ...op, state: 'submitted' }, 'funding-test'),
  ).rejects.toThrow();
  await expect(fundingPendingOperation(op, 'another-draft')).rejects.toThrow();
});
