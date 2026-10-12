import { it, expect } from 'vitest';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import {
  inspectNativeWithdrawal,
  withdrawalInput,
  signNativeWithdrawal,
  validatedNativeWithdrawal,
} from './native-withdrawal';
import {
  decodeNativeWithdrawalReceipt,
  recheckNativeWithdrawal,
} from './native-withdrawal-server';
import {
  getTransactionDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
it('prepares and independently decodes one exact legacy transfer with real Ed25519 signing', async () => {
  const f = await nativeWithdrawalFixture();
  expect(
    (await inspectNativeWithdrawal(f.review, f.signed.transaction, true))
      .signature,
  ).toBe(f.signed.signature);
  const tx = getTransactionDecoder().decode(
      getBase64Encoder().encode(f.review.transaction),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  expect(message.version).toBe('legacy');
  if (message.version !== 'legacy')
    throw new Error('Expected legacy withdrawal.');
  expect(message.header.numSignerAccounts).toBe(1);
  expect(message.instructions).toHaveLength(1);
  expect(message.staticAccounts).toEqual([
    f.wallet,
    f.recipient,
    '11111111111111111111111111111111',
  ]);
  expect(f.review.maximumDebitRaw).toBe('10005000');
  expect(f.review.reserveLamports).toBe('890880');
  expect(
    await decodeNativeWithdrawalReceipt(
      f.receipt,
      f.review,
      f.signed.signature,
    ),
  ).toMatchObject({
    amountRaw: '10000000',
    networkFeeLamports: '5000',
    walletChangeRaw: '-10005000',
    recipientChangeRaw: '10000000',
    signatureVerified: true,
  });
  expect(f.fetcher).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      body: expect.stringContaining('sendTransaction'),
    }),
  );
});
it('rejects changed recipients, amounts, signatures, fee bounds and settlement evidence', async () => {
  const f = await nativeWithdrawalFixture();
  await expect(
    inspectNativeWithdrawal(
      { ...f.review, recipient: f.wallet },
      f.signed.transaction,
      true,
    ),
  ).rejects.toThrow();
  await expect(
    inspectNativeWithdrawal(
      { ...f.review, amountRaw: '1' },
      f.signed.transaction,
      true,
    ),
  ).rejects.toThrow();
  const bytes = Uint8Array.from(atob(f.signed.transaction), (c) =>
    c.charCodeAt(0),
  );
  bytes[1] ^= 1;
  await expect(
    inspectNativeWithdrawal(
      f.review,
      btoa(String.fromCharCode(...bytes)),
      true,
    ),
  ).rejects.toThrow();
  await expect(
    decodeNativeWithdrawalReceipt(
      {
        ...f.receipt,
        meta: { ...f.receipt.meta, postBalances: ['9995001', '10000000', '1'] },
      },
      f.review,
      f.signed.signature,
    ),
  ).rejects.toThrow('settlement');
  await expect(
    decodeNativeWithdrawalReceipt(
      { ...f.receipt, meta: { ...f.receipt.meta, fee: '5001' } },
      f.review,
      f.signed.signature,
    ),
  ).rejects.toThrow();
  await expect(
    decodeNativeWithdrawalReceipt(f.receipt, f.review, 'other-signature'),
  ).rejects.toThrow();
  expect(() =>
    withdrawalInput(f.wallet, f.recipient, '0.0000000001', 1),
  ).toThrow();
});
it('rechecks exact packet lifetime, fee, reserve and current accounts without replacement', async () => {
  const f = await nativeWithdrawalFixture();
  await recheckNativeWithdrawal(
    f.review,
    AbortSignal.timeout(10000),
    f.fetcher,
  );
  f.data.getFeeForMessage = { context: { slot: 100 }, value: 5001 };
  await expect(
    recheckNativeWithdrawal(f.review, AbortSignal.timeout(10000), f.fetcher),
  ).rejects.toThrow('fee');
  f.data.getFeeForMessage = { context: { slot: 100 }, value: 5000 };
  f.data.isBlockhashValid = { context: { slot: 100 }, value: false };
  await expect(
    recheckNativeWithdrawal(f.review, AbortSignal.timeout(10000), f.fetcher),
  ).rejects.toThrow('expired');
  await expect(
    signNativeWithdrawal(
      f.session,
      { ...f.review, expiresAt: new Date(Date.now() - 1).toISOString() },
      () => {},
    ),
  ).rejects.toThrow();
});
it('validates retained states and requires exact success receipts while preserving verified failure', async () => {
  const f = await nativeWithdrawalFixture(),
    receipt = await decodeNativeWithdrawalReceipt(
      f.receipt,
      f.review,
      f.signed.signature,
    );
  const row = {
    id: f.review.id,
    wallet: f.wallet,
    walletRevision: 1,
    state: 'finalized',
    signature: f.signed.signature,
    document: f.review,
    receipt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  expect(await validatedNativeWithdrawal(row)).toMatchObject({
    state: 'finalized',
  });
  await expect(
    validatedNativeWithdrawal({ ...row, receipt: null }),
  ).rejects.toThrow();
  await expect(
    validatedNativeWithdrawal({ ...row, walletRevision: 2 }),
  ).rejects.toThrow();
  expect(
    await decodeNativeWithdrawalReceipt(
      {
        ...f.receipt,
        meta: {
          ...f.receipt.meta,
          postBalances: ['19995000', '0', '1'],
          err: { InstructionError: [0, 'InsufficientFunds'] },
        },
      },
      f.review,
      f.signed.signature,
    ),
  ).toMatchObject({
    failed: true,
    networkFeeLamports: '5000',
    walletChangeRaw: '-5000',
    error: {
      type: 'InstructionError',
      instructionIndex: 0,
      instructionCode: 'InsufficientFunds',
    },
  });
});
