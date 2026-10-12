import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import type { WalletWorkspace } from '@/lib/wallet-workspace';
import {
  walletAddress,
  workspaceWalletBatch,
  walletTags,
} from '@/lib/wallet-workspace';
import type { BalanceSnapshot } from '@/lib/wallet-balance-format';
import { HoldingsReadError } from '@/lib/wallet-holdings';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
  holdings: vi.fn(),
  evmHoldings: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-balances', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet-balances')>()),
  observeWalletBalances: mocks.observe,
}));
vi.mock('@/lib/wallet-holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet-holdings')>()),
  observeWalletHoldings: mocks.holdings,
}));
vi.mock('@/lib/evm-holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evm-holdings')>()),
  observeEvmHoldings: mocks.evmHoldings,
}));
import {
  GET as getEvmHoldings,
  POST as refreshEvmHoldings,
} from './evm-holdings/route';
import { GET as getHoldings, POST as refreshHoldings } from './holdings/route';
import { GET, POST } from './route';
import { POST as refreshBalances } from './balances/route';
let mf: Miniflare;
const address = (n = 1) =>
  bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 1)));
const write = (body: Record<string, unknown>, headers = {}) =>
  POST(
    new Request('http://localhost/api/wallet-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ chain: 'Solana', ...body }),
    }),
  );
const create = (id = 'a', chain = 'Solana') =>
  write({ action: 'folder.create', id, name: `Folder ${id}`, chain });
const add = (
  folderId = 'a',
  wallets = [{ address: address(), label: 'QA wallet', role: 'Recipient' }],
  chain = 'Solana',
) => write({ action: 'wallet.add', folderId, wallets, chain });
const list = async () => (await (await GET()).json()) as WalletWorkspace;
it('assigns multiple folders atomically and retains a wallet through an active secondary folder', async () => {
  await create('a');
  await create('b');
  await add();
  const request = {
    action: 'wallet.folders',
    wallets: [{ address: address(), revision: 1 }],
    folders: [
      { id: 'a', revision: 1 },
      { id: 'b', revision: 1 },
    ],
  };
  expect((await write(request)).status).toBe(200);
  expect((await list()).wallets).toHaveLength(1);
  expect((await list()).wallets[0].folderIds).toEqual(['a', 'b']);
  expect((await write(request)).status).toBe(409);
  expect(
    (await write({ action: 'folder.archive', id: 'a', revision: 1 })).status,
  ).toBe(200);
  mocks.observe.mockResolvedValue(snapshot());
  expect((await refresh()).status).toBe(200);
  expect((await list()).balances).toHaveLength(1);
  expect(
    (await write({ action: 'folder.archive', id: 'b', revision: 1 })).status,
  ).toBe(200);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  expect((await refresh()).status).toBe(200);
});
it('rejects one stale wallet or folder for the entire membership assignment and isolates owners', async () => {
  await create('a');
  await create('b');
  await add('a', [
    { address: address(), label: '', role: 'Recipient' },
    { address: address(2), label: '', role: 'Recipient' },
  ]);
  const desired = {
    action: 'wallet.folders',
    wallets: [
      { address: address(), revision: 1 },
      { address: address(2), revision: 2 },
    ],
    folders: [
      { id: 'a', revision: 1 },
      { id: 'b', revision: 1 },
    ],
  };
  expect((await write(desired)).status).toBe(409);
  expect(
    (await list()).wallets.every(
      (w) => w.revision === 1 && w.folderIds?.length === 1,
    ),
  ).toBe(true);
  desired.wallets[1].revision = 1;
  desired.folders[1].revision = 2;
  expect((await write(desired)).status).toBe(409);
  mocks.user = { userId: 'foreign', email: 'foreign@test.example' };
  expect(
    (await write({ ...desired, folders: [{ id: 'a', revision: 1 }] })).status,
  ).toBe(409);
});
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'wallet-workspace-test',
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
          env: { DB: { type: 'd1', id: 'wallet-workspace-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'wallet-workspace-test',
  )) as unknown as D1Database;
  for (const sql of readFileSync(
    new URL('../../../drizzle/0011_huge_donald_blake.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0012_messy_zzzax.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0013_fresh_sandman.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0015_smiling_bloodstorm.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0019_wallet_folder_memberships.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  await mocks.db
    .prepare(
      "INSERT INTO wallet_folders (owner_id,id,name,chain,archived,revision,updated_at) VALUES ('migration-owner','legacy','Legacy folder','Solana',1,7,'2026-10-09')",
    )
    .run();
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0020_wallet_folder_colors.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
  expect(
    await mocks.db
      .prepare(
        "SELECT color,revision,archived FROM wallet_folders WHERE owner_id='migration-owner'",
      )
      .first(),
  ).toEqual({ color: '#A6B1FF', revision: 7, archived: 1 });
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0030_workspace_wallet_tags.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  await mocks.db.batch([
    mocks.db.prepare('DELETE FROM workspace_wallets'),
    mocks.db.prepare('DELETE FROM wallet_folders'),
    mocks.db.prepare('DELETE FROM wallet_balance_snapshots'),
    mocks.db.prepare('DELETE FROM wallet_balance_gates'),
    mocks.db.prepare('DELETE FROM wallet_holdings_snapshots'),
  ]);
  mocks.observe.mockReset();
  mocks.holdings.mockReset();
  mocks.evmHoldings.mockReset();
});
afterAll(async () => {
  await mf.dispose();
});
describe('external wallet workspace', () => {
  it('persists folders, roles and addresses independently, with rename/archive/restore', async () => {
    expect((await create()).status).toBe(200);
    expect((await add()).status).toBe(200);
    expect(
      (
        await write({
          action: 'folder.rename',
          id: 'a',
          name: 'Treasury',
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await write({
          action: 'wallet.edit',
          address: address(),
          folderId: 'a',
          label: 'Launch signer',
          role: 'Deployer',
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (await write({ action: 'folder.archive', id: 'a', revision: 2 })).status,
    ).toBe(200);
    let state = await list();
    expect(state.folders[0]).toMatchObject({
      name: 'Treasury',
      archived: true,
      revision: 3,
    });
    expect(state.wallets[0]).toMatchObject({
      label: 'Launch signer',
      role: 'Deployer',
      archived: false,
      revision: 2,
      folderId: 'a',
    });
    expect(
      (await add('a', [{ address: address(2), label: '', role: 'Recipient' }]))
        .status,
    ).toBe(409);
    expect(
      (await write({ action: 'folder.restore', id: 'a', revision: 3 })).status,
    ).toBe(200);
    expect(
      (
        await write({
          action: 'wallet.archive',
          wallets: [{ address: address(), revision: 2 }],
        })
      ).status,
    ).toBe(200);
    expect((await add()).status).toBe(409); // archived duplicates are retained
    expect(
      (
        await write({
          action: 'wallet.restore',
          wallets: [{ address: address(), revision: 3 }],
        })
      ).status,
    ).toBe(200);
    state = await list();
    expect(state.wallets[0]).toMatchObject({
      label: 'Launch signer',
      role: 'Deployer',
      revision: 4,
      archived: false,
    });
    await write({ action: 'folder.archive', id: 'a', revision: 4 });
    await write({
      action: 'wallet.archive',
      wallets: [{ address: address(), revision: 4 }],
    });
    expect(
      (
        await write({
          action: 'wallet.restore',
          wallets: [{ address: address(), revision: 5 }],
        })
      ).status,
    ).toBe(200);
    expect((await list()).wallets[0]).toMatchObject({
      archived: false,
      revision: 6,
    });
    await write({ action: 'folder.restore', id: 'a', revision: 5 });
    expect(
      (
        await write({
          action: 'wallet.restore',
          wallets: [{ address: address(), revision: 5 }],
        })
      ).status,
    ).toBe(409); // stale wallet revision remains rejected
  });
  it('makes selected moves all-or-none and rejects stale revisions and foreign folders', async () => {
    await create();
    await create('b');
    await add(
      'a',
      [1, 2].map((n) => ({
        address: address(n),
        label: `W${n}`,
        role: 'Recipient',
      })),
    );
    expect(
      (
        await write({
          action: 'wallet.move',
          folderId: 'b',
          wallets: [
            { address: address(), revision: 1 },
            { address: address(2), revision: 2 },
          ],
        })
      ).status,
    ).toBe(409);
    expect(
      (await list()).wallets.every(
        (w) => w.folderId === 'a' && w.revision === 1,
      ),
    ).toBe(true);
    const results = await Promise.all([
      write({
        action: 'wallet.move',
        folderId: 'b',
        wallets: [
          { address: address(), revision: 1 },
          { address: address(2), revision: 1 },
        ],
      }),
      write({
        action: 'wallet.archive',
        wallets: [
          { address: address(), revision: 1 },
          { address: address(2), revision: 1 },
        ],
      }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect((await list()).wallets.every((w) => w.revision === 2)).toBe(true);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect(await list()).toEqual({
      folders: [],
      wallets: [],
      balances: [],
      proofs: [],
    });
    await create('foreign');
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    expect(
      (
        await add('foreign', [
          { address: address(3), label: '', role: 'Recipient' },
        ])
      ).status,
    ).toBe(409);
    expect(
      (
        await write({
          action: 'folder.rename',
          id: 'foreign',
          name: 'Stolen',
          revision: 1,
        })
      ).status,
    ).toBe(409);
  });
  it('canonicalizes EVM addresses and validates network, role, folder and batch bounds', async () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    await create('evm', 'Ethereum');
    expect(
      (
        await add(
          'evm',
          [{ address: lower, label: 'Funder', role: 'Funder' }],
          'Ethereum',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await add(
          'evm',
          [
            {
              address: walletAddress(lower, 'Ethereum'),
              label: 'Different',
              role: 'Recipient',
            },
          ],
          'Ethereum',
        )
      ).status,
    ).toBe(409);
    expect((await list()).wallets[0].address).toBe(
      walletAddress(lower, 'Ethereum'),
    );
    expect(
      (await add('evm', [{ address: address(), label: '', role: 'Recipient' }]))
        .status,
    ).toBe(409);
    for (const patch of [{ chain: 'Unknown' }, { name: '' }, { name: '\n' }])
      expect(
        (
          await write({
            action: 'folder.create',
            id: 'invalid',
            name: 'Valid',
            ...patch,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await add(
          'evm',
          [{ address: lower, label: '', role: 'Admin' }],
          'Ethereum',
        )
      ).status,
    ).toBe(400);
    expect(() =>
      walletAddress('0x0000000000000000000000000000000000000000', 'Ethereum'),
    ).toThrow();
    expect(() =>
      workspaceWalletBatch(
        [{ address: lower }, { address: walletAddress(lower, 'Ethereum') }],
        'Ethereum',
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      workspaceWalletBatch(
        Array.from({ length: 101 }, () => ({ address: lower })),
        'Ethereum',
      ),
    ).toThrow(/100/);
  });
  it('admits batches atomically at the 500-wallet and 100-folder caps', async () => {
    await create();
    await mocks.db
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<499) INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) SELECT 'alice','Solana','fixture-'||n,'a','','Recipient',0,1,'2026-10-09T00:00:00.000Z' FROM seq`,
      )
      .run();
    expect(
      (
        await add(
          'a',
          [1, 2].map((n) => ({
            address: address(n),
            label: '',
            role: 'Recipient',
          })),
        )
      ).status,
    ).toBe(409);
    const results = await Promise.all([
      add(),
      add('a', [{ address: address(2), label: '', role: 'Recipient' }]),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect((await list()).wallets).toHaveLength(500);
    await mocks.db
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<98) INSERT INTO wallet_folders (owner_id,id,name,chain,archived,revision,updated_at) SELECT 'alice','fixture-'||n,'Folder','Solana',0,1,'2026-10-09T00:00:00.000Z' FROM seq`,
      )
      .run();
    const folderResults = await Promise.all([
      create('last'),
      create('overflow'),
    ]);
    expect(folderResults.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await create('a')).status).toBe(200);
  });
  it('rejects unauthorized and invalid-origin writes without changing data', async () => {
    expect((await create('a')).status).toBe(200);
    expect(
      (
        await write(
          { action: 'folder.archive', id: 'a', revision: 1 },
          { origin: 'https://other.test' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await write(
          { action: 'folder.archive', id: 'a', revision: 1 },
          { 'content-type': 'text/plain' },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await write({
          action: 'folder.rename',
          id: 'a',
          name: 'x',
          revision: 0,
        })
      ).status,
    ).toBe(400);
    expect((await list()).folders[0].revision).toBe(1);
    mocks.user = null;
    expect((await GET()).status).toBe(401);
    expect((await create('b')).status).toBe(401);
  });
});

const refresh = (addresses = [address()], headers = {}) =>
  refreshBalances(
    new Request('http://localhost/api/wallet-workspace/balances', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ chain: 'Solana', addresses }),
    }),
  );
function snapshot(addresses = [address()], blockNumber = 100): BalanceSnapshot {
  const shared = {
    chain: 'Solana' as const,
    currency: 'SOL',
    decimals: 9,
    blockNumber,
    blockHash: null,
    observedAt: new Date().toISOString(),
    snapshotId: crypto.randomUUID(),
    source: 'rpc.example.test',
    commitment: 'confirmed',
  };
  return {
    ...shared,
    total: String(addresses.length),
    items: addresses.map((address) => ({
      ...shared,
      address,
      raw: '1000000000',
      amount: '1',
    })),
  };
}
describe('persisted native balance snapshots', () => {
  it('admits only owned active wallets, retains exact snapshots and gates repeated reads', async () => {
    await create();
    await add();
    mocks.observe.mockResolvedValue(snapshot());
    expect((await refresh()).status).toBe(200);
    expect((await list()).balances?.[0]).toMatchObject({
      raw: '1000000000',
      amount: '1',
      blockNumber: 100,
    });
    expect((await refresh()).status).toBe(429);
    expect(mocks.observe).toHaveBeenCalledTimes(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await refresh()).status).toBe(404);
    expect((await list()).balances).toEqual([]);
    mocks.user = null;
    expect((await refresh()).status).toBe(401);
  });
  it('retains previous values on provider failure, older blocks and changes during refresh', async () => {
    await create();
    await add();
    mocks.observe.mockResolvedValue(snapshot());
    await refresh();
    const previous = (await list()).balances;
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.observe.mockRejectedValue(new Error('Provider unavailable'));
    expect((await refresh()).status).toBe(502);
    expect((await list()).balances).toEqual(previous);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.observe.mockResolvedValue(snapshot([address()], 99));
    expect((await refresh()).status).toBe(409);
    expect((await list()).balances).toEqual(previous);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.observe.mockImplementation(async () => {
      await write({
        action: 'wallet.archive',
        wallets: [{ address: address(), revision: 1 }],
      });
      return snapshot([address()], 101);
    });
    expect((await refresh()).status).toBe(409);
    expect((await list()).balances).toEqual(previous);
    expect((await refresh()).status).toBe(404);
  });
  it('rolls back whole-snapshot storage failure and rejects invalid requests before RPC', async () => {
    await create();
    await add(
      'a',
      [1, 2].map((n) => ({
        address: address(n),
        label: '',
        role: 'Recipient',
      })),
    );
    expect(
      (await refresh([address()], { origin: 'https://other.test' })).status,
    ).toBe(403);
    expect((await refresh([address(), address()])).status).toBe(400);
    expect(mocks.observe).not.toHaveBeenCalled();
    await mocks.db
      .prepare(
        `CREATE TRIGGER reject_balance BEFORE INSERT ON wallet_balance_snapshots WHEN NEW.address='${address(2)}' BEGIN SELECT RAISE(ABORT,'storage failed'); END`,
      )
      .run();
    mocks.observe.mockResolvedValue(snapshot([address(), address(2)]));
    expect((await refresh([address(), address(2)])).status).toBe(503);
    expect((await list()).balances).toEqual([]);
    await mocks.db.prepare('DROP TRIGGER reject_balance').run();
  });
});

const holdingsRead = () =>
  getHoldings(
    new Request(
      'http://localhost/api/wallet-workspace/holdings?address=' + address(),
    ),
  );
const holdingsRefresh = (
  headers = {},
  body = { chain: 'Solana', address: address() },
) =>
  refreshHoldings(
    new Request('http://localhost/api/wallet-workspace/holdings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const holdingsSnapshot = (minSlot = 100, maxSlot = 101) => ({
  chain: 'Solana',
  address: address(),
  holdings: [],
  accountCount: 0,
  slots: [],
  minSlot,
  maxSlot,
  source: 'rpc.test',
  commitment: 'confirmed',
  observedAt: new Date().toISOString(),
});
describe('retained token holdings', () => {
  it('distinguishes provider access and rate limits without exposing provider credentials or replacing saved holdings', async () => {
    await create();
    await add();
    mocks.holdings.mockResolvedValue(holdingsSnapshot());
    expect((await holdingsRefresh()).status).toBe(200);
    for (const [status, code] of [
      [401, 'HOLDINGS_PROVIDER_ACCESS_DENIED'],
      [403, 'HOLDINGS_PROVIDER_ACCESS_DENIED'],
      [429, 'HOLDINGS_PROVIDER_RATE_LIMITED'],
      [500, 'HOLDINGS_PROVIDER_UNAVAILABLE'],
    ] as const) {
      await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
      mocks.holdings.mockRejectedValue(
        new HoldingsReadError('getTokenAccountsByOwner', 'rpc.test', status),
      );
      const response = await holdingsRefresh();
      expect(response.status).toBe(502);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe(code);
      expect(JSON.stringify(data)).not.toContain('rpc.test');
      expect(JSON.stringify(data)).not.toContain('getTokenAccountsByOwner');
      expect(await (await holdingsRead()).json()).toMatchObject({
        snapshot: { minSlot: 100, maxSlot: 101 },
      });
    }
  });
  it('saves a complete empty inventory, retains it on reload and scopes reads and refreshes to the owner', async () => {
    await create();
    await add();
    mocks.holdings.mockResolvedValue(holdingsSnapshot());
    expect((await holdingsRefresh()).status).toBe(200);
    expect(await (await holdingsRead()).json()).toMatchObject({
      snapshot: { accountCount: 0, minSlot: 100, maxSlot: 101 },
    });
    expect((await holdingsRefresh()).status).toBe(429);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await holdingsRead()).status).toBe(404);
    expect((await holdingsRefresh()).status).toBe(404);
    expect(mocks.holdings).toHaveBeenCalledTimes(1);
    mocks.user = null;
    expect((await holdingsRead()).status).toBe(401);
    expect((await holdingsRefresh()).status).toBe(401);
  });
  it('retains exact grouped balances and account status without numeric coercion', async () => {
    await create();
    await add();
    const holding = {
      mint: address(3),
      program: 'Token-2022 fixture',
      raw: '9007199254740993',
      amount: '9007199254.740993',
      decimals: 6,
      accounts: [
        {
          address: address(2),
          raw: '9007199254740993',
          frozen: true,
          extensions: true,
        },
      ],
    };
    mocks.holdings.mockResolvedValue({
      ...holdingsSnapshot(),
      holdings: [holding],
      accountCount: 1,
    });
    expect((await holdingsRefresh()).status).toBe(200);
    expect(await (await holdingsRead()).json()).toMatchObject({
      snapshot: { holdings: [holding], accountCount: 1 },
    });
  });
  it('retains the previous observation on provider failure and overlapping older slot ranges', async () => {
    await create();
    await add();
    mocks.holdings.mockResolvedValue(holdingsSnapshot());
    await holdingsRefresh();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.holdings.mockRejectedValue(new Error('secret provider credential'));
    const failed = await holdingsRefresh();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret');
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.holdings.mockResolvedValue(holdingsSnapshot(99, 102));
    expect((await holdingsRefresh()).status).toBe(409);
    expect(await (await holdingsRead()).json()).toMatchObject({
      snapshot: { minSlot: 100, maxSlot: 101 },
    });
  });
  it('rejects wallet revisions and wallet archives that occur while provider requests run', async () => {
    await create();
    await add();
    mocks.holdings.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE workspace_wallets SET revision=revision+1')
        .run();
      return holdingsSnapshot();
    });
    expect((await holdingsRefresh()).status).toBe(409);
    expect(await (await holdingsRead()).json()).toEqual({ snapshot: null });
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.holdings.mockImplementation(async () => {
      await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
      return holdingsSnapshot();
    });
    expect((await holdingsRefresh()).status).toBe(409);
    expect((await holdingsRefresh()).status).toBe(404);
  });
  it('allows archived observations to be read and rejects unsupported chains and malformed writes', async () => {
    await create();
    await add();
    mocks.holdings.mockResolvedValue(holdingsSnapshot());
    await mocks.db.prepare('UPDATE wallet_folders SET archived=1').run();
    expect((await holdingsRefresh()).status).toBe(200);
    await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
    expect((await holdingsRead()).status).toBe(200);
    expect((await holdingsRefresh()).status).toBe(404);
    expect(
      (await holdingsRefresh({ origin: 'https://evil.test' })).status,
    ).toBe(403);
    expect(
      (await holdingsRefresh({ 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect(
      (await holdingsRefresh({}, { chain: 'BNB', address: address() })).status,
    ).toBe(400);
  });
});

describe('retained EVM token observations', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const contract = '0x2222222222222222222222222222222222222222';
  const read = () =>
    getEvmHoldings(
      new Request(
        'http://localhost/api/wallet-workspace/evm-holdings?chain=Ethereum&address=' +
          address,
      ),
    );
  const refresh = () =>
    refreshEvmHoldings(
      new Request('http://localhost/api/wallet-workspace/evm-holdings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain: 'Ethereum',
          address,
          contracts: [contract],
        }),
      }),
    );
  const snapshot = {
    chain: 'Ethereum',
    address,
    holdings: [
      {
        contract,
        raw: '9007199254740993',
        amount: '9007199254.740993',
        decimals: 6,
      },
    ],
    blockNumber: 100,
    blockHash: '0x' + 'a'.repeat(64),
    source: 'rpc.test',
    observedAt: new Date().toISOString(),
  };
  async function setup() {
    await mocks.db
      .prepare(
        "INSERT INTO wallet_folders(id,owner_id,name,chain,archived,revision,updated_at) VALUES ('evm-folder','alice','EVM fixture','Ethereum',0,1,'2026-10-10T00:00:00Z')",
      )
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES ('alice','Ethereum',?,'evm-folder','EVM fixture','Recipient',0,1,'2026-10-10T00:00:00Z')",
      )
      .bind(address)
      .run();
    mocks.evmHoldings.mockResolvedValue(snapshot);
  }
  it('retains exact amounts and scopes reads, refreshes and the shared throttle to the owner', async () => {
    await setup();
    expect((await refresh()).status).toBe(200);
    expect(await (await read()).json()).toEqual({ snapshot });
    expect((await refresh()).status).toBe(429);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read()).status).toBe(404);
    expect((await refresh()).status).toBe(404);
    mocks.user = null;
    expect((await read()).status).toBe(401);
    expect((await refresh()).status).toBe(401);
  });
  it('retains prior observations on incomplete provider reads and older blocks', async () => {
    await setup();
    await refresh();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.evmHoldings.mockRejectedValue(new Error('secret provider details'));
    const failed = await refresh();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('secret');
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.evmHoldings.mockResolvedValue({ ...snapshot, blockNumber: 99 });
    expect((await refresh()).status).toBe(409);
    expect(await (await read()).json()).toEqual({ snapshot });
  });
  it('rejects roster changes during observation and allows archived retained reads', async () => {
    await setup();
    mocks.evmHoldings.mockImplementation(async () => {
      await mocks.db
        .prepare('UPDATE workspace_wallets SET revision=revision+1')
        .run();
      return snapshot;
    });
    expect((await refresh()).status).toBe(409);
    expect(await (await read()).json()).toEqual({ snapshot: null });
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.evmHoldings.mockResolvedValue(snapshot);
    expect((await refresh()).status).toBe(200);
    await mocks.db.prepare('UPDATE wallet_folders SET archived=1').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    expect((await refresh()).status).toBe(200);
    await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
    expect((await refresh()).status).toBe(404);
    expect((await read()).status).toBe(200);
  });
});

it('saves, edits, reads and restores public wallets with no folder, without duplicating them', async () => {
  expect((await add('')).status).toBe(200);
  expect((await list()).folders).toHaveLength(0);
  expect((await list()).wallets[0]).toMatchObject({
    folderId: '',
    folderIds: [],
    revision: 1,
  });
  expect(
    (
      await write({
        action: 'wallet.edit',
        address: address(),
        revision: 1,
        folderId: '',
        label: 'No folder',
        role: 'Recipient',
      })
    ).status,
  ).toBe(200);
  mocks.observe.mockResolvedValue(snapshot());
  expect((await refresh()).status).toBe(200);
  expect((await list()).balances).toHaveLength(1);
  expect(
    (
      await write({
        action: 'wallet.archive',
        wallets: [{ address: address(), revision: 2 }],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await write({
        action: 'wallet.restore',
        wallets: [{ address: address(), revision: 3 }],
      })
    ).status,
  ).toBe(200);
  expect((await list()).wallets[0]).toMatchObject({
    folderIds: [],
    archived: false,
    revision: 4,
  });
});
it('clears all memberships atomically and rejects stale or foreign empty assignments', async () => {
  await create();
  await add();
  const action = {
    action: 'wallet.folders',
    wallets: [{ address: address(), revision: 1 }],
    folders: [],
  };
  mocks.user = { userId: 'foreign', email: 'foreign@test.example' };
  expect((await write(action)).status).toBe(409);
  mocks.user = { userId: 'alice', email: 'alice@test.example' };
  expect((await write(action)).status).toBe(200);
  expect((await list()).wallets[0]).toMatchObject({
    folderId: '',
    folderIds: [],
    revision: 2,
  });
  expect((await write(action)).status).toBe(409);
  expect(
    (
      await write({
        ...action,
        wallets: [{ address: address(), revision: 2 }],
        folders: [{ id: 'a', revision: 1 }],
      })
    ).status,
  ).toBe(200);
  expect((await list()).wallets[0].folderIds).toEqual(['a']);
});

it('toggles one folder across heterogeneous wallets while preserving unrelated memberships and unchanged revisions', async () => {
  await create('a');
  await create('b');
  await create('c');
  await add('a', [{ address: address(), label: '', role: 'Recipient' }]);
  await add('b', [{ address: address(2), label: '', role: 'Recipient' }]);
  await write({
    action: 'wallet.folders',
    wallets: [{ address: address(), revision: 1 }],
    folders: [
      { id: 'a', revision: 1 },
      { id: 'c', revision: 1 },
    ],
  });
  const toggle = {
    action: 'wallet.folder-toggle',
    wallets: [
      { address: address(), revision: 2 },
      { address: address(2), revision: 1 },
    ],
    folder: { id: 'a', revision: 1 },
    member: true,
  };
  expect((await write(toggle)).status).toBe(200);
  let rows = (await list()).wallets;
  expect(rows.find((w) => w.address === address())).toMatchObject({
    folderIds: ['a', 'c'],
    folderId: 'a',
    revision: 2,
  });
  expect(rows.find((w) => w.address === address(2))).toMatchObject({
    folderIds: ['b', 'a'],
    folderId: 'b',
    revision: 2,
  });
  expect(
    (
      await write({
        ...toggle,
        wallets: rows.map((w) => ({
          address: w.address,
          revision: w.revision,
        })),
        member: false,
      })
    ).status,
  ).toBe(200);
  rows = (await list()).wallets;
  expect(rows.find((w) => w.address === address())).toMatchObject({
    folderIds: ['c'],
    folderId: 'c',
    revision: 3,
  });
  expect(rows.find((w) => w.address === address(2))).toMatchObject({
    folderIds: ['b'],
    folderId: 'b',
    revision: 3,
  });
  expect(
    (
      await write({
        ...toggle,
        wallets: [{ address: address(), revision: 3 }],
        folder: { id: 'c', revision: 1 },
        member: false,
      })
    ).status,
  ).toBe(200);
  expect(
    (await list()).wallets.find((w) => w.address === address()),
  ).toMatchObject({ folderIds: [], folderId: '' });
});
it('rejects stale wallets, stale or archived folders and foreign owners before changing any toggled membership', async () => {
  await create('a');
  await create('b');
  await add('a', [
    { address: address(), label: '', role: 'Recipient' },
    { address: address(2), label: '', role: 'Recipient' },
  ]);
  const toggle = {
    action: 'wallet.folder-toggle',
    wallets: [
      { address: address(), revision: 1 },
      { address: address(2), revision: 2 },
    ],
    folder: { id: 'b', revision: 1 },
    member: true,
  };
  expect((await write(toggle)).status).toBe(409);
  toggle.wallets[1].revision = 1;
  expect(
    (await write({ ...toggle, folder: { id: 'b', revision: 2 } })).status,
  ).toBe(409);
  mocks.user = { userId: 'foreign', email: 'foreign@example.test' };
  expect((await write(toggle)).status).toBe(409);
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  await write({ action: 'folder.archive', id: 'b', revision: 1 });
  expect(
    (await write({ ...toggle, folder: { id: 'b', revision: 2 } })).status,
  ).toBe(409);
  expect(
    (await list()).wallets.every(
      (w) => w.revision === 1 && w.folderIds?.join(',') === 'a',
    ),
  ).toBe(true);
});

it('persists normalized folder colors with owner and revision protection', async () => {
  expect((await create()).status).toBe(200);
  expect((await list()).folders[0].color).toBe('#A6B1FF');
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'a',
        revision: 1,
        name: 'Teal folder',
        color: '#12abef',
      })
    ).status,
  ).toBe(200);
  expect((await list()).folders[0]).toMatchObject({
    name: 'Teal folder',
    color: '#12ABEF',
    revision: 2,
  });
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'a',
        revision: 1,
        name: 'Stale',
        color: '#ED5B5E',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'a',
        chain: 'Base',
        revision: 2,
        name: 'Wrong network',
        color: '#ED5B5E',
      })
    ).status,
  ).toBe(409);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'a',
        revision: 2,
        name: 'Other owner',
        color: '#ED5B5E',
      })
    ).status,
  ).toBe(409);
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  expect(
    (
      await write({
        action: 'folder.rename',
        id: 'a',
        revision: 2,
        name: 'Legacy rename',
      })
    ).status,
  ).toBe(200);
  expect((await list()).folders[0]).toMatchObject({
    color: '#12ABEF',
    revision: 3,
  });
  expect(
    (await write({ action: 'folder.archive', id: 'a', revision: 3 })).status,
  ).toBe(200);
  expect(
    (await write({ action: 'folder.restore', id: 'a', revision: 4 })).status,
  ).toBe(200);
  expect((await list()).folders[0]).toMatchObject({
    color: '#12ABEF',
    revision: 5,
    archived: false,
  });
});
it('rejects malformed folder colors without changing metadata', async () => {
  await create();
  for (const color of [
    'red',
    '#123',
    '#12345678',
    'url(javascript:alert(1))',
    null,
    123,
  ]) {
    expect(
      (
        await write({
          action: 'folder.update',
          id: 'a',
          revision: 1,
          name: 'Rejected',
          color,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await write({
          action: 'folder.create',
          id: 'bad',
          name: 'Rejected',
          color,
        })
      ).status,
    ).toBe(400);
  }
  expect((await list()).folders).toHaveLength(1);
  expect((await list()).folders[0]).toMatchObject({
    name: 'Folder a',
    color: '#A6B1FF',
    revision: 1,
  });
});

it('rejects duplicate names across active and archived folders while allowing other networks and owners', async () => {
  const folder = (id: string, name: string, chain = 'Solana') =>
    write({ action: 'folder.create', id, name, chain });
  expect((await folder('a', 'Café wallets')).status).toBe(200);
  expect((await folder('b', '  CAFÉ WALLETS  ')).status).toBe(409);
  expect(
    (await write({ action: 'folder.archive', id: 'a', revision: 1 })).status,
  ).toBe(200);
  expect((await folder('b', 'café wallets')).status).toBe(409);
  expect((await folder('b', 'Other')).status).toBe(200);
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'b',
        revision: 1,
        name: 'CAFÉ wallets',
        color: '#123456',
      })
    ).status,
  ).toBe(409);
  expect((await list()).folders.find((f) => f.id === 'b')).toMatchObject({
    name: 'Other',
    color: '#A6B1FF',
    revision: 1,
  });
  expect(
    (
      await write({
        action: 'folder.update',
        id: 'b',
        revision: 1,
        name: ' Other ',
        color: '#123456',
      })
    ).status,
  ).toBe(200);
  expect((await folder('base', 'Café wallets', 'Base')).status).toBe(200);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect((await folder('a', 'Café wallets')).status).toBe(200);
});
it('admits only one concurrent create or rename to the same normalized folder name', async () => {
  const createResults = await Promise.all(
    ['a', 'b'].map((id) =>
      write({
        action: 'folder.create',
        id,
        name: id === 'a' ? 'Shared' : ' SHARED ',
      }),
    ),
  );
  expect(
    createResults.map((result) => result.status).sort((a, b) => a - b),
  ).toEqual([200, 409]);
  expect((await list()).folders).toHaveLength(1);
  await create('c');
  await create('d');
  const editResults = await Promise.all(
    ['c', 'd'].map((id) =>
      write({
        action: 'folder.update',
        id,
        revision: 1,
        name: id === 'c' ? 'Target' : 'TARGET',
        color: '#123456',
      }),
    ),
  );
  expect(
    editResults.map((result) => result.status).sort((a, b) => a - b),
  ).toEqual([200, 409]);
  expect(
    (await list()).folders.filter(
      (folder) => folder.name.toLowerCase() === 'target',
    ),
  ).toHaveLength(1);
});

it('deletes only the folder and preserves wallets, other memberships and retained observations', async () => {
  await create('a');
  await create('b');
  await add('a');
  await add('a', [
    { address: address(2), label: 'Archived member', role: 'Recipient' },
  ]);
  await add('b', [
    { address: address(3), label: 'Unrelated', role: 'Recipient' },
  ]);
  await write({
    action: 'wallet.folder-toggle',
    folder: { id: 'b', revision: 1 },
    wallets: [{ address: address(), revision: 1 }],
    member: true,
  });
  await write({
    action: 'wallet.archive',
    wallets: [{ address: address(2), revision: 1 }],
  });
  await mocks.db
    .prepare(
      "INSERT INTO wallet_balance_snapshots (owner_id,chain,address,document,block_number) VALUES ('alice','Solana',?,'{}',1)",
    )
    .bind(address())
    .run();
  const before = await list();
  expect(
    (await write({ action: 'folder.delete', id: 'a', revision: 1 })).status,
  ).toBe(200);
  const after = await list();
  expect(after.folders.map((folder) => folder.id)).toEqual(['b']);
  expect(after.wallets).toHaveLength(3);
  expect(
    after.wallets.find((wallet) => wallet.address === address()),
  ).toMatchObject({
    folderId: 'b',
    folderIds: ['b'],
    archived: false,
    revision: 3,
  });
  expect(
    after.wallets.find((wallet) => wallet.address === address(2)),
  ).toMatchObject({ folderId: '', folderIds: [], archived: true, revision: 3 });
  expect(after.wallets.find((wallet) => wallet.address === address(3))).toEqual(
    before.wallets.find((wallet) => wallet.address === address(3)),
  );
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS count FROM wallet_balance_snapshots')
      .first(),
  ).toEqual({ count: 1 });
  expect(
    (await write({ action: 'folder.delete', id: 'a', revision: 1 })).status,
  ).toBe(409);
});
it('rejects stale, wrong-network and other-owner folder deletion without modifying any wallet', async () => {
  await create();
  await add();
  const before = await list();
  expect(
    (await write({ action: 'folder.delete', id: 'a', revision: 2 })).status,
  ).toBe(409);
  expect(
    (
      await write({
        action: 'folder.delete',
        id: 'a',
        revision: 1,
        chain: 'Base',
      })
    ).status,
  ).toBe(409);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect(
    (await write({ action: 'folder.delete', id: 'a', revision: 1 })).status,
  ).toBe(409);
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  expect(await list()).toEqual(before);
});
it('rolls membership removal back when folder deletion fails', async () => {
  await create();
  await add();
  const before = await list();
  await mocks.db
    .prepare(
      "CREATE TRIGGER reject_folder_delete BEFORE DELETE ON wallet_folders BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    .run();
  try {
    expect(
      (await write({ action: 'folder.delete', id: 'a', revision: 1 })).status,
    ).toBe(503);
    expect(await list()).toEqual(before);
  } finally {
    await mocks.db.prepare('DROP TRIGGER reject_folder_delete').run();
  }
});

it('normalizes wallet tags and rejects malformed or excessive labels', () => {
  expect(walletTags([' Team ', 'team', 'Reserve'])).toEqual([
    'Team',
    'Reserve',
  ]);
  for (const value of [
    'team',
    [''],
    ['a,b'],
    ['bad\nlabel'],
    ['x'.repeat(31)],
    Array(11).fill('tag'),
    [42],
  ])
    expect(() => walletTags(value)).toThrow();
});
it('persists tags through owned revision edits, archives and restore without dropping omitted legacy tags', async () => {
  await create();
  expect(
    (
      await write({
        action: 'wallet.add',
        folderId: 'a',
        wallets: [
          {
            address: address(),
            label: 'Tagged wallet',
            role: 'Recipient',
            tags: [' Team ', 'team', 'Reserve'],
          },
        ],
      })
    ).status,
  ).toBe(200);
  expect((await list()).wallets[0].tags).toEqual(['Team', 'Reserve']);
  const edit = {
    action: 'wallet.edit',
    address: address(),
    revision: 1,
    label: 'Tagged wallet',
    role: 'Recipient',
    folderId: 'a',
    tags: ['Launch'],
  };
  expect((await write(edit)).status).toBe(200);
  expect((await write({ ...edit, tags: ['Stale'] })).status).toBe(409);
  expect((await list()).wallets[0].tags).toEqual(['Launch']);
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
  expect((await list()).wallets).toEqual([]);
  expect((await write({ ...edit, revision: 2, tags: ['Other'] })).status).toBe(
    409,
  );
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  const { tags: _, ...legacy } = edit;
  expect((await write({ ...legacy, revision: 2 })).status).toBe(200);
  expect((await list()).wallets[0].tags).toEqual(['Launch']);
  expect(
    (
      await write({
        action: 'wallet.archive',
        wallets: [{ address: address(), revision: 3 }],
      })
    ).status,
  ).toBe(200);
  expect((await list()).wallets[0].tags).toEqual(['Launch']);
  expect(
    (
      await write({
        action: 'wallet.restore',
        wallets: [{ address: address(), revision: 4 }],
      })
    ).status,
  ).toBe(200);
  expect((await write({ ...edit, revision: 5, tags: [] })).status).toBe(200);
  expect((await list()).wallets[0].tags).toEqual([]);
});

it('edits tags without changing retained archived folder memberships and rejects new assignments to archived folders', async () => {
  await create();
  await create('b');
  await add();
  expect(
    (
      await write({
        action: 'wallet.folders',
        wallets: [{ address: address(), revision: 1 }],
        folders: [
          { id: 'a', revision: 1 },
          { id: 'b', revision: 1 },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (await write({ action: 'folder.archive', id: 'a', revision: 1 })).status,
  ).toBe(200);
  const wallet = (await list()).wallets[0];
  expect(
    (
      await write({
        action: 'wallet.edit',
        address: address(),
        revision: wallet.revision,
        label: 'Tagged',
        role: 'Recipient',
        folderId: 'a',
        tags: ['Reserve'],
      })
    ).status,
  ).toBe(200);
  expect((await list()).wallets[0]).toMatchObject({
    tags: ['Reserve'],
    folderIds: ['a', 'b'],
    folderId: 'a',
  });
  await add('b', [{ address: address(2), label: 'Other', role: 'Recipient' }]);
  expect(
    (
      await write({
        action: 'wallet.edit',
        address: address(2),
        revision: 1,
        label: 'Other',
        role: 'Recipient',
        folderId: 'a',
        tags: ['Reserve'],
      })
    ).status,
  ).toBe(409);
  expect(
    (await list()).wallets.find((w) => w.address === address(2))?.tags,
  ).toEqual([]);
});
