import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { volumeCleanupExclusionFixture } from '../../../../test/volume-cleanup-exclusion-fixture';
import { cleanupFixture } from '../../../../test/wallet-cleanup-fixture';
import {
  signWalletCleanupBatch,
  decode,
  isCleanupSell,
  type WalletCleanup,
} from '@/lib/wallet-cleanup';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'storage-owner' }),
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      actual.balanceRpc(args[0], args[1], args[2], args[3], mocks.fetcher),
  };
});
import { POST } from './route';
import { markVolumeBundleAttempted } from '@/lib/volume-bundle-reservations';

let f: Awaited<ReturnType<typeof volumeCleanupExclusionFixture>>;
let clean: ReturnType<typeof cleanupFixture>,
  other: ReturnType<typeof cleanupFixture>;
let sends: string[], realFetch: ReturnType<typeof vi.fn>;
let finalizedReceipt: unknown;
beforeEach(async () => {
  f = await volumeCleanupExclusionFixture(137);
  mocks.db = f.db;
  clean = cleanupFixture(71);
  other = cleanupFixture(73);
  sends = [];
  finalizedReceipt = null;
  expect(f.review.wallet).toBe(clean.wallet);
  for (const wallet of [clean.destination, other.wallet])
    f.sqlite
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at) VALUES(?,'Solana',?,'','Synthetic','trading',?)",
      )
      .run(f.owner, wallet, new Date().toISOString());
  mocks.fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.method === 'getTransaction')
      return Response.json({ jsonrpc: '2.0', id: 1, result: finalizedReceipt });
    if (body.method === 'sendTransaction') {
      sends.push(body.params[0]);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: bs58.encode(decode(body.params[0]).slice(1, 65)),
      });
    }
    const source = JSON.stringify(body.params).includes(other.wallet)
      ? other
      : clean;
    return source.fetcher(url, init);
  }) as typeof fetch;
  realFetch = vi.fn(async () => {
    throw Error('Real fetch is forbidden in this test');
  });
  vi.stubGlobal('fetch', realFetch);
});
afterEach(() => {
  f?.sqlite.close();
  vi.unstubAllGlobals();
});
const post = (body: object) =>
  POST(
    new Request('https://bundle.test/api/wallet-workspace/cleanup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    }),
  );
const prepare = (multiple = false) =>
  post({
    action: 'prepare',
    destination: clean.destination,
    wallets: [
      { address: clean.wallet, revision: 1 },
      ...(multiple ? [{ address: other.wallet, revision: 1 }] : []),
    ],
  });
const upgrade = () =>
  f.sqlite.exec(
    readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
  );

it('refuses the real multi-wallet signing claim atomically under a legacy bundle conflict', async () => {
  const response = await prepare(true);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    batchId: string;
    cleanups: WalletCleanup[];
    errors: unknown[];
  };
  expect(body.errors).toEqual([]);
  expect(body.cleanups).toHaveLength(2);
  await f.reserve();
  upgrade();
  const claim = await post({ action: 'begin_signing', batchId: body.batchId });
  expect(claim.status).toBe(409);
  expect(((await claim.json()) as { error: string }).error).toContain(
    'already reserved',
  );
  expect(
    f.sqlite.prepare('SELECT state FROM wallet_cleanups ORDER BY id').all(),
  ).toEqual([{ state: 'awaiting_signature' }, { state: 'awaiting_signature' }]);
  expect(sends).toEqual([]);
  expect(realFetch).not.toHaveBeenCalled();
});

it.each([false, true])(
  'cleanup submission with migration applied=%s distinguishes the fake-send control from the exact guarded refusal',
  async (apply) => {
    const response = await prepare();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      batchId: string;
      cleanups: WalletCleanup[];
    };
    const row = body.cleanups[0];
    expect(
      (await post({ action: 'begin_signing', batchId: body.batchId })).status,
    ).toBe(200);
    const [signed] = await signWalletCleanupBatch(
      await clean.session(clean.owner),
      [row.document],
      () => {},
    );
    expect(
      (
        await post({
          action: 'register',
          id: row.id,
          transaction: signed.transaction,
        })
      ).status,
    ).toBe(200);
    await f.reserve();
    if (apply) upgrade();
    const submit = await post({
      action: 'submit',
      id: row.id,
      transaction: signed.transaction,
    });
    if (apply) {
      expect(submit.status).toBe(409);
      expect(((await submit.json()) as { error: string }).error).toContain(
        'already reserved',
      );
      expect(sends).toEqual([]);
      expect(
        f.sqlite.prepare('SELECT state,signature FROM wallet_cleanups').get(),
      ).toEqual({ state: 'signed', signature: signed.signature });
    } else {
      expect(submit.status).toBe(200);
      expect(sends).toEqual([signed.transaction]);
    }
    expect(realFetch).not.toHaveBeenCalled();
  },
);

it('recovers the exact finalized cleanup receipt under a legacy held bundle, then admits its attempt marker', async () => {
  const response = await prepare();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    batchId: string;
    cleanups: WalletCleanup[];
  };
  const row = body.cleanups[0];
  expect(
    (await post({ action: 'begin_signing', batchId: body.batchId })).status,
  ).toBe(200);
  const [signed] = await signWalletCleanupBatch(
    await clean.session(clean.owner),
    [row.document],
    () => {},
  );
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(200);
  await f.reserve();
  upgrade();
  const attempt = crypto.randomUUID();
  await expect(
    markVolumeBundleAttempted(f.db, f.owner, f.request.id, attempt),
  ).rejects.toThrow();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(409);
  expect(f.sqlite.prepare('SELECT state FROM wallet_cleanups').get()).toEqual({
    state: 'signed',
  });
  if (isCleanupSell(row.document))
    throw Error('Expected native cleanup fixture');
  finalizedReceipt = clean.receipt(row.document, signed.transaction);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(f.sqlite.prepare('SELECT state FROM wallet_cleanups').get()).toEqual({
    state: 'finalized',
  });
  expect(
    await markVolumeBundleAttempted(f.db, f.owner, f.request.id, attempt),
  ).toMatchObject({
    state: 'attempted',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(sends).toEqual([]);
  expect(realFetch).not.toHaveBeenCalled();
});
