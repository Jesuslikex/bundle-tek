import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from './warmup-signing';
import {
  connectWarmupExternalWallet,
  matchingWarmupExternalAccount,
  onWarmupExternalWalletChange,
  signApprovedExternalWarmupPacket,
  supportsWarmupExternalWallet,
  type WarmupExternalWallet,
} from './warmup-external-signer';
import { WalletSigningRejected } from './wallet-signing-rejection';

async function fixture(side: 'Buy' | 'Sell' = 'Buy') {
  const f = await nativeWarmupFixture({ side, v2: true, fee: 2, lookup: true });
  const review: WarmupSigningReview = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: f.wallet,
    sha256: f.order.preparation.sha256,
    transaction: f.order.preparation.transaction,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    network: 'mainnet',
    maximumFeeLamports: '5000',
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    lastValidBlockHeight: '1000',
    settlement: await requireWarmupSigningReview(f.order, f.simulation),
    platformFee: f.order.platformFee,
  };
  const account = {
    address: f.wallet,
    publicKey: bs58.decode(f.wallet),
    chains: ['solana:mainnet'] as const,
    features: ['solana:signTransaction'] as const,
  };
  const bytes = Uint8Array.from(atob(f.signed.transaction), (c) =>
    c.charCodeAt(0),
  );
  const sign = vi.fn(async (..._inputs: unknown[]) => [
    { signedTransaction: bytes },
  ]);
  const connect = vi.fn(async () => ({ accounts: [account] }));
  const on = vi.fn((_event: string, _listener: () => void) => () => {});
  const wallet = {
    version: '1.0.0' as const,
    name: 'Fixture wallet',
    icon: 'data:image/png;base64,' as const,
    chains: ['solana:mainnet'] as const,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect },
      'standard:events': { version: '1.0.0', on },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: [0],
        signTransaction: sign,
      },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: vi.fn(() => {
          throw new Error('must not send');
        }),
      },
    },
  };
  return { f, review, account, wallet, sign, connect, on, bytes };
}
it('does not invoke the external signer if the optional owner fence fails', async () => {
  const f = await fixture();
  const beforeSign = vi.fn(async (): Promise<void> => {
    throw Error('fence');
  });
  const onSignerStart = vi.fn();
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}, undefined, {
      beforeSign,
      onSignerStart,
    }),
  ).rejects.toThrow('fence');
  expect(onSignerStart).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
  beforeSign.mockResolvedValue();
  await signApprovedExternalWarmupPacket(
    f.wallet,
    f.review,
    () => {},
    undefined,
    { beforeSign, onSignerStart },
  );
  expect(onSignerStart).toHaveBeenCalledOnce();
  expect(f.sign).toHaveBeenCalledOnce();
  expect(onSignerStart.mock.invocationCallOrder[0]).toBeLessThan(
    f.sign.mock.invocationCallOrder[0],
  );
});
it('refuses external warmup review metadata changed during the async owner fence', async () => {
  const f = await fixture();
  const onSignerStart = vi.fn();
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}, undefined, {
      beforeSign: async () => {
        f.review.expiresAt = new Date(
          Date.parse(f.review.expiresAt) + 1000,
        ).toISOString();
      },
      onSignerStart,
    }),
  ).rejects.toThrow();
  expect(onSignerStart).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
});
it.each(['Buy', 'Sell'] as const)(
  'signs the exact reviewed native %s route with Wallet Standard mainnet signing only',
  async (side) => {
    const f = await fixture(side);
    await connectWarmupExternalWallet(f.wallet, f.review.wallet);
    expect(f.connect).toHaveBeenCalledOnce();
    const current = vi.fn();
    const packet = await signApprovedExternalWarmupPacket(
      f.wallet,
      f.review,
      current,
    );
    expect(packet).toEqual(f.f.signed);
    expect(current.mock.calls.length).toBeGreaterThan(1);
    expect(f.sign).toHaveBeenCalledOnce();
    expect(f.sign.mock.calls[0][0]).toMatchObject({
      account: f.account,
      chain: 'solana:mainnet',
    });
    expect(
      f.wallet.features['solana:signAndSendTransaction'].signAndSendTransaction,
    ).not.toHaveBeenCalled();
    f.bytes.fill(0);
    expect(packet.transaction).toBe(f.f.signed.transaction);
  },
);
it('checks connected address, public key, chain and account signing feature', async () => {
  const f = await fixture();
  expect(matchingWarmupExternalAccount(f.wallet, f.review.wallet)).toBe(
    f.account,
  );
  for (const account of [
    { ...f.account, address: bs58.encode(new Uint8Array(32).fill(3)) },
    { ...f.account, publicKey: new Uint8Array(32).fill(3) },
    { ...f.account, chains: ['solana:devnet'] },
    { ...f.account, features: ['solana:signAndSendTransaction'] },
  ]) {
    const wallet = { ...f.wallet, accounts: [account] } as WarmupExternalWallet;
    expect(
      matchingWarmupExternalAccount(wallet, f.review.wallet),
    ).toBeUndefined();
    await expect(
      connectWarmupExternalWallet(wallet, f.review.wallet),
    ).rejects.toThrow('exact wallet');
    await expect(
      signApprovedExternalWarmupPacket(wallet, f.review, () => {}),
    ).rejects.toThrow('differs');
  }
  expect(f.sign).not.toHaveBeenCalled();
});
it('rejects devnet-only, legacy-only, send-only and wallets without change events', async () => {
  const f = await fixture();
  const { ['solana:signTransaction']: _sign, ...sendOnly } = f.wallet.features;
  const { ['standard:events']: _events, ...noEvents } = f.wallet.features;
  const candidates = [
    { ...f.wallet, chains: ['solana:devnet'] },
    { ...f.wallet, features: sendOnly },
    { ...f.wallet, features: noEvents },
    {
      ...f.wallet,
      features: {
        ...f.wallet.features,
        'solana:signTransaction': {
          ...f.wallet.features['solana:signTransaction'],
          supportedTransactionVersions: ['legacy'],
        },
      },
    },
  ];
  for (const wallet of candidates as WarmupExternalWallet[]) {
    expect(supportsWarmupExternalWallet(wallet)).toBe(false);
    await expect(
      signApprovedExternalWarmupPacket(wallet, f.review, () => {}),
    ).rejects.toThrow('must support');
  }
  expect(f.sign).not.toHaveBeenCalled();
});
it('rejects changed packet hashes, signer identities, expired reviews and superseded approval before requesting a signature', async () => {
  const f = await fixture();
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { expiresAt: new Date(0).toISOString() },
    { network: 'devnet' },
  ])
    await expect(
      signApprovedExternalWarmupPacket(
        f.wallet,
        { ...f.review, ...patch } as WarmupSigningReview,
        () => {},
      ),
    ).rejects.toThrow();
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {
      throw new Error('superseded');
    }),
  ).rejects.toThrow('superseded');
  expect(f.sign).not.toHaveBeenCalled();
});
it.each(['message', 'signature', 'trailing', 'empty', 'multiple'] as const)(
  'rejects wallet output with %s changes',
  async (kind) => {
    const f = await fixture();
    const bytes = Uint8Array.from(f.bytes);
    if (kind === 'message') bytes[bytes.length - 1] ^= 1;
    if (kind === 'signature') bytes[1] ^= 1;
    f.sign.mockImplementation(async () =>
      kind === 'empty'
        ? []
        : kind === 'multiple'
          ? [{ signedTransaction: bytes }, { signedTransaction: bytes }]
          : [
              {
                signedTransaction:
                  kind === 'trailing' ? Uint8Array.from([...bytes, 0]) : bytes,
              },
            ],
    );
    await expect(
      signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}),
    ).rejects.toThrow();
  },
);
it.each(['account', 'feature', 'expiry', 'scope'] as const)(
  'withholds returned signatures when %s changes during the wallet prompt',
  async (kind) => {
    const f = await fixture();
    let current = true;
    f.sign.mockImplementation(async () => {
      if (kind === 'account') f.wallet.accounts = [{ ...f.account }];
      if (kind === 'feature')
        f.wallet.features['solana:signTransaction'] = {
          ...f.wallet.features['solana:signTransaction'],
          signTransaction: vi.fn(async (...args: Parameters<typeof f.sign>) =>
            f.sign(...args),
          ),
        };
      if (kind === 'expiry') f.review.expiresAt = new Date(0).toISOString();
      if (kind === 'scope') current = false;
      return [{ signedTransaction: f.bytes }];
    });
    await expect(
      signApprovedExternalWarmupPacket(f.wallet, f.review, () => {
        if (!current) throw new Error('superseded');
      }),
    ).rejects.toThrow();
  },
);
it('retains explicit rejection and contains untrusted extension error text', async () => {
  const f = await fixture();
  f.sign.mockRejectedValueOnce({ code: 4001 });
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}),
  ).rejects.toBeInstanceOf(WalletSigningRejected);
  f.sign.mockRejectedValueOnce(
    new Error('secret untrusted extension response'),
  );
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}),
  ).rejects.toThrow('Wallet signing did not complete');
});
it.each(['account', 'feature', 'expiry', 'scope'] as const)(
  'retains the verified packet for Jito recovery before rejecting a changed %s',
  async (kind) => {
    const f = await fixture();
    let current = true;
    f.sign.mockImplementation(async () => {
      if (kind === 'account') f.wallet.accounts = [{ ...f.account }];
      if (kind === 'feature')
        f.wallet.features['solana:signTransaction'] = {
          ...f.wallet.features['solana:signTransaction'],
          signTransaction: vi.fn(async (...args: Parameters<typeof f.sign>) =>
            f.sign(...args),
          ),
        };
      if (kind === 'expiry') f.review.expiresAt = new Date(0).toISOString();
      if (kind === 'scope') current = false;
      return [{ signedTransaction: f.bytes }];
    });
    const retain = vi.fn(async () => {});
    await expect(
      signApprovedExternalWarmupPacket(
        f.wallet,
        f.review,
        () => {
          if (!current) throw new Error('superseded');
        },
        retain,
      ),
    ).rejects.toThrow();
    expect(retain).toHaveBeenCalledExactlyOnceWith(f.f.signed);
    expect(f.sign).toHaveBeenCalledOnce();
    expect(
      f.wallet.features['solana:signAndSendTransaction'].signAndSendTransaction,
    ).not.toHaveBeenCalled();
  },
);
it.each(['message', 'signature'] as const)(
  'does not retain a changed %s even when the approval expires during signing',
  async (kind) => {
    const f = await fixture();
    f.sign.mockImplementation(async () => {
      f.review.expiresAt = new Date(0).toISOString();
      const bytes = Uint8Array.from(f.bytes);
      bytes[kind === 'message' ? bytes.length - 1 : 1] ^= 1;
      return [{ signedTransaction: bytes }];
    });
    const retain = vi.fn(async () => {});
    await expect(
      signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}, retain),
    ).rejects.toThrow();
    expect(retain).not.toHaveBeenCalled();
  },
);
it('does not request a second signature when retention fails', async () => {
  const f = await fixture();
  const retain = vi.fn(async () => {
    throw new Error('Registration unavailable');
  });
  await expect(
    signApprovedExternalWarmupPacket(f.wallet, f.review, () => {}, retain),
  ).rejects.toThrow('Registration unavailable');
  expect(retain).toHaveBeenCalledExactlyOnceWith(f.f.signed);
  expect(f.sign).toHaveBeenCalledOnce();
});
it('subscribes to account changes and returns the wallet cleanup callback', async () => {
  const f = await fixture(),
    changed = vi.fn(),
    cleanup = vi.fn();
  f.on.mockReturnValue(cleanup);
  const unsubscribe = onWarmupExternalWalletChange(f.wallet, changed);
  expect(f.on).toHaveBeenCalledWith('change', changed);
  f.on.mock.calls[0][1]();
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  expect(cleanup).toHaveBeenCalledOnce();
});
