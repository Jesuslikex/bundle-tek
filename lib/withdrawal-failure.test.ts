import { it, expect } from 'vitest';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import { decodeNativeWithdrawalReceipt } from './native-withdrawal-server';
import { decodeTokenWithdrawalReceipt } from './token-withdrawal-server';
import { validatedNativeWithdrawal } from './native-withdrawal';
import { withdrawalFailureReason } from './withdrawal-failure';
import { parseBalanceJson } from './wallet-balances';
it.each(['native', 'spl', '2022'])(
  'retains exact failed %s packet cost and rejects contradictory evidence',
  async (kind) => {
    const f =
      kind === 'native'
        ? await nativeWithdrawalFixture()
        : await tokenWithdrawalFixture(false, kind === '2022', kind === '2022');
    const decoder =
      kind === 'native'
        ? decodeNativeWithdrawalReceipt
        : decodeTokenWithdrawalReceipt;
    const post = [...f.receipt.meta.preBalances];
    post[0] = (BigInt(post[0]) - 6000n).toString();
    const raw = {
      ...f.receipt,
      meta: {
        ...f.receipt.meta,
        fee: '6000',
        err: { InstructionError: [0, { Custom: 42 }] },
        postBalances: post,
      },
    };
    const failure = await decoder(
      parseBalanceJson(JSON.stringify(raw)),
      f.review,
      f.signed.signature,
    );
    expect(failure).toMatchObject({
      failed: true,
      networkFeeLamports: '6000',
      walletChangeRaw: '-6000',
      feeLimitExceeded: true,
      error: { type: 'InstructionError', customCode: 42 },
    });
    const row = {
      id: f.review.id,
      wallet: f.wallet,
      walletRevision: 1,
      state: 'failed',
      signature: f.signed.signature,
      document: f.review,
      receipt: null,
      failureReceipt: failure,
      createdAt: f.review.preparedAt,
      updatedAt: f.review.preparedAt,
    };
    await expect(validatedNativeWithdrawal(row)).resolves.toMatchObject({
      state: 'failed',
    });
    await expect(
      validatedNativeWithdrawal({ ...row, state: 'signed' }),
    ).rejects.toThrow();
    await expect(
      validatedNativeWithdrawal({
        ...row,
        failureReceipt: { ...failure, walletChangeRaw: '0' },
      }),
    ).rejects.toThrow();
    await expect(
      decoder(
        {
          ...raw,
          meta: { ...raw.meta, postBalances: f.receipt.meta.postBalances },
        },
        f.review,
        f.signed.signature,
      ),
    ).rejects.toThrow();
    await expect(
      decoder(
        {
          ...raw,
          meta: {
            ...raw.meta,
            err: { InstructionError: [255, 'InsufficientFunds'] },
          },
        },
        f.review,
        f.signed.signature,
      ),
    ).rejects.toThrow();
    await expect(decoder(raw, f.review, 'bad signature')).rejects.toThrow();
  },
);
it('normalizes RPC integer strings without retaining arbitrary error payloads', () => {
  expect(
    withdrawalFailureReason({
      InstructionError: ['1', { Custom: '4294967295' }],
    }),
  ).toEqual({
    type: 'InstructionError',
    instructionIndex: 1,
    instructionCode: 'Custom',
    customCode: 4294967295,
  });
  expect(
    withdrawalFailureReason({
      InsufficientFundsForRent: { account_index: 1, untrusted: 'secret' },
    }),
  ).toEqual({ type: 'InsufficientFundsForRent' });
  for (const bad of [
    { InstructionError: [0, { Custom: '4294967296' }] },
    { InstructionError: [-1, 'InsufficientFunds'] },
    'arbitrary lower case',
  ])
    expect(() => withdrawalFailureReason(bad)).toThrow();
});
