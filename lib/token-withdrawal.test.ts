import { it, expect } from 'vitest';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import {
  decodeTokenWithdrawalReceipt,
  recheckTokenWithdrawal,
} from './token-withdrawal-server';
import {
  inspectNativeWithdrawal,
  validatedNativeWithdrawal,
} from './native-withdrawal';
import { getExtensionEncoder } from '@solana-program/token-2022';
import { withdrawalTransferFee } from './token-withdrawal-fee';
import {
  withdrawalExtensions,
  withdrawalTokenAccountSize,
} from './token-withdrawal-extensions';
import { prepareTokenWithdrawal } from './token-withdrawal-server';
import { tokenWithdrawalInput } from './native-withdrawal';
import { address } from '@solana/kit';
import { parseBalanceJson } from './wallet-balances';
it.each([false, true])(
  'prepares, signs and verifies exact large-unit SPL transfer with existing destination=%s',
  async (existing) => {
    const f = await tokenWithdrawalFixture(existing);
    expect(f.review.amountRaw).toBe('9007199254740993');
    expect(f.review.token!.createAccount).toBe(!existing);
    expect(f.review.maximumDebitRaw).toBe(existing ? '5000' : '2044280');
    const receipt = await decodeTokenWithdrawalReceipt(
      parseBalanceJson(JSON.stringify(f.receipt)),
      f.review,
      f.signed.signature,
    );
    expect('failed' in receipt).toBe(false);
    if ('failed' in receipt) throw new Error();
    expect(receipt.token!.destinationChangeRaw).toBe('9007199254740993');
    await validatedNativeWithdrawal({
      id: f.review.id,
      wallet: f.wallet,
      walletRevision: 1,
      state: 'finalized',
      signature: f.signed.signature,
      document: f.review,
      receipt,
      createdAt: f.review.preparedAt,
      updatedAt: f.review.preparedAt,
    });
  },
);
it('rejects changed mint, associated accounts, precision, signed packet and token settlement', async () => {
  const f = await tokenWithdrawalFixture();
  for (const token of [
    { ...f.review.token!, decimals: 5 },
    { ...f.review.token!, destinationAccount: f.wallet },
    { ...f.review.token!, mint: f.recipient },
  ])
    await expect(
      inspectNativeWithdrawal(
        { ...f.review, token },
        f.signed.transaction,
        true,
      ),
    ).rejects.toThrow();
  const bad = structuredClone(f.receipt);
  bad.meta.postTokenBalances[1].uiTokenAmount.amount = '9007199254740994';
  await expect(
    decodeTokenWithdrawalReceipt(bad, f.review, f.signed.signature),
  ).rejects.toThrow('units');
  bad.meta.postTokenBalances[1].uiTokenAmount.amount = '9007199254740993';
  bad.meta.postTokenBalances[1].owner = f.wallet;
  await expect(
    decodeTokenWithdrawalReceipt(bad, f.review, f.signed.signature),
  ).rejects.toThrow('identity');
  const native = structuredClone(f.receipt);
  native.meta.postBalances[0] = '1';
  await expect(
    decodeTokenWithdrawalReceipt(native, f.review, f.signed.signature),
  ).rejects.toThrow('settlement');
});
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'verifies real signed Token-2022 packet and finalized net units with existing=%s fee=%s',
  async (existing, fee) => {
    const f = await tokenWithdrawalFixture(existing, true, fee);
    expect(f.review.token!.mintExtensions).toEqual(
      fee ? ['TransferFeeConfig'] : [],
    );
    expect(f.review.token!.transferFee?.feeRaw).toBe(fee ? '100' : undefined);
    expect(f.review.maximumDebitRaw).toBe(
      existing ? '5000' : fee ? '2162600' : '2079080',
    );
    const receipt = await decodeTokenWithdrawalReceipt(
      parseBalanceJson(JSON.stringify(f.receipt)),
      f.review,
      f.signed.signature,
    );
    if ('failed' in receipt) throw new Error();
    expect(receipt.token!.destinationChangeRaw).toBe(
      fee ? '9007199254740893' : '9007199254740993',
    );
    expect(receipt.token!.transferFeeRaw).toBe(fee ? '100' : undefined);
    await validatedNativeWithdrawal({
      id: f.review.id,
      wallet: f.wallet,
      walletRevision: 1,
      state: 'finalized',
      signature: f.signed.signature,
      document: f.review,
      receipt,
      createdAt: f.review.preparedAt,
      updatedAt: f.review.preparedAt,
    });
    if (fee) {
      const bad = structuredClone(f.receipt);
      bad.meta.postTokenBalances[1].uiTokenAmount.amount = (
        BigInt(bad.meta.postTokenBalances[1].uiTokenAmount.amount) + 1n
      ).toString();
      await expect(
        decodeTokenWithdrawalReceipt(bad, f.review, f.signed.signature),
      ).rejects.toThrow('units');
      for (const transferFee of [
        { ...f.review.token!.transferFee!, feeRaw: '0' },
        { ...f.review.token!.transferFee!, netAmountRaw: '9007199254740993' },
      ])
        await expect(
          inspectNativeWithdrawal(
            { ...f.review, token: { ...f.review.token!, transferFee } },
            f.signed.transaction,
            true,
          ),
        ).rejects.toThrow();
    }
  },
);
it('calculates integer transfer-fee ceiling and cap, preserving uint64 precision', () => {
  expect(withdrawalTransferFee(1n, 1, 100n)).toBe(1n);
  expect(withdrawalTransferFee(10001n, 1, 100n)).toBe(2n);
  expect(withdrawalTransferFee((1n << 64n) - 1n, 100, 500n)).toBe(500n);
  expect(withdrawalTransferFee(100n, 0, 500n)).toBe(0n);
  expect(withdrawalTransferFee(100n, 10000, 0n)).toBe(0n);
  expect(withdrawalTransferFee(100n, 10000, 500n)).toBe(100n);
  expect(() => withdrawalTransferFee(100n, 10001, 0n)).toThrow();
  expect(withdrawalTokenAccountSize(false)).toBe(170);
  expect(withdrawalTokenAccountSize(true)).toBe(182);
});
it('refuses fee epoch, schedules, unknown mint/account extensions and malformed TLV changes before signing or submission', async () => {
  for (const kind of [
    'epoch',
    'schedule',
    'hook',
    'account',
    'duplicate',
    'length',
    'type',
    'padding',
  ]) {
    const f = await tokenWithdrawalFixture(false, true, true);
    const accounts = f.data.getMultipleAccounts as {
      value: { data: string[] }[];
    };
    if (kind === 'epoch')
      f.data.getEpochInfo = { epoch: '10', absoluteSlot: '100' };
    else {
      const index = kind === 'account' ? 2 : 1;
      let bytes = Uint8Array.from(atob(accounts.value[index].data[0]), (c) =>
        c.charCodeAt(0),
      );
      if (kind === 'schedule')
        new DataView(bytes.buffer).setUint16(166 + 4 + 72 + 16, 101, true);
      if (kind === 'length') bytes[168] = 255;
      if (kind === 'type') bytes[165] = 2;
      if (kind === 'padding') bytes[82] = 1;
      if (kind === 'hook')
        bytes = Uint8Array.from([
          ...bytes,
          ...getExtensionEncoder().encode({ __kind: 'NonTransferable' }),
        ]);
      if (kind === 'account')
        bytes = Uint8Array.from([
          ...bytes,
          ...getExtensionEncoder().encode({
            __kind: 'MemoTransfer',
            requireIncomingTransferMemos: true,
          }),
        ]);
      if (kind === 'duplicate')
        bytes = Uint8Array.from([...bytes, ...bytes.slice(166)]);
      accounts.value[index].data[0] = btoa(String.fromCharCode(...bytes));
    }
    await expect(
      recheckTokenWithdrawal(f.review, AbortSignal.timeout(10000), f.fetcher),
    ).rejects.toThrow();
  }
});
it('accepts metadata-only Token-2022 mint extensions and rejects a zero-net fee', async () => {
  const f = await tokenWithdrawalFixture(false, true);
  const accounts = f.data.getMultipleAccounts as {
    value: { data: string[] }[];
  };
  const original = Uint8Array.from(atob(accounts.value[1].data[0]), (c) =>
    c.charCodeAt(0),
  );
  const extensions = Uint8Array.from([
    ...getExtensionEncoder().encode({
      __kind: 'MetadataPointer',
      authority: address('11111111111111111111111111111111'),
      metadataAddress: address(f.mint),
    }),
    ...getExtensionEncoder().encode({
      __kind: 'TokenMetadata',
      updateAuthority: null,
      mint: address(f.mint),
      name: 'Fixture',
      symbol: 'TEST',
      uri: 'https://example.invalid/metadata',
      additionalMetadata: new Map(),
    }),
  ]);
  const bytes = new Uint8Array(166 + extensions.length);
  bytes.set(original);
  bytes[165] = 1;
  bytes.set(extensions, 166);
  accounts.value[1].data[0] = btoa(String.fromCharCode(...bytes));
  const reviewed = await prepareTokenWithdrawal(
    tokenWithdrawalInput(f.wallet, f.recipient, f.review.amount, 1, f.mint, 6),
    AbortSignal.timeout(10000),
    f.fetcher,
  );
  expect(reviewed.token!.mintExtensions).toEqual([
    'MetadataPointer',
    'TokenMetadata',
  ]);
  expect(
    withdrawalExtensions(bytes, reviewed.token!.program, true),
  ).toHaveLength(2);
  const fee = await tokenWithdrawalFixture(false, true, true);
  await expect(
    prepareTokenWithdrawal(
      tokenWithdrawalInput(
        fee.wallet,
        fee.recipient,
        '0.000001',
        1,
        fee.mint,
        6,
      ),
      AbortSignal.timeout(10000),
      fee.fetcher,
    ),
  ).rejects.toThrow('no recipient');
});
it('rechecks frozen/extended accounts, insufficient units, changed mint precision, fee and blockhash', async () => {
  for (const kind of [
    'frozen',
    'program',
    'balance',
    'decimals',
    'fee',
    'blockhash',
  ]) {
    const f = await tokenWithdrawalFixture(),
      accounts = f.data.getMultipleAccounts as {
        value: { owner: string; data: string[] }[];
      };
    if (kind === 'program')
      accounts.value[1].owner = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    if (['frozen', 'balance'].includes(kind)) {
      const bytes = Uint8Array.from(atob(accounts.value[2].data[0]), (c) =>
        c.charCodeAt(0),
      );
      if (kind === 'frozen') bytes[108] = 2;
      else new DataView(bytes.buffer).setBigUint64(64, 1n, true);
      accounts.value[2].data[0] = btoa(String.fromCharCode(...bytes));
    }
    if (kind === 'decimals') {
      const bytes = Uint8Array.from(atob(accounts.value[1].data[0]), (c) =>
        c.charCodeAt(0),
      );
      bytes[44] = 5;
      accounts.value[1].data[0] = btoa(String.fromCharCode(...bytes));
    }
    if (kind === 'fee')
      f.data.getFeeForMessage = { context: { slot: '100' }, value: '5001' };
    if (kind === 'blockhash')
      f.data.isBlockhashValid = { context: { slot: '100' }, value: false };
    await expect(
      recheckTokenWithdrawal(f.review, AbortSignal.timeout(10000), f.fetcher),
    ).rejects.toThrow();
  }
});
