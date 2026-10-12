import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import {
  supplyFixture,
  supplyScope,
  supplyProject,
  supplyWallet,
} from '../../../../test/supply-history-fixture';
import {
  captureSupply,
  supplyScopeId,
  type SupplyHistoryRow,
} from '@/lib/supply-history';
const mocks = vi.hoisted(() => ({
  user: { userId: 'one' } as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
  accounts: vi.fn(),
}));
vi.mock('@/lib/supply-token-accounts', () => ({
  observeSupplyTokenAccounts: mocks.accounts,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/supply-movement-evidence', async (original) => ({
  ...(await original<typeof import('@/lib/supply-movement-evidence')>()),
  observeSupplyMovementEvidence: mocks.observe,
}));
import { GET, POST } from './route';
import { directMovementFixture } from '../../../../test/direct-movement-fixture';
import { classifyWalletMovement } from '@/lib/wallet-movement-classification';
let mf: Miniflare;
let current: SupplyHistoryRow;
const wallet = supplyScope.wallets[0].address;
const migration = [
  '0063_imported_supply_history',
  '0064_supply_movement_evidence',
].flatMap((name) =>
  readFileSync(`drizzle/${name}.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean),
);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'movement-tests',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'movement-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'movement-tests');
  await mocks.db
    .prepare(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER)',
    )
    .run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  mocks.observe.mockReset();
  mocks.accounts.mockReset().mockResolvedValue({
    wallet,
    mint: supplyScope.mint,
    decimals: 6,
    slot: 200,
    accounts: [supplyWallet(5)],
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
  });
  for (const table of [
    'supply_movement_evidence',
    'imported_supply_observations',
    'imported_supply_scopes',
    'imported_supply_read_gates',
  ])
    await mocks.db.prepare('DROP TABLE IF EXISTS ' + table).run();
  for (const statement of migration) await mocks.db.prepare(statement).run();
  await mocks.db.prepare('DELETE FROM imported_token_projects').run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1)')
    .bind('one', supplyProject)
    .run();
  const scopeId = await supplyScopeId(supplyScope);
  const previous: SupplyHistoryRow = {
    id: 'first',
    sequence: 1,
    scopeId,
    document: captureSupply(supplyFixture(), supplyScope, 1, null),
  };
  current = {
    id: 'second',
    sequence: 2,
    scopeId,
    document: captureSupply(supplyFixture(1), supplyScope, 1, previous),
  };
  await mocks.db
    .prepare(
      'INSERT INTO imported_supply_scopes(owner_id,project_id,id,document,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      'one',
      supplyProject,
      scopeId,
      JSON.stringify(supplyScope),
      new Date().toISOString(),
    )
    .run();
  for (const row of [previous, current])
    await mocks.db
      .prepare(
        'INSERT INTO imported_supply_observations(sequence,id,owner_id,project_id,scope_id,document,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        row.sequence,
        row.id,
        'one',
        supplyProject,
        scopeId,
        JSON.stringify(row.document),
        new Date().toISOString(),
      )
      .run();
  mocks.observe.mockResolvedValue({
    observationId: current.id,
    wallet,
    mint: supplyScope.mint,
    fromSlot: 101,
    toSlot: 141,
    anchor: 200,
    requestedCursor: null,
    nextCursor: null,
    scannedSignatures: 0,
    failedSignatures: 0,
    unavailableTransactions: 0,
    completeThroughBoundary: true,
    transactions: [],
    observedAt: new Date().toISOString(),
  });
});
const terms = () => ({
  id: supplyProject,
  revision: 1,
  observationId: current.id,
  wallet,
});
const post = (extra = {}) =>
  new Request('http://localhost/api/imported-projects/supply-movements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...terms(), ...extra }),
  });
const get = () =>
  new Request(
    'http://localhost/api/imported-projects/supply-movements?' +
      new URLSearchParams({ ...terms(), revision: '1' }),
  );
it('discovers current token accounts without creating an evidence record and shares read pacing', async () => {
  const response = await POST(post({ mode: 'accounts' }));
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { accounts: { accounts: string[] } }).accounts
      .accounts,
  ).toEqual([supplyWallet(5)]);
  expect((await POST(post())).status).toBe(429);
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(
    ((await (await GET(get())).json()) as { items: unknown[] }).items,
  ).toEqual([]);
});
it('binds retained cursors to their original signature index and reloads account evidence', async () => {
  const cursor = JSON.stringify({
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    slot: 130,
    anchor: 200,
  });
  const value = await mocks.observe();
  mocks.observe.mockClear();
  mocks.observe.mockResolvedValue({
    ...value,
    indexedAddress: supplyWallet(5),
    accountObservedSlot: 200,
    nextCursor: cursor,
  });
  expect((await POST(post({ indexedAddress: supplyWallet(5) }))).status).toBe(
    200,
  );
  await mocks.db.prepare('DELETE FROM imported_supply_read_gates').run();
  expect((await POST(post({ cursor }))).status).toBe(400);
  mocks.observe.mockResolvedValue({
    ...value,
    indexedAddress: supplyWallet(5),
    accountObservedSlot: 200,
    requestedCursor: cursor,
    nextCursor: null,
  });
  expect(
    (await POST(post({ cursor, indexedAddress: supplyWallet(5) }))).status,
  ).toBe(200);
  const items = (
    (await (await GET(get())).json()) as {
      items: { document: { indexedAddress: string } }[];
    }
  ).items;
  expect(items).toHaveLength(2);
  expect(items[0].document.indexedAddress).toBe(supplyWallet(5));
});
it('reuses an exact saved continuation page without provider reads or duplicate writes, while manual inspection stays fresh', async () => {
  const original = (await (await POST(post())).json()) as { item: unknown };
  mocks.observe.mockClear();
  const cached = await POST(post({ reuseSaved: true }));
  expect(cached.status).toBe(200);
  expect(((await cached.json()) as { item: unknown }).item).toEqual(
    original.item,
  );
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(
    ((await (await GET(get())).json()) as { items: unknown[] }).items,
  ).toHaveLength(1);
  expect((await POST(post({ reuseSaved: 'yes' }))).status).toBe(400);
  expect(
    (await POST(post({ reuseSaved: true, indexedAddress: supplyWallet(8) })))
      .status,
  ).toBe(429);
  await mocks.db.prepare('DELETE FROM imported_supply_read_gates').run();
  expect((await POST(post())).status).toBe(200);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  expect(
    ((await (await GET(get())).json()) as { items: unknown[] }).items,
  ).toHaveLength(2);
  await mocks.db.prepare('UPDATE imported_token_projects SET revision=2').run();
  expect((await POST(post({ reuseSaved: true }))).status).toBe(409);
});
it('retains immutable evidence and reloads it without another provider call', async () => {
  const response = await POST(post());
  expect(response.status).toBe(200);
  const saved = ((await response.json()) as { item: unknown }).item;
  expect(
    ((await (await GET(get())).json()) as { items: unknown[] }).items,
  ).toEqual([saved]);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  await expect(
    mocks.db
      .prepare('UPDATE supply_movement_evidence SET wallet_address=?')
      .bind(supplyWallet(3))
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db.prepare('DELETE FROM supply_movement_evidence').run(),
  ).rejects.toThrow('retained');
});
it('rejects unauthenticated, foreign, unrelated and baseline requests without a provider call', async () => {
  mocks.user = null;
  expect((await GET(get())).status).toBe(401);
  expect((await POST(post())).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await POST(post())).status).toBe(409);
  mocks.user = { userId: 'one' };
  expect((await POST(post({ wallet: supplyWallet(3) }))).status).toBe(409);
  expect((await POST(post({ observationId: 'first' }))).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('paces provider reads and rejects cursors absent from this saved alert', async () => {
  expect((await POST(post({ cursor: '{"bad":true}' }))).status).toBe(400);
  const cursor = JSON.stringify({
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    slot: 130,
    anchor: 200,
  });
  expect((await POST(post({ cursor }))).status).toBe(400);
  expect((await POST(post())).status).toBe(200);
  expect((await POST(post())).status).toBe(429);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
});
it('does not save evidence when the project changes during inspection', async () => {
  const value = await mocks.observe();
  mocks.observe.mockClear();
  mocks.observe.mockImplementationOnce(async () => {
    await mocks.db
      .prepare('UPDATE imported_token_projects SET revision=2')
      .run();
    return value;
  });
  expect((await POST(post())).status).toBe(409);
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM supply_movement_evidence')
        .first<{ count: number }>()
    )?.count,
  ).toBe(0);
});
it('retains saved evidence after a provider failure', async () => {
  await POST(post());
  await mocks.db.prepare('DELETE FROM imported_supply_read_gates').run();
  mocks.observe.mockRejectedValueOnce(new Error('unavailable'));
  expect((await POST(post())).status).toBe(502);
  expect(
    ((await (await GET(get())).json()) as { items: unknown[] }).items,
  ).toHaveLength(1);
});
it.each(['PumpSwap', 'Raydium CPMM', 'Pump.fun'])(
  'persists and restores a decoded %s classification through the authenticated real route',
  async (protocol) => {
    const tx =
      protocol === 'Pump.fun'
        ? (
            await import('../../../../test/pump-native-fixture')
          ).nativePumpFixture()
        : directMovementFixture(protocol === 'PumpSwap' ? 0 : 2, 0);
    if (protocol === 'Pump.fun') {
      tx.tokenChanges[0].mint = supplyScope.mint;
      tx.movementInstructions![0].accounts![2] = supplyScope.mint;
    } else {
      tx.tokenChanges[1].mint = supplyScope.mint;
      tx.movementInstructions![0].accounts![protocol === 'PumpSwap' ? 3 : 11] =
        supplyScope.mint;
      tx.movementInstructions![2].info!.mint = supplyScope.mint;
    }
    const classification = classifyWalletMovement(tx, supplyScope.mint);
    expect(classification).toMatchObject({ kind: 'buy', protocol });
    const evidence = await mocks.observe();
    mocks.observe.mockResolvedValue({
      ...evidence,
      transactions: [
        {
          signature: bs58.encode(new Uint8Array(64).fill(3)),
          slot: 120,
          blockTime: null,
          beforeRaw: '100000',
          afterRaw: '101000',
          changeRaw: '1000',
          decimals: 6,
          source: 'fixture.test',
          classification,
        },
      ],
    });
    expect((await POST(post())).status).toBe(200);
    const response = await GET(get());
    expect(response.status).toBe(200);
    const stored = (await response.json()) as {
      items: Array<{
        document: { transactions: Array<{ classification: unknown }> };
      }>;
    };
    expect(stored.items[0].document.transactions[0].classification).toEqual(
      classification,
    );
  },
);
