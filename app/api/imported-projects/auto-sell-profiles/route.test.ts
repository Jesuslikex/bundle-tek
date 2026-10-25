import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { newAutoSellStrategy } from '@/lib/auto-sell';
import {
  readSavedAutoSellProfile,
  requireAutoSellProfileSummary,
  type AutoSellProfileTerms,
  type SavedAutoSellProfile,
} from '@/lib/auto-sell-profile';

const mocks = vi.hoisted(() => ({
  user: { userId: 'owner', email: 'owner@example.test' } as {
    userId: string;
    email: string;
  } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';

const origin = 'http://localhost';
const endpoint = origin + '/api/imported-projects/auto-sell-profiles';
const projectId = '00000000-0000-4000-8000-000000000001';
const otherProjectId = '00000000-0000-4000-8000-000000000002';
const profileId = '00000000-0000-4000-8000-000000000003';
const mint = 'So11111111111111111111111111111111111111112';
const address = '11111111111111111111111111111111';
const uuid = (n: number) =>
  '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
function terms(): AutoSellProfileTerms {
  return {
    name: 'Saved route fixture',
    projectId,
    projectRevision: 1,
    token: { chain: 'Solana', mint, decimals: 9, totalSupplyRaw: '1000000000' },
    wallets: [{ address, revision: 1 }],
    configuration: {
      strategies: [
        {
          ...newAutoSellStrategy(0),
          id: 'strategy',
          replicationPercent: '100',
        },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 60,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
}
function body(n = 1, expectedVersion = 0, value = terms()) {
  return {
    action: 'save',
    id: uuid(n),
    profileId,
    expectedVersion,
    terms: value,
  };
}
function post(
  value: unknown = body(),
  headers: Record<string, string> = {
    origin,
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  return POST(
    new Request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
      signal,
    }),
  );
}
function get(query = '?projectId=' + projectId, signal?: AbortSignal) {
  return GET(new Request(endpoint + query, { signal }));
}
let client: Client;
beforeEach(async () => {
  mocks.user = { userId: 'owner', email: 'owner@example.test' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('No provider/network access in this suite.');
    }),
  );
  client = createClient({ url: 'file::memory:' });
  mocks.db = createTursoDatabase(client);
  for (const file of [
    '0011_huge_donald_blake.sql',
    '0024_imported_token_projects.sql',
    '0149_auto_sell_profiles.sql',
  ])
    for (const sql of readFileSync('drizzle/' + file, 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await client.execute(sql);
  await client.execute({
    sql: 'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
    args: [
      'owner',
      projectId,
      'Solana',
      mint,
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: mint,
          decimals: 9,
          totalSupplyRaw: '1000000000',
        },
      }),
      uuid(900),
      new Date().toISOString(),
    ],
  });
  await client.execute({
    sql: 'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,0,1,?)',
    args: [
      'owner',
      'Solana',
      address,
      'fixture-folder',
      'Fixture wallet',
      'Recipient',
      new Date().toISOString(),
    ],
  });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  client.close();
  vi.unstubAllGlobals();
});
async function count() {
  return (await client.execute('SELECT COUNT(*) AS n FROM auto_sell_profiles'))
    .rows[0].n;
}
async function save(
  n = 1,
  version = 0,
  value = terms(),
): Promise<SavedAutoSellProfile> {
  const response = await post(body(n, version, value));
  expect(response.status).toBe(200);
  return ((await response.json()) as { profile: SavedAutoSellProfile }).profile;
}

it('requires authentication for both saved reads and writes without persisting anything', async () => {
  mocks.user = null;
  expect((await get()).status).toBe(401);
  expect((await post()).status).toBe(401);
  expect(await count()).toBe(0);
});
const invalidOrigins: Record<string, string>[] = [
  {},
  { origin: 'https://foreign.example', 'content-type': 'application/json' },
];
it.each(invalidOrigins)(
  'requires the exact same origin before a save %#',
  async (headers) => {
    expect((await post(body(), headers)).status).toBe(403);
    expect(await count()).toBe(0);
  },
);
it.each([
  'text/plain',
  'application/jsonp',
  'application/x-www-form-urlencoded',
])('rejects non-JSON content type %s', async (contentType) => {
  expect(
    (await post(body(), { origin, 'content-type': contentType })).status,
  ).toBe(415);
  expect(await count()).toBe(0);
});
it.each([
  { ...body(), password: 'never save this' },
  { ...body(), automaticResumeAllowed: true },
  { ...body(), action: 'start' },
  { ...body(), expectedVersion: -1 },
  { ...body(), expectedVersion: '0' },
  { ...body(), expectedVersion: 0.5 },
  { ...body(), terms: { ...terms(), vault: {} } },
  {
    ...body(),
    terms: {
      ...terms(),
      configuration: { ...terms().configuration, runner: { running: true } },
    },
  },
])(
  'refuses unknown authority/secret fields or malformed save input %#',
  async (input) => {
    expect((await post(input)).status).toBe(400);
    expect(await count()).toBe(0);
  },
);
it('rejects oversized and invalid JSON request bodies without leaking parser text', async () => {
  const oversized = await post({ ...body(), extra: 'x'.repeat(263168) });
  expect(oversized.status).toBe(400);
  const malformed = await POST(
    new Request(endpoint, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '<html>private parser detail</html>',
    }),
  );
  expect(malformed.status).toBe(400);
  expect(JSON.stringify(await malformed.json())).not.toMatch(
    /private parser|Unexpected token|<html>/,
  );
  expect(await count()).toBe(0);
});
it.each([
  '?projectId=' + projectId + '&projectId=' + projectId,
  '?projectId=' + projectId + '&id=' + uuid(1) + '&id=' + uuid(2),
  '?projectId=' + projectId + '&id=' + uuid(1) + '&before=' + uuid(2),
  '?projectId=' + projectId + '&action=start',
  '?projectId=' + projectId + '&before=' + uuid(1) + '&before=' + uuid(2),
])('rejects ambiguous or unknown query parameters %s', async (query) => {
  expect((await get(query)).status).toBe(400);
});
it('saves, exactly reads and lists a real codec-bound profile with false authority and lean index metadata', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as {
    profile: SavedAutoSellProfile;
    signingAllowed: false;
    executionAllowed: false;
    automaticResumeAllowed: false;
  };
  expect(value).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  const admitted = await readSavedAutoSellProfile(value.profile);
  expect(admitted.terms).toEqual(terms());
  const read = await get('?projectId=' + projectId + '&id=' + admitted.id);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(value);
  const list = await get();
  expect(list.status).toBe(200);
  const page = (await list.json()) as {
    profiles: unknown[];
    nextCursor: unknown;
    signingAllowed: false;
    executionAllowed: false;
    automaticResumeAllowed: false;
  };
  expect(page).toMatchObject({
    nextCursor: null,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(page.profiles).toHaveLength(1);
  const summary = requireAutoSellProfileSummary(page.profiles[0]);
  expect(summary).toMatchObject({
    id: admitted.id,
    profileId,
    version: 1,
    walletCount: 1,
    strategyCount: 1,
    sha256: admitted.sha256,
  });
  expect(page.profiles[0]).not.toHaveProperty('terms');
  expect(page.profiles[0]).not.toHaveProperty('configuration');
  expect(await count()).toBe(1);
});
it('keeps other owners, projects and cursor scopes out of exact saved history', async () => {
  const saved = await save();
  mocks.user = { userId: 'other', email: 'other@example.test' };
  expect(
    (await get('?projectId=' + projectId + '&id=' + saved.id)).status,
  ).toBe(404);
  expect(await (await get()).json()).toMatchObject({ profiles: [] });
  expect(
    (await get('?projectId=' + projectId + '&before=' + saved.id)).status,
  ).toBe(404);
  expect((await post(body(2))).status).toBe(404);
  mocks.user = { userId: 'owner', email: 'owner@example.test' };
  expect(
    (await get('?projectId=' + otherProjectId + '&id=' + saved.id)).status,
  ).toBe(404);
  const foreign = terms();
  foreign.projectId = otherProjectId;
  expect((await post(body(2, 0, foreign))).status).toBe(404);
  expect(await count()).toBe(1);
});
it('recovers the exact original save after source revisions/archive change without creating another version', async () => {
  const original = await save();
  await client.execute(
    'UPDATE imported_token_projects SET revision=2,archived=1',
  );
  await client.execute('UPDATE workspace_wallets SET revision=2,archived=1');
  const retry = await post();
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { profile: unknown }).profile).toEqual(
    original,
  );
  expect(
    (await get('?projectId=' + projectId + '&id=' + original.id)).status,
  ).toBe(200);
  expect((await post(body(2, 1))).status).toBe(409);
  expect(await count()).toBe(1);
});
it('creates immutable sequential versions and rejects competing or changed save identities', async () => {
  await save();
  expect((await post(body(2, 0))).status).toBe(409);
  const updated = terms();
  updated.name = 'Next revision';
  const next = await save(2, 1, updated);
  expect(next.version).toBe(2);
  const changed = terms();
  changed.name = 'Changed original request';
  expect((await post(body(1, 0, changed))).status).toBe(409);
  expect((await post({ ...body(1), profileId: uuid(999) })).status).toBe(409);
  expect(await count()).toBe(2);
});
it('rejects an aborted request and a cancelled streaming body without saving or running anything', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await post(body(), undefined, cancelled.signal)).status).toBe(408);
  expect((await get(undefined, cancelled.signal)).status).toBe(408);
  const pending = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  });
  const request = new Request(endpoint, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: stream,
    signal: pending.signal,
    duplex: 'half',
  } as RequestInit);
  const result = POST(request);
  queueMicrotask(() => pending.abort());
  expect((await result).status).toBe(408);
  expect(await count()).toBe(0);
});
