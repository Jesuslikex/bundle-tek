import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { persistWatchedWallet } from '@/lib/supply-watch-wallet';
import type { WalletWorkspace } from '@/lib/wallet-workspace';
import {
  importedTokenDocument,
  type ImportedTokenProject,
} from '@/lib/imported-token-project';
import {
  canonicalSupplyScope,
  type SupplyHistoryRow,
} from '@/lib/supply-history';
import { supplyFixture, supplyWallet } from './supply-history-fixture';
const mocks = vi.hoisted(() => ({
  user: { userId: 'watch-flow' } as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/supply-partition', async (original) => ({
  ...(await original<typeof import('@/lib/supply-partition')>()),
  observeSupplyPartition: mocks.observe,
}));
import {
  GET as roster,
  POST as saveWallet,
} from '@/app/api/wallet-workspace/route';
import {
  GET as history,
  POST as capture,
} from '@/app/api/imported-projects/supply-history/route';
let mf: Miniflare;
let project: ImportedTokenProject;
let testNumber = 0;
const watchedAddress = supplyWallet(7);
const scope = canonicalSupplyScope({
  mint: supplyWallet(9),
  wallets: [{ address: watchedAddress, group: 'external' }],
});
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'watch-flow-test',
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
          env: { DB: { type: 'd1', id: 'watch-flow-disposable' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'watch-flow-test');
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const statements = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await mocks.db.batch(
      statements.map((statement) => mocks.db.prepare(statement)),
    );
  }
}, 60000);
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  testNumber++;
  mocks.user = { userId: 'watch-flow-' + testNumber };
  mocks.observe.mockReset().mockResolvedValue(supplyFixture(0, scope));
  project = {
    id: 'watch-project-' + testNumber,
    revision: 1,
    archived: false,
    updatedAt: '2026-10-13T00:00:00.000Z',
    document: importedTokenDocument(
      { chain: 'Solana', address: scope.mint },
      {
        chain: 'Solana',
        address: scope.mint,
        name: 'Watch QA',
        symbol: 'WQA',
        decimals: 6,
        totalSupplyRaw: '1000000',
        metadataUri: '',
        observedAt: '2026-10-13T00:00:00.000Z',
        source: 'https://fixture.test',
      },
    ),
  };
  await mocks.db
    .prepare(
      'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
    )
    .bind(
      mocks.user.userId,
      project.id,
      'Solana',
      scope.mint,
      JSON.stringify(project.document),
      crypto.randomUUID(),
      project.updatedAt,
    )
    .run();
});
const trace: { method: string; status: number }[] = [];
const routeFetch: typeof fetch = async (input, init) => {
  const inputUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(inputUrl, 'http://watch.test');
  if (
    url.origin !== 'http://watch.test' ||
    url.pathname !== '/api/wallet-workspace'
  )
    throw new Error('Unexpected in-process route');
  const method = init?.method ?? 'GET';
  const response =
    method === 'GET'
      ? await roster()
      : await saveWallet(new Request(url, init));
  trace.push({ method, status: response.status });
  return response;
};
const baseline = () =>
  capture(
    new Request('http://watch.test/api/imported-projects/supply-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        revision: project.revision,
        wallets: scope.wallets,
      }),
    }),
  );
const readHistory = () =>
  history(
    new Request(
      `http://watch.test/api/imported-projects/supply-history?id=${project.id}&revision=1`,
    ),
  );
it('persists a sampled public wallet through the real roster route before baseline, reload and movement alerts', async () => {
  expect((await baseline()).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
  trace.length = 0;
  const wallet = await persistWatchedWallet(
    project,
    watchedAddress,
    routeFetch,
  );
  expect(trace).toEqual([
    { method: 'GET', status: 200 },
    { method: 'POST', status: 200 },
    { method: 'GET', status: 200 },
  ]);
  expect(wallet).toMatchObject({
    address: watchedAddress,
    chain: 'Solana',
    role: 'Recipient',
    revision: 1,
    archived: false,
  });
  const savedRoster = (await (await roster()).json()) as WalletWorkspace;
  expect(savedRoster.wallets).toEqual([wallet]);
  expect(savedRoster.proofs).toEqual([]);
  const first = await baseline();
  expect(first.status).toBe(200);
  const firstRecord = (await first.json()) as {
    scopeId: string;
    item: SupplyHistoryRow;
  };
  expect(firstRecord.item.document.alerts).toEqual([]);
  const reloaded = (await (await readHistory()).json()) as {
    scopeId: string;
    items: SupplyHistoryRow[];
  };
  expect(reloaded.scopeId).toBe(firstRecord.scopeId);
  expect(reloaded.items).toEqual([firstRecord.item]);
  trace.length = 0;
  expect(
    await persistWatchedWallet(project, watchedAddress, routeFetch),
  ).toEqual(wallet);
  expect(trace).toEqual([{ method: 'GET', status: 200 }]);
  await mocks.db
    .prepare('DELETE FROM imported_supply_read_gates WHERE owner_id=?')
    .bind(mocks.user!.userId)
    .run();
  mocks.observe.mockResolvedValueOnce(supplyFixture(1, scope));
  expect((await baseline()).status).toBe(200);
  const moved = (await (await readHistory()).json()) as {
    items: SupplyHistoryRow[];
  };
  expect(moved.items).toHaveLength(2);
  expect(moved.items[0].document.previousSequence).toBe(
    firstRecord.item.sequence,
  );
  expect(moved.items[0].document.alerts).toMatchObject([
    { address: watchedAddress, direction: 'decrease', raw: '10000' },
  ]);
  mocks.user = null;
  expect((await readHistory()).status).toBe(401);
});
it('does not treat another account roster or an archived roster record as a watchable saved wallet', async () => {
  const owner = mocks.user!;
  mocks.user = { userId: 'other-account' };
  await persistWatchedWallet(project, watchedAddress, routeFetch);
  mocks.user = owner;
  expect((await baseline()).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
  const wallet = await persistWatchedWallet(
    project,
    watchedAddress,
    routeFetch,
  );
  expect(
    (
      await saveWallet(
        new Request('http://watch.test/api/wallet-workspace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'wallet.archive',
            chain: 'Solana',
            wallets: [{ address: wallet.address, revision: wallet.revision }],
          }),
        }),
      )
    ).status,
  ).toBe(200);
  await expect(
    persistWatchedWallet(project, watchedAddress, routeFetch),
  ).rejects.toThrow('archived');
  expect((await baseline()).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
});
