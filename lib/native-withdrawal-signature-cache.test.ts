import { expect, it } from 'vitest';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import {
  retainNativeWithdrawalSignature,
  restoreNativeWithdrawalSignature,
  clearNativeWithdrawalSignature,
} from './native-withdrawal-signature-cache';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
it('retains only a public signature and reconstructs the same signed packet after registration timeout', async () => {
  const f = await nativeWithdrawalFixture(),
    tab = storage();
  expect(await restoreNativeWithdrawalSignature(f.review, tab)).toBeNull();
  await retainNativeWithdrawalSignature(f.review, f.signed, tab);
  const value = JSON.parse([...tab.values.values()][0]);
  expect(Object.keys(value).sort()).toEqual(['sha256', 'signature', 'wallet']);
  expect(await restoreNativeWithdrawalSignature(f.review, tab)).toEqual(
    f.signed,
  );
  clearNativeWithdrawalSignature(f.review, tab);
  expect(await restoreNativeWithdrawalSignature(f.review, tab)).toBeNull();
});
it('rejects changed packet context and forged returned signatures without replacing retained evidence', async () => {
  const f = await nativeWithdrawalFixture(),
    tab = storage();
  await retainNativeWithdrawalSignature(f.review, f.signed, tab);
  await expect(
    restoreNativeWithdrawalSignature(
      { ...f.review, sha256: '0'.repeat(64) },
      tab,
    ),
  ).rejects.toThrow('context');
  await expect(
    retainNativeWithdrawalSignature(
      f.review,
      { ...f.signed, signature: '1'.repeat(64) },
      tab,
    ),
  ).rejects.toThrow('differs');
  expect(await restoreNativeWithdrawalSignature(f.review, tab)).toEqual(
    f.signed,
  );
  const key = [...tab.values.keys()][0];
  tab.setItem(
    key,
    JSON.stringify({
      wallet: f.wallet,
      sha256: f.review.sha256,
      signature: '1'.repeat(64),
    }),
  );
  await expect(
    restoreNativeWithdrawalSignature(f.review, tab),
  ).rejects.toThrow();
});
it('does not turn durable registration into failure when tab storage cleanup is unavailable', async () => {
  const f = await nativeWithdrawalFixture();
  expect(() =>
    clearNativeWithdrawalSignature(f.review, {
      ...storage(),
      removeItem() {
        throw new Error('storage unavailable');
      },
    }),
  ).not.toThrow();
});
it.each([false, true])(
  'restores a checked token signature with its exact mint, precision and ATA creation packet with Token-2022 fee=%s',
  async (fee) => {
    const f = await tokenWithdrawalFixture(false, fee, fee),
      tab = storage();
    await retainNativeWithdrawalSignature(f.review, f.signed, tab);
    expect(await restoreNativeWithdrawalSignature(f.review, tab)).toEqual(
      f.signed,
    );
    await expect(
      restoreNativeWithdrawalSignature(
        {
          ...f.review,
          token: {
            ...f.review.token!,
            createAccount: false,
            accountRentLamports: '0',
          },
        },
        tab,
      ),
    ).rejects.toThrow();
  },
);
