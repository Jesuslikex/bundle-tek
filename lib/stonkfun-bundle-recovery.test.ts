import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { venueRecoveryFixture } from '../test/venue-launch-recovery-fixture';
import {
  actVenueLaunchRecovery as act,
  prepareVenueLaunchRecovery as prepare,
  readVenueLaunchRecovery as read,
} from './venue-launch-recovery';
import { buildStonkBundle } from './stonkfun-bundle';
import type { StonkLaunchInput } from './stonkfun-launch';
import type { StonkBundleReview } from './stonkfun-bundle-service';
import { signStonkBundlePackets } from './stonkfun-bundle-signing';
import type { VaultSession } from './browser-wallet-vault';

const signal = () => new AbortController().signal;
const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const pair = (n: number) =>
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n));
const key = (n: number) => bs58.encode(pair(n).publicKey);
const seedHex = (n: number) => Buffer.alloc(32, n).toString('hex');
type Fixture = Awaited<ReturnType<typeof venueRecoveryFixture>>;
const kept: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of kept) f.dispose();
  kept.length = 0;
});

async function bundled() {
  const f = await venueRecoveryFixture('stonkfun');
  kept.push(f);
  const holders = [
    { address: key(10), revision: 1, buyRaw: '200000000' },
    { address: key(11), revision: 2, buyRaw: '100000000' },
    { address: key(12), revision: 1, buyRaw: '50000000' },
  ];
  const sized = holders.map((h, i) => ({
    holder: h.address,
    revision: h.revision,
    buyRaw: h.buyRaw,
    minTokensOutRaw: String(990 - i),
    expectedTokensOutRaw: String(1000 - i),
    solCostLamports: '2079080',
  }));
  const built = await buildStonkBundle(f.review.input as StonkLaunchInput, {
    holders: sized.map(({ holder, buyRaw, minTokensOutRaw }) => ({
      holder,
      buyRaw,
      minTokensOutRaw,
    })),
    tipAccount: TIP,
    tipLamports: '100000',
  });
  const review: StonkBundleReview = {
    ...(f.review as StonkBundleReview),
    terms: { ...f.review.terms, holders, tipLamports: '100000' },
    bundle: {
      format: 'stonkfun-holder-bundle-v1',
      sha256: built.sha256,
      tipAccount: TIP,
      tipLamports: '100000',
      holders: sized,
      packets: built.packets,
      holdersBuyRaw: '350000000',
      holdersTokensOutRaw: '2997',
      holdersSupplyBps: 0,
      bundleSimulated: false,
    },
  };
  const sendBundle = vi.fn(
    async (_txs: string[], _s: AbortSignal): Promise<unknown> => 'bundle-id-1',
  );
  const deps = {
    ...f.deps,
    prepareStonkBundle: vi.fn(async () => structuredClone(review)),
    sendBundle,
  };
  const terms = { ...review.terms, origin: 'https://bundle.test' };
  const session = {
    payload: {
      wallets: [1, 10, 11, 12].map((n) => ({
        family: 'solana',
        address: key(n),
        seed: seedHex(n),
      })),
    },
  } as unknown as VaultSession;
  return { f, review, deps, terms, sendBundle, session };
}

async function signedRow(b: Awaited<ReturnType<typeof bundled>>) {
  const p = await prepare(
    b.f.db,
    b.f.owner,
    'stonkfun',
    b.terms,
    signal(),
    b.deps,
  );
  await act(
    b.f.db,
    b.f.owner,
    'stonkfun',
    {
      action: 'approve',
      id: p.recoveryId,
      sha256: p.sha256,
      bundleSha256: b.review.bundle.sha256,
      approved: true,
    },
    signal(),
    b.deps,
  );
  await act(
    b.f.db,
    b.f.owner,
    'stonkfun',
    { action: 'register', id: p.recoveryId, transaction: b.f.signed },
    signal(),
    b.deps,
  );
  return p;
}

describe('StonkFun holder bundle saved launch', () => {
  it('saves holder terms through the original database guards', async () => {
    const b = await bundled();
    const p = await prepare(
      b.f.db,
      b.f.owner,
      'stonkfun',
      b.terms,
      signal(),
      b.deps,
    );
    const row = await read(b.f.db, b.f.owner, 'stonkfun', p.recoveryId);
    expect(row.state).toBe('review');
    expect((row.review as StonkBundleReview).bundle.sha256).toBe(
      b.review.bundle.sha256,
    );
    expect(b.deps.prepareStonkBundle).toHaveBeenCalledOnce();
    expect(b.f.deps.prepareStonk).not.toHaveBeenCalled();
  });

  it('requires approval of the exact bundle digest', async () => {
    const b = await bundled();
    const p = await prepare(
      b.f.db,
      b.f.owner,
      'stonkfun',
      b.terms,
      signal(),
      b.deps,
    );
    for (const bundleSha256 of [undefined, 'f'.repeat(64)])
      await expect(
        act(
          b.f.db,
          b.f.owner,
          'stonkfun',
          {
            action: 'approve',
            id: p.recoveryId,
            sha256: p.sha256,
            approved: true,
            ...(bundleSha256 ? { bundleSha256 } : {}),
          },
          signal(),
          b.deps,
        ),
      ).rejects.toThrow(/exact saved holder bundle/);
    expect(
      (await read(b.f.db, b.f.owner, 'stonkfun', p.recoveryId)).state,
    ).toBe('review');
  });

  it('sends create, holders and tip once as one Jito bundle', async () => {
    const b = await bundled();
    const p = await signedRow(b);
    const packets = await signStonkBundlePackets(b.session, b.review);
    const result = await act(
      b.f.db,
      b.f.owner,
      'stonkfun',
      {
        action: 'submit',
        id: p.recoveryId,
        sha256: p.sha256,
        bundleSha256: b.review.bundle.sha256,
        bundleTransactions: packets,
        approved: true,
      },
      signal(),
      b.deps,
    );
    expect(result.state).toBe('submitted');
    expect(b.sendBundle).toHaveBeenCalledOnce();
    expect(b.sendBundle.mock.calls[0][0]).toEqual([b.f.signed, ...packets]);
    expect(
      b.f.rpc.mock.calls.filter(([m]) => m === 'sendTransaction'),
    ).toHaveLength(0);
    // A repeated submit never resends.
    await act(
      b.f.db,
      b.f.owner,
      'stonkfun',
      {
        action: 'submit',
        id: p.recoveryId,
        sha256: p.sha256,
        bundleSha256: b.review.bundle.sha256,
        bundleTransactions: packets,
        approved: true,
      },
      signal(),
      b.deps,
    );
    expect(b.sendBundle).toHaveBeenCalledOnce();
  });

  it('refuses missing or altered holder signatures before any send', async () => {
    const b = await bundled();
    const p = await signedRow(b);
    const packets = await signStonkBundlePackets(b.session, b.review);
    const wrong = (() => {
      const tx = getTransactionDecoder().decode(
        Uint8Array.from(Buffer.from(packets[0], 'base64')),
      );
      const sig = nacl.sign.detached(
        Uint8Array.from(tx.messageBytes),
        pair(3).secretKey,
      ) as SignatureBytes;
      return getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { ...tx.signatures, [address(key(10))]: sig },
        }),
      );
    })();
    for (const bundleTransactions of [
      undefined,
      packets.slice(0, 2),
      [wrong, ...packets.slice(1)],
    ])
      await expect(
        act(
          b.f.db,
          b.f.owner,
          'stonkfun',
          {
            action: 'submit',
            id: p.recoveryId,
            sha256: p.sha256,
            bundleSha256: b.review.bundle.sha256,
            approved: true,
            ...(bundleTransactions ? { bundleTransactions } : {}),
          },
          signal(),
          b.deps,
        ),
      ).rejects.toMatchObject({ status: 400 });
    expect(b.sendBundle).not.toHaveBeenCalled();
    expect(
      (await read(b.f.db, b.f.owner, 'stonkfun', p.recoveryId)).state,
    ).toBe('signed');
  });

  it('keeps an unknown Jito outcome in submitting for recovery', async () => {
    const b = await bundled();
    b.sendBundle.mockRejectedValueOnce(new Error('timeout'));
    const p = await signedRow(b);
    const packets = await signStonkBundlePackets(b.session, b.review);
    const result = await act(
      b.f.db,
      b.f.owner,
      'stonkfun',
      {
        action: 'submit',
        id: p.recoveryId,
        sha256: p.sha256,
        bundleSha256: b.review.bundle.sha256,
        bundleTransactions: packets,
        approved: true,
      },
      signal(),
      b.deps,
    );
    expect(result.state).toBe('submitting');
    expect(b.sendBundle).toHaveBeenCalledOnce();
  });

  it('refuses holder signing when a bundle wallet is not in the vault', async () => {
    const b = await bundled();
    const session = {
      payload: {
        wallets: b.session.payload.wallets.filter((w) => w.address !== key(12)),
      },
    } as unknown as VaultSession;
    await expect(signStonkBundlePackets(session, b.review)).rejects.toThrow(
      /Import bundle wallet/,
    );
  });

  it('a plain StonkFun launch rejects bundle fields', async () => {
    const f = await venueRecoveryFixture('stonkfun');
    kept.push(f);
    const p = await prepare(
      f.db,
      f.owner,
      'stonkfun',
      f.terms,
      signal(),
      f.deps,
    );
    await expect(
      act(
        f.db,
        f.owner,
        'stonkfun',
        {
          action: 'approve',
          id: p.recoveryId,
          sha256: p.sha256,
          bundleSha256: 'a'.repeat(64),
          approved: true,
        },
        signal(),
        f.deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
