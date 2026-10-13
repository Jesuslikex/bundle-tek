import { expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { env } from 'cloudflare:workers';
import { readFileSync } from 'node:fs';
import { supplyWallet as address } from '../../../../test/supply-history-fixture';
import { SOLANA_MAINNET_GENESIS } from '../../../../lib/wallet-balances';
import { readHolderIndexHistory } from '../../../../lib/holder-index-history-client';
import { holderIndexSummary } from '../../../../lib/holder-index';
import { holderIndexWithheldFees } from '../../../../lib/holder-index-withheld';

const state = vi.hoisted(() => ({
  db: null as D1Database | null,
  owner: 'mint-fee-owner',
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: state.owner }),
}));
vi.mock('@/db', () => ({ getD1: () => state.db! }));
import { POST, GET } from './route';

it('persists live-shaped mint/account fees through the real provider, routes and D1; rejects changing observations and cumulative over-counting', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'holder-mint-fees-test',
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
          env: { DB: { type: 'd1', id: 'holder-mint-fees-disposable' } },
        },
      },
    ],
  });
  let mintFee = '2',
    amount = '5',
    accountFee = '3',
    cursor: string | null = 'next-page',
    mintSlot = 201;
  let calls = 0;
  const runId = '00000000-0000-4000-8000-000000000021';
  const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  try {
    const db = await mf.getD1Database('DB', 'holder-mint-fees-test');
    state.db = db;
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const chunks = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(chunks.map((sql) => db.prepare(sql)));
    }
    await db
      .prepare(
        'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
      )
      .bind(
        state.owner,
        'mint-project',
        'Solana',
        address(9),
        '{}',
        'mint-fees-fixture',
        new Date().toISOString(),
      )
      .run();
    env.SOLANA_INDEXER_RPC_URL = 'https://mint-fees-fixture.test';
    vi.stubGlobal(
      'fetch',
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        if (typeof init?.body !== 'string')
          throw new Error('RPC JSON required.');
        const query = JSON.parse(init.body);
        const result =
          query.method === 'getGenesisHash'
            ? SOLANA_MAINNET_GENESIS
            : query.method === 'getTokenSupply'
              ? { context: { slot: 200 }, value: { amount: '20', decimals: 6 } }
              : query.method === 'getAccountInfo'
                ? {
                    context: { slot: mintSlot },
                    value: {
                      owner: program,
                      executable: false,
                      data: {
                        parsed: {
                          type: 'mint',
                          info: {
                            supply: '20',
                            decimals: 6,
                            isInitialized: true,
                            extensions: [
                              {
                                extension: 'transferFeeConfig',
                                state: { withheldAmount: mintFee },
                              },
                            ],
                          },
                        },
                      },
                    },
                  }
                : {
                    context: { slot: mintSlot + 1 },
                    value: {
                      paginationKey: cursor,
                      accounts: [
                        {
                          pubkey: address(cursor ? 1 : 2),
                          account: {
                            owner: program,
                            executable: false,
                            data: {
                              parsed: {
                                type: 'account',
                                info: {
                                  mint: address(9),
                                  owner: address(cursor ? 7 : 8),
                                  state: 'initialized',
                                  tokenAmount: { amount, decimals: 6 },
                                  extensions: [
                                    {
                                      extension: 'transferFeeAmount',
                                      state: { withheldAmount: accountFee },
                                    },
                                  ],
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  };
        return Response.json({ jsonrpc: '2.0', id: 1, result });
      },
    );
    const post = (page: number) =>
      POST(
        new Request('https://bundle.test/api/imported-projects/holder-index', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'mint-project',
            revision: 1,
            runId,
            page,
            enumeration: 'program-accounts-v2',
          }),
        }),
      );
    expect((await post(1)).status).toBe(200);
    expect(calls).toBe(4);
    expect((await post(1)).status).toBe(200);
    expect(calls).toBe(4);
    mintFee = '4';
    cursor = null;
    amount = '10';
    accountFee = '0';
    mintSlot = 203;
    const changedMint = await post(2);
    expect(changedMint.status).toBe(409);
    const changedBody = (await changedMint.json()) as { error: string };
    expect(changedBody.error).toContain('Start a fresh scan');
    expect(
      (
        await db
          .prepare('SELECT last_page FROM holder_index_runs')
          .first<{ last_page: number }>()
      )?.last_page,
    ).toBe(1);
    mintFee = '2';
    amount = '12';
    accountFee = '4';
    expect((await post(2)).status).toBe(409);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM holder_index_pages')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    amount = '10';
    accountFee = '0';
    expect((await post(2)).status).toBe(200);
    const readsBeforeReload = calls;
    const history = await readHolderIndexHistory(
      { id: 'mint-project', revision: 1, mint: address(9), decimals: 6 },
      runId,
      new AbortController().signal,
      async (url) => {
        if (typeof url !== 'string')
          throw new Error('Local history URL required.');
        return GET(new Request(new URL(url, 'https://bundle.test')));
      },
    );
    expect(calls).toBe(readsBeforeReload);
    const scan = history.scan!;
    expect([scan.minMintSlot, scan.maxMintSlot]).toEqual([201, 203]);
    expect(scan.status).toBe('enumerated');
    expect(holderIndexSummary(scan).coveredPercent).toBe(75);
    expect(holderIndexWithheldFees(scan)).toMatchObject({
      raw: '3',
      mintRaw: '2',
      reportedAccounts: 2,
      remainderAfterObservedFeesRaw: '0',
    });
    const row = await db
      .prepare('SELECT document,indexed_raw FROM holder_index_runs')
      .first<{ document: string; indexed_raw: string }>();
    expect(row?.indexed_raw).toBe('15');
    expect(JSON.parse(row!.document)).toMatchObject({
      observedAccountWithheldRaw: '3',
      mintObservation: { withheldRaw: '2' },
    });
    expect((await post(2)).status).toBe(200);
    expect(calls).toBe(readsBeforeReload);
    state.owner = 'different-owner';
    expect(
      (
        await GET(
          new Request(
            `https://bundle.test/api/imported-projects/holder-index?id=mint-project&revision=1&run=${runId}`,
          ),
        )
      ).status,
    ).toBe(404);
  } finally {
    delete env.SOLANA_INDEXER_RPC_URL;
    vi.unstubAllGlobals();
    state.owner = 'mint-fee-owner';
    state.db = null;
    await mf.dispose();
  }
});
