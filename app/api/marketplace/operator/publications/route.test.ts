import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
import { readMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory-server';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import { operatorDraftRequest } from '@/lib/marketplace-operator-draft-view';
import { saveOperatorDraft } from '@/lib/marketplace-operator-draft-storage';
import {
  PUBLICATION_ACK,
  WITHDRAWAL_ACK,
  type PublicationRequest,
} from '@/lib/marketplace-publication';
import { publishListing } from '@/lib/marketplace-publication-storage';
const mocks = vi.hoisted(() => ({
  user: { userId: 'operator' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
import { GET as catalog } from '../../bundle-catalog/route';
let client: Client, db: D1Database, draftId: string, queries: string[];
const sig = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,label TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
  for (const file of [
    '0118_marketplace_operator_drafts',
    '0119_marketplace_publications',
  ])
    for (const sql of readFileSync('drizzle/' + file + '.sql', 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  const source = marketplaceOwnedFixture();
  for (const item of source.sources.wallets) {
    const w = item as {
      address: string;
      label: string;
      revision: number;
      updatedAt: string;
    };
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
      .bind(
        'operator',
        'Solana',
        w.address,
        w.label,
        w.revision,
        w.updatedAt,
        0,
      )
      .run();
  }
  const proof = source.sources.proofs[0] as {
    address: string;
    verifiedAt: string;
  };
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
    .bind('operator', 'Solana', proof.address, proof.verifiedAt)
    .run();
  const inventory = await readMarketplaceOwnedInventory(db, 'operator', sig()),
    review = await reviewOperatorListing(inventory, {
      address: inventory.wallets[0].address,
      walletRevision: 2,
      priceLamports: '50000000',
    });
  draftId = (
    await saveOperatorDraft(
      db,
      'operator',
      operatorDraftRequest(crypto.randomUUID(), review, true),
      sig(),
    )
  ).id;
  mocks.user = { userId: 'operator' };
  queries = [];
  mocks.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No providers permitted');
    }),
  );
});
afterEach(() => {
  client?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const endpoint = 'http://localhost/api/marketplace/operator/publications';
const post = (
  body: unknown,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) =>
  POST(
    new Request(endpoint, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  );
const get = (id: string) => GET(new Request(endpoint + '?id=' + id));
const browse = () =>
  catalog(new Request('http://localhost/api/marketplace/bundle-catalog'));
async function input(): Promise<PublicationRequest> {
  const response = await post({ action: 'review', draftId });
  expect(response.status).toBe(200);
  const { preview } = (await response.json()) as {
    preview: { reviewedAt: string; contextSha256: string };
  };
  return {
    id: crypto.randomUUID(),
    draftId,
    reviewedAt: preview.reviewedAt,
    contextSha256: preview.contextSha256,
    acknowledgement: PUBLICATION_ACK,
  };
}
it('checks operator authorization before SQL and keeps catalog sign-in separate', async () => {
  mocks.user = null;
  expect((await get(crypto.randomUUID())).status).toBe(401);
  expect((await post({ action: 'review', draftId })).status).toBe(401);
  expect((await browse()).status).toBe(401);
  expect(queries).toEqual([]);
  mocks.user = { userId: 'buyer' };
  expect((await post({ action: 'review', draftId })).status).toBe(403);
  expect((await get(crypto.randomUUID())).status).toBe(403);
  expect(queries).toEqual([]);
  expect((await browse()).status).toBe(200);
});
it('publishes exactly once, exposes only the customer subset, withdraws separately and keeps historical recovery', async () => {
  const selected = await input(),
    published = await post({ action: 'publish', ...selected });
  expect(published.status).toBe(200);
  expect((await post({ action: 'publish', ...selected })).status).toBe(200);
  const customer = (await (await browse()).json()) as {
    listings: unknown[];
    purchaseEnabled: boolean;
  };
  expect(customer.listings).toHaveLength(1);
  expect(customer.purchaseEnabled).toBe(false);
  expect(
    (await GET(new Request(endpoint + '?draftId=' + draftId))).status,
  ).toBe(200);
  expect(JSON.stringify(customer)).not.toMatch(
    /owner_id|draftId|reviewSha256|ownershipProofAt|fundedAt|label/,
  );
  expect(
    (
      await post({
        action: 'withdraw',
        id: selected.id,
        contextSha256: selected.contextSha256,
        acknowledgement: WITHDRAWAL_ACK,
      })
    ).status,
  ).toBe(200);
  expect(
    ((await (await browse()).json()) as { listings: unknown[] }).listings,
  ).toHaveLength(0);
  const recovered = (await (await get(selected.id)).json()) as {
    publication: { withdrawnAt: string | null };
  };
  expect(recovered.publication.withdrawnAt).not.toBeNull();
  await expect(
    db
      .prepare(
        'UPDATE marketplace_withdrawals SET acknowledgement=acknowledgement',
      )
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    db.prepare('DELETE FROM marketplace_withdrawals').run(),
  ).rejects.toThrow('immutable');
  expect(fetch).not.toHaveBeenCalled();
});
it('atomically refuses a second active publication across different operator drafts and permits it only after withdrawal', async () => {
  const first = await input();
  expect((await post({ action: 'publish', ...first })).status).toBe(200);
  await db
    .prepare(
      "INSERT INTO workspace_wallets SELECT 'other',chain,address,label,revision,updated_at,archived FROM workspace_wallets WHERE owner_id='operator'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO wallet_ownership_proofs SELECT 'other',chain,address,verified_at FROM wallet_ownership_proofs WHERE owner_id='operator'",
    )
    .run();
  const inventory = await readMarketplaceOwnedInventory(db, 'other', sig()),
    review = await reviewOperatorListing(inventory, {
      address: inventory.wallets[0].address,
      walletRevision: 2,
      priceLamports: '50000000',
    });
  const draft = await saveOperatorDraft(
    db,
    'other',
    operatorDraftRequest(crypto.randomUUID(), review, true),
    sig(),
  );
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator","other"]');
  mocks.user = { userId: 'other' };
  const response = await post({ action: 'review', draftId: draft.id }),
    body = (await response.json()) as {
      preview: { contextSha256: string; reviewedAt: string };
    };
  const second = {
    id: crypto.randomUUID(),
    draftId: draft.id,
    reviewedAt: body.preview.reviewedAt,
    contextSha256: body.preview.contextSha256,
    acknowledgement: PUBLICATION_ACK,
  };
  expect((await post({ action: 'publish', ...second })).status).toBe(409);
  mocks.user = { userId: 'operator' };
  expect(
    (
      await post({
        action: 'withdraw',
        id: first.id,
        contextSha256: first.contextSha256,
        acknowledgement: WITHDRAWAL_ACK,
      })
    ).status,
  ).toBe(200);
  mocks.user = { userId: 'other' };
  expect((await post({ action: 'publish', ...second })).status).toBe(200);
  expect(
    ((await (await browse()).json()) as { listings: unknown[] }).listings,
  ).toHaveLength(1);
});
it.each(['purchaseEnabled', 'deliveryEnabled', 'signingAllowed'] as const)(
  'database rejects a raw publication that enables %s',
  async (gate) => {
    const selected = await input(),
      response = await post({ action: 'review', draftId }),
      { preview } = (await response.json()) as {
        preview: Record<string, unknown>;
      };
    const parent = await db
      .prepare(
        'SELECT wallet_address,review_sha256 FROM marketplace_operator_drafts WHERE owner_id=? AND id=?',
      )
      .bind('operator', draftId)
      .first<{ wallet_address: string; review_sha256: string }>();
    const document = {
      format: 'bundle-publication-v1',
      id: selected.id,
      publishedAt: new Date().toISOString(),
      preview: { ...preview, [gate]: true },
      acknowledgement: PUBLICATION_ACK,
      withdrawnAt: null,
    };
    await expect(
      db
        .prepare('INSERT INTO marketplace_publications VALUES(?,?,?,?,?,?,?,?)')
        .bind(
          selected.id,
          'operator',
          draftId,
          parent!.review_sha256,
          parent!.wallet_address,
          preview.contextSha256,
          JSON.stringify(document),
          document.publishedAt,
        )
        .run(),
    ).rejects.toThrow('Invalid');
    expect(
      (await db
        .prepare('SELECT count(*) AS n FROM marketplace_publications')
        .first<{ n: number }>())!.n,
    ).toBe(0);
  },
);
it('rejects missing consent, forged roles, extra fields, wrong origin and unbounded requests', async () => {
  const selected = await input();
  for (const body of [
    { action: 'publish', ...selected, acknowledgement: undefined },
    { action: 'publish', ...selected, owner_id: 'buyer' },
    { action: 'publish', ...selected, signingAllowed: true },
    {
      action: 'withdraw',
      id: selected.id,
      contextSha256: selected.contextSha256,
    },
  ])
    expect((await post(body)).status).toBe(400);
  expect(
    (
      await post(
        { action: 'review', draftId },
        { origin: 'https://other.test', 'content-type': 'application/json' },
      )
    ).status,
  ).toBe(403);
  expect((await post('x'.repeat(3000))).status).toBe(413);
  expect((await get(selected.id + '&id=' + selected.id)).status).toBe(400);
});
it('refuses duplicate active addresses and publications from another operator or account', async () => {
  const selected = await input();
  expect((await post({ action: 'publish', ...selected })).status).toBe(200);
  expect(
    (await post({ action: 'publish', ...selected, id: crypto.randomUUID() }))
      .status,
  ).toBe(409);
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator","other"]');
  mocks.user = { userId: 'other' };
  expect((await get(selected.id)).status).toBe(404);
  expect((await post({ action: 'review', draftId })).status).toBe(404);
  expect(
    (
      await post({
        action: 'withdraw',
        id: selected.id,
        contextSha256: selected.contextSha256,
        acknowledgement: WITHDRAWAL_ACK,
      })
    ).status,
  ).toBe(404);
});
it.each(['wallet', 'proof', 'history', 'receipt'] as const)(
  'refuses changed saved evidence before publication: %s',
  async (kind) => {
    const selected = await input();
    if (kind === 'wallet')
      await db
        .prepare('UPDATE workspace_wallets SET revision=revision+1')
        .run();
    if (kind === 'proof')
      await db.prepare('DELETE FROM wallet_ownership_proofs').run();
    if (kind === 'history') {
      const run = marketplaceOwnedFixture().sources.runs[0] as {
        id: string;
        revision: number;
        createdAt: string;
        updatedAt: string;
        document: string;
      };
      await db
        .prepare('INSERT INTO warmup_history_runs VALUES(?,?,?,?,?,?)')
        .bind(
          'operator',
          run.id,
          run.revision,
          run.createdAt,
          run.updatedAt,
          run.document,
        )
        .run();
    }
    if (kind === 'receipt')
      await db
        .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?)')
        .bind(
          'operator',
          (await readMarketplaceOwnedInventory(db, 'operator', sig()))
            .wallets[0].address,
          'receipt',
        )
        .run();
    expect((await post({ action: 'publish', ...selected })).status).toBe(409);
  },
);
it('excludes revoked operators and archived wallets from later customer snapshots', async () => {
  const selected = await input();
  await post({ action: 'publish', ...selected });
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["other"]');
  expect(
    ((await (await browse()).json()) as { listings: unknown[] }).listings,
  ).toHaveLength(0);
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  await db.prepare('UPDATE workspace_wallets SET archived=1').run();
  expect(
    ((await (await browse()).json()) as { listings: unknown[] }).listings,
  ).toHaveLength(0);
  expect((await get(selected.id)).status).toBe(200);
});
it('refuses a legitimately saved watch-only draft with a specific control-proof requirement', async () => {
  await db.prepare('DELETE FROM wallet_ownership_proofs').run();
  const inventory = await readMarketplaceOwnedInventory(db, 'operator', sig()),
    review = await reviewOperatorListing(inventory, {
      address: inventory.wallets[0].address,
      walletRevision: 2,
      priceLamports: '50000000',
    });
  const draft = await saveOperatorDraft(
    db,
    'operator',
    operatorDraftRequest(crypto.randomUUID(), review, true),
    sig(),
  );
  const response = await post({ action: 'review', draftId: draft.id });
  expect(response.status).toBe(422);
  expect(JSON.stringify(await response.json())).toContain('Verify control');
});
it('refuses a control-proof deletion between publication review and the insert', async () => {
  const selected = await input();
  await expect(
    publishListing(
      hooked(async () => {
        await db.prepare('DELETE FROM wallet_ownership_proofs').run();
      }),
      'operator',
      selected,
      sig(),
    ),
  ).rejects.toThrow(/changed|review/);
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM marketplace_publications')
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
function hooked(hook: () => Promise<void>, lost = false) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO marketplace_publications'))
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  await hook();
                  const result = await bound.run();
                  if (lost) throw Error('Lost response');
                  return result;
                },
              };
            },
          };
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
it('database guard refuses a wallet race and preserves an insert committed before response loss', async () => {
  const selected = await input();
  await expect(
    publishListing(
      hooked(async () => {
        await db
          .prepare('UPDATE workspace_wallets SET revision=revision+1')
          .run();
      }),
      'operator',
      selected,
      sig(),
    ),
  ).rejects.toThrow();
  await db.prepare('UPDATE workspace_wallets SET revision=revision-1').run();
  let writes = 0;
  const result = await publishListing(
    hooked(async () => {
      writes++;
    }, true),
    'operator',
    selected,
    sig(),
  );
  expect(result.id).toBe(selected.id);
  expect(writes).toBe(1);
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM marketplace_publications')
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it('refuses changed hashes, expiry, cancellation, missing guards and row mutation', async () => {
  const selected = await input();
  expect(
    (
      await post({
        action: 'publish',
        ...selected,
        contextSha256: '0'.repeat(64),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post({
        action: 'publish',
        ...selected,
        reviewedAt: new Date(Date.now() - 60001).toISOString(),
      })
    ).status,
  ).toBe(409);
  const c = new AbortController();
  c.abort();
  expect(
    (await post({ action: 'publish', ...selected }, undefined, c.signal))
      .status,
  ).toBe(408);
  await post({ action: 'publish', ...selected });
  await expect(
    db.prepare('UPDATE marketplace_publications SET document=document').run(),
  ).rejects.toThrow('immutable');
  await expect(
    db.prepare('DELETE FROM marketplace_publications').run(),
  ).rejects.toThrow('immutable');
  await db.prepare('DROP TRIGGER marketplace_publications_no_update').run();
  expect((await browse()).status).toBe(503);
});
