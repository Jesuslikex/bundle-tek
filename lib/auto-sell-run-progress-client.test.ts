import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from '@/test/auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
} from './auto-sell-run-storage';
import { createAutoSellRunAttempt } from './auto-sell-run';
import {
  loadAutoSellRunProgress,
  type AutoSellRunProgressSelection,
} from './auto-sell-run-progress-client';
import {
  readAutoSellRunProgress,
  type AutoSellRunProgressEvidence,
} from './auto-sell-run-progress';
const auth = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  owner: 'progress-client-owner',
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: auth.owner }),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET } from '@/app/api/imported-projects/auto-sell-run-progress/route';
let client: Client,
  body: Record<string, unknown>,
  pick: AutoSellRunProgressSelection,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  reference: AutoSellRunProgressEvidence;
const signal = () => new AbortController().signal;
beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  auth.db = createTursoDatabase(client);
  await initializeAutoSellRunStorageFixture(auth.db);
  const f = await setupAutoSellRunStorageFixture(auth.db, {
    owner: auth.owner,
  });
  const run = await createOwnedAutoSellRun(
    auth.db,
    auth.owner,
    f.createInput,
    signal(),
  );
  const a = await reserveOwnedAutoSellAttempt(
    auth.db,
    auth.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  await startOwnedAutoSellPreparation(
    auth.db,
    auth.owner,
    run.id,
    a.id,
    signal(),
  );
  const response = await GET(
    new Request(
      'https://bundle.test/api/imported-projects/auto-sell-run-progress?' +
        new URLSearchParams({ projectId: f.projectId, runId: run.id }),
    ),
  );
  expect(response.status).toBe(200);
  body = (await response.json()) as Record<string, unknown>;
  reference = body.evidence as AutoSellRunProgressEvidence;
  pick = {
    ownerScope: body.ownerScope as string,
    projectId: f.projectId,
    runId: run.id,
    runSha256: run.sha256,
    minimum: { sequence: 1, accountedRaw: a.inputRaw, stopped: false },
  };
});
afterAll(() => client.close());
beforeEach(() => {
  fetcher = vi.fn(async () => Response.json(structuredClone(body)));
});
afterEach(() => {
  vi.restoreAllMocks();
});
const load = (selection = structuredClone(pick), s = signal()) =>
  loadAutoSellRunProgress(selection, s, fetcher);
it('independently replays a real owned API/Turso response with GET-only no-store exact selection', async () => {
  const before = (await client.execute('SELECT total_changes() n')).rows[0].n;
  const progress = await load();
  expect(progress.accounting.sequence).toBe(1);
  expect(progress.accounting.accountedRaw).toBe(pick.minimum.accountedRaw);
  expect(progress.unresolvedAttempts[0].preparationStarted).toBe(true);
  expect(progress).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    allowanceReleased: false,
  });
  expect(fetcher).toHaveBeenCalledWith(
    '/api/imported-projects/auto-sell-run-progress?' +
      new URLSearchParams({ projectId: pick.projectId, runId: pick.runId }),
    expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    }),
  );
  expect((await client.execute('SELECT total_changes() n')).rows[0].n).toBe(
    before,
  );
});
it.each(['ownerScope', 'projectId', 'runId', 'runSha256'] as const)(
  'refuses a different expected %s',
  async (key) => {
    const p = structuredClone(pick);
    p[key] =
      key === 'ownerScope' || key === 'runSha256'
        ? 'b'.repeat(64)
        : '00000000-0000-4000-8000-000000000099';
    await expect(load(p)).rejects.toThrow('could not be verified');
  },
);
it.each([
  'signingAllowed',
  'executionAllowed',
  'automaticResumeAllowed',
  'allowanceReleased',
])('refuses a true %s response flag', async (key) => {
  fetcher.mockResolvedValue(Response.json({ ...body, [key]: true }));
  await expect(load()).rejects.toThrow('could not be verified');
});
it.each([202, 400, 401, 404, 408, 500, 503])(
  'refuses HTTP%s without body excerpts',
  async (status) => {
    fetcher.mockResolvedValue(
      new Response('<html>private parser secret</html>', {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(load()).rejects.toThrow('could not be verified');
  },
);
it('reports full-history capacity refusal without accepting partial progress', async () => {
  fetcher.mockResolvedValue(
    Response.json({ error: 'private' }, { status: 409 }),
  );
  await expect(load()).rejects.toThrow('Use the paged saved attempts');
});
it('refuses HTML and oversized JSON on200', async () => {
  fetcher.mockResolvedValue(
    new Response('<html>private</html>', {
      headers: { 'content-type': 'text/html' },
    }),
  );
  await expect(load()).rejects.toThrow('could not be verified');
  fetcher.mockResolvedValue(
    Response.json({ padding: 'x'.repeat(1048576), ...body }),
  );
  await expect(load()).rejects.toThrow('could not be verified');
});
it('refuses missing or extra wrapper fields', async () => {
  const altered = { ...body, extra: 1 };
  fetcher.mockResolvedValue(Response.json(altered));
  await expect(load()).rejects.toThrow();
  const missing = { ...body };
  delete missing.allowanceReleased;
  fetcher.mockResolvedValue(Response.json(missing));
  await expect(load()).rejects.toThrow();
});
it('refuses an omitted attempt suffix against the declared head', async () => {
  const e = structuredClone(reference);
  e.attempts = [];
  fetcher.mockResolvedValue(Response.json({ ...body, evidence: e }));
  await expect(load()).rejects.toThrow();
});
it('retains prior charged/sequence floors even if a stale response has an internally valid genesis head', async () => {
  const e = structuredClone(reference);
  e.attempts = [];
  e.preparationStarts = [];
  e.head = { sequence: 0, headSha256: e.run.sha256 };
  fetcher.mockResolvedValue(Response.json({ ...body, evidence: e }));
  await expect(load()).rejects.toThrow();
});
it('requires exact observed head at the same sequence', async () => {
  await expect(
    load({ ...pick, minimum: { ...pick.minimum, headSha256: 'b'.repeat(64) } }),
  ).rejects.toThrow();
});
it('pins the observed earlier head even when the valid complete chain grows', async () => {
  const e = structuredClone(reference),
    at = new Date(Date.parse(e.observedAt) + 1000).toISOString();
  const later = await createAutoSellRunAttempt(
    e.run,
    e.attempts,
    {
      id: '00000000-0000-4000-8000-000000000099',
      runId: e.run.id,
      expectedSequence: 1,
      expectedHeadSha256: e.head.headSha256,
      strategyId: 'counter',
      wallet: e.attempts[0].wallet,
      walletRevision: e.attempts[0].walletRevision,
      inputRaw: '10',
      occurrence: {
        kind: 'counter',
        sourceIds: ['later-source'],
        bufferedRaw: '10',
      },
      consent: 'reserve-auto-sell-attempt-v1',
    },
    '00000000-0000-4000-8000-000000000098',
    at,
  );
  e.attempts.push(later);
  e.head = { sequence: 2, headSha256: later.sha256 };
  e.observedAt = at;
  expect((await readAutoSellRunProgress(e)).accounting.sequence).toBe(2);
  fetcher.mockImplementation(async () =>
    Response.json({ ...body, evidence: e }),
  );
  await expect(
    load({
      ...pick,
      minimum: { ...pick.minimum, headSequence: 1, headSha256: 'b'.repeat(64) },
    }),
  ).rejects.toThrow();
  expect(
    (
      await load({
        ...pick,
        minimum: {
          ...pick.minimum,
          headSequence: 1,
          headSha256: reference.head.headSha256,
        },
      })
    ).accounting.sequence,
  ).toBe(2);
});
it('keeps a separately observed genesis head pinned as later observations advance', async () => {
  expect(
    (
      await load({
        ...pick,
        minimum: {
          ...pick.minimum,
          headSequence: 0,
          headSha256: reference.run.sha256,
        },
      })
    ).accounting.sequence,
  ).toBe(1);
  await expect(
    load({
      ...pick,
      minimum: { ...pick.minimum, headSequence: 0, headSha256: 'b'.repeat(64) },
    }),
  ).rejects.toThrow();
});
it('requires every previously known preparation start even on its first complete progress read', async () => {
  await expect(
    load({
      ...pick,
      minimum: {
        ...pick.minimum,
        startedAttemptIds: ['00000000-0000-4000-8000-000000000099'],
      },
    }),
  ).rejects.toThrow();
  expect(
    (
      await load({
        ...pick,
        minimum: {
          ...pick.minimum,
          startedAttemptIds: [reference.attempts[0].id],
        },
      })
    ).unresolvedAttempts[0].preparationStarted,
  ).toBe(true);
});
it('refuses an earlier observation or stopped-to-open regression', async () => {
  await expect(
    load({
      ...pick,
      minimum: { ...pick.minimum, observedAt: '2099-01-01T00:00:00.000Z' },
    }),
  ).rejects.toThrow();
  await expect(
    load({ ...pick, minimum: { ...pick.minimum, stopped: true } }),
  ).rejects.toThrow();
});
it('preserves every previously verified preparation start across complete reads', async () => {
  const e = structuredClone(reference);
  e.preparationStarts = [];
  fetcher.mockResolvedValue(Response.json({ ...body, evidence: e }));
  await expect(
    load({ ...pick, previousEvidence: reference }),
  ).rejects.toThrow();
});
it('refuses a changed preparation-start observation while retaining the original proof', async () => {
  const e = structuredClone(reference);
  const prev = structuredClone(reference);
  prev.preparationStarts[0].createdAt = new Date(
    Date.parse(prev.observedAt) + 1000,
  ).toISOString();
  prev.observedAt = prev.preparationStarts[0].createdAt;
  e.observedAt = new Date(Date.parse(prev.observedAt) + 1000).toISOString();
  await readAutoSellRunProgress(prev);
  await readAutoSellRunProgress(e);
  fetcher.mockResolvedValue(Response.json({ ...body, evidence: e }));
  await expect(load({ ...pick, previousEvidence: prev })).rejects.toThrow();
});
it('replays prior evidence before dispatch and refuses corrupted/foreign prior context', async () => {
  const e = structuredClone(reference);
  e.head.headSha256 = 'b'.repeat(64);
  await expect(load({ ...pick, previousEvidence: e })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('captures caller selection and prior evidence before asynchronous work', async () => {
  const p = {
    ...structuredClone(pick),
    previousEvidence: structuredClone(reference),
  };
  const promise = load(p);
  p.runId = '00000000-0000-4000-8000-000000000099';
  p.previousEvidence.head.headSha256 = 'b'.repeat(64);
  expect((await promise).run.id).toBe(pick.runId);
});
it('does not invoke accessor-backed prior evidence', async () => {
  const e = structuredClone(reference),
    getter = vi.fn(() => reference.head);
  Object.defineProperty(e, 'head', { enumerable: true, get: getter });
  await expect(load({ ...pick, previousEvidence: e })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects malformed local floor without dispatch', async () => {
  await expect(
    load({ ...pick, minimum: { ...pick.minimum, sequence: 0 } }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('aborts an uncooperative pending fetch without waiting for a late result', async () => {
  let finish!: (value: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const c = new AbortController(),
    promise = load(structuredClone(pick), c.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  c.abort();
  await expect(promise).rejects.toThrow('checking stopped');
  finish(Response.json(body));
});
it('never dispatches an already aborted read', async () => {
  const c = new AbortController();
  c.abort();
  await expect(load(structuredClone(pick), c.signal)).rejects.toThrow(
    'checking stopped',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
