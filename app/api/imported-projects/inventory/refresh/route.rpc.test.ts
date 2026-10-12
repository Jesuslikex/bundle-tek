import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
  vi,
} from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { inventoryFixture } from '../../../../../test/imported-wallet-inventory-fixture';
import { sizeSessionSellPercentage } from '@/lib/trade-session-sell-sizing';
import { tradeSessionTerms } from '@/lib/imported-trade-session';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { TOKEN_PROGRAMS } from '@/lib/wallet-holdings';
import type { ImportedWalletInventory } from '@/lib/imported-wallet-inventory';
const mocks = vi.hoisted(() => ({
  user: { userId: 'one' },
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () =>
    mintMode ? 'https://mainnet.helius-rpc.com/' : 'https://rpc.test/',
}));
import { POST } from './route';
import { GET } from '../route';
const id = '00000000-0000-4000-8000-000000000001',
  mint = inventoryFixture().holdings[0].mint;
const wallets = Array.from({ length: 25 }, (_, i) => ({
  address: bs58.encode(new Uint8Array(32).fill(i + 1)),
  revision: 1,
}));
const token = { chain: 'Solana', address: mint, decimals: 6 };
let mf: Miniflare,
  calls: unknown[] = [],
  corrupt = false;
let mintMode = false;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'group-rpc-tests',
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
          env: { DB: { type: 'd1', id: 'group-rpc-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'group-rpc-tests');
  for (const sql of readFileSync(
    'drizzle/0066_wallet_mint_holdings.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await mocks.db.prepare(sql).run();
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,chain TEXT,archived INTEGER,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_holdings_snapshots(owner_id TEXT,chain TEXT,address TEXT,document TEXT,max_slot INTEGER,PRIMARY KEY(owner_id,chain,address))',
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  calls = [];
  corrupt = false;
  mintMode = false;
  for (const table of [
    'imported_token_projects',
    'workspace_wallets',
    'wallet_holdings_snapshots',
    'wallet_balance_gates',
    'wallet_mint_holdings_snapshots',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,?,0,?)')
    .bind('one', id, 'Solana', JSON.stringify({ token }))
    .run();
  for (const w of wallets)
    await mocks.db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
      .bind('one', 'Solana', w.address)
      .run();
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected RPC JSON.');
    const body = JSON.parse(init.body);
    calls.push(body);
    if (mintMode && body.method !== 'getGenesisHash') {
      if (body.method === 'getAccountInfo')
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 100 },
            value: {
              owner: TOKEN_PROGRAMS[0],
              executable: false,
              data: {
                parsed: {
                  type: 'mint',
                  info: { isInitialized: true, decimals: 6 },
                },
              },
            },
          },
        });
      if (
        body.method !== 'getTokenAccountsByOwnerV2' ||
        body.params[1].mint !== mint
      )
        throw new Error('Unexpected mint RPC');
      const owner = body.params[0];
      const second = body.params[2].paginationKey !== undefined;
      const index = wallets.findIndex((w) => w.address === owner);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          context: { slot: second ? 102 : 101 },
          value: {
            paginationKey: second ? null : 'next',
            accounts: [
              {
                pubkey: bs58.encode(
                  new Uint8Array(32).fill((second ? 130 : 100) + index),
                ),
                account: {
                  owner: TOKEN_PROGRAMS[0],
                  executable: false,
                  data: {
                    space: 165,
                    parsed: {
                      type: 'account',
                      info: {
                        owner:
                          corrupt && index === 1 ? wallets[0].address : owner,
                        mint,
                        state: second ? 'initialized' : 'frozen',
                        tokenAmount: {
                          amount: second ? '3003' : '1000',
                          decimals: 6,
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      });
    }
    if (!Array.isArray(body))
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: body.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : 100,
      });
    const account = (
      owner: string,
      program: string,
      n: number,
      amount: string,
      state: string,
      projectMint = true,
    ) => ({
      pubkey: bs58.encode(new Uint8Array(32).fill(n)),
      account: {
        owner: program,
        executable: false,
        data: {
          space: 165,
          parsed: {
            type: 'account',
            info: {
              owner,
              mint: projectMint
                ? mint
                : bs58.encode(new Uint8Array(32).fill(240)),
              state,
              tokenAmount: { amount, decimals: 6 },
            },
          },
        },
      },
    });
    return Response.json(
      body
        .map((call) => {
          const owner = call.params[0],
            index = wallets.findIndex((w) => w.address === owner),
            program = call.params[1].programId;
          const rows =
            program === TOKEN_PROGRAMS[0]
              ? [
                  account(owner, program, 100 + index, '1000', 'frozen'),
                  account(owner, program, 130 + index, '3003', 'initialized'),
                ]
              : [
                  account(
                    owner,
                    program,
                    160 + index,
                    '7',
                    'initialized',
                    false,
                  ),
                ];
          if (corrupt && index === 1)
            rows[0].account.data.parsed.info.owner = wallets[0].address;
          return {
            jsonrpc: '2.0',
            id: call.id,
            result: {
              context: { slot: program === TOKEN_PROGRAMS[0] ? 100 : 101 },
              value: rows,
            },
          };
        })
        .reverse(),
    );
  });
});
const request = () =>
  new Request('http://localhost/api/imported-projects/inventory/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ id, revision: 1, wallets }),
  });
const saved = () =>
  mocks.db
    .prepare(
      'SELECT address,document FROM wallet_holdings_snapshots ORDER BY address',
    )
    .all<{ address: string; document: string }>();
it('persists paginated mint-only evidence separately, reloads selected token inventory and sizes a sell', async () => {
  mintMode = true;
  const selected = wallets.slice(0, 2);
  const mintRequest = () =>
    new Request('http://localhost/api/imported-projects/inventory/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        revision: 1,
        scope: 'mint',
        wallets: selected,
      }),
    });
  expect((await POST(mintRequest())).status).toBe(200);
  expect((await saved()).results).toHaveLength(0);
  const stored = await mocks.db
    .prepare(
      'SELECT document FROM wallet_mint_holdings_snapshots ORDER BY address',
    )
    .all<{ document: string }>();
  expect(stored.results).toHaveLength(2);
  expect(JSON.parse(stored.results[0].document)).toMatchObject({
    scope: 'mint',
    slots: [101, 102],
  });
  const response = await GET(
    new Request(
      `http://localhost/api/imported-projects/inventory?id=${id}&revision=1&scope=mint`,
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: ImportedWalletInventory[] };
  expect(body.items.filter((i) => i.observation)).toHaveLength(2);
  expect(
    body.items.find((i) => i.wallet === selected[0].address)?.observation,
  ).toMatchObject({
    raw: '4003',
    frozenRaw: '1000',
    unfrozenRaw: '3003',
    scope: 'mint',
  });
  expect(
    sizeSessionSellPercentage(
      body.items,
      selected,
      6,
      50,
      Date.now(),
      new Map(),
    ),
  ).toEqual(['0.001501', '0.001501']);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  corrupt = true;
  expect((await POST(mintRequest())).status).toBe(502);
  const retained = await mocks.db
    .prepare(
      'SELECT document FROM wallet_mint_holdings_snapshots ORDER BY address',
    )
    .all<{ document: string }>();
  expect(retained.results).toEqual(stored.results);
});
it('decodes both programs, persists 25 complete observations, reloads inventory and sizes exact session inputs', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(calls).toHaveLength(27);
  expect((await saved()).results).toHaveLength(25);
  const inventory = await GET(
    new Request(
      `http://localhost/api/imported-projects/inventory?id=${id}&revision=1`,
    ),
  );
  expect(inventory.status).toBe(200);
  const data = (await inventory.json()) as { items: ImportedWalletInventory[] };
  expect(data.items).toHaveLength(25);
  expect(
    data.items.every(
      (i) =>
        i.observation !== null &&
        i.observation.raw === '4003' &&
        i.observation.frozenRaw === '1000' &&
        i.observation.unfrozenRaw === '3003',
    ),
  ).toBe(true);
  const amounts = sizeSessionSellPercentage(
    data.items,
    wallets,
    6,
    25,
    Date.now(),
  );
  expect(amounts.every((a) => a === '0.00075')).toBe(true);
  const terms = tradeSessionTerms(
    {
      projectId: id,
      projectRevision: 1,
      side: 'Sell',
      entries: wallets.map((w, index) => ({
        wallet: w.address,
        walletRevision: w.revision,
        amount: amounts[index],
      })),
    },
    token,
  );
  expect(terms.totalRaw).toBe('18750');
  expect(terms.entries).toHaveLength(25);
});
it('preserves all stored observations when actual account decoding rejects one wallet', async () => {
  expect((await POST(request())).status).toBe(200);
  const before = (await saved()).results;
  await mocks.db
    .prepare('UPDATE wallet_balance_gates SET next_allowed_at=0')
    .run();
  corrupt = true;
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect((await saved()).results).toEqual(before);
});
