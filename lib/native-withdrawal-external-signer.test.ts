import { it, expect, vi } from 'vitest';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import { tokenWithdrawalFixture } from '../test/token-withdrawal-fixture';
import {
  signExternalNativeWithdrawal,
  supportsNativeWithdrawalWallet,
  type NativeWithdrawalExternalWallet,
} from './native-withdrawal-external-signer';
import bs58 from 'bs58';
function wallet(
  address: string,
  sign: () => Promise<readonly { signedTransaction: Uint8Array }[]>,
) {
  const account = {
    address,
    publicKey: bs58.decode(address),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
  };
  return {
    name: 'Fixture',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy'],
        signTransaction: sign,
      },
      'standard:connect': { version: '1.0.0', connect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
    },
  } as unknown as NativeWithdrawalExternalWallet;
}
it('does not invoke the external withdrawal signer if the optional owner fence fails', async () => {
  const f = await nativeWithdrawalFixture();
  const sign = vi.fn(async () => [
    {
      signedTransaction: Uint8Array.from(atob(f.signed.transaction), (c) =>
        c.charCodeAt(0),
      ),
    },
  ]);
  const beforeSign = vi.fn(async (): Promise<void> => {
    throw Error('fence');
  });
  const onSignerStart = vi.fn();
  const register = vi.fn(async () => {});
  await expect(
    signExternalNativeWithdrawal(
      wallet(f.wallet, sign),
      f.review,
      () => {},
      register,
      { beforeSign, onSignerStart },
    ),
  ).rejects.toThrow('fence');
  expect(onSignerStart).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  beforeSign.mockResolvedValue();
  await signExternalNativeWithdrawal(
    wallet(f.wallet, sign),
    f.review,
    () => {},
    register,
    { beforeSign, onSignerStart },
  );
  expect(onSignerStart).toHaveBeenCalledOnce();
  expect(sign).toHaveBeenCalledOnce();
  expect(onSignerStart.mock.invocationCallOrder[0]).toBeLessThan(
    sign.mock.invocationCallOrder[0],
  );
});
it('refuses external withdrawal metadata changed during the async owner fence', async () => {
  const f = await nativeWithdrawalFixture();
  const sign = vi.fn(async () => []);
  const onSignerStart = vi.fn();
  await expect(
    signExternalNativeWithdrawal(
      wallet(f.wallet, sign),
      f.review,
      () => {},
      async () => {},
      {
        beforeSign: async () => {
          f.review.expiresAt = new Date(
            Date.parse(f.review.expiresAt) + 1000,
          ).toISOString();
        },
        onSignerStart,
      },
    ),
  ).rejects.toThrow();
  expect(onSignerStart).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});
it.each([false, true])(
  'does not introduce a pre-prompt rejection for a rebuilt feature wrapper with a stable signer, hooks=%s',
  async (useHooks) => {
    const f = await nativeWithdrawalFixture();
    const sign = vi.fn(async () => [
      {
        signedTransaction: Uint8Array.from(atob(f.signed.transaction), (c) =>
          c.charCodeAt(0),
        ),
      },
    ]);
    const w = wallet(f.wallet, sign),
      features = w.features;
    Object.defineProperty(w, 'features', {
      get: () => ({
        ...features,
        'solana:signTransaction': {
          ...(features['solana:signTransaction'] as object),
        },
      }),
    });
    const retain = vi.fn(async () => {}),
      onSignerStart = vi.fn();
    await expect(
      signExternalNativeWithdrawal(
        w,
        f.review,
        () => {},
        retain,
        useHooks ? { beforeSign: async () => {}, onSignerStart } : undefined,
      ),
    ).rejects.toThrow('Wallet changed after signing');
    expect(sign).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledOnce();
    expect(onSignerStart).toHaveBeenCalledTimes(useHooks ? 1 : 0);
  },
);
it.each([false, true])(
  'uses legacy mainnet sign-only and retains returned signatures before account-change checks with Token-2022 fee=%s',
  async (fee) => {
    const f = fee
      ? await tokenWithdrawalFixture(false, true, true)
      : await nativeWithdrawalFixture();
    let changed = false;
    const sign = vi.fn(async () => {
        changed = true;
        return [
          {
            signedTransaction: Uint8Array.from(
              atob(f.signed.transaction),
              (c) => c.charCodeAt(0),
            ),
          },
        ];
      }),
      register = vi.fn(async () => {}),
      w = wallet(f.wallet, sign);
    expect(supportsNativeWithdrawalWallet(w)).toBe(true);
    await expect(
      signExternalNativeWithdrawal(
        w,
        f.review,
        () => {
          if (changed) throw new Error('changed');
        },
        register,
      ),
    ).rejects.toThrow('changed');
    expect(register).toHaveBeenCalledExactlyOnceWith(f.signed);
    expect(sign.mock.calls).toHaveLength(1);
  },
);
it('does not register modified packets or retry ambiguous signing failures', async () => {
  const f = await nativeWithdrawalFixture(),
    register = vi.fn(async () => {}),
    bytes = Uint8Array.from(atob(f.signed.transaction), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  await expect(
    signExternalNativeWithdrawal(
      wallet(f.wallet, async () => [{ signedTransaction: bytes }]),
      f.review,
      () => {},
      register,
    ),
  ).rejects.toThrow();
  expect(register).not.toHaveBeenCalled();
  const sign = vi.fn(async () => {
    throw new Error('timeout');
  });
  await expect(
    signExternalNativeWithdrawal(
      wallet(f.wallet, sign),
      f.review,
      () => {},
      register,
    ),
  ).rejects.toThrow('unknown');
  expect(sign).toHaveBeenCalledTimes(1);
  expect(register).not.toHaveBeenCalled();
});
