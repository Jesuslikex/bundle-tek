import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { DEFAULT_VENUE_OPTIONS, EMPTY_IDENTITY } from '@/lib/workspace-project';
import {
  metadataEditReviewHash,
  type MetadataEditSource,
} from '@/lib/project-collaboration-metadata';
const mocks = vi.hoisted(() => ({
  user: { userId: 'bob', email: 'bob@example.test' } as {
    userId: string;
    email: string;
  } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
const resources: DatabaseSync[] = [];
afterEach(() => {
  for (const db of resources.splice(0)) db.close();
  mocks.user = { userId: 'bob', email: 'bob@example.test' };
});
const revision = '2026-10-25T00:00:00.000Z';
const shareId = '12345678-1234-4234-8234-123456789abc';
const mutationId = '87654321-1234-4234-8234-123456789abc';
const origin = 'http://localhost';
const get = (query = '') =>
  GET(new Request(`${origin}/api/projects/collaboration/metadata${query}`));
const post = (
  body: unknown,
  headers: Record<string, string> = {
    origin,
    'content-type': 'application/json',
  },
) =>
  POST(
    new Request(`${origin}/api/projects/collaboration/metadata`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
async function body() {
  const response = await get(`?shareId=${shareId}`);
  expect(response.status).toBe(200);
  const source = (await response.json()) as MetadataEditSource;
  const values = {
    tokenName: 'Reviewed',
    ticker: 'NEW',
    description: 'Reviewed description',
  };
  return {
    action: 'save',
    mutationId,
    shareId,
    projectId: 'shared-project',
    expectedUpdatedAt: revision,
    values,
    reviewHash: await metadataEditReviewHash(source, values),
    approved: true,
  };
}
function fixture(permission = 1, wallets = false) {
  const sql = new DatabaseSync(':memory:');
  resources.push(sql);
  const clock = new DatabaseSync(':memory:');
  resources.push(clock);
  let now = '2026-10-25T12:00:00.000Z';
  sql.function(
    'strftime',
    { varargs: true },
    (...args) =>
      clock
        .prepare(`SELECT strftime(${args.map(() => '?').join(',')}) AS value`)
        .get(...args.map((a) => (a === 'now' ? now : a)))!.value as
        | string
        | null,
  );
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries.filter((e) => !e.tag.startsWith('0151_')))
    sql.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
  sql.exec(
    readFileSync('drizzle/0151_project_collaboration_metadata.sql', 'utf8'),
  );
  const doc = {
    plan: structuredClone(DEFAULT_LAUNCH_PLAN),
    identity: { ...EMPTY_IDENTITY, website: 'https://private.example.test' },
    options: structuredClone(DEFAULT_VENUE_OPTIONS),
  };
  if (wallets) {
    Object.assign(doc.options, {
      wallets: {
        chain: 'Solana',
        recipients: [
          {
            address: '11111111111111111111111111111111',
            revision: 1,
            folderRevision: 0,
            root: true,
          },
        ],
      },
    });
    sql
      .prepare(
        `INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,folder_ids,label,role,updated_at) VALUES('alice','Solana','11111111111111111111111111111111','','[]','Owned','Recipient',?)`,
      )
      .run(revision);
  }
  sql
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,document,updated_at) VALUES(?,?,?,?)',
    )
    .run('alice', 'shared-project', JSON.stringify(doc), revision);
  sql
    .prepare(
      `INSERT INTO project_shares(id,owner_id,project_id,token_hash,member_id,created_at,accepted_at,expires_at,wallet_scope,metadata_edit) VALUES(?,'alice','shared-project',?,'bob',?,?,?, ?,?)`,
    )
    .run(
      shareId,
      'a'.repeat(64),
      now,
      now,
      '2026-10-26T12:00:00.000Z',
      JSON.stringify({
        format: 'project-share-wallet-scope-v1',
        projectRevision: revision,
        wallets: [],
      }),
      permission,
    );
  let beforeInsert: (() => void) | undefined;
  const db = {
    prepare(text: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          args = input;
          return statement;
        },
        async first() {
          return (
            sql.prepare(text).get(...(args as (string | number | null)[])) ??
            null
          );
        },
        async run() {
          if (
            text.includes('INSERT INTO project_collaboration_metadata_edits')
          ) {
            const effect = beforeInsert;
            beforeInsert = undefined;
            effect?.();
          }
          const result = sql
            .prepare(text)
            .run(...(args as (string | number | null)[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    sql,
    db,
    doc,
    setNow(value: string) {
      now = value;
    },
    race(effect: () => void) {
      beforeInsert = effect;
    },
  };
}

it('requires sign-in before any source, receipt or write access', async () => {
  mocks.user = null;
  expect((await get(`?shareId=${shareId}`)).status).toBe(401);
  expect((await get(`?mutationId=${mutationId}`)).status).toBe(401);
  expect((await post({})).status).toBe(401);
});
it.each([
  '',
  '?shareId=x',
  '?mutationId=x',
  '?shareId=x&mutationId=x',
  `?shareId=${shareId}&shareId=${shareId}`,
  '?unknown=x',
])('requires one exact admitted query: %s', async (query) => {
  mocks.db = fixture().db;
  expect((await get(query)).status).toBe(400);
});
it.each([
  {},
  { origin: 'https://foreign.example', 'content-type': 'application/json' },
  { origin, 'content-type': 'text/plain' },
] as Record<string, string>[])(
  'rejects missing origin or JSON headers %#',
  async (headers) => {
    mocks.db = fixture().db;
    expect([403, 415]).toContain((await post({}, headers)).status);
  },
);
it.each([
  'not json',
  '[]',
  'null',
  JSON.stringify({ action: 'other' }),
  JSON.stringify({ action: 'save', approved: false }),
])('rejects malformed or unapproved save envelopes %#', async (input) => {
  const f = fixture();
  mocks.db = f.db;
  expect((await post(input)).status).toBe(400);
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    0,
  );
});
it('bounds actual streamed bytes even without Content-Length', async () => {
  mocks.db = fixture().db;
  expect((await post(' '.repeat(4097))).status).toBe(413);
});
it('saves only reviewed text, uses no-store, and recovers own historical receipts after revocation', async () => {
  const f = fixture();
  mocks.db = f.db;
  const request = await body();
  const response = await post(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const receipt = await response.json();
  expect(JSON.stringify(receipt)).not.toMatch(
    /source_document|owner_id|editor_id|private.example/,
  );
  f.sql.exec(
    `UPDATE project_shares SET revoked_at='2026-10-25T12:01:00.000Z';UPDATE workspace_projects SET updated_at='2026-10-25T12:02:00.000Z'`,
  );
  expect((await get(`?shareId=${shareId}`)).status).toBe(403);
  expect(await (await post(request)).json()).toEqual(receipt);
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  expect(await (await get(`?mutationId=${mutationId}`)).json()).toEqual({
    receipt,
  });
  mocks.user = { userId: 'foreign', email: 'foreign@example.test' };
  expect(await (await get(`?mutationId=${mutationId}`)).json()).toEqual({
    receipt: null,
  });
  expect((await post(request)).status).toBe(403);
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    1,
  );
});
it.each(['revoke', 'revision', 'document', 'expiry'] as const)(
  'refuses a concurrent %s at the real insert',
  async (kind) => {
    const f = fixture();
    mocks.db = f.db;
    const request = await body();
    f.race(() => {
      if (kind === 'revoke')
        f.sql.exec(
          `UPDATE project_shares SET revoked_at='2026-10-25T12:01:00.000Z'`,
        );
      if (kind === 'revision')
        f.sql.exec(
          `UPDATE workspace_projects SET updated_at='2026-10-25T12:02:00.000Z'`,
        );
      if (kind === 'document')
        f.sql.exec(
          `UPDATE workspace_projects SET document=json_set(document,'$.identity.website','https://changed.example')`,
        );
      if (kind === 'expiry') f.setNow('2026-10-26T12:00:00.000Z');
    });
    expect((await post(request)).status).toBe(409);
    expect(await (await get(`?mutationId=${mutationId}`)).json()).toEqual({
      receipt: null,
    });
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  },
);
it('refuses unknown authority fields and mismatched replay payloads', async () => {
  const f = fixture();
  mocks.db = f.db;
  const request = await body();
  expect((await post({ ...request, signingAllowed: true })).status).toBe(400);
  expect((await post(request)).status).toBe(200);
  expect(
    (await post({ ...request, values: { ...request.values, ticker: 'OTHER' } }))
      .status,
  ).toBe(409);
});
it('keeps generic database failures free of raw SQL and private source text', async () => {
  mocks.db = {
    prepare() {
      throw Error('private.example SELECT credentials');
    },
  } as unknown as D1Database;
  const response = await get(`?shareId=${shareId}`);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(
    /SELECT|credentials|private.example/,
  );
});
it.each(['Ab\ud800', 'Ab\udfff', 'Ab\u0000'])(
  'rejects crafted non-round-tripping text before any database mutation (%j)',
  async (tokenName) => {
    const f = fixture();
    mocks.db = f.db;
    const request = await body();
    expect(
      (await post({ ...request, values: { ...request.values, tokenName } }))
        .status,
    ).toBe(400);
    expect(
      f.sql
        .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
        .get()!.n,
    ).toBe(0);
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  },
);
