import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
  rpc: vi.fn(),
  holdings: vi.fn(),
  transaction: vi.fn(),
  signatures: vi.fn(),
  evm: vi.fn(),
  evmHoldings: vi.fn(),
  evmTransaction: vi.fn(),
  transferIdentities: vi.fn(),
  discovery: vi.fn(),
}));
vi.mock('@/lib/evm-transaction-discovery', async (original) => ({
  ...(await original<typeof import('@/lib/evm-transaction-discovery')>()),
  discoverEvmTransactions: mocks.discovery,
}));
vi.mock('@/lib/evm-transfer-identity', async (original) => ({
  ...(await original<typeof import('@/lib/evm-transfer-identity')>()),
  observeTransferIdentities: mocks.transferIdentities,
}));
vi.mock('@/lib/tracked-evm-transaction', async (original) => ({
  ...(await original<typeof import('@/lib/tracked-evm-transaction')>()),
  observeEvmTransaction: mocks.evmTransaction,
}));
vi.mock('@/lib/evm-holdings', async (original) => ({
  ...(await original<typeof import('@/lib/evm-holdings')>()),
  observeEvmHoldings: mocks.evmHoldings,
}));
vi.mock('@/lib/wallet-warmup-history', () => ({
  observeWarmupHistory: mocks.evm,
}));
vi.mock('@/lib/tracked-signatures', async (original) => ({
  ...(await original<typeof import('@/lib/tracked-signatures')>()),
  observeSignaturePage: mocks.signatures,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/tracked-wallet-transaction', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/tracked-wallet-transaction')
  >()),
  observeTrackedTransaction: mocks.transaction,
}));
vi.mock('@/lib/wallet-holdings', () => ({
  observeWalletHoldings: mocks.holdings,
}));
vi.mock('@/lib/solana-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solana-rpc')>()),
  getSolanaRpcEndpoint: (network: string) => network,
  rpcCall: mocks.rpc,
}));
import { GET, POST } from './route';
import {
  GET as savedDiscovery,
  POST as scanDiscovery,
} from './evm-discovery/route';
import {
  GET as savedEvmTransactions,
  POST as refreshEvmTransaction,
} from './evm-transactions/route';
import { GET as savedEvm, POST as refreshEvm } from './evm/route';
import {
  GET as savedEvmHoldings,
  POST as refreshEvmHoldings,
} from './evm-holdings/route';
import {
  GET as retainedSignatures,
  POST as saveSignatures,
} from './signatures/saved/route';
import { GET as signaturePage } from './signatures/route';
import { GET as observe } from './observe/route';
import { GET as inspectTransaction } from './transaction/route';
import {
  GET as savedTransactions,
  POST as saveTransaction,
} from './transactions/route';
import {
  GET as retainedHoldings,
  POST as refreshHoldings,
} from './holdings/route';
import type { HoldingsSnapshot } from '@/lib/wallet-holdings';
import { validateWalletBatch } from '@/lib/tracked-wallet';
import type { TrackedWallet, WalletObservation } from '@/lib/tracked-wallet';

let mf: Miniflare;
const saveObserved = (
  entry: TrackedWallet,
  signature = inspectSignature,
  headers = {},
) =>
  saveTransaction(
    new Request('http://localhost/api/tracker/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
        signature,
      }),
    }),
  );
const savedList = (entry: TrackedWallet, extra = {}) =>
  savedTransactions(
    new Request(
      'http://localhost/api/tracker/transactions?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
          ...extra,
        }),
    ),
  );
const observedTx = (
  entry: TrackedWallet,
  signature = inspectSignature,
  patch = {},
) => ({
  address: entry.address,
  network: entry.network,
  signature,
  slot: 300,
  failed: false,
  feeRaw: '5000',
  nativeChangeRaw: '-1',
  tokenChanges: [],
  tokensComplete: true,
  observedAt: '2026-10-10T15:00:00.000Z',
  ...patch,
});
describe('retained tracked transaction observations', () => {
  it('retains exact public evidence, opens it without RPC and keeps it through archive', async () => {
    await add();
    let entry = (await list())[0];
    const tx = observedTx(entry, inspectSignature, {
      nativeChangeRaw: '-9007199254740993',
    });
    mocks.transaction.mockResolvedValue(tx);
    expect((await saveObserved(entry)).status).toBe(200);
    expect((await saveObserved(entry)).status).toBe(200);
    mocks.transaction.mockClear();
    expect(await (await savedList(entry)).json()).toMatchObject({
      items: [
        {
          signature: inspectSignature,
          nativeChangeRaw: '-9007199254740993',
          stale: false,
        },
      ],
      nextCursor: null,
    });
    expect(
      await (await savedList(entry, { signature: inspectSignature })).json(),
    ).toMatchObject({ transaction: tx, stale: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await write({
      ...entry,
      action: 'archive',
      expectedUpdatedAt: entry.updatedAt,
    });
    entry = (await list())[0];
    expect(
      await (await savedList(entry, { signature: inspectSignature })).json(),
    ).toMatchObject({ transaction: tx, stale: true });
  });
  it('isolates owners and networks and validates JSON, origin, cursors and versions before RPC', async () => {
    await add();
    const entry = (await list())[0];
    expect(
      (
        await saveObserved(entry, inspectSignature, {
          origin: 'https://other.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await saveObserved(entry, inspectSignature, {
          'content-type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect((await saveObserved(entry, 'bad')).status).toBe(400);
    expect((await savedList(entry, { cursor: '{bad' })).status).toBe(400);
    expect(
      (
        await savedList(entry, {
          cursor: JSON.stringify({
            observedAt: '2026-02-30T00:00:00.000Z',
            signature: inspectSignature,
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await savedList(entry, {
          signature: inspectSignature,
          cursor: JSON.stringify({
            observedAt: '2026-10-10T15:00:00.000Z',
            signature: inspectSignature,
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await savedList(entry, {
          expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(409);
    expect((await savedList(entry, { network: 'devnet' })).status).toBe(404);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await savedList(entry)).status).toBe(404);
    expect((await saveObserved(entry)).status).toBe(404);
    mocks.user = null;
    expect((await savedList(entry)).status).toBe(401);
    expect((await saveObserved(entry)).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['edit', 'archive'])(
    'cannot save through an in-flight wallet %s',
    async (action) => {
      await add();
      const entry = (await list())[0];
      mocks.transaction.mockImplementation(async () => {
        await write({
          ...entry,
          action,
          label: 'Changed',
          expectedUpdatedAt: entry.updatedAt,
        });
        return observedTx(entry);
      });
      expect((await saveObserved(entry)).status).toBe(409);
      expect(await (await savedList((await list())[0])).json()).toMatchObject({
        items: [],
      });
    },
  );
  it('retains prior evidence on provider failure, missing history, older reads or changed confirmation slots', async () => {
    await add();
    const entry = (await list())[0];
    const original = observedTx(entry);
    mocks.transaction.mockResolvedValueOnce(original);
    expect((await saveObserved(entry)).status).toBe(200);
    mocks.transaction.mockRejectedValueOnce(new Error('private-provider-key'));
    const failed = await saveObserved(entry);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('private-provider-key');
    mocks.transaction.mockResolvedValueOnce(null);
    expect((await saveObserved(entry)).status).toBe(404);
    mocks.transaction.mockResolvedValueOnce(
      observedTx(entry, inspectSignature, { slot: 301 }),
    );
    expect((await saveObserved(entry)).status).toBe(409);
    mocks.transaction.mockResolvedValueOnce(
      observedTx(entry, inspectSignature, {
        observedAt: '2026-10-09T15:00:00.000Z',
      }),
    );
    expect((await saveObserved(entry)).status).toBe(409);
    expect(
      await (await savedList(entry, { signature: inspectSignature })).json(),
    ).toMatchObject({ transaction: original });
  });
  it('pages tied observation times without leaking full documents or conflating unavailable token metadata with zero', async () => {
    await add();
    const entry = (await list())[0];
    for (let n = 1; n <= 23; n++) {
      const signature = bs58.encode(new Uint8Array(64).fill(n));
      mocks.transaction.mockResolvedValueOnce(
        observedTx(entry, signature, {
          tokensComplete: false,
          programs: ['private-document-test-marker'],
        }),
      );
      expect((await saveObserved(entry, signature)).status).toBe(200);
    }
    const first = (await (await savedList(entry)).json()) as {
      items: { signature: string; tokensComplete: boolean }[];
      nextCursor: string;
    };
    expect(first.items).toHaveLength(20);
    expect(first.items.every((i) => !i.tokensComplete)).toBe(true);
    expect(JSON.stringify(first)).not.toContain('private-document-test-marker');
    const last = (await (
      await savedList(entry, { cursor: first.nextCursor })
    ).json()) as { items: { signature: string }[]; nextCursor: null };
    expect(last.items).toHaveLength(3);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...last.items].map((i) => i.signature)).size,
    ).toBe(23);
  });
});
const inspectSignature = bs58.encode(new Uint8Array(64).fill(1));
const inspect = (entry: TrackedWallet, extra = {}) =>
  inspectTransaction(
    new Request(
      'http://localhost/api/tracker/transaction?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          signature: inspectSignature,
          expectedUpdatedAt: entry.updatedAt,
          ...extra,
        }),
    ),
  );
describe('owner-scoped tracked transaction inspection', () => {
  it('admits the current owned wallet on either network, including archived records', async () => {
    await add([{ ...wallet(), network: 'devnet' }]);
    let entry = (await list())[0];
    mocks.transaction.mockResolvedValue({
      address: entry.address,
      network: 'devnet',
      signature: inspectSignature,
    });
    expect((await inspect(entry)).status).toBe(200);
    expect(mocks.transaction.mock.calls[0].slice(0, 3)).toEqual([
      entry.address,
      'devnet',
      inspectSignature,
    ]);
    await write({
      ...entry,
      action: 'archive',
      expectedUpdatedAt: entry.updatedAt,
    });
    entry = (await list())[0];
    expect((await inspect(entry)).status).toBe(200);
  });
  it('requires owner authorization and canonical wallet/signature/version input before RPC', async () => {
    await add();
    const entry = (await list())[0];
    expect((await inspect(entry, { signature: '2'.repeat(64) })).status).toBe(
      400,
    );
    expect((await inspect(entry, { network: 'invalid' })).status).toBe(400);
    expect(
      (await inspect(entry, { expectedUpdatedAt: '2026-02-30T00:00:00.000Z' }))
        .status,
    ).toBe(400);
    expect(
      (await inspect(entry, { expectedUpdatedAt: '2025-01-01T00:00:00.000Z' }))
        .status,
    ).toBe(409);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await inspect(entry)).status).toBe(404);
    mocks.user = null;
    const response = await inspect(entry);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['edit', 'archive'])(
    'rejects %s while a provider read is in flight',
    async (action) => {
      await add();
      const entry = (await list())[0];
      mocks.transaction.mockImplementation(async () => {
        await write({
          ...entry,
          label: 'Changed',
          action,
          expectedUpdatedAt: entry.updatedAt,
        });
        return { signature: inspectSignature };
      });
      expect((await inspect(entry)).status).toBe(409);
    },
  );
  it('reports missing history separately and sanitizes provider failures', async () => {
    await add();
    const entry = (await list())[0];
    mocks.transaction.mockResolvedValueOnce(null);
    expect((await inspect(entry)).status).toBe(404);
    mocks.transaction.mockRejectedValueOnce(new Error('provider-key-secret'));
    const response = await inspect(entry);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
  });
});
const getHoldings = (entry: { address: string; network: string }) =>
  retainedHoldings(
    new Request(
      `http://localhost/api/tracker/holdings?${new URLSearchParams({ address: entry.address, network: entry.network })}`,
    ),
  );
const postHoldings = (entry: TrackedWallet, extra = {}, headers = {}) =>
  refreshHoldings(
    new Request('http://localhost/api/tracker/holdings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
        ...extra,
      }),
    }),
  );
const tokenSnapshot = (address: string, slot = 200): HoldingsSnapshot => ({
  address,
  chain: 'Solana',
  commitment: 'confirmed',
  source: 'example.test',
  observedAt: '2026-10-10T15:00:00.000Z',
  minSlot: slot,
  maxSlot: slot + 1,
  accountCount: 1,
  slots: [],
  holdings: [
    {
      mint: address,
      program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      raw: '9007199254740993',
      amount: '9007199.254740993',
      decimals: 9,
      accounts: [
        { address, raw: '9007199254740993', frozen: true, extensions: false },
      ],
    },
  ],
});
describe('retained public tracker token holdings', () => {
  it('retains exact units separately from the wallet workspace, survives archive and isolates owners', async () => {
    await add();
    const entry = (await list())[0];
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: null,
      stale: false,
    });
    mocks.holdings.mockResolvedValue(tokenSnapshot(entry.address));
    expect((await postHoldings(entry)).status).toBe(200);
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: tokenSnapshot(entry.address),
      stale: false,
      capturedUpdatedAt: entry.updatedAt,
    });
    await write({
      action: 'archive',
      ...entry,
      expectedUpdatedAt: entry.updatedAt,
    });
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: tokenSnapshot(entry.address),
      stale: true,
    });
    expect((await postHoldings((await list())[0])).status).toBe(404);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await getHoldings(entry)).status).toBe(404);
    expect((await postHoldings(entry)).status).toBe(404);
    await add();
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: null,
    });
  });
  it('rejects invalid network, stale versions, cross-origin and unsigned-out requests before provider reads', async () => {
    await add();
    const entry = (await list())[0];
    expect((await getHoldings({ ...entry, network: 'devnet' })).status).toBe(
      400,
    );
    expect((await postHoldings(entry, { network: 'devnet' })).status).toBe(400);
    expect(
      (
        await postHoldings(entry, {
          expectedUpdatedAt: '2026-02-30T00:00:00.000Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postHoldings(entry, {
          expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(409);
    expect(
      (await postHoldings(entry, {}, { origin: 'https://evil.test' })).status,
    ).toBe(403);
    mocks.user = null;
    expect((await getHoldings(entry)).status).toBe(401);
    expect((await postHoldings(entry)).status).toBe(401);
    expect(mocks.holdings).not.toHaveBeenCalled();
  });
  it('throttles owner refreshes and retains older data when the provider fails', async () => {
    await add();
    const entry = (await list())[0];
    mocks.holdings.mockResolvedValueOnce(tokenSnapshot(entry.address));
    expect((await postHoldings(entry)).status).toBe(200);
    expect((await postHoldings(entry)).status).toBe(429);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.holdings.mockRejectedValueOnce(new Error('private-provider-key'));
    const response = await postHoldings(entry);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-provider-key');
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: tokenSnapshot(entry.address),
    });
  });
  it.each(['edit', 'archive'])(
    'rejects an in-flight %s and preserves the last admitted snapshot',
    async (action) => {
      await add();
      const entry = (await list())[0];
      mocks.holdings.mockResolvedValueOnce(tokenSnapshot(entry.address));
      expect((await postHoldings(entry)).status).toBe(200);
      await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
      mocks.holdings.mockImplementationOnce(async () => {
        expect(
          (
            await write({
              action,
              ...entry,
              label: 'Changed',
              expectedUpdatedAt: entry.updatedAt,
            })
          ).status,
        ).toBe(200);
        return tokenSnapshot(entry.address, 300);
      });
      expect((await postHoldings(entry)).status).toBe(409);
      expect(await (await getHoldings(entry)).json()).toMatchObject({
        snapshot: tokenSnapshot(entry.address),
        stale: true,
      });
    },
  );
  it('rejects an older observation after newer slots have been retained', async () => {
    await add();
    const entry = (await list())[0];
    mocks.holdings.mockResolvedValueOnce(tokenSnapshot(entry.address, 300));
    expect((await postHoldings(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.holdings.mockResolvedValueOnce(tokenSnapshot(entry.address, 200));
    expect((await postHoldings(entry)).status).toBe(409);
    expect(await (await getHoldings(entry)).json()).toMatchObject({
      snapshot: { minSlot: 300 },
    });
  });
});
const wallet = (n = 1) => ({
  address: bs58.encode(
    Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 1)),
  ),
  network: 'mainnet',
  label: `Wallet ${n}`,
});
const write = (body: unknown, headers = {}) =>
  POST(
    new Request('http://localhost/api/tracker', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const add = (
  wallets: Array<
    ReturnType<typeof wallet> &
      Partial<Pick<TrackedWallet, 'group' | 'icon' | 'favorite'>>
  > = [wallet()],
) => write({ action: 'add', wallets });
const snapshot = (entry = wallet()) =>
  observe(
    new Request(
      `http://localhost/api/tracker/observe?${new URLSearchParams({ address: entry.address, network: entry.network })}`,
    ),
  );
const list = async () =>
  ((await (await GET()).json()) as { wallets: TrackedWallet[] }).wallets;

beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'tracker-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'tracker-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'tracker-test',
  )) as unknown as D1Database;
  const migration = readFileSync(
    new URL(
      '../../../drizzle/0006_worried_cassandra_nova.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const sql of migration
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0008_slim_wrecker.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0026_tracked_wallet_holdings.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0027_tracked_wallet_transactions.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  await mocks.db
    .prepare(
      'CREATE TABLE wallet_balance_gates (owner_id TEXT UNIQUE NOT NULL,next_allowed_at INTEGER NOT NULL)',
    )
    .run();
}, 30000);
beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0031_tracked_signature_snapshots.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  mocks.rpc.mockReset();
  mocks.holdings.mockReset();
  mocks.transaction.mockReset();
  mocks.signatures.mockReset();
  mocks.evm.mockReset();
  mocks.evmHoldings.mockReset();
  mocks.evmTransaction.mockReset();
  mocks.transferIdentities.mockReset();
  mocks.discovery.mockReset();
  await mocks.db.prepare('DELETE FROM tracked_evm_discovery').run();
  await mocks.db.prepare('DELETE FROM tracked_evm_transactions').run();
  await mocks.db.prepare('DELETE FROM tracked_evm_holdings').run();
  await mocks.db.prepare('DELETE FROM tracked_evm_snapshots').run();
  await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
  await mocks.db.prepare('DELETE FROM tracked_wallets').run();
  await mocks.db.prepare('DELETE FROM tracked_wallet_holdings').run();
  await mocks.db.prepare('DELETE FROM tracked_wallet_transactions').run();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  await mocks.db.prepare('DELETE FROM tracked_signature_snapshots').run();
});

beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0035_tracked_evm_holdings.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0034_evm_tracker_snapshots.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
});

const evmGet = (entry: TrackedWallet) =>
  savedEvm(
    new Request(
      'http://localhost/api/tracker/evm?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
        }),
    ),
  );
const evmPost = (entry: TrackedWallet, headers = {}) =>
  refreshEvm(
    new Request('http://localhost/api/tracker/evm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
      }),
    }),
  );
const evmObservation = (
  entry: TrackedWallet,
  observedAt = '2026-10-10T17:00:00.000Z',
) => ({
  address: entry.address,
  chain: entry.network,
  observedAt,
  source: 'mainnet.base.org',
  nativeBalance: '0.000000000000000001',
  currency: 'ETH',
  block: '123',
  blockHash: '0x' + 'a'.repeat(64),
  outgoingTransactions: '9007199254740993',
  sampleCount: null,
  successfulSampleCount: null,
  oldestObservedAt: null,
  latestObservedAt: null,
  coverage: 'Canonical account nonce only.',
});
describe('EVM tracker registry and retained observations', () => {
  it('keeps each network distinct with checksum-normalized addresses and rejects EVM contexts at Solana-only endpoints', async () => {
    const address = '0x52908400098527886e0f7030069857d2e4169ee7';
    const networks = ['Ethereum', 'Base', 'BNB', 'Arc', 'Robinhood'];
    expect(
      (
        await write({
          action: 'add',
          wallets: networks.map((network) => ({
            address,
            network,
            label: 'EVM QA',
          })),
        })
      ).status,
    ).toBe(200);
    const entries = await list();
    expect(entries).toHaveLength(5);
    expect(
      entries.every(
        (entry) =>
          entry.address === '0x52908400098527886E0F7030069857D2E4169EE7',
      ),
    ).toBe(true);
    expect(
      (
        await write({
          action: 'add',
          wallets: [
            {
              address: entries[0].address,
              network: entries[0].network,
              label: 'Duplicate',
            },
          ],
        })
      ).status,
    ).toBe(409);
    expect(await list()).toHaveLength(5);
    const entry = entries[0];
    expect((await snapshot(entry)).status).toBe(400);
    expect(
      (
        await signaturePage(
          new Request(
            'http://localhost/api/tracker/signatures?' +
              new URLSearchParams({
                address: entry.address,
                network: entry.network,
              }),
          ),
        )
      ).status,
    ).toBe(400);
    expect((await savedList(entry)).status).toBe(400);
    expect((await saveObserved(entry)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.signatures).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('retains exact EVM evidence without provider reads on reopen and keeps archived snapshots with owner and revision isolation', async () => {
    await write({
      action: 'add',
      wallets: [
        {
          address: '0x1111111111111111111111111111111111111111',
          network: 'Base',
          label: 'Base QA',
        },
      ],
    });
    let entry = (await list())[0];
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: null,
      executionAllowed: false,
    });
    expect(mocks.evm).not.toHaveBeenCalled();
    const observation = evmObservation(entry);
    mocks.evm.mockResolvedValue(observation);
    expect((await evmPost(entry)).status).toBe(200);
    expect(mocks.evm).toHaveBeenCalledWith(
      'Base',
      entry.address,
      expect.any(AbortSignal),
    );
    expect((await evmPost(entry)).status).toBe(429);
    mocks.evm.mockClear();
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: observation,
      stale: false,
    });
    expect(mocks.evm).not.toHaveBeenCalled();
    await write({
      ...entry,
      action: 'archive',
      expectedUpdatedAt: entry.updatedAt,
    });
    const old = entry;
    entry = (await list())[0];
    expect((await evmGet(old)).status).toBe(409);
    expect((await evmPost(entry)).status).toBe(409);
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: observation,
      stale: true,
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await evmGet(entry)).status).toBe(404);
    expect((await evmPost(entry)).status).toBe(404);
    mocks.user = null;
    expect((await evmGet(entry)).status).toBe(401);
  });
  it('preserves snapshots on provider failures and rejects writes after in-flight archives or competing reads', async () => {
    await write({
      action: 'add',
      wallets: [
        {
          address: '0x1111111111111111111111111111111111111111',
          network: 'Base',
          label: 'Base QA',
        },
      ],
    });
    let entry = (await list())[0];
    const saved = evmObservation(entry);
    mocks.evm.mockResolvedValue(saved);
    expect((await evmPost(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.evm.mockRejectedValue(new Error('secret provider detail'));
    const failure = await evmPost(entry);
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain('secret');
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: saved,
    });
    expect((await evmPost(entry, { origin: 'https://evil.test' })).status).toBe(
      403,
    );
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    const raced = evmObservation(entry, '2026-10-10T17:00:01.000Z');
    mocks.evm.mockImplementation(async () => {
      await mocks.db
        .prepare(
          'UPDATE tracked_evm_snapshots SET document=?,observed_at=? WHERE owner_id=?',
        )
        .bind(JSON.stringify(raced), raced.observedAt, 'alice')
        .run();
      return evmObservation(entry, '2026-10-10T17:00:02.000Z');
    });
    expect((await evmPost(entry)).status).toBe(409);
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: raced,
    });
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.evm.mockImplementation(async () => {
      await write({
        ...entry,
        action: 'archive',
        expectedUpdatedAt: entry.updatedAt,
      });
      return evmObservation(entry, '2026-10-10T17:00:03.000Z');
    });
    expect((await evmPost(entry)).status).toBe(409);
    entry = (await list())[0];
    expect(await (await evmGet(entry)).json()).toMatchObject({
      snapshot: raced,
      stale: true,
    });
  });
});
afterAll(async () => {
  await mf?.dispose();
});

describe('persistent tracker on real local D1', () => {
  it('saves organization fields, edits with owner-scoped revisions and preserves them through archive/restore', async () => {
    expect(
      (
        await add([
          { ...wallet(), group: 'Research', icon: '🔬', favorite: true },
        ])
      ).status,
    ).toBe(200);
    let entry = (await list())[0];
    expect(entry).toMatchObject({
      group: 'Research',
      icon: '🔬',
      favorite: true,
    });
    const edit = {
      action: 'edit',
      ...entry,
      label: 'Renamed whale',
      group: 'Whales',
      icon: '🐋',
      favorite: false,
      expectedUpdatedAt: entry.updatedAt,
    };
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await write(edit)).status).toBe(409);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    const responses = await Promise.all([
      write(edit),
      write({ ...edit, label: 'Concurrent edit' }),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect((await write(edit)).status).toBe(409);
    entry = (await list())[0];
    expect(entry.group).toBe('Whales');
    expect(entry.icon).toBe('🐋');
    expect(entry.favorite).toBe(false);
    for (const action of ['archive', 'restore']) {
      expect(
        (await write({ action, ...entry, expectedUpdatedAt: entry.updatedAt }))
          .status,
      ).toBe(200);
      entry = (await list())[0];
      expect(entry).toMatchObject({
        group: 'Whales',
        icon: '🐋',
        favorite: false,
      });
    }
  });
  it('rejects invalid organization values without changing stored metadata and normalizes older adds', async () => {
    expect((await add()).status).toBe(200);
    const entry = (await list())[0];
    expect(entry).toMatchObject({ group: '', icon: '⭐', favorite: false });
    for (const invalid of [
      { group: 'x'.repeat(41) },
      { group: 'bad\nname' },
      { favorite: 'true' },
      { icon: '<script>' },
      { label: 'x'.repeat(61) },
    ]) {
      expect(
        (
          await write({
            action: 'edit',
            ...entry,
            ...invalid,
            expectedUpdatedAt: entry.updatedAt,
          })
        ).status,
      ).toBe(400);
    }
    expect((await list())[0]).toEqual(entry);
    expect(
      (
        await add([
          {
            ...wallet(),
            label: 'Do not overwrite',
            group: 'Wrong',
            icon: '🚀',
            favorite: true,
          },
          wallet(2),
        ])
      ).status,
    ).toBe(200);
    expect((await list()).find((w) => w.address === entry.address)).toEqual(
      entry,
    );
  });
  it('requires auth for reads, writes and observations', async () => {
    mocks.user = null;
    for (const response of [await GET(), await add(), await snapshot()]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('persists bulk adds, skips existing entries without relabelling, archives and restores with optimistic revisions', async () => {
    expect((await add([wallet(), wallet(2)])).status).toBe(200);
    expect(await list()).toHaveLength(2);
    expect(
      (await add([{ ...wallet(), label: 'overwrite attempt' }, wallet(3)]))
        .status,
    ).toBe(200);
    expect(
      (await list()).find(
        (w: { address: string }) => w.address === wallet().address,
      )?.label,
    ).toBe('Wallet 1');
    let entry = (await list())[0];
    expect(
      (
        await write({
          action: 'archive',
          ...entry,
          expectedUpdatedAt: entry.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await write({
          action: 'restore',
          ...entry,
          expectedUpdatedAt: entry.updatedAt,
        })
      ).status,
    ).toBe(409);
    entry = (await list()).find(
      (w: { address: string }) => w.address === entry.address,
    )!;
    expect(entry.archived).toBe(true);
    expect(
      (
        await write({
          action: 'restore',
          ...entry,
          expectedUpdatedAt: entry.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (await list()).every((w: { archived: boolean }) => !w.archived),
    ).toBe(true);
  });
  it('isolates owners and prevents observing other owners or archived addresses', async () => {
    await add();
    const [entry] = await list();
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect(await list()).toEqual([]);
    expect((await snapshot()).status).toBe(404);
    expect(
      (
        await write({
          action: 'archive',
          ...entry,
          expectedUpdatedAt: entry.updatedAt,
        })
      ).status,
    ).toBe(409);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    await write({
      action: 'archive',
      ...entry,
      expectedUpdatedAt: entry.updatedAt,
    });
    expect((await snapshot()).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects invalid entire batches, duplicates, credential-looking input, wrong content type and cross-origin writes', async () => {
    for (const wallets of [
      [wallet(), { ...wallet(2), address: 'not-a-public-key' }],
      [wallet(), wallet()],
      [{ ...wallet(), address: 'secret-key:[1,2,3]' }],
      [{ ...wallet(), network: 'test' }],
      [{ ...wallet(), label: 'x'.repeat(61) }],
    ])
      expect((await add(wallets)).status).toBe(400);
    expect(
      (
        await write(
          { action: 'add', wallets: [wallet()] },
          { origin: 'https://other.test' },
        )
      ).status,
    ).toBe(403);
    expect((await write({}, { 'content-type': 'text/plain' })).status).toBe(
      415,
    );
    expect((await write({ data: 'x'.repeat(20001) })).status).toBe(413);
    expect(await list()).toEqual([]);
    expect(() => validateWalletBatch([])).toThrow();
  });
  it('atomically admits concurrent batches up to the cap without partial adds or affecting other owners', async () => {
    await add(Array.from({ length: 98 }, (_, i) => wallet(i + 1)));
    const responses = await Promise.all([
      add([wallet(99), wallet(100)]),
      add([wallet(101), wallet(102)]),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect(await list()).toHaveLength(100);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await add()).status).toBe(200);
  });
  it('returns only read-only validated RPC observations on the selected network with anchored history reads', async () => {
    await add();
    mocks.rpc
      .mockResolvedValueOnce({ context: { slot: 123 }, value: 1500000000 })
      .mockResolvedValueOnce([
        { signature: '2'.repeat(88), slot: 121, blockTime: null, err: null },
      ]);
    const response = await snapshot();
    expect(response.status).toBe(200);
    const { observation } = (await response.json()) as {
      observation: WalletObservation;
    };
    expect(observation.balanceSol).toBe(1.5);
    expect(observation.signatures[0].failed).toBe(false);
    expect(mocks.rpc.mock.calls.map((c) => c[1])).toEqual([
      'getBalance',
      'getSignaturesForAddress',
    ]);
    expect(mocks.rpc.mock.calls[1][2][1]).toEqual({
      commitment: 'confirmed',
      limit: 12,
      minContextSlot: 123,
    });
    expect(mocks.rpc.mock.calls[0][0]).toBe('mainnet');
  });
  it('rejects malformed RPC values and does not disclose provider errors', async () => {
    await add();
    for (const value of [NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
      mocks.rpc.mockResolvedValueOnce({ context: { slot: 123 }, value });
      expect((await snapshot()).status).toBe(502);
    }
    mocks.rpc.mockRejectedValueOnce(new Error('provider-url-with-secret'));
    const response = await snapshot();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret');
    mocks.rpc
      .mockResolvedValueOnce({ context: { slot: 123 }, value: 0 })
      .mockResolvedValueOnce([
        { signature: 'javascript:bad', slot: 1, blockTime: null, err: null },
      ]);
    expect((await snapshot()).status).toBe(502);
  });
});

const publicPage = (entry: TrackedWallet, cursor?: string) =>
  signaturePage(
    new Request(
      'http://localhost/api/tracker/signatures?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
          ...(cursor ? { cursor } : {}),
        }),
    ),
  );
it('requires owned wallet versions and throttles public pages while retaining archive access', async () => {
  await add([wallet()]);
  const entry = (await list())[0];
  mocks.signatures.mockResolvedValue({
    address: entry.address,
    network: entry.network,
    signatures: [],
    anchor: 1,
    nextCursor: null,
  });
  expect((await publicPage(entry, 'bad')).status).toBe(400);
  expect(mocks.signatures).not.toHaveBeenCalled();
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect((await publicPage(entry)).status).toBe(404);
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  expect(
    (await publicPage({ ...entry, updatedAt: '2020-01-01T00:00:00.000Z' }))
      .status,
  ).toBe(409);
  const response = await publicPage(entry);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(
    ((await response.json()) as { executionAllowed: boolean }).executionAllowed,
  ).toBe(false);
  expect((await publicPage(entry)).status).toBe(429);
  await write({
    action: 'archive',
    ...entry,
    expectedUpdatedAt: entry.updatedAt,
  });
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  expect((await publicPage((await list())[0])).status).toBe(200);
  mocks.user = null;
  expect((await publicPage(entry)).status).toBe(401);
});
it('rejects an in-flight wallet edit and exposes generic provider errors', async () => {
  await add([wallet()]);
  const entry = (await list())[0];
  mocks.signatures.mockImplementation(async () => {
    await mocks.db
      .prepare(
        "UPDATE tracked_wallets SET updated_at='2030-01-01T00:00:00.000Z' WHERE owner_id='alice'",
      )
      .run();
    return { signatures: [] };
  });
  expect((await publicPage(entry)).status).toBe(409);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.signatures.mockRejectedValue(new Error('provider secret'));
  const response = await publicPage((await list())[0]);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('provider secret');
});

const retainedRequest = (entry: TrackedWallet, cursor?: string) =>
  new Request(
    'http://localhost/api/tracker/signatures/saved?' +
      new URLSearchParams({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
        ...(cursor ? { cursor } : {}),
      }),
  );
const retain = (entry: TrackedWallet, cursor?: string) =>
  saveSignatures(
    new Request(retainedRequest(entry, cursor), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
it('retains a public page, resumes older pages and reads archived snapshots without RPC', async () => {
  await add([wallet()]);
  const entry = (await list())[0];
  const firstCursor = JSON.stringify({
    signature: inspectSignature,
    slot: 100,
    anchor: 100,
  });
  const page = {
    address: entry.address,
    network: entry.network,
    source: 'rpc.test',
    observedAt: '2026-10-10T15:00:00.000Z',
    anchor: 100,
    signatures: [
      {
        signature: inspectSignature,
        slot: 100,
        blockTime: null,
        failed: false,
      },
    ],
    nextCursor: firstCursor,
  };
  mocks.signatures.mockResolvedValue(page);
  expect((await retain(entry)).status).toBe(200);
  mocks.signatures.mockClear();
  const response = await retainedSignatures(retainedRequest(entry));
  expect(((await response.json()) as { page: unknown }).page).toEqual(page);
  expect(mocks.signatures).not.toHaveBeenCalled();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  const olderSig = bs58.encode(new Uint8Array(64).fill(5));
  mocks.signatures.mockResolvedValue({
    ...page,
    observedAt: '2026-10-10T15:00:01.000Z',
    signatures: [
      { signature: olderSig, slot: 99, blockTime: null, failed: true },
    ],
    nextCursor: null,
  });
  const older = await retain(entry, firstCursor);
  expect(older.status).toBe(200);
  expect(
    ((await older.json()) as { page: { signatures: unknown[] } }).page
      .signatures,
  ).toHaveLength(2);
  expect((await retain(entry, firstCursor)).status).toBe(409);
  await write({
    action: 'archive',
    ...entry,
    expectedUpdatedAt: entry.updatedAt,
  });
  const archived = (await list())[0];
  const saved = await retainedSignatures(retainedRequest(archived));
  expect(((await saved.json()) as { stale: boolean }).stale).toBe(true);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect((await retainedSignatures(retainedRequest(archived))).status).toBe(
    404,
  );
});
it('preserves retained pages on provider failures, duplicate pages and stale responses', async () => {
  await add([wallet()]);
  const entry = (await list())[0];
  const cursor = JSON.stringify({
    signature: inspectSignature,
    slot: 100,
    anchor: 100,
  });
  const page = {
    address: entry.address,
    network: entry.network,
    source: 'rpc.test',
    observedAt: '2026-10-10T15:00:00.000Z',
    anchor: 100,
    signatures: [
      {
        signature: inspectSignature,
        slot: 100,
        blockTime: null,
        failed: false,
      },
    ],
    nextCursor: cursor,
  };
  mocks.signatures.mockResolvedValue(page);
  expect((await retain(entry)).status).toBe(200);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.signatures.mockResolvedValue(page);
  expect((await retain(entry, cursor)).status).toBe(502);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.signatures.mockRejectedValue(new Error('provider details'));
  expect((await retain(entry)).status).toBe(502);
  const saved = await retainedSignatures(retainedRequest(entry));
  expect(((await saved.json()) as { page: unknown }).page).toEqual(page);
  expect(
    (
      await saveSignatures(
        new Request(retainedRequest(entry), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://other.test',
          },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(403);
});

it('rejects a concurrent retained-view replacement and enforces the server continuation cap before RPC', async () => {
  await add([wallet()]);
  const entry = (await list())[0];
  const page = {
    address: entry.address,
    network: entry.network,
    source: 'rpc.test',
    observedAt: '2026-10-10T15:00:00.000Z',
    anchor: 100,
    signatures: [],
    nextCursor: null,
  };
  mocks.signatures.mockImplementation(async () => {
    await mocks.db
      .prepare('INSERT INTO tracked_signature_snapshots VALUES (?,?,?,?,?,?)')
      .bind(
        'alice',
        entry.network,
        entry.address,
        JSON.stringify({ ...page, source: 'concurrent.test' }),
        entry.updatedAt,
        page.observedAt,
      )
      .run();
    return page;
  });
  expect((await retain(entry)).status).toBe(409);
  const saved = await retainedSignatures(retainedRequest(entry));
  expect(
    ((await saved.json()) as { page: { source: string } }).page.source,
  ).toBe('concurrent.test');
  const cursor = JSON.stringify({
    signature: inspectSignature,
    slot: 100,
    anchor: 100,
  });
  await mocks.db
    .prepare('UPDATE tracked_signature_snapshots SET document=?')
    .bind(
      JSON.stringify({
        ...page,
        nextCursor: cursor,
        signatures: Array.from({ length: 250 }, (_, i) => ({
          signature: String(i),
          slot: 100,
          blockTime: null,
          failed: false,
        })),
      }),
    )
    .run();
  mocks.signatures.mockClear();
  expect((await retain(entry, cursor)).status).toBe(409);
  expect(mocks.signatures).not.toHaveBeenCalled();
});

it('retains tracker ERC-20 holdings with exact units, archive access and owner/version isolation', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const contract = '0x2222222222222222222222222222222222222222';
  await write({
    action: 'add',
    wallets: [{ network: 'Base', address, label: 'Token QA' }],
  });
  const entry = (await list())[0];
  const get = (wallet = entry) =>
    savedEvmHoldings(
      new Request(
        'http://localhost/api/tracker/evm-holdings?' +
          new URLSearchParams({
            network: wallet.network,
            address: wallet.address,
            expectedUpdatedAt: wallet.updatedAt,
          }),
      ),
    );
  const post = (
    wallet = entry,
    contracts: string[] = [contract],
    headers = {},
  ) =>
    refreshEvmHoldings(
      new Request('http://localhost/api/tracker/evm-holdings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          network: wallet.network,
          address: wallet.address,
          expectedUpdatedAt: wallet.updatedAt,
          contracts,
        }),
      }),
    );
  expect(
    ((await (await get()).json()) as { snapshot: unknown }).snapshot,
  ).toBeNull();
  expect(mocks.evmHoldings).not.toHaveBeenCalled();
  expect((await post(entry, [])).status).toBe(400);
  expect((await post(entry, [contract, contract])).status).toBe(400);
  expect(mocks.evmHoldings).not.toHaveBeenCalled();
  const observation = {
    chain: 'Base',
    address,
    holdings: [
      {
        contract,
        raw: '9007199254740993',
        decimals: 6,
        amount: '9007199254.740993',
      },
    ],
    blockNumber: 123,
    blockHash: '0x' + 'a'.repeat(64),
    observedAt: '2026-10-10T18:00:00.000Z',
    source: 'rpc.test',
  };
  mocks.evmHoldings.mockResolvedValue(observation);
  expect((await post()).status).toBe(200);
  expect(mocks.evmHoldings).toHaveBeenCalledWith(
    { chain: 'Base', address, contracts: [contract] },
    expect.any(AbortSignal),
  );
  expect((await post()).status).toBe(429);
  mocks.evmHoldings.mockClear();
  expect(
    ((await (await get()).json()) as { snapshot: unknown }).snapshot,
  ).toEqual(observation);
  expect(mocks.evmHoldings).not.toHaveBeenCalled();
  await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
  mocks.evmHoldings.mockRejectedValue(new Error('private provider secret'));
  const failed = await post();
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private provider secret');
  expect(
    ((await (await get()).json()) as { snapshot: unknown }).snapshot,
  ).toEqual(observation);
  expect(
    (await post(entry, [contract], { origin: 'https://other.test' })).status,
  ).toBe(403);
  await write({
    action: 'archive',
    ...entry,
    expectedUpdatedAt: entry.updatedAt,
  });
  const archived = (await list())[0];
  expect((await get()).status).toBe(409);
  expect((await post(archived)).status).toBe(409);
  expect(
    ((await (await get(archived)).json()) as { stale: boolean }).stale,
  ).toBe(true);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect((await get(archived)).status).toBe(404);
  mocks.user = null;
  expect((await get()).status).toBe(401);
});

it('rejects competing EVM holdings saves and in-flight archival while retaining the winning observation', async () => {
  const address = '0x1111111111111111111111111111111111111111',
    contract = '0x2222222222222222222222222222222222222222';
  await write({
    action: 'add',
    wallets: [{ network: 'Base', address, label: 'Race QA' }],
  });
  const entry = (await list())[0];
  const post = () =>
    refreshEvmHoldings(
      new Request('http://localhost/api/tracker/evm-holdings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          network: 'Base',
          address,
          expectedUpdatedAt: entry.updatedAt,
          contracts: [contract],
        }),
      }),
    );
  const observation = {
    chain: 'Base',
    address,
    holdings: [],
    blockNumber: 123,
    blockHash: '0x' + 'a'.repeat(64),
    observedAt: '2026-10-10T18:00:00.000Z',
    source: 'winning.test',
  };
  mocks.evmHoldings.mockImplementation(async () => {
    await mocks.db
      .prepare('INSERT INTO tracked_evm_holdings VALUES (?,?,?,?,?,?)')
      .bind(
        'alice',
        'Base',
        address,
        JSON.stringify(observation),
        entry.updatedAt,
        observation.observedAt,
      )
      .run();
    return {
      ...observation,
      observedAt: '2026-10-10T18:00:01.000Z',
      source: 'late.test',
    };
  });
  expect((await post()).status).toBe(409);
  await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
  mocks.evmHoldings.mockImplementation(async () => {
    await write({
      action: 'archive',
      ...entry,
      expectedUpdatedAt: entry.updatedAt,
    });
    return { ...observation, observedAt: '2026-10-10T18:00:02.000Z' };
  });
  expect((await post()).status).toBe(409);
  expect(
    (
      await mocks.db
        .prepare('SELECT document FROM tracked_evm_holdings')
        .first<{ document: string }>()
    )?.document,
  ).toBe(JSON.stringify(observation));
});

beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0039_tracked_evm_transactions.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
const evmTxHash = '0x' + 'a'.repeat(64);
beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0040_tracked_evm_discovery.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
const discoveryRequest = (entry: TrackedWallet, headers = {}, extra = {}) =>
  scanDiscovery(
    new Request('http://localhost/api/tracker/evm-discovery', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
        ...extra,
      }),
    }),
  );
const discoveryGet = (entry: TrackedWallet) =>
  savedDiscovery(
    new Request(
      'http://localhost/api/tracker/evm-discovery?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
        }),
    ),
  );
describe('retained recent EVM discovery', () => {
  it('extends only the owned saved cursor and preserves prior pages on failed continuation', async () => {
    const entry = await seed();
    expect(
      (await discoveryRequest(entry, {}, { action: 'older' })).status,
    ).toBe(409);
    expect(mocks.discovery).not.toHaveBeenCalled();
    const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
    const initial = {
      chain: 'Base',
      address: entry.address,
      fromBlock: '10',
      toBlock: '19',
      fromBlockHash: h(10),
      fromParentHash: h(9),
      blockHash: h(19),
      blocksScanned: 10,
      transactionsScanned: 30,
      includesTokenEvents: true,
      matchingEventCount: 1,
      candidates: [{ hash: evmTxHash, valueRaw: '9007199254740993' }],
      observedAt: '2026-10-10T19:20:00.000Z',
    };
    mocks.discovery.mockResolvedValue(initial);
    expect(
      (await discoveryRequest(entry, {}, { includeTokenEvents: true })).status,
    ).toBe(200);
    expect(mocks.discovery).toHaveBeenLastCalledWith(
      'Base',
      entry.address,
      expect.any(AbortSignal),
      expect.any(Function),
      undefined,
      true,
    );
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    const older = {
      ...initial,
      fromBlock: '0',
      toBlock: '9',
      fromBlockHash: h(0),
      fromParentHash: h(0),
      blockHash: h(9),
      candidates: [{ hash: h(100), valueRaw: '1' }],
      observedAt: '2026-10-10T19:21:00.000Z',
    };
    mocks.discovery.mockClear();
    expect(
      (
        await discoveryRequest(
          entry,
          {},
          { action: 'older', expectedDiscoveryObservedAt: 'bad' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await discoveryRequest(
          entry,
          {},
          { action: 'older', expectedDiscoveryObservedAt: older.observedAt },
        )
      ).status,
    ).toBe(409);
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM tracker_evm_read_gates')
        .first(),
    ).toMatchObject({ n: 0 });
    mocks.discovery.mockRejectedValueOnce(
      new Error('Changed retained branch.'),
    );
    expect(
      (await discoveryRequest(entry, {}, { action: 'older' })).status,
    ).toBe(502);
    expect((await discoveryData(entry)).discovery!.observedAt).toBe(
      initial.observedAt,
    );
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.discovery.mockResolvedValue(older);
    const response = await discoveryRequest(
      entry,
      {},
      {
        action: 'older',
        expectedDiscoveryObservedAt: initial.observedAt,
        fromBlock: '999',
        blockHash: h(999),
        includeTokenEvents: false,
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.discovery).toHaveBeenLastCalledWith(
      'Base',
      entry.address,
      expect.any(AbortSignal),
      expect.any(Function),
      {
        number: '9',
        hash: h(9),
        childNumber: '10',
        childHash: h(10),
        originalNumber: '19',
        originalHash: h(19),
      },
      true,
    );
    const document = (
      (await response.json()) as {
        discovery: {
          fromBlock: string;
          toBlock: string;
          pages: Array<{ observedAt: string }>;
          candidates: unknown[];
        };
      }
    ).discovery;
    expect(document.fromBlock).toBe('0');
    expect(document.toBlock).toBe('19');
    expect(document.candidates).toHaveLength(2);
    expect(document.pages.map((p) => p.observedAt)).toEqual([
      initial.observedAt,
      older.observedAt,
    ]);
    mocks.discovery.mockClear();
    expect(
      (await discoveryRequest(entry, {}, { action: 'older' })).status,
    ).toBe(409);
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect((await discoveryData(entry)).discovery!.candidates).toHaveLength(2);
  });
  async function discoveryData(entry: TrackedWallet) {
    return (await (await discoveryGet(entry)).json()) as {
      discovery: {
        candidates: Array<{ valueRaw: string }>;
        observedAt: string;
        concurrent?: boolean;
      } | null;
    };
  }
  async function seed() {
    const entry = await seedEvmTx();
    mocks.discovery.mockResolvedValue({
      chain: 'Base',
      address: entry.address,
      fromBlock: '10',
      toBlock: '19',
      blockHash: '0x' + 'b'.repeat(64),
      candidates: [{ hash: evmTxHash, valueRaw: '9007199254740993' }],
      observedAt: '2026-10-10T19:20:00.000Z',
    });
    return entry;
  }
  it('retains scans, shares throttling, reads archives without providers and isolates owners', async () => {
    let entry = await seed();
    expect((await discoveryData(entry)).discovery!).toBeNull();
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect((await discoveryRequest(entry)).status).toBe(200);
    expect(mocks.discovery).toHaveBeenCalledWith(
      'Base',
      entry.address,
      expect.any(AbortSignal),
    );
    expect((await evmTxPost(entry)).status).toBe(429);
    expect((await discoveryGet(entry)).status).toBe(200);
    expect(
      (
        await write({
          action: 'archive',
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
        })
      ).status,
    ).toBe(200);
    entry = (await list())[0];
    mocks.discovery.mockClear();
    expect((await discoveryData(entry)).discovery!.candidates[0].valueRaw).toBe(
      '9007199254740993',
    );
    expect((await discoveryRequest(entry)).status).toBe(409);
    expect(mocks.discovery).not.toHaveBeenCalled();
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await discoveryGet(entry)).status).toBe(404);
    mocks.user = null;
    expect((await discoveryGet(entry)).status).toBe(401);
  });
  it('rejects invalid input and provider failures without overwriting retained scans', async () => {
    const entry = await seed();
    expect(
      (await discoveryRequest(entry, { origin: 'https://other.test' })).status,
    ).toBe(403);
    expect(
      (await discoveryRequest(entry, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect(
      (await discoveryRequest({ ...entry, updatedAt: 'bad' })).status,
    ).toBe(400);
    expect(
      (
        await discoveryRequest({
          ...entry,
          updatedAt: '2026-10-09T12:00:00.000Z',
        })
      ).status,
    ).toBe(409);
    expect((await discoveryRequest(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.discovery.mockRejectedValue(new Error('private provider diagnostic'));
    const fail = await discoveryRequest(entry);
    expect(fail.status).toBe(502);
    expect(await fail.text()).not.toContain('private');
    expect((await discoveryData(entry)).discovery!.observedAt).toBe(
      '2026-10-10T19:20:00.000Z',
    );
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.discovery.mockRejectedValueOnce(
      new Error('Too many discovery matches. Narrower indexing is required.'),
    );
    const capped = await discoveryRequest(entry);
    expect(capped.status).toBe(502);
    expect(await capped.json()).toMatchObject({
      error: expect.stringContaining('100-transaction match limit'),
    });
    expect((await discoveryData(entry)).discovery!.observedAt).toBe(
      '2026-10-10T19:20:00.000Z',
    );
  });
  it('rejects in-flight archive and concurrent saved-document replacement', async () => {
    let entry = await seed();
    const report = await mocks.discovery();
    expect((await discoveryRequest(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    const concurrent = { ...report, concurrent: true };
    mocks.discovery.mockImplementationOnce(async () => {
      await mocks.db
        .prepare('UPDATE tracked_evm_discovery SET document=?')
        .bind(JSON.stringify(concurrent))
        .run();
      return { ...report, observedAt: '2026-10-10T19:21:00.000Z' };
    });
    expect((await discoveryRequest(entry)).status).toBe(409);
    expect((await discoveryData(entry)).discovery!.concurrent).toBe(true);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.discovery.mockImplementationOnce(async () => {
      expect(
        (
          await write({
            action: 'archive',
            address: entry.address,
            network: entry.network,
            expectedUpdatedAt: entry.updatedAt,
          })
        ).status,
      ).toBe(200);
      return { ...report, observedAt: '2026-10-10T19:22:00.000Z' };
    });
    expect((await discoveryRequest(entry)).status).toBe(409);
    entry = (await list())[0];
    expect((await discoveryData(entry)).discovery!.concurrent).toBe(true);
  }, 15000);
});
const evmTxGet = (entry: TrackedWallet) =>
  savedEvmTransactions(
    new Request(
      'http://localhost/api/tracker/evm-transactions?' +
        new URLSearchParams({
          address: entry.address,
          network: entry.network,
          expectedUpdatedAt: entry.updatedAt,
        }),
    ),
  );
const evmTxPost = (entry: TrackedWallet, extra = {}, headers = {}) =>
  refreshEvmTransaction(
    new Request('http://localhost/api/tracker/evm-transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        address: entry.address,
        network: entry.network,
        expectedUpdatedAt: entry.updatedAt,
        hash: evmTxHash,
        ...extra,
      }),
    }),
  );
async function seedEvmTx() {
  await write({
    action: 'add',
    wallets: [
      {
        address: '0x1111111111111111111111111111111111111111',
        network: 'Base',
        label: 'Public QA',
      },
    ],
  });
  const entry = (await list())[0];
  mocks.evmTransaction.mockResolvedValue({
    chain: 'Base',
    address: entry.address,
    hash: evmTxHash,
    blockHash: '0x' + 'b'.repeat(64),
    blockNumber: '12',
    valueRaw: '9007199254740993',
    observedAt: '2026-10-10T18:00:00.000Z',
  });
  return entry;
}
describe('retained EVM transaction observations', () => {
  it('saves exact evidence, reads storage only, retains archives and isolates owners', async () => {
    let entry = await seedEvmTx();
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [],
      executionAllowed: false,
    });
    expect(mocks.evmTransaction).not.toHaveBeenCalled();
    expect((await evmTxPost(entry)).status).toBe(200);
    expect(mocks.evmTransaction).toHaveBeenCalledWith(
      'Base',
      entry.address,
      evmTxHash,
      expect.any(AbortSignal),
    );
    expect((await evmTxPost(entry)).status).toBe(429);
    mocks.evmTransaction.mockClear();
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [
        { transaction: { valueRaw: '9007199254740993' }, stale: false },
      ],
    });
    expect(mocks.evmTransaction).not.toHaveBeenCalled();
    await write({
      ...entry,
      action: 'archive',
      expectedUpdatedAt: entry.updatedAt,
    });
    const old = entry;
    entry = (await list())[0];
    expect((await evmTxGet(old)).status).toBe(409);
    expect((await evmTxPost(entry)).status).toBe(409);
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [{ stale: true }],
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await evmTxGet(entry)).status).toBe(404);
    expect((await evmTxPost(entry)).status).toBe(404);
    mocks.user = null;
    expect((await evmTxGet(entry)).status).toBe(401);
    expect((await evmTxPost(entry)).status).toBe(401);
  });
  it('rejects bad input before RPC and retains prior observations on unavailable data', async () => {
    const entry = await seedEvmTx();
    expect((await evmTxPost(entry, { hash: 'bad' })).status).toBe(400);
    expect(
      (await evmTxPost(entry, {}, { origin: 'https://other.test' })).status,
    ).toBe(403);
    expect(mocks.evmTransaction).not.toHaveBeenCalled();
    expect((await evmTxPost(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.evmTransaction.mockRejectedValueOnce(new Error('secret-provider'));
    const failed = await evmTxPost(entry);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret-provider');
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.evmTransaction.mockResolvedValueOnce(null);
    expect((await evmTxPost(entry)).status).toBe(404);
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [{ transaction: { valueRaw: '9007199254740993' } }],
    });
  });
  it('rejects in-flight edits, concurrent saved changes and the bounded history cap', async () => {
    let entry = await seedEvmTx();
    mocks.evmTransaction.mockImplementationOnce(async () => {
      await write({
        ...entry,
        action: 'archive',
        expectedUpdatedAt: entry.updatedAt,
      });
      return {
        chain: 'Base',
        address: entry.address,
        hash: evmTxHash,
        observedAt: '2026-10-10T18:00:00.000Z',
      };
    });
    expect((await evmTxPost(entry)).status).toBe(409);
    entry = (await list())[0];
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [],
    });
    await write({
      ...entry,
      action: 'restore',
      expectedUpdatedAt: entry.updatedAt,
    });
    entry = (await list())[0];
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    const observation = {
      chain: 'Base',
      address: entry.address,
      hash: evmTxHash,
      observedAt: '2026-10-10T18:00:00.000Z',
    };
    mocks.evmTransaction.mockImplementationOnce(async () => {
      await mocks.db
        .prepare('INSERT INTO tracked_evm_transactions VALUES (?,?,?,?,?,?,?)')
        .bind(
          'alice',
          'Base',
          entry.address,
          evmTxHash,
          JSON.stringify(observation),
          entry.updatedAt,
          observation.observedAt,
        )
        .run();
      return observation;
    });
    expect((await evmTxPost(entry)).status).toBe(409);
    await mocks.db.prepare('DELETE FROM tracked_evm_transactions').run();
    const inserts = Array.from({ length: 100 }, (_, i) =>
      mocks.db
        .prepare('INSERT INTO tracked_evm_transactions VALUES (?,?,?,?,?,?,?)')
        .bind(
          'alice',
          'Base',
          entry.address,
          '0x' + i.toString(16).padStart(64, '0'),
          JSON.stringify({
            ...observation,
            hash: '0x' + i.toString(16).padStart(64, '0'),
          }),
          entry.updatedAt,
          observation.observedAt,
        ),
    );
    await mocks.db.batch(inserts);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.evmTransaction.mockResolvedValue(observation);
    expect((await evmTxPost(entry)).status).toBe(409);
    expect(
      ((await (await evmTxGet(entry)).json()) as { observations: unknown[] })
        .observations,
    ).toHaveLength(100);
  }, 15000);
});

const identityContract = '0x2222222222222222222222222222222222222222';
const identityBlockHash = '0x' + 'b'.repeat(64);
const identityReport = () => ({
  identities: [
    {
      contract: identityContract,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      blockNumber: 12,
      blockHash: identityBlockHash,
      observedAt: '2026-10-10T19:00:00.000Z',
      source: 'mainnet.base.org',
    },
  ],
  unavailable: [],
  observedAt: '2026-10-10T19:00:00.000Z',
});
async function seedSavedTransfer() {
  const entry = await seedEvmTx();
  mocks.evmTransaction.mockResolvedValueOnce({
    chain: 'Base',
    address: entry.address,
    hash: evmTxHash,
    blockHash: identityBlockHash,
    blockNumber: '12',
    transferEvents: [{ contract: identityContract, raw: '2000000' }],
    observedAt: '2026-10-10T18:00:00.000Z',
  });
  expect((await evmTxPost(entry)).status).toBe(200);
  await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
  return entry;
}
describe('historical tracked token identities', () => {
  it('uses the saved contract/block, retains readable metadata and preserves the original transaction read time', async () => {
    let entry = await seedSavedTransfer();
    mocks.transferIdentities.mockResolvedValue(identityReport());
    expect(
      (
        await evmTxPost(entry, {
          action: 'identity',
          contracts: ['spoof'],
          blockHash: 'spoof',
          blockNumber: '999',
        })
      ).status,
    ).toBe(200);
    expect(mocks.transferIdentities).toHaveBeenCalledWith(
      expect.objectContaining({
        blockNumber: '12',
        blockHash: identityBlockHash,
        transferEvents: [{ contract: identityContract, raw: '2000000' }],
      }),
      expect.any(AbortSignal),
    );
    mocks.transferIdentities.mockClear();
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [
        {
          transaction: {
            observedAt: '2026-10-10T18:00:00.000Z',
            tokenIdentity: identityReport(),
          },
        },
      ],
    });
    expect(mocks.transferIdentities).not.toHaveBeenCalled();
    await write({
      ...entry,
      action: 'archive',
      expectedUpdatedAt: entry.updatedAt,
    });
    entry = (await list())[0];
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(409);
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [
        { stale: true, transaction: { tokenIdentity: identityReport() } },
      ],
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await evmTxGet(entry)).status).toBe(404);
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(404);
  });
  it('retains prior metadata and exact raw records when historical identity lookup fails', async () => {
    const entry = await seedSavedTransfer();
    mocks.transferIdentities.mockResolvedValue(identityReport());
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.transferIdentities.mockResolvedValueOnce({
      identities: [],
      unavailable: [identityContract],
      observedAt: '2026-10-10T20:00:00.000Z',
    });
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(502);
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [
        {
          transaction: {
            transferEvents: [{ raw: '2000000' }],
            tokenIdentity: identityReport(),
          },
        },
      ],
    });
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.transferIdentities.mockRejectedValueOnce(
      new Error('secret-archive-provider'),
    );
    const response = await evmTxPost(entry, { action: 'identity' });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret-archive-provider');
  });
  it('rejects missing observations and in-flight wallet or document changes without losing saved events', async () => {
    let entry = await seedEvmTx();
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(409);
    mocks.evmTransaction.mockResolvedValueOnce({
      chain: 'Base',
      address: entry.address,
      hash: evmTxHash,
      blockHash: identityBlockHash,
      blockNumber: '12',
      transferEvents: [{ contract: identityContract, raw: '2000000' }],
      observedAt: '2026-10-10T18:00:00.000Z',
    });
    expect((await evmTxPost(entry)).status).toBe(200);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.transferIdentities.mockImplementationOnce(async () => {
      await mocks.db
        .prepare(
          "UPDATE tracked_evm_transactions SET document=json_set(document,'$.newer',1) WHERE owner_id='alice'",
        )
        .run();
      return identityReport();
    });
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(409);
    await mocks.db.prepare('DELETE FROM tracker_evm_read_gates').run();
    mocks.transferIdentities.mockImplementationOnce(async () => {
      await write({
        ...entry,
        action: 'archive',
        expectedUpdatedAt: entry.updatedAt,
      });
      return identityReport();
    });
    expect((await evmTxPost(entry, { action: 'identity' })).status).toBe(409);
    entry = (await list())[0];
    expect(await (await evmTxGet(entry)).json()).toMatchObject({
      observations: [
        { transaction: { transferEvents: [{ raw: '2000000' }], newer: 1 } },
      ],
    });
  }, 15000);
});
