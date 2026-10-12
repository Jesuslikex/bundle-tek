import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { supplyWallet } from '../../../../test/supply-history-fixture';
import { readHolderIndexPageWithRetry } from '../../../../lib/holder-index-retry';
import { readHolderIndexHistory } from '../../../../lib/holder-index-history-client';
import { holderIndexSummary } from '../../../../lib/holder-index';
const state = vi.hoisted(() => ({
  db: null as D1Database | null,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'retry-owner' }),
}));
vi.mock('@/db', () => ({ getD1: () => state.db! }));
vi.mock('@/lib/holder-index-provider', () => ({
  observeHolderIndexPage: state.observe,
}));
import { POST, GET } from './route';
const indexedAddress = (n: number) => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(n);
  return bs58.encode(bytes);
};
it('recovers a lost committed page through the actual route and D1 without rereading or double counting 1000 accounts', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'holder-retry-test',
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
          env: { DB: { type: 'd1', id: 'holder-retry-isolated' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'holder-retry-test');
    state.db = db;
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const statements = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(statements.map((s) => db.prepare(s)));
    }
    const mint = supplyWallet(9),
      runId = '00000000-0000-4000-8000-000000000010';
    await db
      .prepare(
        'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
      )
      .bind(
        'retry-owner',
        'retry-project',
        'Solana',
        mint,
        '{}',
        'retry-fixture',
        new Date().toISOString(),
      )
      .run();
    state.observe.mockImplementation(async (_mint: string, page: number) => ({
      mint,
      page,
      decimals: 6,
      totalSupplyRaw: '1000000',
      supplySlot: 200,
      indexedSlot: 190,
      observedAt: new Date().toISOString(),
      source: 'provider-fixture.test',
      enumeration: 'das-cursor',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedCursor: page === 1 ? null : 'cursor-1',
      nextCursor: page === 1 ? 'cursor-1' : null,
      accounts:
        page === 1
          ? Array.from({ length: 1000 }, (_, i) => ({
              address: indexedAddress(i + 100),
              owner: indexedAddress(i + 2000),
              raw: '1',
              frozen: false,
            }))
          : [
              {
                address: indexedAddress(8000),
                owner: indexedAddress(8001),
                raw: '999000',
                frozen: false,
              },
            ],
    }));
    let loseResponse = true;
    const bodies: string[] = [];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('/api/imported-projects/holder-index');
        if (typeof init?.body !== 'string')
          throw new Error('Expected immutable JSON page request.');
        bodies.push(init.body);
        const response = await POST(
          new Request('http://localhost/api/imported-projects/holder-index', {
            ...init,
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost',
            },
          }),
        );
        if (loseResponse) {
          loseResponse = false;
          expect(response.status).toBe(200);
          throw new TypeError('Response lost after database commit');
        }
        return response;
      },
    );
    const query = { id: 'retry-project', revision: 1, runId, page: 1 };
    const first = await readHolderIndexPageWithRetry(
      query,
      new AbortController().signal,
    );
    expect(first.page.accounts).toHaveLength(1000);
    expect(bodies[0]).toBe(bodies[1]);
    expect(state.observe).toHaveBeenCalledTimes(1);
    await readHolderIndexPageWithRetry(
      { ...query, page: 2 },
      new AbortController().signal,
    );
    expect(state.observe).toHaveBeenCalledTimes(2);
    const history = await readHolderIndexHistory(
      { id: query.id, revision: 1, mint, decimals: 6 },
      runId,
      new AbortController().signal,
      async (input, init) => {
        if (typeof input !== 'string')
          throw new Error('Expected saved-history URL.');
        return GET(new Request('http://localhost' + input, init));
      },
    );
    expect(history.scan!.accounts.size).toBe(1001);
    expect(history.scan!.indexedRaw).toBe(1000000n);
    expect(history.scan!.status).toBe('enumerated');
    expect(holderIndexSummary(history.scan!).remainderRaw).toBe('0');
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM holder_index_pages WHERE run_id=?')
        .bind(runId)
        .first('n'),
    ).toBe(2);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    state.db = null;
    await mf.dispose();
  }
}, 60000);
