import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { warmupSessionConsentFixture } from '@/test/warmup-session-consent-fixture';
import { retainWalletWarmupSessionConsent } from '@/lib/wallet-warmup-session-consent';
import type { publicWalletWarmupSessionJournal } from '@/lib/wallet-warmup-session-journal-public';
const mocks = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
  reads: 0,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    mocks.reads++;
    return mocks.db;
  },
}));
import { GET, POST } from './route';
type Journal = ReturnType<typeof publicWalletWarmupSessionJournal>;
async function journalResponse(response: Response): Promise<Journal> {
  return ((await response.json()) as { journal: Journal }).journal;
}
let f: Awaited<ReturnType<typeof warmupSessionConsentFixture>>;
let record: {
  operation: 'record';
  id: string;
  consentId: string;
  termsSha256: string;
  recordRequested: true;
};
const url = 'http://localhost/api/wallet-workspace/warmup/session-journals';
const headers = {
  origin: 'http://localhost',
  'content-type': 'application/json',
};
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider requests permitted');
    }),
  );
  f = await warmupSessionConsentFixture();
  for (const name of [
    '0124_wallet_warmup_session_journals',
    '0125_wallet_warmup_session_settlements',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await f.db.prepare(sql).run();
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    f.input,
    true,
    new AbortController().signal,
  );
  record = {
    operation: 'record',
    id: crypto.randomUUID(),
    consentId: consent.id,
    termsSha256: consent.termsSha256,
    recordRequested: true,
  };
  mocks.user = { userId: 'owner' };
  mocks.db = f.db;
  mocks.reads = 0;
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const post = (
  body: unknown = record,
  extra: Record<string, string> = headers,
  signal?: AbortSignal,
) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: extra,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  );
const get = (query = 'id=' + record.id, signal?: AbortSignal) =>
  GET(new Request(url + '?' + query, { signal }));
async function create() {
  const response = await post();
  expect(response.status).toBe(200);
  return ((await response.json()) as { journal: Journal }).journal;
}
function control(j: Journal, name: string, id = crypto.randomUUID()) {
  return {
    operation: 'control',
    id,
    journalId: j.id,
    expectedVersion: j.version,
    expectedHeadSha256: j.headSha256,
    control: name,
  };
}
async function eventCount() {
  return (await f.db
    .prepare('SELECT count(*) AS n FROM wallet_warmup_session_journal_events')
    .first<{ n: number }>())!.n;
}
function writes(
  prefix: string,
  run: (original: () => Promise<unknown>) => Promise<unknown>,
) {
  const db = f.db;
  return {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const original = db.prepare(sql);
      if (!sql.startsWith(prefix)) return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return { run: () => run(() => bound.run()) };
        },
      };
    },
  } as unknown as D1Database;
}
it('authenticates both methods before storage or input handling', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect((await get()).status).toBe(401);
  expect(mocks.reads).toBe(0);
});
it.each([
  [{}, 403],
  [{ ...headers, origin: 'https://elsewhere.example' }, 403],
  [{ ...headers, 'content-type': 'text/html' }, 415],
  [{ ...headers, 'content-type': 'application/jsonp' }, 415],
] as const)('rejects unsafe write headers %j', async (h, status) => {
  expect((await post(record, h)).status).toBe(status);
  expect(mocks.reads).toBe(0);
});
it.each(['unchecked', 'owner', 'extra', 'missing', 'noncanonical'] as const)(
  'rejects invalid root selection: %s',
  async (kind) => {
    const body: Record<string, unknown> = { ...record };
    if (kind === 'unchecked') body.recordRequested = false;
    if (kind === 'owner') body.owner = 'other';
    if (kind === 'extra') body.signingAllowed = true;
    if (kind === 'missing') delete body.termsSha256;
    if (kind === 'noncanonical') body.id = record.id.toUpperCase();
    expect((await post(body)).status).toBe(400);
    expect(mocks.reads).toBe(0);
  },
);
it.each(['submitted', 'unknown', 'finalized', 'sign', 'send', 'start'])(
  'rejects a client %s control without storage access',
  async (name) => {
    expect(
      (
        await post({
          operation: 'control',
          id: crypto.randomUUID(),
          journalId: record.id,
          expectedVersion: 0,
          expectedHeadSha256: 'a'.repeat(64),
          control: name,
        })
      ).status,
    ).toBe(400);
    expect(mocks.reads).toBe(0);
  },
);
it.each(['actionId', 'command', 'settlement', 'at'])(
  'rejects client-owned %s evidence',
  async (key) => {
    expect(
      (
        await post({
          operation: 'control',
          id: crypto.randomUUID(),
          journalId: record.id,
          expectedVersion: 0,
          expectedHeadSha256: 'a'.repeat(64),
          control: 'begin-review',
          [key]: 'client',
        })
      ).status,
    ).toBe(400);
    expect(mocks.reads).toBe(0);
  },
);
it('bounds streamed UTF-8 bytes, refuses malformed JSON and observes cancellation before storage', async () => {
  expect(
    (await post(JSON.stringify({ padding: 'é'.repeat(1100) }))).status,
  ).toBe(413);
  for (const body of ['<html>private', '[]', 'null'])
    expect((await post(body)).status).toBe(400);
  const c = new AbortController();
  c.abort();
  expect((await post(record, headers, c.signal)).status).toBe(408);
  expect((await get(undefined, c.signal)).status).toBe(408);
  expect(mocks.reads).toBe(0);
});
it.each([
  '',
  'id=wrong',
  'id=a&id=b',
  'id=' + crypto.randomUUID() + '&extra=x',
  'id=' + crypto.randomUUID() + '&eventId=wrong',
  'id=' +
    crypto.randomUUID() +
    '&eventId=' +
    crypto.randomUUID() +
    '&eventId=' +
    crypto.randomUUID(),
])('rejects malformed recovery query %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(mocks.reads).toBe(0);
});
it('records only the exact owned consent and projects a bounded non-authorizing progress DTO', async () => {
  const journal = await create();
  expect(journal).toMatchObject({
    id: record.id,
    consentId: record.consentId,
    version: 0,
    recoveryRequired: false,
    commandReceipt: null,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    snapshot: {
      phase: 'review-required',
      completedActions: 0,
      totalActions: 4,
      pending: null,
    },
  });
  expect(Object.keys(journal).sort()).toEqual(
    [
      'id',
      'consentId',
      'termsSha256',
      'createdAt',
      'version',
      'headSha256',
      'recoveryRequired',
      'snapshot',
      'commandReceipt',
      'executionAllowed',
      'signingAllowed',
      'automaticExecutionAllowed',
    ].sort(),
  );
  const serialized = JSON.stringify(journal);
  for (const key of [
    'sourceDocument',
    'source_sha256',
    'planDocument',
    'anchor',
    'events',
    'proof',
    'contextKey',
    'source.kind',
  ])
    expect(serialized).not.toContain('"' + key + '"');
  const response = await get();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await journalResponse(response)).toEqual(journal);
  expect((await post({ ...record, termsSha256: 'a'.repeat(64) })).status).toBe(
    409,
  );
  expect((await post({ ...record, id: crypto.randomUUID() })).status).toBe(409);
  expect(await eventCount()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it('isolates owners and does not create missing journals during reads or controls', async () => {
  const j = await create();
  mocks.user = { userId: 'other' };
  expect((await get()).status).toBe(404);
  expect((await post(control(j, 'stop'))).status).toBe(404);
  expect((await post({ ...record, id: crypto.randomUUID() })).status).toBe(404);
  mocks.user = { userId: 'owner' };
  expect((await get('id=' + crypto.randomUUID())).status).toBe(404);
  expect(await eventCount()).toBe(0);
});
it('persists pause/resume/stop, refuses invalid resume and cannot resume a stopped session', async () => {
  let j = await create();
  expect((await post(control(j, 'resume'))).status).toBe(409);
  for (const name of ['pause', 'resume', 'stop']) {
    const c = control(j, name);
    const response = await post(c);
    expect(response.status).toBe(200);
    j = await journalResponse(response);
    expect(j.commandReceipt).toMatchObject({
      id: c.id,
      operation: name,
      version: j.version,
    });
    expect(
      (await journalResponse(await get('id=' + j.id + '&eventId=' + c.id)))
        .commandReceipt,
    ).toEqual(j.commandReceipt);
  }
  expect(j.snapshot).toMatchObject({ stopped: true, phase: 'stopped' });
  expect((await post(control(j, 'resume'))).status).toBe(409);
  expect(await eventCount()).toBe(3);
});
it('derives the next review action on the server and recovers a duplicate command without renewal', async () => {
  const j = await create(),
    c = control(j, 'begin-review');
  const response = await post(c);
  expect(response.status).toBe(200);
  const next = await journalResponse(response);
  expect(next).toMatchObject({
    version: 1,
    recoveryRequired: true,
    snapshot: { phase: 'in-flight', pending: { state: 'reviewing' } },
  });
  expect(next.snapshot.pending?.action.id).toBe(next.commandReceipt?.actionId);
  expect(next.snapshot.pending?.action).not.toHaveProperty('source');
  expect(await journalResponse(await post(c))).toEqual(next);
  expect((await post(control(next, 'begin-review'))).status).toBe(409);
  expect((await post({ ...c, control: 'pause' })).status).toBe(409);
  expect(await eventCount()).toBe(1);
});
it.each(['plan', 'wallet', 'archive'])(
  'refuses a new review after %s drift but still permits stopping recovery',
  async (kind) => {
    const j = await create();
    await f.db
      .prepare(
        kind === 'plan'
          ? 'UPDATE wallet_warmup_plans SET revision=2'
          : kind === 'wallet'
            ? 'UPDATE workspace_wallets SET revision=2'
            : 'UPDATE wallet_warmup_plans SET archived=1',
      )
      .run();
    expect((await post(control(j, 'begin-review'))).status).toBe(409);
    expect((await post(control(j, 'stop'))).status).toBe(200);
    expect(await eventCount()).toBe(1);
  },
);
it('rejects stale heads instead of overwriting a concurrent control', async () => {
  const j = await create(),
    a = control(j, 'pause'),
    b = control(j, 'stop');
  const results = await Promise.all([post(a), post(b)]);
  expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect(await eventCount()).toBe(1);
});
it('recovers a root after a committed write loses its response without a second INSERT', async () => {
  let calls = 0;
  mocks.db = writes(
    'INSERT INTO wallet_warmup_session_journals',
    async (run) => {
      calls++;
      await run();
      throw Error('response lost');
    },
  );
  const j = await create();
  expect(await journalResponse(await post())).toEqual(j);
  expect(calls).toBe(1);
});
it('recovers an accepted command after cancellation with the same journal and command ID', async () => {
  const j = await create(),
    c = control(j, 'pause'),
    abort = new AbortController();
  let calls = 0;
  mocks.db = writes(
    'INSERT INTO wallet_warmup_session_journal_events',
    async (run) => {
      calls++;
      const result = await run();
      abort.abort();
      return result;
    },
  );
  expect((await post(c, headers, abort.signal)).status).toBe(408);
  const recovered = await journalResponse(
    await get('id=' + j.id + '&eventId=' + c.id),
  );
  expect(recovered.commandReceipt).toMatchObject({
    id: c.id,
    operation: 'pause',
  });
  expect((await journalResponse(await post(c))).commandReceipt).toEqual(
    recovered.commandReceipt,
  );
  expect(calls).toBe(1);
});
it('keeps historical progress readable after expiry/archive without renewing the original review', async () => {
  const j = await create();
  await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(j.snapshot.sourceReviewExpiresAt) + 1,
  );
  const result = await journalResponse(await get());
  expect(result.snapshot.sourceReviewFresh).toBe(false);
  expect(result.snapshot.sourceReviewExpiresAt).toBe(
    j.snapshot.sourceReviewExpiresAt,
  );
  expect((await post(control(result, 'begin-review'))).status).toBe(409);
  expect((await post(control(result, 'stop'))).status).toBe(200);
});
it('does not invent a missing command receipt or expose raw storage/parser errors', async () => {
  const j = await create();
  const result = await journalResponse(
    await get('id=' + j.id + '&eventId=' + crypto.randomUUID()),
  );
  expect(result.commandReceipt).toBeNull();
  expect(await eventCount()).toBe(0);
  mocks.db = {
    prepare() {
      throw Error('<html>PRIVATE_STORAGE_DETAIL');
    },
  } as unknown as D1Database;
  const response = await get();
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    'PRIVATE_STORAGE_DETAIL',
  );
});
